import { AuthContextSet, ToolError, TransactionTrace, canonicalHash, type ContractId, type JsonValue, type Network, type TransactionTrace as TransactionTraceT } from "@ozpb/core";
import { extractAuthContexts, traceTransaction, type RpcClient } from "@ozpb/stellar";

export type RecordingSource =
  | { kind: "tx_hash"; tx_hash: string }
  | { kind: "simulated_xdr"; envelope_xdr: string; result_meta_xdr?: string }
  | { kind: "simulated_trace"; trace: TransactionTraceT };

export interface RecordTransactionInput {
  account: string;
  source: RecordingSource;
  polarity: "positive" | "negative";
}

export interface RecordTransactionDeps {
  network: Network;
  now: () => string;
  rpc?: RpcClient;
  enrich?: (token: ContractId) => { decimals: number; symbol?: string } | undefined;
}

export interface RecordingArtifact {
  schema_version: "1";
  source_kind: RecordingSource["kind"];
  traces: TransactionTraceT[];
  evidence: AuthContextSet;
  recording_hash: string;
}

export async function recordTransactionEvidence(input: RecordTransactionInput, deps: RecordTransactionDeps): Promise<RecordingArtifact> {
  const trace = await traceFromSource(input.source, deps);
  const traces = [trace];
  const evidence = extractAuthContexts({ account: input.account, traces, polarity: input.polarity });
  const draft = {
    schema_version: "1" as const,
    source_kind: input.source.kind,
    traces,
    evidence,
  };
  return {
    ...draft,
    recording_hash: canonicalHash(draft as unknown as JsonValue),
  };
}

async function traceFromSource(source: RecordingSource, deps: RecordTransactionDeps): Promise<TransactionTraceT> {
  switch (source.kind) {
    case "tx_hash":
      if (deps.rpc === undefined) {
        throw new ToolError("E_NET_RPC_UNAVAILABLE", "rpc client is required when recording by transaction hash");
      }
      return traceTransaction(
        { source: { tx_hash: source.tx_hash } },
        { network: deps.network, now: deps.now, rpc: deps.rpc, ...(deps.enrich !== undefined ? { enrich: deps.enrich } : {}) },
      );
    case "simulated_xdr":
      return traceTransaction(
        { source: { envelope_xdr: source.envelope_xdr, ...(source.result_meta_xdr !== undefined ? { result_meta_xdr: source.result_meta_xdr } : {}) } },
        { network: deps.network, now: deps.now, ...(deps.rpc !== undefined ? { rpc: deps.rpc } : {}), ...(deps.enrich !== undefined ? { enrich: deps.enrich } : {}) },
      );
    case "simulated_trace":
      return TransactionTrace.parse(source.trace);
  }
}
