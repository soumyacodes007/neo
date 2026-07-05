/**
 * A2 — `inspect-rule` (Vol 04). One context rule in depth: members, expiry in
 * ledgers + approximate wall-clock, and dormancy. Threshold/spending health
 * requires policy install-state reads (simulated getter calls) — a Phase-4
 * capability; until then `health` reports dormancy and notes the gap (EC-A07).
 */
import { ToolError, type ContextRuleModel } from "@ozpb/core";
import { inspectAccount, type InspectDeps } from "./inspect-account.js";

const LEDGERS_PER_DAY = 17280; // ~5s/ledger

export interface RuleHealth {
  dormant: boolean;
  note?: string;
  expires_at_approx?: string;
}

export interface InspectRuleInput {
  account: string;
  rule_id: number;
}

export async function inspectRule(
  input: InspectRuleInput,
  deps: InspectDeps,
): Promise<{ rule: ContextRuleModel; health: RuleHealth }> {
  const snapshot = await inspectAccount({ account: input.account }, deps);
  const rule = snapshot.rules.find((r) => r.id === input.rule_id);
  if (rule === undefined) {
    throw new ToolError("E_RULE_NOT_FOUND", `rule ${String(input.rule_id)} not found on ${input.account}`, {
      details: { rule_id: input.rule_id },
    });
  }
  const dormant = rule.status === "expired";
  const health: RuleHealth = {
    dormant,
    ...(rule.policies.length > 0
      ? { note: "policy install-state (thresholds/limits) not read; use inspect with resolve_policy_state (Phase 4)" }
      : {}),
    ...(rule.valid_until_ledger !== undefined
      ? { expires_at_approx: approxExpiry(rule.valid_until_ledger, snapshot.ledger, deps.now()) }
      : {}),
  };
  return { rule, health };
}

/** Human "~" wall-clock estimate from a ledger delta (EC-U05: always approximate). */
function approxExpiry(validUntil: number, currentLedger: number, nowIso: string): string {
  const deltaLedgers = validUntil - currentLedger;
  const deltaMs = (deltaLedgers / LEDGERS_PER_DAY) * 24 * 60 * 60 * 1000;
  return `~${new Date(new Date(nowIso).getTime() + deltaMs).toISOString()}`;
}
