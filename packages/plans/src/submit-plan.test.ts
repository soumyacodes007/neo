import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { toContractId, toLedgerSeq, toXdrBase64, type InstallPlan, type PlanStep } from "@ozpb/core";
import { computePlanHash } from "./install-plan.js";
import { submitPlan, type SubmitDeps } from "./submit-plan.js";

const C = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const TOKEN = "APPROVE-abc123";

function step(order: number, reversible = true): PlanStep {
  return {
    order,
    kind: "invoke",
    description: `step ${String(order)}`,
    tx_xdr_unsigned: toXdrBase64("AAAAAA=="),
    invoke: { contract: C, fn: "add_context_rule", args_scval_b64: [] },
    auth_requirements: [],
    simulated: { fee_stroops: "1", footprint_hash: "fp", at_ledger: toLedgerSeq(1000) },
    reversible,
  };
}

function makePlan(steps: PlanStep[] = [step(1), step(2)]): InstallPlan {
  const depends_on = {
    snapshot_hash: "aa".repeat(32),
    ruleset_hash: "bb".repeat(32),
    simulation_report_hash: "cc".repeat(32),
    bypass_report_hash: "dd".repeat(32),
    risk_report_hash: "ee".repeat(32),
  };
  const pre_state = { rules_snapshot: [] };
  const plan_hash = computePlanHash({ steps, depends_on, pre_state });
  return {
    schema_version: "1",
    network: "testnet",
    account: C,
    plan_hash,
    approval_token_ref: "plan-x.txt",
    steps,
    depends_on,
    pre_state,
    revocation_plan: { steps: [], summary: "revoke" },
    expires_at_ledger: toLedgerSeq(2000),
  };
}

function makeDeps(plan: InstallPlan, over: Partial<SubmitDeps> = {}): { deps: SubmitDeps; submit: ReturnType<typeof vi.fn> } {
  const submit = vi.fn(async (_xdr: string, _t: "direct" | "relayer") => ({ tx_hash: "d".repeat(64) }));
  const deps: SubmitDeps = {
    enableSubmit: true,
    loadPlan: (h) => (h === plan.plan_hash ? plan : null),
    readApprovalToken: () => TOKEN,
    currentLedger: 1500,
    network: "testnet",
    accountWasmHashMatches: () => true,
    submit,
    ...over,
  };
  return { deps, submit };
}

function signed(plan: InstallPlan): { order: number; signed_xdr: string }[] {
  return plan.steps.map((s) => ({ order: s.order, signed_xdr: `signed-${String(s.order)}` }));
}

describe("submitPlan (F1)", () => {
  it("installs each step when all gates pass", async () => {
    const plan = makePlan();
    const { deps, submit } = makeDeps(plan);
    const out = await submitPlan(
      { plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" },
      deps,
    );
    expect(out.results.map((r) => r.status)).toEqual(["submitted", "submitted"]);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("disabled → refuses before any side effect", async () => {
    const plan = makePlan();
    const { deps, submit } = makeDeps(plan, { enableSubmit: false });
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_GATE_SUBMIT_DISABLED" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("wrong token → E_GATE_TOKEN_MISMATCH (constant-time)", async () => {
    const plan = makePlan();
    const { deps, submit } = makeDeps(plan);
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: "WRONG", signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_GATE_TOKEN_MISMATCH" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("tampered plan (hash mismatch) → E_GATE_STALE_ARTIFACTS", async () => {
    const plan = makePlan();
    // Mutate a step AFTER the hash was computed → recompute won't match.
    const tampered: InstallPlan = { ...plan, steps: [{ ...plan.steps[0]!, tx_xdr_unsigned: toXdrBase64("ZZZZ") }, plan.steps[1]!] };
    const { deps } = makeDeps(tampered);
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_GATE_STALE_ARTIFACTS" });
  });

  it("expired plan → E_GATE_PLAN_EXPIRED", async () => {
    const plan = makePlan();
    const { deps } = makeDeps(plan, { currentLedger: 9999 });
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_GATE_PLAN_EXPIRED" });
  });

  it("network mismatch → E_INPUT_NETWORK_MISMATCH", async () => {
    const plan = makePlan();
    const { deps } = makeDeps(plan, { network: "mainnet" });
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_INPUT_NETWORK_MISMATCH" });
  });

  it("account upgraded since snapshot → E_GATE_STALE_ARTIFACTS", async () => {
    const plan = makePlan();
    const { deps } = makeDeps(plan, { accountWasmHashMatches: () => false });
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_GATE_STALE_ARTIFACTS" });
  });

  it("resumable: an already-applied step is skipped, not re-submitted", async () => {
    const plan = makePlan();
    const { deps, submit } = makeDeps(plan, { isStepApplied: (s) => s.order === 1 });
    const out = await submitPlan(
      { plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" },
      deps,
    );
    expect(out.results[0]).toMatchObject({ order: 1, status: "skipped" });
    expect(out.results[1]).toMatchObject({ order: 2, status: "submitted" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("irreversible step requires a confirmation phrase", async () => {
    const plan = makePlan([step(1, false)]);
    const { deps } = makeDeps(plan, { confirmationPhrase: "I UNDERSTAND" });
    await expect(
      submitPlan({ plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct" }, deps),
    ).rejects.toMatchObject({ code: "E_INPUT_SCHEMA" });
    // With the phrase it proceeds.
    const ok = await submitPlan(
      { plan_hash: plan.plan_hash, approval_token: TOKEN, signed_steps: signed(plan), transport: "direct", confirmation_phrase: "I UNDERSTAND" },
      deps,
    );
    expect(ok.results[0]?.status).toBe("submitted");
  });
});
