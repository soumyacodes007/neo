import { describe, expect, it } from "vitest";
import { PolicyIntent } from "../schemas/policy-intent.js";
import { AuthContextSet } from "../schemas/auth-context.js";
import { CandidateRuleset } from "../schemas/constraint.js";
import { toXdrBase64, type XdrBase64 } from "../primitives.js";
import type { PolicyClassification } from "../schemas/context-rule.js";
import { synthesizeRuleset } from "./synthesize.js";
import { matchPolicies } from "./match-policies.js";
import { generateTests } from "./generate-tests.js";

const C_ACCOUNT = "C" + "A".repeat(55);
const C_BLEND = "C" + "B".repeat(55);
const C_USDC = "C" + "C".repeat(55);
const G_AGENT = "G" + "A".repeat(55);

const tier1Intent = (): PolicyIntent =>
  PolicyIntent.parse({
    schema_version: "1",
    network: "testnet",
    account: C_ACCOUNT,
    grantee: { signer: { type: "delegated", address: G_AGENT }, label: "AI agent" },
    targets: [
      {
        contract: C_BLEND,
        label: "Blend pool",
        functions: [
          { name: "claim", arg_constraints: [] },
          { name: "submit", arg_constraints: [] },
        ],
        provenance: { kind: "user_intent", quote: "let the agent use Blend" },
      },
    ],
    budgets: [
      {
        token: C_USDC,
        cap: "500",
        decimals: 7,
        window: { ledgers: 17280 },
        scope: "outflow_via_transfer",
        provenance: { kind: "user_intent", quote: "max 500 USDC/day" },
      },
    ],
    expiry: { ledgers: 120960 },
    preserve: [0],
    explicit_denies: [],
    clarifications_resolved: [],
  });

const fakeEncode = (_c: PolicyClassification, _p: Record<string, unknown>): XdrBase64 => toXdrBase64("AAAAAA==");

describe("synthesizeRuleset (C1)", () => {
  it("T-C1.1-1: Tier-1 intent → pool rule + USDC rule with expiry", () => {
    const rs = synthesizeRuleset({ intent: tier1Intent(), intentHash: "deadbeef" }, { currentLedger: 1000 });
    expect(CandidateRuleset.parse(rs)).toBeTruthy();
    expect(rs.rules).toHaveLength(2);
    const blend = rs.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_BLEND)!;
    const usdc = rs.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_USDC)!;
    expect(blend.constraints.map((c) => c.kind).sort()).toEqual(["expiry", "func_allowlist"]);
    expect(blend.constraints.find((c) => c.kind === "func_allowlist")).toMatchObject({ functions: ["claim", "submit"] });
    expect(usdc.constraints.find((c) => c.kind === "amount_cap")).toMatchObject({
      cap_i128: "5000000000",
      source: { kind: "transfer_arg2" },
    });
    expect(blend.valid_until_ledger).toBe(121960);
  });

  it("T-C1.1-4: never emits a Default rule", () => {
    const rs = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x" }, { currentLedger: 1000 });
    expect(rs.rules.every((r) => r.context_type.kind === "call_contract")).toBe(true);
  });

  it("T-C1.1-5: determinism — byte-identical ruleset_hash across runs", () => {
    const a = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x" }, { currentLedger: 1000 });
    const b = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x" }, { currentLedger: 1000 });
    expect(a.ruleset_hash).toBe(b.ruleset_hash);
    expect(a.ruleset_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T-C1.1-2: evidence adds observed sub-contexts without over-generalizing args", () => {
    const evidence = AuthContextSet.parse({
      schema_version: "1",
      account: C_ACCOUNT,
      network: "testnet",
      polarity: "positive",
      contexts: [
        {
          context_type: { kind: "call_contract", address: C_USDC },
          contract: C_USDC,
          fn_name: "transfer",
          arity: 1,
          depth: "sub",
          arg_summary: [
            {
              index: 0,
              sc_type: "scvI128",
              distinct_values_scval_b64: ["AAAAAA=="],
              observed_count: 1,
              numeric_range: { min: "500", max: "500" },
            },
          ],
          occurrences: [
            {
              tx_hash: "11".repeat(32),
              ledger: 2000,
              context_index: 0,
              depth: "sub",
              successful: true,
              provenance: { kind: "observed_tx", tx_hash: "11".repeat(32), context_index: 0 },
            },
          ],
        },
      ],
      window: { from_ledger: 2000, to_ledger: 2000 },
      evidence_hash: "22".repeat(32),
    });
    const rs = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x", evidence }, { currentLedger: 1000 });
    const usdc = rs.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_USDC)!;
    expect(usdc.constraints.find((c) => c.kind === "func_allowlist")).toMatchObject({ functions: ["transfer"] });
    expect(usdc.constraints.find((c) => c.kind === "arg_predicate")).toMatchObject({
      fn: "transfer",
      arg_index: 0,
      op: "eq",
      values_scval_b64: ["AAAAAA=="],
    });
    expect(rs.based_on.evidence_hash).toBe(evidence.evidence_hash);
  });
});

describe("matchPolicies (C2)", () => {
  it("T-C2.1-1/-3: transfer cap → spending_limit; func allowlist → pb_function_allowlist", () => {
    const rs = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x" }, { currentLedger: 1000 });
    const { ruleset, requires_codegen } = matchPolicies(rs, { encodeInstallParams: fakeEncode });
    const usdc = ruleset.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_USDC)!;
    const blend = ruleset.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_BLEND)!;
    const usdcBinding = usdc.policy_bindings.find((b) => b.binding.kind === "existing")!;
    expect(usdcBinding.binding).toMatchObject({ kind: "existing", classification: "oz:spending_limit" });
    expect(blend.policy_bindings[0]?.binding).toMatchObject({ classification: "pb:function_allowlist" });
    expect(requires_codegen).toEqual([]);
  });

  it("INV-CR-3 / EC-S02: a transfer_arg2 cap NOT on its token rule never binds spending_limit", () => {
    // Hand-build a ruleset where the amount_cap token differs from the rule contract.
    const rs = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x" }, { currentLedger: 1000 });
    const blend = rs.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_BLEND)!;
    // Inject a transfer_arg2 cap on the Blend rule (token = USDC ≠ Blend contract).
    blend.constraints.push({
      kind: "amount_cap",
      token: C_USDC as never,
      cap_i128: "5000000000",
      window: { ledgers: 17280 },
      source: { kind: "transfer_arg2" },
      id: "x:amount_cap",
      provenance: [{ kind: "user_intent", quote: "q" }],
    });
    const { ruleset } = matchPolicies(rs, { encodeInstallParams: fakeEncode });
    const rematched = ruleset.rules.find((r) => r.context_type.kind === "call_contract" && r.context_type.address === C_BLEND)!;
    const capBinding = rematched.policy_bindings.find((b) =>
      b.binding.kind === "existing" && b.binding.classification === "pb:call_cap",
    );
    expect(capBinding).toBeDefined();
    expect(rematched.policy_bindings.some((b) => b.binding.kind === "existing" && b.binding.classification === "oz:spending_limit")).toBe(false);
  });
});

describe("generateTests (D2)", () => {
  it("produces allow + mutation deny cases with full coverage for func+expiry", () => {
    // A ruleset with only func_allowlist + expiry (no amount_cap) is fully coverable.
    const rs = synthesizeRuleset(
      {
        intent: PolicyIntent.parse({
          ...tier1Intent(),
          budgets: [],
        }),
        intentHash: "x",
      },
      { currentLedger: 1000 },
    );
    const cases = generateTests({ ruleset: rs });
    expect(cases.some((c) => c.kind === "allow")).toBe(true);
    expect(cases.some((c) => c.origin.kind === "mutation" && c.origin.operator === "wrong_function")).toBe(true);
    expect(cases.some((c) => c.origin.kind === "mutation" && c.origin.operator === "expired_window")).toBe(true);
  });

  it("INV-Test-1: an unencodable amount_cap → E_DOMAIN_COVERAGE_GAP", () => {
    const rs = synthesizeRuleset({ intent: tier1Intent(), intentHash: "x" }, { currentLedger: 1000 });
    expect(() => generateTests({ ruleset: rs })).toThrow(/COVERAGE_GAP|not exercised/i);
    // …unless gaps are explicitly permitted.
    expect(generateTests({ ruleset: rs }, { allowCoverageGaps: true }).length).toBeGreaterThan(0);
  });
});
