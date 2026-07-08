import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

const ArtifactSchema = z.object({
  kind: z.enum(["recording", "ruleset", "simulation_report", "bypass_report", "risk_report", "install_plan", "generated_policy", "testnet_fixture"]),
  path: z.string().optional(),
  hash: z.string().optional(),
  status: z.enum(["missing", "present", "stale", "failed", "passed", "review_required"]).default("present"),
});

export function registerWorkflowStatusTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_workflow_status",
    {
      title: "Workflow status",
      description: "Summarizes current artifact state and returns the next safe MCP step for an agent.",
      inputSchema: {
        artifacts: z.array(ArtifactSchema).default([]),
        check_paths: z.array(z.string()).default([]),
      },
    },
    withToolBoundary("ozpb_workflow_status", async (input) => {
      const checked = [];
      for (const file of input.check_paths) {
        const abs = path.resolve(process.cwd(), file);
        try {
          const stat = await fs.stat(abs);
          checked.push({ path: file, exists: true, bytes: stat.size });
        } catch {
          checked.push({ path: file, exists: false, bytes: 0 });
        }
      }
      return {
        artifacts: input.artifacts,
        checked_paths: checked,
        next_step: nextStep(input.artifacts),
        hard_rules: [
          "Do not submit or install without owner approval.",
          "Do not treat fake simulation as security verification.",
          "Generated policy code must be reviewed, compiled, and simulated before install.",
          "Changed actions must route to owner approval when coverage fails.",
        ],
      };
    }),
  );
}

function nextStep(artifacts: z.infer<typeof ArtifactSchema>[]): string {
  const has = (kind: z.infer<typeof ArtifactSchema>["kind"], status?: z.infer<typeof ArtifactSchema>["status"]) =>
    artifacts.some((a) => a.kind === kind && (status === undefined || a.status === status));
  if (!has("recording")) return "ozpb_record_evidence";
  if (!has("ruleset")) return "ozpb_synthesize_ruleset or ozpb_author_policy_draft";
  if (has("generated_policy", "review_required")) return "review generated files, then ozpb_compile_generated_policy";
  if (!has("simulation_report", "passed")) return "ozpb_generate_tests then ozpb_run_simulation with real fork/testnet engine";
  if (!has("install_plan")) return "ozpb_prepare_install_plan";
  return "ozpb_install_policy";
}
