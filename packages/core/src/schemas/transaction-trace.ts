/** SCH-TransactionTrace (Vol 02 §4). Lossless decode of one transaction. */
import { z } from "zod";
import { Amount, ContractId, LedgerSeq, TxHash, XdrBase64 } from "../primitives.js";
import { Network, SchemaVersion } from "./common.js";

/** Lossless ScVal projection: always carries the raw XDR so opaque/future
 * variants survive a round-trip (INV-Trace-1, EC-X02). */
export const ScValJson = z.object({
  type: z.string(),
  value: z.unknown(),
  xdr_b64: XdrBase64,
});
export type ScValJson = z.infer<typeof ScValJson>;

export interface InvocationNodeT {
  contract: ContractId;
  fn_name: string;
  args: ScValJson[];
  sub_invocations: InvocationNodeT[];
}

// Input type is `unknown` (not the branded output) so the recursive `z.lazy`
// definition typechecks against the branded `ContractId` field.
export const InvocationNode: z.ZodType<InvocationNodeT, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    contract: ContractId,
    fn_name: z.string(),
    args: z.array(ScValJson),
    sub_invocations: z.array(InvocationNode),
  }),
);

export const AuthEntryTrace = z.object({
  credentials: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source_account") }),
    z.object({
      kind: z.literal("address"),
      address: z.union([z.string(), ContractId]),
      nonce: z.string(),
      signature_expiration_ledger: LedgerSeq,
    }),
  ]),
  root_invocation: InvocationNode,
});
export type AuthEntryTrace = z.infer<typeof AuthEntryTrace>;

export const TokenDelta = z.object({
  token: ContractId,
  from: z.string(),
  to: z.string(),
  amount: Amount,
  decimals: z.number().int(),
  symbol: z.string().optional(),
  source: z.enum(["event", "meta"]),
});
export type TokenDelta = z.infer<typeof TokenDelta>;

export const DecodedEvent = z.object({
  contract: ContractId.optional(),
  topics: z.array(ScValJson),
  data: ScValJson,
});
export type DecodedEvent = z.infer<typeof DecodedEvent>;

export const TransactionTrace = z.object({
  schema_version: SchemaVersion,
  network: Network,
  tx_hash: TxHash,
  ledger: LedgerSeq,
  closed_at: z.string().datetime(),
  successful: z.boolean(),
  source_account: z.string(), // G or M strkey
  fee_bump: z.object({ fee_source: z.string() }).optional(),
  operations: z.array(z.object({ type: z.string(), detail: z.unknown() })),
  host_function: z.unknown().optional(),
  auth_entries: z.array(AuthEntryTrace),
  events: z.array(DecodedEvent),
  token_deltas: z.array(TokenDelta),
  raw: z.object({
    envelope_xdr: XdrBase64,
    result_xdr: XdrBase64.optional(),
    result_meta_xdr: XdrBase64.optional(),
  }),
});
export type TransactionTrace = z.infer<typeof TransactionTrace>;
