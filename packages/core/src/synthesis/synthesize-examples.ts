/**
 * C1.3 — example-driven synthesis (Vol 06 §2, FN-C1.3). Given labeled positive
 * (allow) and negative (deny) auth-context evidence, find the smallest constraint
 * set that admits every positive and excludes every negative — or prove it is
 * impossible at the context level and fail honestly with
 * `E_UNSATISFIABLE_BY_CONTEXT` (naming the colliding pair).
 *
 * Pure + deterministic. Values are compared as exact ScVal XDR bytes (never JSON
 * approximations), so the synthesized predicates match on-chain enforcement.
 */
import { ToolError } from "../errors.js";
import { canonicalHash, type JsonValue } from "../canonical.js";
import { toLedgerSeq } from "../primitives.js";
import type { ContractId } from "../primitives.js";
import type { AuthContextSet, AuthContextEvidence } from "../schemas/auth-context.js";
import type { CandidateRule, CandidateRuleset, Constraint } from "../schemas/constraint.js";
import type { SignerModel } from "../schemas/signer.js";
import type { Provenance } from "../schemas/common.js";

export interface ExampleSynthInput {
  allow: AuthContextSet;
  deny: AuthContextSet;
  signers: SignerModel[];
  validUntilLedger: number;
  intentHash: string;
}

const PROV: Provenance = { kind: "default", rule: "example-driven" };

export function synthesizeFromExamples(input: ExampleSynthInput): CandidateRuleset {
  const { allow, deny } = input;
  if (allow.polarity !== "positive" || deny.polarity !== "negative") {
    throw new ToolError("E_INPUT_SCHEMA", "allow set must be positive and deny set negative");
  }

  // 1. Collision pre-check: a deny byte-identical to an allow cannot be separated.
  const allowSigs = new Map<string, AuthContextEvidence>();
  for (const c of allow.contexts) allowSigs.set(contextSignature(c), c);
  for (const d of deny.contexts) {
    const hit = allowSigs.get(contextSignature(d));
    if (hit !== undefined) {
      throw new ToolError(
        "E_UNSATISFIABLE_BY_CONTEXT",
        `a deny example is byte-identical to an allow example on ${d.contract}.${d.fn_name} — no context-level policy can separate them`,
        { details: { contract: d.contract, fn_name: d.fn_name }, suggestion: "these differ only in external state; a stateful custom policy or narrower intent is required" },
      );
    }
  }

  // 2. Allow-closure per contract: function allowlist + per-(fn,arg) value model.
  const byContract = new Map<string, ContractClosure>();
  for (const c of allow.contexts) {
    const closure = byContract.get(c.contract) ?? newClosure(c.contract);
    closure.functions.add(c.fn_name);
    for (const a of c.arg_summary) {
      const key = `${c.fn_name}:${String(a.index)}`;
      const m = closure.args.get(key) ?? { values: new Set<string>(), numeric: a.numeric_range !== undefined, min: undefined, max: undefined };
      for (const v of a.distinct_values_scval_b64) m.values.add(v);
      if (a.numeric_range !== undefined) {
        m.numeric = true;
        m.min = minBig(m.min, BigInt(a.numeric_range.min));
        m.max = maxBig(m.max, BigInt(a.numeric_range.max));
      }
      closure.args.set(key, m);
    }
    byContract.set(c.contract, closure);
  }

  // 3. Discriminate each deny; mark the (fn,arg) predicates needed to exclude it.
  const neededArgPreds = new Set<string>(); // `${contract}|${fn}|${idx}`
  for (const d of deny.contexts) {
    const closure = byContract.get(d.contract);
    if (closure === undefined) continue; // contract never allowed ⇒ excluded by scope
    if (!closure.functions.has(d.fn_name)) continue; // fn not allowed ⇒ excluded by func_allowlist

    // Same contract + fn as some allow: find a discriminating argument.
    let discriminated = false;
    for (const a of d.arg_summary) {
      const key = `${d.fn_name}:${String(a.index)}`;
      const m = closure.args.get(key);
      if (m === undefined) continue;
      if (m.numeric && a.numeric_range !== undefined) {
        // Deny outside the allow numeric envelope → a range predicate excludes it.
        if (BigInt(a.numeric_range.min) < (m.min ?? 0n) || BigInt(a.numeric_range.max) > (m.max ?? 0n)) {
          neededArgPreds.add(`${d.contract}|${key}`);
          discriminated = true;
          break;
        }
      }
      // Deny has a value not in the allow set → an eq/in predicate excludes it.
      if (a.distinct_values_scval_b64.some((v) => !m.values.has(v))) {
        neededArgPreds.add(`${d.contract}|${key}`);
        discriminated = true;
        break;
      }
    }
    if (!discriminated) {
      throw new ToolError(
        "E_UNSATISFIABLE_BY_CONTEXT",
        `deny on ${d.contract}.${d.fn_name} is indistinguishable from an allow example at the auth-context level`,
        { details: { contract: d.contract, fn_name: d.fn_name } },
      );
    }
  }

  // 4. Assemble rules: func_allowlist + needed arg predicates + expiry.
  const validUntil = toLedgerSeq(input.validUntilLedger);
  const rules: CandidateRule[] = [...byContract.values()]
    .sort((a, b) => a.contract.localeCompare(b.contract))
    .map((closure): CandidateRule => {
      const constraints: Constraint[] = [];
      const funcs = [...closure.functions].sort();
      constraints.push({ kind: "func_allowlist", contract: closure.contract, functions: funcs, id: `${closure.contract}:func`, provenance: [PROV] });

      for (const key of [...closure.args.keys()].sort()) {
        const predKey = `${closure.contract}|${key}`;
        if (!neededArgPreds.has(predKey)) continue;
        const [fn, idxStr] = key.split(":");
        const m = closure.args.get(key)!;
        const arg_index = Number(idxStr);
        if (m.numeric && m.min !== undefined && m.max !== undefined) {
          constraints.push({
            kind: "arg_predicate", contract: closure.contract, fn: fn!, arg_index, op: "range",
            min_i128: m.min.toString(), max_i128: m.max.toString(),
            id: `${predKey}:range`, provenance: [PROV],
          });
        } else {
          const values = [...m.values].sort();
          constraints.push({
            kind: "arg_predicate", contract: closure.contract, fn: fn!, arg_index,
            op: values.length === 1 ? "eq" : "in",
            values_scval_b64: values as never,
            id: `${predKey}:${values.length === 1 ? "eq" : "in"}`, provenance: [PROV],
          });
        }
      }

      constraints.push({ kind: "expiry", valid_until_ledger: validUntil, id: `${closure.contract}:expiry`, provenance: [PROV] });
      constraints.sort((a, b) => a.id.localeCompare(b.id));
      return {
        name: ruleName(closure.contract),
        context_type: { kind: "call_contract", address: closure.contract },
        valid_until_ledger: validUntil,
        signers: input.signers,
        constraints,
        policy_bindings: [],
      };
    });

  const draft = {
    schema_version: "1" as const,
    account: allow.account,
    network: allow.network,
    based_on: { intent_hash: input.intentHash, evidence_hash: allow.evidence_hash },
    rules,
    removals: [],
    updates: [],
    unsatisfied: [],
  };
  const ruleset_hash = canonicalHash(draft as unknown as JsonValue);
  return { ...draft, ruleset_hash };
}

interface ArgModel {
  values: Set<string>;
  numeric: boolean;
  min: bigint | undefined;
  max: bigint | undefined;
}
interface ContractClosure {
  contract: ContractId;
  functions: Set<string>;
  args: Map<string, ArgModel>;
}
function newClosure(contract: ContractId): ContractClosure {
  return { contract, functions: new Set(), args: new Map() };
}

/** Byte-identical signature: contract, fn, and the exact per-arg value sets. */
function contextSignature(c: AuthContextEvidence): string {
  const args = c.arg_summary
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((a) => `${String(a.index)}=${[...a.distinct_values_scval_b64].sort().join(",")}`)
    .join(";");
  return `${c.contract}|${c.fn_name}|${args}`;
}

function minBig(a: bigint | undefined, b: bigint): bigint {
  return a === undefined ? b : a < b ? a : b;
}
function maxBig(a: bigint | undefined, b: bigint): bigint {
  return a === undefined ? b : a > b ? a : b;
}
function ruleName(contract: string): string {
  return `ex-${contract.slice(1, 5).toLowerCase()}`.slice(0, 20);
}
