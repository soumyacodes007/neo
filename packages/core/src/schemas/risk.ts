/** SCH-BypassReport & SCH-RiskReport (Vol 02 §9). */
import { z } from "zod";
import { LedgerSeq } from "../primitives.js";
import { SchemaVersion } from "./common.js";
import { PolicyRef } from "./context-rule.js";
import { SignerModel } from "./signer.js";

export const BypassFinding = z.object({
  rule_id: z.number().int(),
  context: z.object({ kind: z.string(), target: z.string().optional(), fn_name: z.string().optional() }),
  verdict: z.enum(["SAFE", "BYPASS", "UNKNOWN"]),
  path: z.string().optional(),
  reasoning: z.object({ policy_semantics: z.enum(["none", "known", "unknown"]), threat_keys: z.number().int() }),
  recommendation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("remove_rule"), rule_id: z.number().int() }),
    z.object({ kind: z.literal("expire_rule"), rule_id: z.number().int(), at: LedgerSeq }),
    z.object({ kind: z.literal("raise_threshold"), rule_id: z.number().int(), to: z.number().int() }),
    z.object({ kind: z.literal("manual_review"), note: z.string() }),
    z.object({ kind: z.literal("none") }),
  ]),
});
export type BypassFinding = z.infer<typeof BypassFinding>;

export const BypassReport = z.object({
  schema_version: SchemaVersion,
  snapshot_hash: z.string(),
  ruleset_hash: z.string(),
  threat_model: z.object({ grantee_signers: z.array(SignerModel), extra_compromised: z.number().int().default(0) }),
  findings: z.array(BypassFinding),
  exhaustive: z.boolean(),
  report_hash: z.string().length(64),
});
export type BypassReport = z.infer<typeof BypassReport>;

export const RiskReport = z.object({
  schema_version: SchemaVersion,
  ruleset_hash: z.string(),
  residual_risks: z.array(
    z.object({
      severity: z.enum(["critical", "high", "medium", "low", "info"]),
      code: z.string(),
      description: z.string(),
      evidence: z.string().optional(),
    }),
  ),
  limitations: z.array(z.object({ code: z.string(), message: z.string() })),
  unknown_policies: z.array(PolicyRef),
  bypass_summary: z.object({ safe: z.number().int(), bypass: z.number().int(), unknown: z.number().int() }),
  irreversibility_notes: z.array(z.string()),
  expiry_summary: z.string(),
  revocation_summary: z.string(),
  report_hash: z.string().length(64),
});
export type RiskReport = z.infer<typeof RiskReport>;
