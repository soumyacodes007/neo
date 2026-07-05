/** SCH-Common — shared schema primitives (Vol 02 §0). */
import { z } from "zod";
import { Amount, ContractId, LedgerSeq, TxHash } from "../primitives.js";

export const Network = z.enum(["testnet", "mainnet", "local"]);
export type Network = z.infer<typeof Network>;

export const SchemaVersion = z.literal("1");
export type SchemaVersion = z.infer<typeof SchemaVersion>;

/**
 * Every synthesized fact carries provenance — the anti-hallucination seam
 * (INV-Intent-3). A constraint is either grounded in an observed transaction,
 * an explicit user intent quote, or a named default policy.
 */
export const Provenance = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("observed_tx"),
    tx_hash: TxHash,
    context_index: z.number().int().min(0),
  }),
  z.object({ kind: z.literal("user_intent"), quote: z.string().max(500) }),
  z.object({ kind: z.literal("default"), rule: z.string() }),
]);
export type Provenance = z.infer<typeof Provenance>;

export const TokenAmount = z.object({
  token: ContractId,
  amount: Amount,
  decimals: z.number().int().min(0).max(38),
  symbol: z.string().max(32).optional(),
});
export type TokenAmount = z.infer<typeof TokenAmount>;

/** Canonical lookback/window unit is ledgers; days are converted at parse time. */
export const LedgerWindow = z.object({ ledgers: z.number().int().positive() });
export type LedgerWindow = z.infer<typeof LedgerWindow>;

export { LedgerSeq };
