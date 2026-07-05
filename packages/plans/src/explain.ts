/**
 * E3 — `explain-policy` (Vol 09 §3). A deterministic renderer over the data model
 * (NO LLM) so the explanation can never drift from the artifacts. Produces the
 * human-facing plain-English grant, and a risk report derived strictly from
 * limitations + bypass findings + unknown policies (INV-Risk-1): it can neither
 * invent nor omit a mapped risk. On-chain strings are fenced; amounts are dual
 * form; addresses are never truncated (EC-T01/T06/S10).
 */
import { canonicalHash, type JsonValue } from "@ozpb/core";
import type { BypassReport, CandidateRuleset, PolicyBinding, RiskReport } from "@ozpb/core";

export interface ExplainInput {
  ruleset: CandidateRuleset;
  bypassReport?: BypassReport;
  /** Ledger→approx wall clock base; if absent, expiry is shown in ledgers only. */
  nowLedger?: number;
}

export interface ExplainResult {
  markdown: string;
  riskReport: RiskReport;
}

export function explainPolicy(input: ExplainInput): ExplainResult {
  const { ruleset } = input;
  const riskReport = buildRiskReport(input);
  const lines: string[] = [];

  lines.push(`# Policy plan for account ${ruleset.account}`, "");
  lines.push(`Network: ${ruleset.network}. This grants the following, and nothing more:`, "");

  for (const rule of ruleset.rules) {
    const target = rule.context_type.kind === "call_contract" ? rule.context_type.address : `(${rule.context_type.kind})`;
    const funcs = rule.constraints
      .filter((c): c is Extract<typeof c, { kind: "func_allowlist" }> => c.kind === "func_allowlist")
      .flatMap((c) => c.functions);
    lines.push(`## Rule "${fence(rule.name)}" — call ${target}`);
    lines.push(
      funcs.length > 0
        ? `- May call: ${funcs.map((f) => `\`${fence(f)}\``).join(", ")}`
        : `- May call: any function on this contract`,
    );
    for (const c of rule.constraints) {
      if (c.kind === "amount_cap") {
        lines.push(`- Capped at ${rawAmount(c.cap_i128)} (raw i128) per ${c.window.ledgers} ledgers (~${approxDays(c.window.ledgers)})`);
      }
      if (c.kind === "expiry") {
        lines.push(`- Expires at ledger ${c.valid_until_ledger}${input.nowLedger !== undefined ? ` (~${approxDays(c.valid_until_ledger - input.nowLedger)} from now)` : ""}`);
      }
      if (c.kind === "rate_limit") {
        lines.push(`- Rate-limited to ${c.max_calls} calls per ${c.window.ledgers} ledgers`);
      }
    }
    for (const b of rule.policy_bindings) {
      lines.push(`- Enforced by: ${describeBinding(b)}`);
    }
    lines.push("");
  }

  lines.push("## Residual risks");
  if (riskReport.residual_risks.length === 0) lines.push("- None mapped.");
  for (const r of riskReport.residual_risks) {
    lines.push(`- **[${r.severity}]** ${r.description}`);
  }
  lines.push("", riskReport.expiry_summary, "", riskReport.revocation_summary);

  return { markdown: lines.join("\n"), riskReport };
}

function buildRiskReport(input: ExplainInput): RiskReport {
  const { ruleset, bypassReport } = input;
  const residual: RiskReport["residual_risks"] = [];
  const limitations: RiskReport["limitations"] = [];
  const unknownPolicies: RiskReport["unknown_policies"] = [];

  for (const rule of ruleset.rules) {
    for (const b of rule.policy_bindings) {
      for (const lim of b.limitations) limitations.push(lim);
      if (b.binding.kind === "codegen") {
        residual.push({
          severity: "high",
          code: "custom_codegen",
          description: "custom, unaudited policy code is present — manual review required",
        });
      }
      if (b.binding.kind === "existing" && b.binding.classification === "unknown") {
        unknownPolicies.push({ address: b.binding.address ?? ruleset.account, classification: "unknown" });
        residual.push({ severity: "high", code: "unknown_policy", description: "an unknown policy contract cannot be reasoned about" });
      }
    }
  }

  // Bypass-derived severities (fail-closed: any UNKNOWN/BYPASS surfaces).
  let safe = 0;
  let bypass = 0;
  let unknown = 0;
  for (const f of bypassReport?.findings ?? []) {
    if (f.verdict === "SAFE") safe++;
    else if (f.verdict === "BYPASS") {
      bypass++;
      residual.push({ severity: "critical", code: "bypass", description: `rule ${f.rule_id} can bypass this grant`, ...(f.path !== undefined ? { evidence: f.path } : {}) });
    } else {
      unknown++;
      residual.push({ severity: "high", code: "bypass_unknown", description: `rule ${f.rule_id} cannot be proven safe` });
    }
  }
  for (const lim of limitations) {
    residual.push({ severity: "info", code: lim.code, description: lim.message });
  }

  const expiry = minExpiry(ruleset);
  const draft = {
    schema_version: "1" as const,
    ruleset_hash: ruleset.ruleset_hash,
    residual_risks: residual,
    limitations,
    unknown_policies: unknownPolicies,
    bypass_summary: { safe, bypass, unknown },
    irreversibility_notes: [],
    expiry_summary: `Expiry: the grant self-expires at ledger ${expiry}.`,
    revocation_summary: "To revoke early: sign & submit the paired revocation plan (revoke-1.xdr).",
  };
  const report_hash = canonicalHash(draft as unknown as JsonValue);
  return { ...draft, report_hash };
}

function describeBinding(b: PolicyBinding): string {
  switch (b.binding.kind) {
    case "none_needed":
      return "the rule structure itself (signers + expiry) — no policy needed";
    case "existing":
      return `${b.binding.classification}${b.binding.address !== undefined ? ` @ ${b.binding.address}` : " (to deploy)"}`;
    case "codegen":
      return `custom generated policy (${b.binding.codegen_ref})`;
  }
}

function minExpiry(ruleset: CandidateRuleset): number {
  return Math.min(...ruleset.rules.map((r) => r.valid_until_ledger));
}

/** Fence an on-chain string for display (EC-T01): backticks + control-char strip already done upstream. */
function fence(s: string): string {
  return s.replace(/`/g, "'");
}

function rawAmount(i128: string): string {
  return i128;
}

function approxDays(ledgers: number): string {
  return `${(ledgers / 17280).toFixed(1)} days`;
}
