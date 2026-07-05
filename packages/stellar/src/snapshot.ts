/**
 * Fork-snapshot address-set builder (Vol 03 §7, FN-ST.23).
 *
 * Pure: computes which addresses a fork test must include (account, targets,
 * tokens, policies, verifiers). The actual `stellar snapshot create` (FN-ST.24)
 * runs host-side in the sandbox package; this module only decides the set so a
 * fork never fails on an incomplete footprint (EC-M02).
 */
import type { ContractId } from "@ozpb/core";

export interface SnapshotEvidence {
  /** Contract addresses seen in trace invocations. */
  invocationContracts?: ContractId[];
  /** Token contracts seen in token deltas. */
  tokens?: ContractId[];
  /** Target contracts / tokens / policies from a candidate ruleset. */
  ruleTargets?: ContractId[];
  policies?: ContractId[];
  /** Verifier contracts referenced by external signers. */
  verifiers?: ContractId[];
}

/**
 * FN-ST.23 — union every address a fork must materialize, deduped and sorted
 * (deterministic, Vol 01 §2.6).
 */
export function deriveSnapshotAddressSet(account: ContractId, evidence: SnapshotEvidence): ContractId[] {
  const set = new Set<ContractId>([account]);
  for (const group of [
    evidence.invocationContracts,
    evidence.tokens,
    evidence.ruleTargets,
    evidence.policies,
    evidence.verifiers,
  ]) {
    for (const addr of group ?? []) set.add(addr);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
