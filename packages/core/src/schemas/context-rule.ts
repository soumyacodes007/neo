/** SCH-ContextRuleModel (Vol 02 §2). Off-chain mirror of `ContextRuleEntry`. */
import { z } from "zod";
import { ContractId, LedgerSeq, WasmHash } from "../primitives.js";
import { SignerRef } from "./signer.js";

export const ContextType = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("call_contract"), address: ContractId }),
  z.object({ kind: z.literal("create_contract"), wasm_hash: WasmHash }),
]);
export type ContextType = z.infer<typeof ContextType>;

/** Policy classification comes ONLY from the live WASM-hash registry (INV-Rule-4). */
export const PolicyClassification = z.enum([
  "oz:simple_threshold",
  "oz:weighted_threshold",
  "oz:spending_limit",
  "pb:function_allowlist",
  "pb:arg_guard",
  "pb:call_cap",
  "pb:rate_limit",
  "generated",
  "unknown",
]);
export type PolicyClassification = z.infer<typeof PolicyClassification>;

export const PolicyRef = z.object({
  address: ContractId,
  policy_id: z.number().int().min(0).optional(),
  classification: PolicyClassification,
  wasm_hash: WasmHash.optional(),
  install_state: z.unknown().optional(), // typed per classification, Vol 02 §2.1
});
export type PolicyRef = z.infer<typeof PolicyRef>;

export const ContextRuleModel = z.object({
  id: z.number().int().min(0),
  name: z.string().max(20),
  context_type: ContextType,
  valid_until_ledger: LedgerSeq.optional(),
  expires_at_approx: z.string().datetime().optional(),
  signers: z.array(SignerRef).max(15),
  policies: z.array(PolicyRef).max(5),
  privilege: z.enum(["admin-equivalent", "scoped"]),
  status: z.enum(["active", "expired"]),
});
export type ContextRuleModel = z.infer<typeof ContextRuleModel>;
