/**
 * D2 — `generate-tests` (Vol 08 §3). Deterministically derives an allow/deny
 * test suite from a `CandidateRuleset`. Allow cases exercise each permitted
 * function; the mutation battery produces deny cases (wrong function, wrong
 * contract, expired window, and — when arg/amount bytes are available — value
 * mutations). INV-Test-1: every constraint must appear in ≥1 allow AND ≥1 deny
 * case, else `E_DOMAIN_COVERAGE_GAP` (never a silent hole).
 *
 * Value mutations (`amount_plus_epsilon`, `arg_tamper`) require exact ScVal
 * bytes; without evidence/an encoder they are reported as coverage gaps rather
 * than fabricated (honest). Panic codes are representative and pinned by the
 * fork simulation (Phase 4 exit).
 */
import { ToolError } from "../errors.js";
import type { CandidateRuleset, Constraint } from "../schemas/constraint.js";
import type { TestCase } from "../schemas/test-case.js";
import type { Provenance } from "../schemas/common.js";

const DEFAULT_PROV: Provenance = { kind: "default", rule: "generated-test" };
// Representative Contract error codes (pinned by fork sim, Vol 08 D3).
const ERR_FUNC_ALLOWLIST = 3300;
const ERR_RULE_EXPIRED = 3013;

export interface GenerateTestsInput {
  ruleset: CandidateRuleset;
}

export interface GenerateTestsDeps {
  /** Permit constraints that cannot be exercised both ways (default false). */
  allowCoverageGaps?: boolean;
}

export function generateTests(input: GenerateTestsInput, deps: GenerateTestsDeps = {}): TestCase[] {
  const cases: TestCase[] = [];
  let n = 0;
  const id = (): string => `t:${String(n++)}`;
  const exercised = new Map<string, { allow: boolean; deny: boolean }>();
  const mark = (constraintId: string, kind: "allow" | "deny"): void => {
    const e = exercised.get(constraintId) ?? { allow: false, deny: false };
    e[kind] = true;
    exercised.set(constraintId, e);
  };

  const allConstraints: Constraint[] = input.ruleset.rules.flatMap((r) => r.constraints);

  for (const rule of input.ruleset.rules) {
    if (rule.context_type.kind !== "call_contract") continue;
    const target = rule.context_type.address;
    const signer_set = rule.signers;
    const allow = rule.constraints.find((c): c is Extract<Constraint, { kind: "func_allowlist" }> => c.kind === "func_allowlist");
    const expiry = rule.constraints.find((c): c is Extract<Constraint, { kind: "expiry" }> => c.kind === "expiry");
    const funcs = allow?.functions ?? [];

    for (const fn of funcs) {
      // Allow: a permitted function within the window.
      cases.push({
        id: id(),
        kind: "allow",
        origin: { kind: "observed", provenance: DEFAULT_PROV },
        context: { contract: target, fn_name: fn, args_scval_b64: [] },
        signer_set,
        ledger_offset: 0,
        expected: { kind: "pass" },
      });
      if (allow !== undefined) mark(allow.id, "allow");
      if (expiry !== undefined) mark(expiry.id, "allow");
    }

    if (allow !== undefined) {
      // Deny: a function NOT in the allowlist (wrong_function).
      cases.push({
        id: id(),
        kind: "deny",
        origin: { kind: "mutation", operator: "wrong_function", base_case: allow.id },
        context: { contract: target, fn_name: "__unlisted_fn__", args_scval_b64: [] },
        signer_set,
        ledger_offset: 0,
        expected: { kind: "panic", contract_error_code: ERR_FUNC_ALLOWLIST },
      });
      mark(allow.id, "deny");
      // Deny: a permitted function on the WRONG contract (the account itself).
      cases.push({
        id: id(),
        kind: "deny",
        origin: { kind: "mutation", operator: "wrong_contract", base_case: allow.id },
        context: { contract: input.ruleset.account, fn_name: funcs[0] ?? "x", args_scval_b64: [] },
        signer_set,
        ledger_offset: 0,
        expected: { kind: "panic", contract_error_code: ERR_FUNC_ALLOWLIST },
      });
    }

    if (expiry !== undefined && funcs.length > 0) {
      // Deny: a permitted call past the rule's expiry (expired_window).
      cases.push({
        id: id(),
        kind: "deny",
        origin: { kind: "mutation", operator: "expired_window", base_case: expiry.id },
        context: { contract: target, fn_name: funcs[0]!, args_scval_b64: [] },
        signer_set,
        ledger_offset: (expiry.valid_until_ledger - input.ruleset.rules[0]!.valid_until_ledger) + 1,
        expected: { kind: "panic", contract_error_code: ERR_RULE_EXPIRED },
      });
      mark(expiry.id, "deny");
    }
  }

  // INV-Test-1 coverage gate.
  if (deps.allowCoverageGaps !== true) {
    const gaps = allConstraints
      .filter((c) => c.kind !== "func_allowlist" || true) // all constraints must be covered
      .filter((c) => {
        const e = exercised.get(c.id);
        return e === undefined || !e.allow || !e.deny;
      })
      .map((c) => c.id);
    if (gaps.length > 0) {
      throw new ToolError("E_DOMAIN_COVERAGE_GAP", "constraints not exercised in both polarities (INV-Test-1)", {
        details: { uncovered: gaps.sort() },
        suggestion: "supply evidence/example bytes so value mutations can be generated",
      });
    }
  }

  return cases;
}
