/**
 * E2 — `prepare-revocation-plan` (Vol 09 §2). Always produced alongside E1. For
 * each rule the install plan ADDS, emit the inverse: preferred instant self-expiry
 * (`update_context_rule_valid_until(id, now)`), plus a full `remove_context_rule(id)`
 * option. Because new rules are appended at `next_rule_id`, the revocation targets
 * those forthcoming ids. The owner/admin rule can always remove any rule
 * (self-administration [code]) — the break-glass path.
 */
import {
  toLedgerSeq,
  toXdrBase64,
  type AccountSnapshot,
  type CandidateRuleset,
  type PlanStep,
  type RevocationPlan,
} from "@ozpb/core";
import { buildUnsignedInvoke } from "@ozpb/stellar";
import { xdr } from "@stellar/stellar-sdk";

export interface RevocationInput {
  ruleset: CandidateRuleset;
  accountSnapshot: AccountSnapshot;
}

export function buildRevocationPlan(input: RevocationInput): RevocationPlan {
  const account = input.ruleset.account;
  const steps: PlanStep[] = [];
  let order = 1;
  // Newly-added rules will occupy ids starting at next_rule_id (append-only [code]).
  let nextId = input.accountSnapshot.next_rule_id;
  for (const rule of input.ruleset.rules) {
    const ruleId = nextId++;
    const expireArgs = [xdr.ScVal.scvU32(ruleId), xdr.ScVal.scvU32(input.accountSnapshot.ledger)];
    const { envelopeXdr } = buildUnsignedInvoke(account, "update_context_rule_valid_until", expireArgs, input.ruleset.network);
    steps.push({
      order: order++,
      kind: "invoke",
      description: `Expire rule "${rule.name}" (id ${String(ruleId)}) immediately`,
      tx_xdr_unsigned: toXdrBase64(envelopeXdr),
      invoke: { contract: account, fn: "update_context_rule_valid_until", args_scval_b64: expireArgs.map((a) => toXdrBase64(a.toXDR("base64"))) },
      auth_requirements: [
        {
          rule_id: input.accountSnapshot.admin_paths[0] ?? 0,
          signers: [],
          digest_note: "sign sha256(signature_payload || context_rule_ids.to_xdr()) — see Vol 03 §digest",
        },
      ],
      simulated: { fee_stroops: "0", footprint_hash: "", at_ledger: toLedgerSeq(input.accountSnapshot.ledger) },
      reversible: false,
      irreversibility_note: "revocation is intentionally one-way; re-grant by re-running the install flow",
    });
  }
  return {
    steps,
    summary: `Revocation expires all ${String(input.ruleset.rules.length)} added rule(s) immediately; the owner rule can also remove them (break-glass).`,
  };
}
