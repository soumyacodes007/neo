import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatePolicyCode, renderGeneratedPolicyReview, writeGeneratedPolicyWorkspace, type CodegenResidual } from "./codegen.js";

const residual: CodegenResidual = {
  kind: "cross_arg_lt",
  constraint_id: "c:novel:0",
  fn_name: "swap",
  left_index: 2,
  right_index: 3,
};

describe("generatePolicyCode (C3)", () => {
  it("T-C3.1-1/2/3: emits a slug-named crate with no build.rs and an allowlisted dep set", () => {
    const g = generatePolicyCode({ policyName: "Novel Slippage Guard!", residual });
    expect(g.crate_name).toBe("stellar-generated-novel-slippage-guard");
    const cargo = g.files.find((f) => f.path === "Cargo.toml")!.content;
    expect(cargo).not.toMatch(/build\.rs/);
    expect(cargo).toContain("soroban-sdk");
    expect(cargo).toContain("stellar-accounts");
    expect(g.manifest.no_build_rs).toBe(true);
    expect(g.manifest.deps).toEqual(["soroban-sdk", "stellar-accounts"]);
  });

  it("T-C3.1-4/6: the manifest maps the generated region and the fenced markers are present + non-overlapping", () => {
    const g = generatePolicyCode({ policyName: "guard", residual });
    const lib = g.files.find((f) => f.path === "src/lib.rs")!.content;
    const region = g.manifest.regions[0]!;
    expect(region.constraint_id).toBe("c:novel:0");
    expect(lib).toContain(region.marker_start);
    expect(lib).toContain(region.marker_end);
    // Exactly one start and one end marker (non-overlapping).
    expect(lib.split(">>> GENERATED").length - 1).toBe(1);
    expect(lib.split("<<< GENERATED").length - 1).toBe(1);
    // The generated check references the configured arg indices.
    expect(lib).toContain("read_i128(e, &args, 2)");
    expect(lib).toContain("read_i128(e, &args, 3)");
  });

  it("T-C3.1-5: an unexpressible residual fails honestly", () => {
    try {
      generatePolicyCode({ policyName: "x", residual: { kind: "oracle_priced_slippage" } as unknown as CodegenResidual });
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("E_C3_UNEXPRESSIBLE");
    }
  });

  it("generates a multi-check context guard with manifest semantics for review", () => {
    const g = generatePolicyCode({
      policyName: "bounded swap",
      residual: {
        kind: "context_guard",
        constraint_id: "c:swap:guard",
        fn_name: "swap",
        checks: [
          { kind: "arg_i128_range", arg_index: 0, min: "1", max: "100" },
          { kind: "arg_u32_eq", arg_index: 1, value: 7 },
          { kind: "cross_arg_compare", left_index: 2, op: "gte", right_index: 3 },
        ],
      },
    });
    const lib = g.files.find((f) => f.path === "src/lib.rs")!.content;
    expect(lib).toContain("value < 1i128 || value > 100i128");
    expect(lib).toContain("value != 7u32");
    expect(lib).toContain("if !(left >= right)");
    expect(g.manifest.regions[0]?.semantics).toContain("args[2] >= args[3]");
    expect(renderGeneratedPolicyReview(g)).toContain("REVIEW REQUIRED");
  });

  it("writes reviewable workspace artifacts without deployment side effects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ozpb-codegen-"));
    try {
      const g = generatePolicyCode({ policyName: "guard", residual });
      const written = await writeGeneratedPolicyWorkspace(g, dir);
      await expect(readFile(written.manifest_path, "utf8")).resolves.toContain("c:novel:0");
      await expect(readFile(written.review_path, "utf8")).resolves.toContain("Compile with the sandbox");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
