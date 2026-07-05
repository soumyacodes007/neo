/**
 * C1 — `synthesize-ruleset` (Vol 06 §2). Pure + deterministic: identical inputs
 * yield a byte-identical `ruleset_hash` (parent acceptance #4).
 *
 * This implements the intent-guided path (Tier 1): one `call_contract` rule per
 * distinct target/token (never `Default`, INV-CR-2/L4), a `func_allowlist` per
 * target (L3), an `amount_cap` per budget, and a mandatory `expiry` per rule
 * (minimality (d)). Evidence-guided closure and example-driven separation
 * (FN-C1.3) are later phases; the generalization lattice for arg predicates is
 * applied when evidence/values are supplied via `deps.encodeArgValue`.
 */
import { amountFitsI128, toLedgerSeq } from "../primitives.js";
import { ToolError } from "../errors.js";
import { canonicalHash, type JsonValue } from "../canonical.js";
import type { PolicyIntent } from "../schemas/policy-intent.js";
import type { Constraint, CandidateRule, CandidateRuleset } from "../schemas/constraint.js";
import type { Provenance } from "../schemas/common.js";
import type { ContractId, LedgerSeq } from "../primitives.js";
import type { SignerModel } from "../schemas/signer.js";

export interface SynthesizeDeps {
  /** Current ledger; `valid_until = currentLedger + intent.expiry.ledgers`. */
  currentLedger: number;
}

export interface SynthesizeInput {
  intent: PolicyIntent;
  intentHash: string;
  snapshotHash?: string;
}

interface RuleAccum {
  contract: ContractId;
  name: string;
  constraints: Constraint[];
  seq: number;
}

const EXPIRY_PROV: Provenance = { kind: "default", rule: "expiry-required-default" };

export function synthesizeRuleset(input: SynthesizeInput, deps: SynthesizeDeps): CandidateRuleset {
  const { intent } = input;
  if (intent.allow_default_context) {
    // INV-CR-2 / EC-S01: Default scope only via the double-confirm override, which
    // rewrites intent elsewhere; a raw allow_default_context must never reach here.
    throw new ToolError("E_INPUT_SCHEMA", "Default-context synthesis is not permitted (INV-CR-2)");
  }
  const validUntil = toLedgerSeq(deps.currentLedger + intent.expiry.ledgers);
  const signers = grantSigners(intent);
  const unsatisfied: { constraint_id: string; reason: string }[] = [];

  // One rule per distinct contract (targets ∪ budget tokens), keyed for determinism.
  const rules = new Map<string, RuleAccum>();
  let seq = 0;
  const ruleFor = (contract: ContractId, label?: string): RuleAccum => {
    let r = rules.get(contract);
    if (r === undefined) {
      r = { contract, name: ruleName(label, seq), constraints: [], seq: seq++ };
      rules.set(contract, r);
    }
    return r;
  };

  // Targets → func_allowlist (L3).
  for (const target of intent.targets) {
    const rule = ruleFor(target.contract, target.label);
    const functions = [...new Set(target.functions.map((f) => f.name))].sort();
    rule.constraints.push({
      kind: "func_allowlist",
      contract: target.contract,
      functions,
      id: `${String(rule.seq)}:func_allowlist`,
      provenance: [target.provenance],
    });
    // Arg predicates that require ScVal encoding are recorded as unsatisfied unless
    // a later evidence/encoding phase supplies exact bytes (honest channel).
    for (const fn of target.functions) {
      for (const ac of fn.arg_constraints) {
        if (ac.op === "any") continue;
        unsatisfied.push({
          constraint_id: `${String(rule.seq)}:arg:${fn.name}:${String(ac.index)}`,
          reason: "arg predicate requires ScVal encoding from evidence (evidence-guided synthesis, Phase 5)",
        });
      }
    }
  }

  // Budgets → amount_cap.
  for (const budget of intent.budgets) {
    const rule = ruleFor(budget.token);
    const scaled = amountFitsI128(budget.cap, budget.decimals);
    if (scaled === null) {
      unsatisfied.push({ constraint_id: `${String(rule.seq)}:amount_cap`, reason: "cap overflows i128 or bad precision" });
      continue;
    }
    rule.constraints.push({
      kind: "amount_cap",
      token: budget.token,
      cap_i128: scaled.toString(),
      window: budget.window,
      source:
        budget.scope === "outflow_via_transfer"
          ? { kind: "transfer_arg2" }
          : {
              kind: "call_arg",
              contract: budget.arg_source!.contract,
              fn: budget.arg_source!.fn,
              path: budget.arg_source!.path,
            },
      id: `${String(rule.seq)}:amount_cap`,
      provenance: [budget.provenance],
    });
  }

  // Every rule gets an expiry constraint (minimality (d)).
  const candidateRules: CandidateRule[] = [...rules.values()]
    .sort((a, b) => a.contract.localeCompare(b.contract))
    .map((r): CandidateRule => {
      const expiryConstraint: Constraint = {
        kind: "expiry",
        valid_until_ledger: validUntil,
        id: `${String(r.seq)}:expiry`,
        provenance: [EXPIRY_PROV],
      };
      const constraints: Constraint[] = [...r.constraints, expiryConstraint].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      return {
        name: r.name,
        context_type: { kind: "call_contract", address: r.contract },
        valid_until_ledger: validUntil,
        signers,
        constraints,
        policy_bindings: [], // filled by C2 match-policies
      };
    });

  const based_on = {
    intent_hash: input.intentHash,
    ...(input.snapshotHash !== undefined ? { snapshot_hash: input.snapshotHash } : {}),
  };
  const draft = {
    schema_version: "1" as const,
    account: intent.account,
    network: intent.network,
    based_on,
    rules: candidateRules,
    removals: [],
    updates: [],
    unsatisfied: unsatisfied.sort((a, b) => a.constraint_id.localeCompare(b.constraint_id)),
  };
  const ruleset_hash = canonicalHash(draft as unknown as JsonValue);
  return { ...draft, ruleset_hash };
}

function grantSigners(intent: PolicyIntent): SignerModel[] {
  const out: SignerModel[] = [intent.grantee.signer];
  if (intent.quorum !== undefined) {
    for (const s of intent.quorum.of_signers) out.push(s);
  }
  return out;
}

function ruleName(label: string | undefined, seq: number): string {
  const base = (label ?? `rule-${String(seq)}`).replace(/[^A-Za-z0-9 _-]/g, "").trim();
  const name = base.length > 0 ? base : `rule-${String(seq)}`;
  return name.slice(0, 20);
}

export type { CandidateRuleset, LedgerSeq };
