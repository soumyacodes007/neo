/**
 * HistoryProvider (Vol 03 §2, FN-ST.8).
 *
 * Transaction lookback across providers with differing retention: RPC (~24h),
 * Hubble/BigQuery (deep), stellar.expert (contract-scoped). The merging provider
 * unions coverage, prefers the freshest provider, dedups by hash, and raises
 * `E_HISTORY_WINDOW_EXCEEDED` when the union cannot cover the request unless
 * `allow_partial` is set (EC-R01/R04).
 */
import { ToolError, type ContractId, type LedgerSeq, type SignerModel, type TxHash } from "@ozpb/core";

export type ProviderKind = "rpc" | "hubble" | "stellar_expert";

export interface RawTx {
  hash: TxHash;
  ledger: LedgerSeq;
  createdAt: number;
  envelopeXdr: string;
  resultXdr?: string;
  resultMetaXdr?: string;
  provider: ProviderKind;
  asOfLedger?: LedgerSeq;
  freshness?: "fresh" | "delayed" | "archive";
}

export interface Coverage {
  oldestLedger: LedgerSeq;
  newestLedger: LedgerSeq;
  asOf: string;
}

export interface HistoryProvider {
  readonly kind: ProviderKind;
  coverage(): Promise<Coverage>;
  txByHash(hash: TxHash): Promise<RawTx | null>;
  txsBySigner(params: { account: ContractId; signer?: SignerModel; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx>;
  txsByContract(params: { contract: ContractId; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx>;
}

export interface WindowResult {
  txs: RawTx[];
  windowCovered: { from: LedgerSeq; to: LedgerSeq };
  providersUsed: ProviderKind[];
  partial: boolean;
}

/** Provider priority when the same tx appears from multiple sources (RPC freshest). */
const PRIORITY: Record<ProviderKind, number> = { rpc: 0, hubble: 1, stellar_expert: 2 };

export class MergingHistoryProvider {
  #providers: HistoryProvider[];

  constructor(providers: HistoryProvider[]) {
    // Deterministic order by priority (Vol 01 §2.6).
    this.#providers = [...providers].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
  }

  /** Fetch one tx by hash, trying providers in priority order (RPC first). */
  async txByHash(hash: TxHash): Promise<RawTx | null> {
    for (const provider of this.#providers) {
      const tx = await provider.txByHash(hash);
      if (tx !== null) return tx;
    }
    return null;
  }

  async coverageUnion(): Promise<{ oldest: LedgerSeq; newest: LedgerSeq }> {
    const covs = await Promise.all(this.#providers.map((p) => p.coverage()));
    const oldest = Math.min(...covs.map((c) => c.oldestLedger)) as LedgerSeq;
    const newest = Math.max(...covs.map((c) => c.newestLedger)) as LedgerSeq;
    return { oldest, newest };
  }

  /**
   * FN-ST.8 — gather a contract's history over `[from, to]`. Fails on a coverage
   * gap unless `allowPartial`, in which case the real covered window is stamped.
   */
  async txsByContract(params: {
    contract: ContractId;
    from: LedgerSeq;
    to: LedgerSeq;
    allowPartial?: boolean;
  }): Promise<WindowResult> {
    const { oldest, newest } = await this.coverageUnion();
    const covered = params.from >= oldest && params.to <= newest;
    if (!covered && params.allowPartial !== true) {
      throw new ToolError(
        "E_HISTORY_WINDOW_EXCEEDED",
        `requested window [${String(params.from)}, ${String(params.to)}] exceeds provider coverage [${String(oldest)}, ${String(newest)}] (EC-R01)`,
        { details: { oldest, newest }, suggestion: "enable a deep-history provider or set allow_partial" },
      );
    }
    const effFrom = Math.max(params.from, oldest) as LedgerSeq;
    const effTo = Math.min(params.to, newest) as LedgerSeq;

    const byHash = new Map<string, RawTx>();
    const providersUsed = new Set<ProviderKind>();
    for (const provider of this.#providers) {
      for await (const tx of provider.txsByContract({ contract: params.contract, from: effFrom, to: effTo })) {
        providersUsed.add(provider.kind);
        const existing = byHash.get(tx.hash);
        // First provider (highest priority) wins; ties never overwrite.
        if (existing === undefined) byHash.set(tx.hash, tx);
      }
    }
    const txs = [...byHash.values()].sort((a, b) => a.ledger - b.ledger || a.hash.localeCompare(b.hash));
    return {
      txs,
      windowCovered: { from: effFrom, to: effTo },
      providersUsed: [...providersUsed].sort((a, b) => PRIORITY[a] - PRIORITY[b]),
      partial: !covered,
    };
  }

  /** FN-ST.8 — signer/account history over [from, to], with the same coverage/dedup semantics. */
  async txsBySigner(params: {
    account: ContractId;
    signer?: SignerModel;
    from: LedgerSeq;
    to: LedgerSeq;
    allowPartial?: boolean;
  }): Promise<WindowResult> {
    const { oldest, newest } = await this.coverageUnion();
    const covered = params.from >= oldest && params.to <= newest;
    if (!covered && params.allowPartial !== true) {
      throw new ToolError(
        "E_HISTORY_WINDOW_EXCEEDED",
        `requested window [${String(params.from)}, ${String(params.to)}] exceeds provider coverage [${String(oldest)}, ${String(newest)}] (EC-R01)`,
        { details: { oldest, newest }, suggestion: "enable a deep-history provider or set allow_partial" },
      );
    }
    const effFrom = Math.max(params.from, oldest) as LedgerSeq;
    const effTo = Math.min(params.to, newest) as LedgerSeq;
    const byHash = new Map<string, RawTx>();
    const providersUsed = new Set<ProviderKind>();
    for (const provider of this.#providers) {
      const signerParams = {
        account: params.account,
        ...(params.signer !== undefined ? { signer: params.signer } : {}),
        from: effFrom,
        to: effTo,
      };
      for await (const tx of provider.txsBySigner(signerParams)) {
        providersUsed.add(provider.kind);
        if (!byHash.has(tx.hash)) byHash.set(tx.hash, tx);
      }
    }
    const txs = [...byHash.values()].sort((a, b) => a.ledger - b.ledger || a.hash.localeCompare(b.hash));
    return {
      txs,
      windowCovered: { from: effFrom, to: effTo },
      providersUsed: [...providersUsed].sort((a, b) => PRIORITY[a] - PRIORITY[b]),
      partial: !covered,
    };
  }
}

/** Injectable seam for Hubble/BigQuery without taking a hard dependency here. */
export interface HubbleQueryClient {
  coverage(): Promise<Coverage | null>;
  txByHash(hash: TxHash): Promise<RawTx | null>;
  txs(params: { account?: ContractId; contract?: ContractId; signer?: SignerModel; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx>;
}

export class HubbleHistoryProvider implements HistoryProvider {
  readonly kind = "hubble" as const;
  constructor(private readonly client: HubbleQueryClient) {}
  async coverage(): Promise<Coverage> {
    return (await this.client.coverage()) ?? zeroCoverage();
  }
  txByHash(hash: TxHash): Promise<RawTx | null> {
    return this.client.txByHash(hash);
  }
  txsBySigner(params: { account: ContractId; signer?: SignerModel; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    return this.client.txs(params);
  }
  txsByContract(params: { contract: ContractId; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    return this.client.txs(params);
  }
}

export interface StellarExpertClient {
  coverage(): Promise<Coverage | null>;
  txByHash(hash: TxHash): Promise<RawTx | null>;
  txsByContract(params: { contract: ContractId; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx>;
}

export class StellarExpertHistoryProvider implements HistoryProvider {
  readonly kind = "stellar_expert" as const;
  constructor(private readonly client: StellarExpertClient) {}
  async coverage(): Promise<Coverage> {
    return (await this.client.coverage()) ?? zeroCoverage();
  }
  txByHash(hash: TxHash): Promise<RawTx | null> {
    return this.client.txByHash(hash);
  }
  async *txsBySigner(_params: { account: ContractId; signer?: SignerModel; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    // stellar.expert is contract-scoped in this implementation; signer search is Hubble/RPC.
  }
  txsByContract(params: { contract: ContractId; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    return this.client.txsByContract(params);
  }
}

function zeroCoverage(): Coverage {
  return { oldestLedger: 1 as LedgerSeq, newestLedger: 0 as LedgerSeq, asOf: "1970-01-01T00:00:00.000Z" };
}
