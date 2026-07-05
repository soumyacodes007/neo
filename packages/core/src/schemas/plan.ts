/** SCH-InstallPlan & SCH-RevocationPlan (Vol 02 §10). */
import { z } from "zod";
import { ContractId, LedgerSeq, XdrBase64 } from "../primitives.js";
import { Network, SchemaVersion } from "./common.js";
import { ContextRuleModel } from "./context-rule.js";
import { SignerModel } from "./signer.js";

export const AuthRequirement = z.object({
  rule_id: z.number().int(),
  signers: z.array(SignerModel),
  digest_note: z.literal(
    "sign sha256(signature_payload || context_rule_ids.to_xdr()) — see Vol 03 §digest",
  ),
});
export type AuthRequirement = z.infer<typeof AuthRequirement>;

export const PlanStep = z.object({
  order: z.number().int().min(1),
  kind: z.enum(["deploy_wasm", "invoke"]),
  description: z.string(),
  tx_xdr_unsigned: XdrBase64,
  invoke: z
    .object({ contract: ContractId, fn: z.string(), args_scval_b64: z.array(XdrBase64) })
    .optional(),
  auth_requirements: z.array(AuthRequirement),
  simulated: z.object({ fee_stroops: z.string(), footprint_hash: z.string(), at_ledger: LedgerSeq }),
  reversible: z.boolean(),
  revert_step_ref: z.number().int().optional(),
  irreversibility_note: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const RevocationPlan = z.object({
  steps: z.array(PlanStep),
  summary: z.string(),
});
export type RevocationPlan = z.infer<typeof RevocationPlan>;

export const InstallPlan = z.object({
  schema_version: SchemaVersion,
  network: Network,
  account: ContractId,
  plan_hash: z.string().length(64),
  approval_token_ref: z.string(), // filename — token value is NEVER in this schema (INV-Plan-3)
  steps: z.array(PlanStep).min(1),
  depends_on: z.object({
    snapshot_hash: z.string(),
    ruleset_hash: z.string(),
    simulation_report_hash: z.string(),
    bypass_report_hash: z.string(),
    risk_report_hash: z.string(),
  }),
  pre_state: z.object({ rules_snapshot: z.array(ContextRuleModel) }),
  revocation_plan: RevocationPlan,
  expires_at_ledger: LedgerSeq,
});
export type InstallPlan = z.infer<typeof InstallPlan>;
