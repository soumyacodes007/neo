/** SCH-AccountSnapshot (Vol 02 §3). */
import { z } from "zod";
import { ContractId, LedgerSeq, WasmHash } from "../primitives.js";
import { Network, SchemaVersion } from "./common.js";
import { ContextRuleModel, PolicyRef } from "./context-rule.js";
import { SignerRef } from "./signer.js";

export const SnapshotWarning = z.object({
  code: z.string(),
  message: z.string(),
  rule_id: z.number().int().optional(),
});
export type SnapshotWarning = z.infer<typeof SnapshotWarning>;

export const AccountSnapshot = z.object({
  schema_version: SchemaVersion,
  network: Network,
  account: ContractId,
  ledger: LedgerSeq,
  taken_at: z.string().datetime(),
  account_wasm_hash: WasmHash,
  rules: z.array(ContextRuleModel), // sorted by id asc
  next_rule_id: z.number().int(),
  rule_count: z.number().int(),
  signer_registry: z.array(SignerRef), // deduped, sorted by canonical_hash
  policy_registry: z.array(PolicyRef), // deduped, sorted by address
  admin_paths: z.array(z.number().int()),
  recovery_paths: z.array(z.number().int()),
  warnings: z.array(SnapshotWarning),
  gaps: z.array(z.number().int()).optional(), // removed rule ids (debug)
  snapshot_hash: z.string().length(64),
});
export type AccountSnapshot = z.infer<typeof AccountSnapshot>;
