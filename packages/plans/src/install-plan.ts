/**
 * E1 — `prepare-install-plan` (Vol 09 §1). Turns a verified ruleset into ordered,
 * UNSIGNED transactions. It refuses to build unless the verification artifacts are
 * fresh and hash-matched, the simulation is `all_green` (INV-Test-3), and every
 * BYPASS finding is handled (INV-Bypass-2) — this is why "just give me the tx"
 * cannot skip the tests (EC-U06). The approval token is generated here and written
 * only to the human-facing plan file; the schema carries a filename reference,
 * never the value (INV-Plan-3).
 */
import {
  ToolError,
  canonicalHash,
  toLedgerSeq,
  type AccountSnapshot,
  type BypassReport,
  type CandidateRuleset,
  type ContractId,
  type InstallPlan,
  type JsonValue,
  type PlanStep,
  type RiskReport,
  type SimulationReport,
  type XdrBase64,
} from "@ozpb/core";
import { toXdrBase64 } from "@ozpb/core";
import { buildUnsignedInvoke, encodeAddContextRuleArgs, type PolicyMapEntry } from "@ozpb/stellar";
import { xdr } from "@stellar/stellar-sdk";
import { buildRevocationPlan } from "./revocation-plan.js";

const DIGEST_NOTE = "sign sha256(signature_payload || context_rule_ids.to_xdr()) — see Vol 03 §digest" as const;
const PLAN_TTL_LEDGERS = 17280;

export interface SimulatedFields {
  fee_stroops: string;
  footprint_hash: string;
  at_ledger: number;
}

export interface InstallPlanDeps {
  /** Simulate a step to derive fee/footprint (RPC simulateTransaction). Injected. */
  simulateStep: (envelopeXdr: string) => Promise<SimulatedFields>;
  /** High-entropy approval token generator (injected; never Math.random in core). */
  entropy: () => string;
  currentLedger: number;
}

export interface InstallPlanInput {
  ruleset: CandidateRuleset;
  accountSnapshot: AccountSnapshot;
  simulationReport: SimulationReport;
  bypassReport: BypassReport;
  riskReport: RiskReport;
  /** Resolved deployed policy addresses, keyed by `${ruleIndex}:${bindingIndex}`. */
  policyAddresses?: Record<string, ContractId>;
}

export interface PreparedPlan {
  plan: InstallPlan;
  /** The token value — the caller writes it to the plan file; it is NOT in `plan`. */
  approvalToken: string;
}

export async function prepareInstallPlan(input: InstallPlanInput, deps: InstallPlanDeps): Promise<PreparedPlan> {
  gate(input);

  const account = input.ruleset.account;
  const steps: PlanStep[] = [];
  let order = 1;
  for (let i = 0; i < input.ruleset.rules.length; i++) {
    const rule = input.ruleset.rules[i]!;
    const policies = resolvePolicyEntries(i, rule, input.policyAddresses ?? {});
    const args = encodeAddContextRuleArgs({
      contextType: rule.context_type,
      name: rule.name,
      validUntil: rule.valid_until_ledger,
      signers: rule.signers,
      policies,
    });
    const { envelopeXdr } = buildUnsignedInvoke(account, "add_context_rule", args, input.ruleset.network);
    const sim = await deps.simulateStep(envelopeXdr);
    steps.push({
      order: order++,
      kind: "invoke",
      description: `Add context rule "${rule.name}" scoped to ${describeContext(rule)}`,
      tx_xdr_unsigned: toXdrBase64(envelopeXdr),
      invoke: { contract: account, fn: "add_context_rule", args_scval_b64: args.map((a) => toXdrBase64(a.toXDR("base64"))) },
      auth_requirements: [ownerAuth(input.accountSnapshot)],
      simulated: { fee_stroops: sim.fee_stroops, footprint_hash: sim.footprint_hash, at_ledger: toLedgerSeq(sim.at_ledger) },
      reversible: true,
    });
  }

  // Phase 5 ordering law: old permissive rules are removed/expired only after
  // the new scoped grant is live, preserving continuity while closing bypasses.
  for (const update of [...input.ruleset.updates].sort((a, b) => a.rule_id - b.rule_id)) {
    const args = [xdr.ScVal.scvU32(update.rule_id), xdr.ScVal.scvU32(update.set_valid_until)];
    const { envelopeXdr } = buildUnsignedInvoke(account, "update_context_rule_valid_until", args, input.ruleset.network);
    const sim = await deps.simulateStep(envelopeXdr);
    steps.push({
      order: order++,
      kind: "invoke",
      description: `Expire old bypass rule ${String(update.rule_id)} at ledger ${String(update.set_valid_until)}`,
      tx_xdr_unsigned: toXdrBase64(envelopeXdr),
      invoke: { contract: account, fn: "update_context_rule_valid_until", args_scval_b64: args.map((a) => toXdrBase64(a.toXDR("base64"))) },
      auth_requirements: [ownerAuth(input.accountSnapshot)],
      simulated: { fee_stroops: sim.fee_stroops, footprint_hash: sim.footprint_hash, at_ledger: toLedgerSeq(sim.at_ledger) },
      reversible: false,
      irreversibility_note: "old permissive rule expiry is intentionally one-way in this plan; restore from pre_state if needed",
    });
  }

  for (const removal of [...input.ruleset.removals].sort((a, b) => a.rule_id - b.rule_id)) {
    const args = [xdr.ScVal.scvU32(removal.rule_id)];
    const { envelopeXdr } = buildUnsignedInvoke(account, "remove_context_rule", args, input.ruleset.network);
    const sim = await deps.simulateStep(envelopeXdr);
    steps.push({
      order: order++,
      kind: "invoke",
      description: `Remove old bypass rule ${String(removal.rule_id)}: ${removal.reason}`,
      tx_xdr_unsigned: toXdrBase64(envelopeXdr),
      invoke: { contract: account, fn: "remove_context_rule", args_scval_b64: args.map((a) => toXdrBase64(a.toXDR("base64"))) },
      auth_requirements: [ownerAuth(input.accountSnapshot)],
      simulated: { fee_stroops: sim.fee_stroops, footprint_hash: sim.footprint_hash, at_ledger: toLedgerSeq(sim.at_ledger) },
      reversible: false,
      irreversibility_note: "rule removal is restorable only from the embedded pre_state snapshot",
    });
  }

  const approvalToken = deps.entropy();
  const expires_at_ledger = toLedgerSeq(deps.currentLedger + PLAN_TTL_LEDGERS);
  const depends_on = {
    snapshot_hash: input.accountSnapshot.snapshot_hash,
    ruleset_hash: input.ruleset.ruleset_hash,
    simulation_report_hash: input.simulationReport.report_hash,
    bypass_report_hash: input.bypassReport.report_hash,
    risk_report_hash: input.riskReport.report_hash,
  };
  const pre_state = { rules_snapshot: input.accountSnapshot.rules };
  const revocation_plan = buildRevocationPlan({ ruleset: input.ruleset, accountSnapshot: input.accountSnapshot });

  // plan_hash excludes the volatile `simulated` resource fields (EC-M03).
  const hashInput = {
    steps: steps.map((s) => ({ order: s.order, kind: s.kind, tx_xdr_unsigned: s.tx_xdr_unsigned, invoke: s.invoke ?? null })),
    depends_on,
    pre_state,
  };
  const plan_hash = canonicalHash(hashInput as unknown as JsonValue);

  const plan: InstallPlan = {
    schema_version: "1",
    network: input.ruleset.network,
    account,
    plan_hash,
    approval_token_ref: `plan-${plan_hash.slice(0, 12)}.txt`,
    steps,
    depends_on,
    pre_state,
    revocation_plan,
    expires_at_ledger,
  };
  return { plan, approvalToken };
}

/** Refuse to build without fresh, hash-matched, green verification (EC-T03/U06). */
function gate(input: InstallPlanInput): void {
  const rh = input.ruleset.ruleset_hash;
  if (input.simulationReport.ruleset_hash !== rh || input.bypassReport.ruleset_hash !== rh || input.riskReport.ruleset_hash !== rh) {
    throw new ToolError("E_GATE_STALE_ARTIFACTS", "verification artifacts do not match the ruleset hash", {
      details: { ruleset_hash: rh },
    });
  }
  if (input.simulationReport.verdict !== "all_green") {
    throw new ToolError("E_BUILD_SIMULATION_FAILED", "simulation is not all_green (INV-Test-3)");
  }
  const handled = new Set([
    ...input.ruleset.removals.map((r) => r.rule_id),
    ...input.ruleset.updates.map((u) => u.rule_id),
  ]);
  const unhandled = input.bypassReport.findings.filter((f) => f.verdict === "BYPASS" && !handled.has(f.rule_id));
  if (unhandled.length > 0) {
    throw new ToolError("E_DOMAIN_BYPASS_UNHANDLED", "a BYPASS finding is neither removed nor expired (INV-Bypass-2)", {
      details: { rule_ids: unhandled.map((f) => f.rule_id) },
    });
  }
}

function resolvePolicyEntries(
  ruleIndex: number,
  rule: CandidateRuleset["rules"][number],
  addresses: Record<string, ContractId>,
): PolicyMapEntry[] {
  const out: PolicyMapEntry[] = [];
  rule.policy_bindings.forEach((b, bi) => {
    if (b.binding.kind === "none_needed") return;
    const addr = b.binding.kind === "existing" ? b.binding.address ?? addresses[`${String(ruleIndex)}:${String(bi)}`] : addresses[`${String(ruleIndex)}:${String(bi)}`];
    if (addr === undefined) {
      throw new ToolError("E_GATE_STALE_ARTIFACTS", `no deployed address for policy binding ${String(ruleIndex)}:${String(bi)}`, {
        suggestion: "deploy the policy (or provide a known deployment) before planning",
      });
    }
    const installParams: XdrBase64 = b.binding.kind === "existing" ? b.binding.install_params_scval_b64 : toXdrBase64("AAAAAA==");
    out.push({ address: addr, installParams });
  });
  return out;
}

function ownerAuth(snapshot: AccountSnapshot): InstallPlan["steps"][number]["auth_requirements"][number] {
  const ownerRuleId = snapshot.admin_paths[0] ?? 0;
  const ownerRule = snapshot.rules.find((r) => r.id === ownerRuleId);
  return {
    rule_id: ownerRuleId,
    signers: (ownerRule?.signers ?? []).map((s) => s.signer),
    digest_note: DIGEST_NOTE,
  };
}

function describeContext(rule: CandidateRuleset["rules"][number]): string {
  return rule.context_type.kind === "call_contract" ? rule.context_type.address : rule.context_type.kind;
}
