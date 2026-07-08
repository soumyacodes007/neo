/**
 * A4 — `trace-transaction` (Vol 04). The deterministic recorder: fully decode
 * one transaction into a structured, lossless {@link TransactionTrace}. No
 * interpretation of argument meaning is performed (that is B-group's job). A
 * FAILED tx still decodes, marked `successful:false` (negative evidence only,
 * INV-Trace-2 / EC-S03).
 */
import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  TransactionTrace as TransactionTraceSchema,
  ToolError,
  toLedgerSeq,
  toTxHash,
  toXdrBase64,
  type ContractId,
  type Network,
  type TransactionTrace,
  type TxHash,
} from "@ozpb/core";
import { decodeAuthEntries, decodeMeta, decodeTransactionEnvelope, deriveTokenDeltas } from "../xdr.js";
import type { RpcClient } from "../rpc.js";

export interface TraceDeps {
  rpc?: RpcClient;
  network: Network;
  now: () => string;
  /** Optional token metadata lookup (symbol/decimals); failure drops metadata only. */
  enrich?: (token: ContractId) => { decimals: number; symbol?: string } | undefined;
}

export type TraceInput =
  | { source: { tx_hash: string } }
  | { source: { envelope_xdr: string; result_meta_xdr?: string } };

const PASSPHRASE: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  local: Networks.STANDALONE,
};

export async function traceTransaction(input: TraceInput, deps: TraceDeps): Promise<TransactionTrace> {
  const src = input.source;
  let envelopeXdr: string;
  let resultMetaXdr: string | undefined;
  let resultXdr: string | undefined;
  let ledger = 0;
  let closedAt = deps.now();
  let successful = true;
  let txHash: TxHash | undefined;

  if ("tx_hash" in src) {
    if (deps.rpc === undefined) {
      throw new ToolError("E_NET_RPC_UNAVAILABLE", "rpc client is required when tracing by transaction hash");
    }
    const hash = toTxHash(src.tx_hash);
    const tx = await deps.rpc.getTransaction(hash);
    if (tx.envelopeXdr === undefined) {
      throw new ToolError("E_DATA_MALFORMED_XDR", "transaction has no envelope XDR");
    }
    envelopeXdr = tx.envelopeXdr;
    resultMetaXdr = tx.resultMetaXdr;
    resultXdr = tx.resultXdr;
    successful = tx.status === "SUCCESS";
    ledger = tx.ledger ?? 0;
    closedAt = tx.createdAt !== undefined ? new Date(tx.createdAt * 1000).toISOString() : deps.now();
    txHash = hash;
  } else {
    envelopeXdr = src.envelope_xdr;
    resultMetaXdr = src.result_meta_xdr;
  }

  // Decode first (validates + emits ToolError on malformed XDR) before hashing.
  const decoded = decodeTransactionEnvelope(envelopeXdr);
  txHash ??= computeTxHash(envelopeXdr, deps.network);
  const authEntries = decodeAuthEntries(decoded.authEntries);
  const meta = decodeMeta(resultMetaXdr, successful);
  const enrich = deps.enrich ?? ((): undefined => undefined);
  const tokenDeltas = deriveTokenDeltas(meta.events, enrich);

  const trace = {
    schema_version: "1" as const,
    network: deps.network,
    tx_hash: txHash,
    ledger: toLedgerSeq(ledger),
    closed_at: closedAt,
    successful,
    source_account: decoded.sourceAccount,
    ...(decoded.feeBump !== undefined ? { fee_bump: { fee_source: decoded.feeBump.feeSource } } : {}),
    ...(decoded.invocation !== undefined ? { host_function: decoded.invocation } : {}),
    operations: decoded.operations,
    auth_entries: authEntries,
    events: meta.events,
    token_deltas: tokenDeltas,
    raw: {
      envelope_xdr: toXdrBase64(envelopeXdr),
      ...(resultXdr !== undefined ? { result_xdr: toXdrBase64(resultXdr) } : {}),
      ...(resultMetaXdr !== undefined ? { result_meta_xdr: toXdrBase64(resultMetaXdr) } : {}),
    },
  };
  return TransactionTraceSchema.parse(trace);
}

function computeTxHash(envelopeXdr: string, network: Network): TxHash {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, PASSPHRASE[network]);
  const inner = tx instanceof Transaction ? tx : (tx as { innerTransaction: Transaction }).innerTransaction;
  return toTxHash(inner.hash().toString("hex"));
}
