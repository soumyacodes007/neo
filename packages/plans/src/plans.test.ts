import { StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  AccountSnapshot,
  PolicyIntent,
  matchPolicies,
  synthesizeRuleset,
  toContractId,
  toXdrBase64,
  type BypassReport,
  type CandidateRuleset,
  type PolicyClassification,
  type RiskReport,
  type SimulationReport,
  type TestCase,
  type XdrBase64,
} from "@ozpb/core";
import { explainPolicy } from "./explain.js";
import { runSimulation, type SimulationEngine } from "./simulate.js";
import { prepareInstallPlan, type InstallPlanDeps } from "./install-plan.js";
import { detectBypass } from "./detect-bypass.js";

const C_ACCOUNT = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const C_BLEND = toContractId(StrKey.encodeContract(Buffer.alloc(32, 2)));
const C_USDC = toContractId(StrKey.encodeContract(Buffer.alloc(32, 3)));
const C_POL_A = toContractId(StrKey.encodeContract(Buffer.alloc(32, 8)));
const C_POL_B = toContractId(StrKey.encodeContract(Buffer.alloc(32, 9)));
const G_AGENT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
const G_OWNER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5));

// Real (decodable) install-params bytes.
const realEncode = (_c: PolicyClassification, _p: Record<string, unknown>): XdrBase64 =>
  toXdrBase64(xdr.ScVal.scvVoid().toXDR("base64"));

function tier1Ruleset(): CandidateRuleset {
  const intent = PolicyIntent.parse({
    schema_version: "1",
    network: "testnet",
    account: C_ACCOUNT,
    grantee: { signer: { type: "delegated", address: G_AGENT }, label: "agent" },
    targets: [{ contract: C_BLEND, functions: [{ name: "claim", arg_constraints: [] }], provenance: { kind: "user_intent", quote: "blend" } }],
    budgets: [{ token: C_USDC, cap: "500", decimals: 7, window: { ledgers: 17280 }, scope: "outflow_via_transfer", provenance: { kind: "user_intent", quote: "500/day" } }],
    expiry: { ledgers: 120960 },
    preserve: [0],
    explicit_denies: [],
    clarifications_resolved: [],
  });
  const rs = synthesizeRuleset({ intent, intentHash: "deadbeef" }, { currentLedger: 1000 });
  return matchPolicies(rs, { encodeInstallParams: realEncode }).ruleset;
}

function snapshot(): AccountSnapshot {
  return AccountSnapshot.parse({
    schema_version: "1",
    network: "testnet",
    account: C_ACCOUNT,
    ledger: 1000,
    taken_at: "2026-07-05T00:00:00.000Z",
    account_wasm_hash: "aa".repeat(32),
    rules: [
      {
        id: 0,
        name: "owner",
        context_type: { kind: "default" },
        signers: [{ signer: { type: "delegated", address: G_OWNER }, canonical_hash: "bb".repeat(32) }],
        policies: [],
        privilege: "admin-equivalent",
        status: "active",
      },
    ],
    next_rule_id: 1,
    rule_count: 1,
    signer_registry: [{ signer: { type: "delegated", address: G_OWNER }, canonical_hash: "bb".repeat(32) }],
    policy_registry: [],
    admin_paths: [0],
    recovery_paths: [0],
    warnings: [],
    snapshot_hash: "cc".repeat(32),
  });
}

const reports = (rulesetHash: string, verdict: "all_green" | "failures" = "all_green"): {
  sim: SimulationReport;
  bypass: BypassReport;
  risk: RiskReport;
} => ({
  sim: {
    schema_version: "1",
    ruleset_hash: rulesetHash,
    engine_runs: [],
    coverage: { constraints_exercised: [], constraints_total: 0 },
    verdict,
    artifacts_dir: "x",
    report_hash: "0".repeat(64),
  },
  bypass: {
    schema_version: "1",
    snapshot_hash: "cc".repeat(32),
    ruleset_hash: rulesetHash,
    threat_model: { grantee_signers: [], extra_compromised: 0 },
    findings: [],
    exhaustive: true,
    report_hash: "0".repeat(64),
  },
  risk: {
    schema_version: "1",
    ruleset_hash: rulesetHash,
    residual_risks: [],
    limitations: [],
    unknown_policies: [],
    bypass_summary: { safe: 0, bypass: 0, unknown: 0 },
    irreversibility_notes: [],
    expiry_summary: "x",
    revocation_summary: "x",
    report_hash: "0".repeat(64),
  },
});

const deps: InstallPlanDeps = {
  simulateStep: () => Promise.resolve({ fee_stroops: "1500", footprint_hash: "fp", at_ledger: 1000 }),
  entropy: () => "APPROVE-TOKEN-123",
  currentLedger: 1000,
};

const addresses = { "0:0": C_POL_A, "1:0": C_POL_B };

describe("prepareInstallPlan (E1)", () => {
  it("builds add_context_rule steps + paired revocation, gated on green reports", async () => {
    const rs = tier1Ruleset();
    const r = reports(rs.ruleset_hash);
    const { plan, approvalToken } = await prepareInstallPlan(
      { ruleset: rs, accountSnapshot: snapshot(), simulationReport: r.sim, bypassReport: r.bypass, riskReport: r.risk, policyAddresses: addresses },
      deps,
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.every((s) => s.invoke?.fn === "add_context_rule")).toBe(true);
    expect(plan.plan_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.revocation_plan.steps).toHaveLength(2);
    expect(plan.revocation_plan.steps[0]?.invoke?.fn).toBe("update_context_rule_valid_until");
    // Token value is NOT embedded in the plan (INV-Plan-3).
    expect(JSON.stringify(plan)).not.toContain(approvalToken);
    expect(plan.approval_token_ref).toMatch(/^plan-/);
  });

  it("plan_hash excludes volatile fee/footprint (EC-M03)", async () => {
    const rs = tier1Ruleset();
    const r = reports(rs.ruleset_hash);
    const base = { ruleset: rs, accountSnapshot: snapshot(), simulationReport: r.sim, bypassReport: r.bypass, riskReport: r.risk, policyAddresses: addresses };
    const p1 = await prepareInstallPlan(base, deps);
    const p2 = await prepareInstallPlan(base, { ...deps, simulateStep: () => Promise.resolve({ fee_stroops: "99999", footprint_hash: "different", at_ledger: 1000 }) });
    expect(p1.plan.plan_hash).toBe(p2.plan.plan_hash);
  });

  it("refuses stale artifacts (EC-T03)", async () => {
    const rs = tier1Ruleset();
    const r = reports("wronghash");
    await expect(
      prepareInstallPlan({ ruleset: rs, accountSnapshot: snapshot(), simulationReport: r.sim, bypassReport: r.bypass, riskReport: r.risk, policyAddresses: addresses }, deps),
    ).rejects.toMatchObject({ code: "E_GATE_STALE_ARTIFACTS" });
  });

  it("refuses a non-green simulation (INV-Test-3)", async () => {
    const rs = tier1Ruleset();
    const r = reports(rs.ruleset_hash, "failures");
    await expect(
      prepareInstallPlan({ ruleset: rs, accountSnapshot: snapshot(), simulationReport: r.sim, bypassReport: r.bypass, riskReport: r.risk, policyAddresses: addresses }, deps),
    ).rejects.toMatchObject({ code: "E_BUILD_SIMULATION_FAILED" });
  });

  it("refuses an unhandled BYPASS (INV-Bypass-2)", async () => {
    const rs = tier1Ruleset();
    const r = reports(rs.ruleset_hash);
    r.bypass.findings.push({
      rule_id: 7,
      context: { kind: "default" },
      verdict: "BYPASS",
      reasoning: { policy_semantics: "none", threat_keys: 0 },
      recommendation: { kind: "remove_rule", rule_id: 7 },
    });
    await expect(
      prepareInstallPlan({ ruleset: rs, accountSnapshot: snapshot(), simulationReport: r.sim, bypassReport: r.bypass, riskReport: r.risk, policyAddresses: addresses }, deps),
    ).rejects.toMatchObject({ code: "E_DOMAIN_BYPASS_UNHANDLED" });
  });

  it("orders handled bypass expiry after new rule installs", async () => {
    const rs = tier1Ruleset();
    rs.updates.push({ rule_id: 7, set_valid_until: 1000 });
    const r = reports(rs.ruleset_hash);
    r.bypass.findings.push({
      rule_id: 7,
      context: { kind: "default" },
      verdict: "BYPASS",
      reasoning: { policy_semantics: "none", threat_keys: 1 },
      recommendation: { kind: "expire_rule", rule_id: 7, at: 1000 },
    });
    const { plan } = await prepareInstallPlan(
      { ruleset: rs, accountSnapshot: snapshot(), simulationReport: r.sim, bypassReport: r.bypass, riskReport: r.risk, policyAddresses: addresses },
      deps,
    );
    expect(plan.steps.map((s) => s.invoke?.fn)).toEqual([
      "add_context_rule",
      "add_context_rule",
      "update_context_rule_valid_until",
    ]);
  });
});

describe("detectBypass (D4)", () => {
  it("flags a planted permissive Default rule for the grantee", () => {
    const rs = tier1Ruleset();
    const snap = snapshot();
    snap.rules.push({
      id: 7,
      name: "old-agent",
      context_type: { kind: "default" },
      signers: [{ signer: { type: "delegated", address: G_AGENT }, canonical_hash: "dd".repeat(32) }],
      policies: [],
      privilege: "admin-equivalent",
      status: "active",
    });
    const report = detectBypass({ ruleset: rs, accountSnapshot: snap });
    const planted = report.findings.find((f) => f.rule_id === 7 && f.verdict === "BYPASS");
    expect(planted?.path).toContain("Default");
    expect(planted?.recommendation.kind).toBe("expire_rule");
    expect(report.exhaustive).toBe(true);
  });

  it("never marks unknown policies SAFE", () => {
    const rs = tier1Ruleset();
    const snap = snapshot();
    snap.rules.push({
      id: 8,
      name: "unknown",
      context_type: { kind: "call_contract", address: C_BLEND },
      signers: [{ signer: { type: "delegated", address: G_AGENT }, canonical_hash: "ee".repeat(32) }],
      policies: [{ address: C_POL_A, classification: "unknown" }],
      privilege: "scoped",
      status: "active",
    });
    const report = detectBypass({ ruleset: rs, accountSnapshot: snap });
    expect(report.findings.find((f) => f.rule_id === 8)?.verdict).toBe("UNKNOWN");
  });
});

describe("explainPolicy (E3)", () => {
  it("renders plain English + a derived risk report with limitations", () => {
    const rs = tier1Ruleset();
    const { markdown, riskReport } = explainPolicy({ ruleset: rs, nowLedger: 1000, accountSnapshot: snapshot() });
    expect(markdown).toContain(C_BLEND);
    expect(markdown).toContain("Expires at ledger 121960");
    expect(markdown).toContain("## Policy diff");
    // spending_limit dual-budget / zero-amount limitations surface as info risks.
    expect(riskReport.limitations.some((l) => l.code.startsWith("spending_limit"))).toBe(true);
    expect(riskReport.residual_risks.some((r) => r.severity === "info")).toBe(true);
    expect(riskReport.report_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("runSimulation (D3)", () => {
  const fakeEngine = (outcome: "pass" | "fail"): SimulationEngine => ({
    engine: "unit",
    toolchainFingerprint: "fake",
    run: (cases: TestCase[]) => Promise.resolve(cases.map((c) => ({ case_id: c.id, outcome }))),
  });
  const oneCase: TestCase[] = [
    {
      id: "t:0",
      kind: "allow",
      origin: { kind: "observed", provenance: { kind: "default", rule: "x" } },
      context: { contract: C_BLEND, fn_name: "claim", args_scval_b64: [] },
      signer_set: [],
      ledger_offset: 0,
      expected: { kind: "pass" },
    },
  ];

  it("verdict all_green when every case passes", async () => {
    const rs = tier1Ruleset();
    const rep = await runSimulation({ ruleset: rs, cases: oneCase, engines: [fakeEngine("pass")] });
    expect(rep.verdict).toBe("all_green");
  });

  it("verdict failures when a case fails", async () => {
    const rs = tier1Ruleset();
    const rep = await runSimulation({ ruleset: rs, cases: oneCase, engines: [fakeEngine("fail")] });
    expect(rep.verdict).toBe("failures");
  });
});
