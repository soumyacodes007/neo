/** SCH-AuthContextSet (Vol 05 B1). Deterministic evidence extracted from traces. */
import { z } from "zod";
import { ContractId, LedgerSeq, TxHash, XdrBase64 } from "../primitives.js";
import { Network, Provenance, SchemaVersion } from "./common.js";
import { ContextType } from "./context-rule.js";

export const ArgSummary = z.object({
  index: z.number().int().min(0),
  name: z.string().optional(),
  sc_type: z.string(),
  distinct_values_scval_b64: z.array(XdrBase64).max(64),
  observed_count: z.number().int().min(0),
  numeric_range: z.object({ min: z.string(), max: z.string() }).optional(),
  opaque: z.boolean().default(false),
});
export type ArgSummary = z.infer<typeof ArgSummary>;

export const AuthContextOccurrence = z.object({
  tx_hash: TxHash,
  ledger: LedgerSeq,
  context_index: z.number().int().min(0),
  depth: z.enum(["root", "sub"]),
  successful: z.boolean(),
  provenance: Provenance,
});
export type AuthContextOccurrence = z.infer<typeof AuthContextOccurrence>;

export const AuthContextEvidence = z.object({
  context_type: ContextType,
  contract: ContractId,
  fn_name: z.string(),
  arity: z.number().int().min(0),
  depth: z.enum(["root", "sub", "mixed"]),
  arg_summary: z.array(ArgSummary),
  occurrences: z.array(AuthContextOccurrence).min(1),
  token_meta: z.object({ token: ContractId, decimals: z.number().int(), symbol: z.string().optional() }).optional(),
});
export type AuthContextEvidence = z.infer<typeof AuthContextEvidence>;

export const AuthContextSet = z.object({
  schema_version: SchemaVersion,
  account: ContractId,
  network: Network,
  polarity: z.enum(["positive", "negative"]),
  contexts: z.array(AuthContextEvidence),
  window: z.object({ from_ledger: LedgerSeq, to_ledger: LedgerSeq }),
  evidence_hash: z.string().length(64),
});
export type AuthContextSet = z.infer<typeof AuthContextSet>;
