import { describe, expect, it } from "vitest";
import { toXdrBase64, type XdrBase64 } from "../primitives.js";
import { AuthContextSet, type AuthContextEvidence } from "../schemas/auth-context.js";
import type { SignerModel } from "../schemas/signer.js";
import { synthesizeFromExamples } from "./synthesize-examples.js";

const C_ACCOUNT = "C" + "A".repeat(55);
const C_POOL = "C" + "B".repeat(55);
const G_AGENT = "G" + "A".repeat(55);
const TOKA = toXdrBase64("AAAAAA==");
const TOKB = toXdrBase64("BBBBBB==");
const signers: SignerModel[] = [{ type: "delegated", address: G_AGENT as never }];

function evidence(
  fn: string,
  args: { index: number; values: XdrBase64[]; range?: [string, string] }[],
): AuthContextEvidence {
  return {
    context_type: { kind: "call_contract", address: C_POOL as never },
    contract: C_POOL as never,
    fn_name: fn,
    arity: args.length,
    depth: "root",
    arg_summary: args.map((a) => ({
      index: a.index,
      sc_type: a.range ? "scvI128" : "scvAddress",
      distinct_values_scval_b64: a.values,
      observed_count: 1,
      opaque: false,
      ...(a.range ? { numeric_range: { min: a.range[0], max: a.range[1] } } : {}),
    })),
    occurrences: [
      { tx_hash: "11".repeat(32) as never, ledger: 100 as never, context_index: 0, depth: "root", successful: true, provenance: { kind: "observed_tx", tx_hash: "11".repeat(32) as never, context_index: 0 } },
    ],
  };
}

function set(polarity: "positive" | "negative", contexts: AuthContextEvidence[]): AuthContextSet {
  return AuthContextSet.parse({
    schema_version: "1",
    account: C_ACCOUNT,
    network: "testnet",
    polarity,
    contexts,
    window: { from_ledger: 1, to_ledger: 200 },
    evidence_hash: "cc".repeat(32),
  });
}

const base = { signers, validUntilLedger: 5000, intentHash: "deadbeef" };

describe("synthesizeFromExamples (C1.3)", () => {
  it("T-C1.3-1: separates good swaps from wrong-token swaps", () => {
    const allow = set("positive", [evidence("swap", [{ index: 0, values: [TOKA] }])]);
    const deny = set("negative", [evidence("swap", [{ index: 0, values: [TOKB] }])]);
    const rs = synthesizeFromExamples({ allow, deny, ...base });
    const rule = rs.rules[0]!;
    expect(rule.constraints.find((c) => c.kind === "func_allowlist")).toMatchObject({ functions: ["swap"] });
    const pred = rule.constraints.find((c) => c.kind === "arg_predicate");
    expect(pred).toMatchObject({ op: "eq", arg_index: 0, values_scval_b64: [TOKA] });
  });

  it("wrong-function deny is excluded by the allowlist alone (no arg predicate)", () => {
    const allow = set("positive", [evidence("swap", [{ index: 0, values: [TOKA] }])]);
    const deny = set("negative", [evidence("drain", [{ index: 0, values: [TOKA] }])]);
    const rs = synthesizeFromExamples({ allow, deny, ...base });
    const rule = rs.rules[0]!;
    expect(rule.constraints.find((c) => c.kind === "func_allowlist")).toMatchObject({ functions: ["swap"] });
    expect(rule.constraints.some((c) => c.kind === "arg_predicate")).toBe(false);
  });

  it("T-C1.3-3: amount-only difference yields a range discriminator", () => {
    // Allow slippage floor 100..100; deny 0..0 (no slippage bound) → range excludes it.
    const allow = set("positive", [evidence("swap", [{ index: 1, values: [toXdrBase64("Zm9v")], range: ["100", "100"] }])]);
    const deny = set("negative", [evidence("swap", [{ index: 1, values: [toXdrBase64("YmFy")], range: ["0", "0"] }])]);
    const rs = synthesizeFromExamples({ allow, deny, ...base });
    const pred = rs.rules[0]!.constraints.find((c) => c.kind === "arg_predicate");
    expect(pred).toMatchObject({ op: "range", min_i128: "100", max_i128: "100" });
  });

  it("T-C1.3-2: a byte-identical allow/deny pair is honestly unsatisfiable", () => {
    const allow = set("positive", [evidence("swap", [{ index: 0, values: [TOKA] }])]);
    const deny = set("negative", [evidence("swap", [{ index: 0, values: [TOKA] }])]);
    expect(() => synthesizeFromExamples({ allow, deny, ...base })).toThrow(/UNSATISFIABLE|indistinguishable|byte-identical/i);
  });

  it("determinism: identical inputs yield the same ruleset_hash", () => {
    const allow = set("positive", [evidence("swap", [{ index: 0, values: [TOKA] }])]);
    const deny = set("negative", [evidence("swap", [{ index: 0, values: [TOKB] }])]);
    const a = synthesizeFromExamples({ allow, deny, ...base });
    const b = synthesizeFromExamples({ allow, deny, ...base });
    expect(a.ruleset_hash).toBe(b.ruleset_hash);
  });
});
