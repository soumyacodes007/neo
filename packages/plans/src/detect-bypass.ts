/**
 * D4 - detect-bypass v1 (Vol 08 §5). Static, finite case analysis over live
 * account rules. It proves simple no-policy cases and fails closed with UNKNOWN
 * when policy/verifier semantics are not available.
 */
import {
  canonicalHash,
  type AccountSnapshot,
  type BypassFinding,
  type BypassReport,
  type CandidateRuleset,
  type ContextRuleModel,
  type JsonValue,
  type SignerModel,
} from "@ozpb/core";

export interface DetectBypassInput {
  ruleset: CandidateRuleset;
  accountSnapshot: AccountSnapshot;
  threatModel?: { extra_compromised?: number };
  preserveRuleIds?: number[];
}

interface BypassContext {
  kind: "default" | "call_contract" | "create_contract";
  target?: string;
  fn_name?: string;
}

export function detectBypass(input: DetectBypassInput): BypassReport {
  const threat = threatSigners(input.ruleset);
  const preserve = new Set(input.preserveRuleIds ?? []);
  const contexts = contextUniverse(input.ruleset);
  const findings: BypassFinding[] = [];

  for (const ctx of contexts) {
    for (const rule of input.accountSnapshot.rules) {
      if (rule.status !== "active") continue;
      if (!matches(rule, ctx)) continue;
      findings.push(classify(rule, ctx, threat, preserve));
    }
  }

  const draft = {
    schema_version: "1" as const,
    snapshot_hash: input.accountSnapshot.snapshot_hash,
    ruleset_hash: input.ruleset.ruleset_hash,
    threat_model: { grantee_signers: [...threat.values()], extra_compromised: input.threatModel?.extra_compromised ?? 0 },
    findings: findings.sort((a, b) => a.rule_id - b.rule_id || JSON.stringify(a.context).localeCompare(JSON.stringify(b.context))),
    exhaustive: true,
  };
  const report_hash = canonicalHash(draft as unknown as JsonValue);
  return { ...draft, report_hash };
}

function classify(
  rule: ContextRuleModel,
  ctx: BypassContext,
  threat: Map<string, SignerModel>,
  preserve: Set<number>,
): BypassFinding {
  const context = reportContext(ctx);
  if (!ruleSignersSubsetThreat(rule, threat)) {
    return {
      rule_id: rule.id,
      context,
      verdict: "SAFE",
      reasoning: { policy_semantics: rule.policies.length === 0 ? "none" : "known", threat_keys: threat.size },
      recommendation: { kind: "none" },
    };
  }

  if (rule.policies.length === 0) {
    return {
      rule_id: rule.id,
      context,
      verdict: "BYPASS",
      path: rule.context_type.kind === "default"
        ? `rule ${String(rule.id)} is Default and all rule signers are in the threat set`
        : `rule ${String(rule.id)} matches ${describeContext(ctx)} and all rule signers are in the threat set`,
      reasoning: { policy_semantics: "none", threat_keys: threat.size },
      recommendation: preserve.has(rule.id)
        ? { kind: "manual_review", note: "preserve-listed rule conflicts with the grant; do not auto-remove" }
        : { kind: "expire_rule", rule_id: rule.id, at: 0 as never },
    };
  }

  if (rule.policies.some((p) => p.classification === "unknown" || p.classification === "generated")) {
    return {
      rule_id: rule.id,
      context,
      verdict: "UNKNOWN",
      reasoning: { policy_semantics: "unknown", threat_keys: threat.size },
      recommendation: { kind: "manual_review", note: "unknown policy code cannot be proven safe" },
    };
  }

  const admitted = knownPoliciesAdmit(rule, ctx);
  return admitted
    ? {
        rule_id: rule.id,
        context,
        verdict: "BYPASS",
        path: `rule ${String(rule.id)} has known policy semantics that may admit ${describeContext(ctx)}`,
        reasoning: { policy_semantics: "known", threat_keys: threat.size },
        recommendation: preserve.has(rule.id)
          ? { kind: "manual_review", note: "preserve-listed rule conflicts with the grant; do not auto-remove" }
          : { kind: "expire_rule", rule_id: rule.id, at: 0 as never },
      }
    : {
        rule_id: rule.id,
        context,
        verdict: "SAFE",
        reasoning: { policy_semantics: "known", threat_keys: threat.size },
        recommendation: { kind: "none" },
      };
}

function knownPoliciesAdmit(rule: ContextRuleModel, ctx: BypassContext): boolean {
  for (const p of rule.policies) {
    if (p.classification === "pb:function_allowlist") {
      const functions = installStateArray(p.install_state, "functions");
      if (ctx.fn_name !== undefined && functions.length > 0 && !functions.includes(ctx.fn_name)) return false;
    }
    if (p.classification === "pb:arg_guard") return false;
    if (p.classification === "oz:simple_threshold") {
      const threshold = installStateNumber(p.install_state, "threshold");
      if (threshold !== undefined && rule.signers.length < threshold) return false;
    }
  }
  return true;
}

function contextUniverse(ruleset: CandidateRuleset): BypassContext[] {
  const out = new Map<string, BypassContext>();
  for (const rule of ruleset.rules) {
    if (rule.context_type.kind === "call_contract") {
      out.set(`call:${rule.context_type.address}`, { kind: "call_contract", target: rule.context_type.address });
    }
    if (rule.context_type.kind === "create_contract") {
      out.set(`create:${rule.context_type.wasm_hash}`, { kind: "create_contract", target: rule.context_type.wasm_hash });
    }
  }
  out.set(`call:${ruleset.account}`, { kind: "call_contract", target: ruleset.account, fn_name: "add_context_rule" });
  out.set("default", { kind: "default" });
  return [...out.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function matches(rule: ContextRuleModel, ctx: BypassContext): boolean {
  if (rule.context_type.kind === "default") return true;
  if (rule.context_type.kind === "call_contract") return ctx.kind === "call_contract" && rule.context_type.address === ctx.target;
  if (rule.context_type.kind === "create_contract") return ctx.kind === "create_contract" && rule.context_type.wasm_hash === ctx.target;
  return false;
}

function threatSigners(ruleset: CandidateRuleset): Map<string, SignerModel> {
  const out = new Map<string, SignerModel>();
  for (const rule of ruleset.rules) for (const signer of rule.signers) out.set(signerKey(signer), signer);
  return out;
}

function ruleSignersSubsetThreat(rule: ContextRuleModel, threat: Map<string, SignerModel>): boolean {
  return rule.signers.length > 0 && rule.signers.every((ref) => threat.has(signerKey(ref.signer)));
}

function signerKey(signer: SignerModel): string {
  return JSON.stringify(signer);
}

function reportContext(ctx: BypassContext): BypassFinding["context"] {
  return {
    kind: ctx.kind,
    ...(ctx.target !== undefined ? { target: ctx.target } : {}),
    ...(ctx.fn_name !== undefined ? { fn_name: ctx.fn_name } : {}),
  };
}

function describeContext(ctx: BypassContext): string {
  return ctx.target === undefined ? ctx.kind : `${ctx.kind}:${ctx.target}${ctx.fn_name !== undefined ? `.${ctx.fn_name}` : ""}`;
}

function installStateNumber(state: unknown, key: string): number | undefined {
  return typeof state === "object" && state !== null && typeof (state as Record<string, unknown>)[key] === "number"
    ? (state as Record<string, number>)[key]
    : undefined;
}

function installStateArray(state: unknown, key: string): string[] {
  const value = typeof state === "object" && state !== null ? (state as Record<string, unknown>)[key] : undefined;
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : [];
}
