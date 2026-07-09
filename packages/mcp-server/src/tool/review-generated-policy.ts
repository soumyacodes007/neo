import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

const ManifestSchema = z.object({
  generated_at: z.string().optional(),
  policy_name: z.string().optional(),
  crate_name: z.string(),
  residual_kind: z.string().optional(),
  no_build_rs: z.boolean(),
  review_required: z.boolean().optional(),
  deps: z.array(z.string()).optional(),
  regions: z.array(z.object({
    id: z.string().optional(),
    constraint_id: z.string().optional(),
    marker_start: z.string(),
    marker_end: z.string(),
    constraint_ids: z.array(z.string()).optional(),
  })).min(1),
});

const CompileResultSchema = z.object({
  ok: z.boolean(),
}).passthrough();

export function registerReviewGeneratedPolicyTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_review_generated_policy",
    {
      title: "Review generated policy",
      description: "Static quality gate for materialized generated Rust policy crates. It never deploys and never signs.",
      inputSchema: {
        crate_path: z.string().min(1),
        compile_result: CompileResultSchema.optional(),
        simulation_report_hash: z.string().length(64).optional(),
      },
    },
    withToolBoundary("ozpb_review_generated_policy", async (input) => {
      const cratePath = resolve(input.crate_path);
      const manifestPath = join(cratePath, "codegen_manifest.json");
      const reviewPath = join(cratePath, "REVIEW.md");
      const cargoPath = join(cratePath, "Cargo.toml");
      const libPath = join(cratePath, "src", "lib.rs");
      const manifest = ManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
      const review = await readFile(reviewPath, "utf8");
      const cargo = await readFile(cargoPath, "utf8");
      const lib = await readFile(libPath, "utf8");
      const files = await listFiles(cratePath);
      const checks = [
        check("manifest_present", true, "codegen_manifest.json parsed"),
        check("review_required", manifest.review_required !== false, "manifest does not opt out of review"),
        check("no_build_rs", manifest.no_build_rs === true && !files.some((f) => f.endsWith(`${sep}build.rs`) || f === "build.rs"), "crate has no build.rs"),
        check("review_doc_present", review.includes("REVIEW REQUIRED"), "REVIEW.md contains the mandatory review warning"),
        check("regions_fenced", manifest.regions.every((r) => lib.includes(r.marker_start) && lib.includes(r.marker_end)), "all manifest regions have start/end markers in src/lib.rs"),
        check("regions_map_constraints", manifest.regions.every((r) => constraintIds(r).length > 0), "every generated region maps to at least one constraint"),
        check("cargo_dependencies_restricted", dependenciesAreRestricted(cargo), "Cargo.toml only uses the expected generated-policy dependencies"),
        check("paths_stay_inside_crate", files.every((f) => !relative(cratePath, join(cratePath, f)).startsWith("..")), "all discovered files stay inside the generated crate"),
        check("compile_passed", input.compile_result?.ok === true, "ozpb_compile_generated_policy passed for this crate"),
        check("simulation_report_attached", input.simulation_report_hash !== undefined, "a real allow/deny simulation report hash is attached"),
      ];
      const staticPass = checks.filter((c) => !["compile_passed", "simulation_report_attached"].includes(c.id)).every((c) => c.pass);
      const deploymentAllowed = checks.every((c) => c.pass);
      return {
        crate_path: cratePath,
        manifest: {
          policy_name: manifest.policy_name ?? manifest.crate_name,
          crate_name: manifest.crate_name,
          residual_kind: manifest.residual_kind ?? "manifest-v1",
          regions: manifest.regions.map((r) => ({ id: r.id ?? r.constraint_id ?? "generated", constraint_ids: constraintIds(r) })),
        },
        checks,
        static_pass: staticPass,
        deployment_allowed: deploymentAllowed,
        next_step: deploymentAllowed
          ? "eligible for explicit human review and install planning"
          : nextStep(checks),
      };
    }),
  );
}

function check(id: string, pass: boolean, detail: string) {
  return { id, pass, detail };
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir);
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...await listFiles(full, base));
    else out.push(relative(base, full));
  }
  return out;
}

function dependenciesAreRestricted(cargoToml: string): boolean {
  const disallowed = [
    "build-dependencies",
    "git =",
    "std::process",
  ];
  if (disallowed.some((needle) => cargoToml.includes(needle))) return false;
  const allowedDependencyNames = new Set(["soroban-sdk", "stellar-accounts"]);
  let inDependencies = false;
  for (const line of cargoToml.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inDependencies = trimmed === "[dependencies]";
      continue;
    }
    if (!inDependencies || trimmed === "" || trimmed.startsWith("#")) continue;
    const name = trimmed.split("=")[0]?.trim();
    if (name !== undefined && !allowedDependencyNames.has(name)) return false;
  }
  return true;
}

function constraintIds(region: { constraint_id?: string | undefined; constraint_ids?: string[] | undefined }): string[] {
  if (region.constraint_ids !== undefined) return region.constraint_ids;
  return region.constraint_id !== undefined ? [region.constraint_id] : [];
}

function nextStep(checks: { id: string; pass: boolean }[]): string {
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  if (failed.includes("compile_passed")) return "call ozpb_compile_generated_policy and pass its compile result back into this gate";
  if (failed.includes("simulation_report_attached")) return "run Docker/fork allow-deny simulation and attach the report hash";
  return `repair generated crate review issues: ${failed.join(", ")}`;
}
