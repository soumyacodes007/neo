/**
 * C1 - synthesize-ruleset (Vol 06). Pure + deterministic: identical inputs
 * yield a byte-identical ruleset_hash.
 *
 * Supports the intent-guided path plus Phase 5 evidence closure: observed
 * contexts add call_contract rules, function allowlists, and exact/in ScVal
 * arg predicates. It never emits Default.
 */
import { amountFitsI128, toLedgerSeq } from "../primitives.js";
import { ToolError } from "../errors.js";
import { canonicalHash, type JsonValue } from "../canonical.js";
import type { PolicyIntent } from "../schemas/policy-intent.js";
import type { AuthContextSet } from "../schemas/auth-context.js";
import type { Constraint, CandidateRule, CandidateRuleset } from "../schemas/constraint.js";
import type { Provenance } from "../schemas/common.js";
import type { ContractId, LedgerSeq } from "../primitives.js";
import type { SignerModel } from "../schemas/signer.js";

export interface SynthesizeDeps {
  /** Current ledger; valid_until = currentLedger + intent.expiry.ledgers. */
  currentLedger: number;
}

export interface SynthesizeInput {
  intent: PolicyIntent;
  intentHash: string;
  snapshotHash?: string;
  evidence?: AuthContextSet;
}

interface RuleAccum {
  contract: ContractId;
  name: string;
  constraints: Constraint[];
  seq: number;
  functions: Map<string, Provenance[]>;
}

const EXPIRY_PROV: Provenance = { kind: "default", rule: "expiry-required-default" };

export function synthesizeRuleset(input: SynthesizeInput, deps: SynthesizeDeps): CandidateRuleset {
  const { intent } = input;
  if (intent.allow_default_context) {
    throw new ToolError("E_INPUT_SCHEMA", "Default-context synthesis is not permitted (INV-CR-2)");
  }
  if (input.evidence !== undefined) {
    if (input.evidence.polarity !== "positive") {
      throw new ToolError("E_INPUT_SCHEMA", "synthesize-ruleset evidence must be positive");
    }
    if (input.evidence.account !== intent.account || input.evidence.network !== intent.network) {
      throw new ToolError("E_INPUT_HASH_MISMATCH", "evidence account/network does not match intent");
    }
  }

  const validUntil = toLedgerSeq(deps.currentLedger + intent.expiry.ledgers);
  const signers = grantSigners(intent);
  const unsatisfied: { constraint_id: string; reason: string }[] = [];

  const rules = new Map<string, RuleAccum>();
  let seq = 0;
  const ruleFor = (contract: ContractId, label?: string): RuleAccum => {
    let r = rules.get(contract);
    if (r === undefined) {
      r = { contract, name: ruleName(label, seq), constraints: [], seq: seq++, functions: new Map() };
      rules.set(contract, r);
    }
    return r;
  };
  const addFunction = (rule: RuleAccum, fn: string, provenance: Provenance): void => {
    const prev = rule.functions.get(fn) ?? [];
    rule.functions.set(fn, [...prev, provenance]);
  };

  for (const target of intent.targets) {
    const rule = ruleFor(target.contract, target.label);
    for (const fn of target.functions) {
      addFunction(rule, fn.name, target.provenance);
      for (const ac of fn.arg_constraints) {
        if (ac.op === "any") continue;
        unsatisfied.push({
          constraint_id: `${String(rule.seq)}:arg:${fn.name}:${String(ac.index)}`,
          reason: "arg predicate requires ScVal encoding from evidence (evidence-guided synthesis, Phase 5)",
        });
      }
    }
  }

  for (const ctx of input.evidence?.contexts ?? []) {
    const rule = ruleFor(ctx.contract);
    const prov = ctx.occurrences[0]?.provenance ?? { kind: "default", rule: "evidence-without-occurrence" };
    addFunction(rule, ctx.fn_name, prov);
    const transferAmount = evidenceTransferAmountCap(ctx, intent);
    for (const arg of ctx.arg_summary) {
      if (transferAmount !== undefined && ctx.fn_name === "transfer" && arg.index === 2) continue;
      if (arg.distinct_values_scval_b64.length === 0) continue;
      rule.constraints.push({
        kind: "arg_predicate",
        contract: ctx.contract,
        fn: ctx.fn_name,
        arg_index: arg.index,
        op: arg.distinct_values_scval_b64.length === 1 ? "eq" : "in",
        values_scval_b64: arg.distinct_values_scval_b64,
        id: `${String(rule.seq)}:arg:${ctx.fn_name}:${String(arg.index)}`,
        provenance: ctx.occurrences.map((o) => o.provenance),
      });
    }
    if (transferAmount !== undefined) {
      rule.constraints.push(transferAmount);
    }
  }

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

  const candidateRules: CandidateRule[] = [...rules.values()]
    .sort((a, b) => a.contract.localeCompare(b.contract))
    .map((r): CandidateRule => {
      if (r.functions.size > 0) {
        r.constraints.push({
          kind: "func_allowlist",
          contract: r.contract,
          functions: [...r.functions.keys()].sort(),
          id: `${String(r.seq)}:func_allowlist`,
          provenance: dedupProvenance([...r.functions.values()].flat()),
        });
      }
      const expiryConstraint: Constraint = {
        kind: "expiry",
        valid_until_ledger: validUntil,
        id: `${String(r.seq)}:expiry`,
        provenance: [EXPIRY_PROV],
      };
      const constraints = [...r.constraints, expiryConstraint].sort((a, b) => a.id.localeCompare(b.id));
      return {
        name: r.name,
        context_type: { kind: "call_contract", address: r.contract },
        valid_until_ledger: validUntil,
        signers,
        constraints,
        policy_bindings: [],
      };
    });

  const based_on = {
    intent_hash: input.intentHash,
    ...(input.evidence !== undefined ? { evidence_hash: input.evidence.evidence_hash } : {}),
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

function dedupProvenance(provenance: Provenance[]): Provenance[] {
  const byKey = new Map<string, Provenance>();
  for (const p of provenance) byKey.set(JSON.stringify(p), p);
  return [...byKey.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function evidenceTransferAmountCap(ctx: AuthContextSet["contexts"][number], intent: PolicyIntent): Constraint | undefined {
  if (ctx.fn_name !== "transfer") return undefined;
  if (intent.budgets.some((b) => b.token === ctx.contract)) return undefined;
  const amountArg = ctx.arg_summary.find((arg) => arg.index === 2);
  const max = amountArg?.numeric_range?.max;
  if (max === undefined) return undefined;
  return {
    kind: "amount_cap",
    token: ctx.contract,
    cap_i128: max,
    window: { ledgers: intent.expiry.ledgers },
    source: { kind: "transfer_arg2" },
    id: `evidence:${ctx.contract}:transfer:amount_cap`,
    provenance: ctx.occurrences.map((o) => o.provenance),
  };
}

export type { CandidateRuleset, LedgerSeq };
