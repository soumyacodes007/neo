/**
 * A1.5 — policy install-state reads (Vol 04 FN-A1.5). For a classified policy,
 * call its read-only getter via `simulateTransaction` and shape the result per
 * Vol 02 §2.1 so A1/A2 show live config (thresholds, limits, allowlists). State
 * is keyed `(smart_account, context_rule_id)`, so this is read per rule×policy.
 * A failed/archived read yields `undefined` (surfaced as absent + warning, not an
 * error, EC-P03) — never a fabricated value.
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import type { ContractId, PolicyClassification, ScValJson } from "@ozpb/core";
import { toScValJson } from "../scval.js";

/** Read one contract function via simulation; returns the result ScVal or null. */
export type SimulateReadFn = (
  contract: ContractId,
  fnName: string,
  args: xdr.ScVal[],
) => Promise<xdr.ScVal | null>;

const GETTER: Partial<Record<PolicyClassification, string>> = {
  "oz:spending_limit": "get_spending_limit_data",
  "oz:simple_threshold": "get_threshold",
  "oz:weighted_threshold": "get_threshold",
  "pb:function_allowlist": "get_allowlist",
  "pb:call_cap": "get_call_cap_data",
  "pb:rate_limit": "get_rate_limit_data",
  "pb:arg_guard": "get_arg_rules",
};

export async function readInstallState(
  classification: PolicyClassification,
  policyAddress: ContractId,
  ruleId: number,
  account: ContractId,
  simulate: SimulateReadFn,
): Promise<unknown> {
  const getter = GETTER[classification];
  if (getter === undefined) return undefined; // generated/unknown → no read
  const args = [xdr.ScVal.scvU32(ruleId), Address.fromString(account).toScVal()];
  const result = await simulate(policyAddress, getter, args);
  if (result === null) return undefined; // archived / not installed
  const json = toScValJson(result);
  return shape(classification, json);
}

function shape(classification: PolicyClassification, json: ScValJson): unknown {
  switch (classification) {
    case "oz:spending_limit":
      return {
        spending_limit: num(field(json, "spending_limit")),
        period_ledgers: num(field(json, "period_ledgers")),
        cached_total_spent: num(field(json, "cached_total_spent")),
        history_len: len(field(json, "spending_history")),
      };
    case "oz:simple_threshold":
    case "oz:weighted_threshold":
      return { threshold: num(json) };
    case "pb:function_allowlist":
      return { functions: symbols(json) };
    case "pb:call_cap":
      return {
        cap: num(field(json, "cap")),
        period_ledgers: num(field(json, "period_ledgers")),
        cached_total: num(field(json, "cached_total")),
        history_len: len(field(json, "history")),
      };
    case "pb:rate_limit":
      return {
        max_calls: num(nested(json, "params", "max_calls")),
        period_ledgers: num(nested(json, "params", "period_ledgers")),
        calls_len: len(field(json, "calls")),
      };
    case "pb:arg_guard":
      return { rules_len: len(field(json, "rules")) };
    default:
      return undefined;
  }
}

// --- ScValJson field helpers ------------------------------------------------

interface MapEntry {
  key: ScValJson;
  val: ScValJson;
}
function isMapEntry(x: unknown): x is MapEntry {
  return typeof x === "object" && x !== null && "key" in x && "val" in x;
}
function field(node: ScValJson | undefined, name: string): ScValJson | undefined {
  if (node === undefined || !Array.isArray(node.value)) return undefined;
  for (const e of node.value as unknown[]) {
    if (isMapEntry(e) && e.key.type === "scvSymbol" && e.key.value === name) return e.val;
  }
  return undefined;
}
function nested(node: ScValJson, a: string, b: string): ScValJson | undefined {
  const inner = field(node, a);
  return inner === undefined ? undefined : field(inner, b);
}
function num(node: ScValJson | undefined): string | undefined {
  if (node === undefined) return undefined;
  return typeof node.value === "number" ? String(node.value) : typeof node.value === "string" ? node.value : undefined;
}
function len(node: ScValJson | undefined): number | undefined {
  return node !== undefined && Array.isArray(node.value) ? node.value.length : undefined;
}
function symbols(node: ScValJson | undefined): string[] {
  if (node === undefined || !Array.isArray(node.value)) return [];
  return (node.value as ScValJson[]).filter((v) => v.type === "scvSymbol").map((v) => String(v.value));
}
