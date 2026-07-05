/**
 * C2 — `match-policies` (Vol 06 §3). Pure decision logic that binds each abstract
 * constraint to a concrete policy, strictly preferring OZ primitives → pb library
 * → codegen. The "never stretch spending_limit" rule (INV-CR-3) is enforced
 * structurally here (EC-S02): an `amount_cap` binds to `oz:spending_limit` ONLY
 * when it is exactly a `transfer_arg2` cap on the rule's own token contract.
 *
 * Install-param ScVal encoding is injected (`deps.encodeInstallParams`) so this
 * module stays pure (no `@stellar/stellar-sdk`).
 */
import type { XdrBase64 } from "../primitives.js";
import type { CandidateRule, CandidateRuleset, Constraint, PolicyBinding } from "../schemas/constraint.js";
import type { PolicyClassification } from "../schemas/context-rule.js";

const MAX_POLICIES = 5;

export interface MatchDeps {
  encodeInstallParams: (classification: PolicyClassification, params: Record<string, unknown>) => XdrBase64;
  /** Known deployed policy addresses to reuse (avoid redundant deploys). */
  knownDeployments?: { classification: PolicyClassification; address: string }[];
}

export interface MatchResult {
  ruleset: CandidateRuleset;
  requires_codegen: string[];
}

export function matchPolicies(ruleset: CandidateRuleset, deps: MatchDeps): MatchResult {
  const requires_codegen: string[] = [];
  const rules = ruleset.rules.map((rule) => matchRule(rule, deps, requires_codegen));
  return { ruleset: { ...ruleset, rules }, requires_codegen: requires_codegen.sort() };
}

function matchRule(rule: CandidateRule, deps: MatchDeps, requiresCodegen: string[]): CandidateRule {
  const bindings: PolicyBinding[] = [];
  const argPredicateIds: string[] = [];

  for (const c of rule.constraints) {
    switch (c.kind) {
      case "expiry":
        // Satisfied by the rule's valid_until — never a policy.
        break;
      case "func_allowlist":
        bindings.push(existing("pb:function_allowlist", [c.id], deps, { functions: c.functions }, []));
        break;
      case "threshold":
        bindings.push(
          existing(
            c.weighted ? "oz:weighted_threshold" : "oz:simple_threshold",
            [c.id],
            deps,
            c.weighted ? { threshold: c.m, weights: c.weights } : { threshold: c.m },
            [driftLimitation()],
          ),
        );
        break;
      case "rate_limit":
        bindings.push(existing("pb:rate_limit", [c.id], deps, { max_calls: c.max_calls, window: c.window.ledgers }, []));
        break;
      case "amount_cap":
        bindings.push(matchAmountCap(c, rule, deps));
        break;
      case "arg_predicate":
        argPredicateIds.push(c.id); // packed into one pb:arg_guard below
        break;
      default: {
        const _exhaustive: never = c;
        void _exhaustive;
      }
    }
  }

  // Pack all arg predicates into a single pb:arg_guard (EC-S08 minimization).
  if (argPredicateIds.length > 0) {
    bindings.push(existing("pb:arg_guard", argPredicateIds, deps, { predicate_count: argPredicateIds.length }, []));
  }

  if (bindings.length > MAX_POLICIES) {
    // Full rule-splitting is a later refinement; surface it honestly for now.
    requiresCodegen.push(`${rule.name}:exceeds_max_policies`);
  }

  return { ...rule, policy_bindings: bindings.slice(0, MAX_POLICIES) };
}

/**
 * INV-CR-3 structural gate. `oz:spending_limit` is allowed ONLY for a
 * `transfer_arg2` cap on a `call_contract(token)` rule whose token is the
 * constraint's token. Every other `amount_cap` routes to `pb:call_cap` with the
 * dual-budget limitation (EC-S02/S16).
 */
function matchAmountCap(
  c: Extract<Constraint, { kind: "amount_cap" }>,
  rule: CandidateRule,
  deps: MatchDeps,
): PolicyBinding {
  const onTokenRule =
    rule.context_type.kind === "call_contract" && rule.context_type.address === c.token;
  if (c.source.kind === "transfer_arg2" && onTokenRule) {
    return existing(
      "oz:spending_limit",
      [c.id],
      deps,
      { spending_limit: c.cap_i128, period_ledgers: c.window.ledgers },
      [
        { code: "spending_limit.zero_amount", message: "zero-amount transfers always pass (EC-S12)" },
        { code: "spending_limit.history_cap", message: "at most 1000 history entries per window (EC-P02)" },
      ],
    );
  }
  return existing(
    "pb:call_cap",
    [c.id],
    deps,
    { cap_i128: c.cap_i128, window: c.window.ledgers, source: c.source },
    [
      {
        code: "call_cap.separate_budget",
        message:
          "meters a protocol-internal/non-transfer amount; this budget is SEPARATE from direct SEP-41 transfer caps (EC-S16)",
      },
    ],
  );
}

function existing(
  classification: PolicyClassification,
  constraintIds: string[],
  deps: MatchDeps,
  params: Record<string, unknown>,
  limitations: { code: string; message: string }[],
): PolicyBinding {
  const known = deps.knownDeployments?.find((d) => d.classification === classification);
  return {
    constraint_ids: constraintIds,
    binding: {
      kind: "existing",
      classification,
      ...(known !== undefined ? { address: known.address as never } : {}),
      install_params_scval_b64: deps.encodeInstallParams(classification, params),
    },
    limitations,
  };
}

function driftLimitation(): { code: string; message: string } {
  return {
    code: "threshold.drift",
    message: "threshold state drifts when signers are added/removed — sequence updates carefully (EC-P01)",
  };
}
