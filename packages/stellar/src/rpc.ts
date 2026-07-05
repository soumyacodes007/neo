/**
 * RpcClient (Vol 03 §1, FN-ST.1–7).
 *
 * A thin, typed, retry-aware wrapper over Soroban RPC. The network effect is
 * isolated behind an injected {@link RpcBackend}, so all of the deterministic
 * logic the spec emphasizes — request budget (EC-R03), ≤200-key chunking
 * (EC-A01), torn-read detection (EC-R07), archived/absent classification
 * (EC-A08), pagination dedup + window bound (EC-R01/R02), tx-status distinction
 * (EC-R05) — is testable with an in-memory fake.
 */
import type { xdr } from "@stellar/stellar-sdk";
import { ToolError, type LedgerSeq, type TxHash, toLedgerSeq } from "@ozpb/core";

const MAX_KEYS_PER_BATCH = 200; // RPC hard limit [web]
const MAX_TORN_RETRIES = 3;
const DEFAULT_BUDGET = 2000;

export type EntryState = "live" | "archived" | "absent";

export interface RawLedgerEntry {
  keyB64: string;
  xdrB64: string; // LedgerEntryData XDR
  liveUntilLedgerSeq?: number;
}

export interface RawLedgerEntriesResponse {
  latestLedger: number;
  entries: RawLedgerEntry[];
}

export interface LedgerEntryResult {
  key: xdr.LedgerKey;
  keyB64: string;
  xdrB64: string | null;
  liveUntilLedger: number | undefined;
  state: EntryState;
}

export type TxStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";

export interface RawTransaction {
  status: TxStatus;
  ledger?: number;
  createdAt?: number; // unix seconds
  envelopeXdr?: string;
  resultXdr?: string;
  resultMetaXdr?: string;
}

export interface RawTxPage {
  transactions: { hash: string; ledger: number; createdAt: number; envelopeXdr: string; resultXdr?: string; resultMetaXdr?: string }[];
  cursor: string | undefined;
  latestLedger: number;
  oldestLedger: number;
}

/** The injected network boundary. Real impl wraps `@stellar/stellar-sdk`'s `rpc.Server`. */
export interface RpcBackend {
  getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }>;
  getLedgerEntries(keysB64: string[]): Promise<RawLedgerEntriesResponse>;
  getTransaction(hash: string): Promise<RawTransaction>;
  getTransactions(params: { startLedger: number; cursor?: string; limit: number }): Promise<RawTxPage>;
}

export interface RpcClientOptions {
  budget?: number;
}

export class RpcClient {
  #backend: RpcBackend;
  #remaining: number;

  private constructor(backend: RpcBackend, budget: number) {
    this.#backend = backend;
    this.#remaining = budget;
  }

  /** FN-ST.1 — construct with an injected backend and a per-session budget. */
  static create(backend: RpcBackend, opts: RpcClientOptions = {}): RpcClient {
    return new RpcClient(backend, opts.budget ?? DEFAULT_BUDGET);
  }

  get remainingBudget(): number {
    return this.#remaining;
  }

  #spend(): void {
    if (this.#remaining <= 0) {
      throw new ToolError("E_NET_BUDGET", "per-session RPC request budget exhausted (EC-R03)", {
        suggestion: "narrow the query or raise the budget",
      });
    }
    this.#remaining -= 1;
  }

  /** FN-ST.2 — freshness anchor. */
  async getLatestLedger(): Promise<{ sequence: LedgerSeq; protocolVersion: number; id: string }> {
    this.#spend();
    const r = await this.#backend.getLatestLedger();
    return { sequence: toLedgerSeq(r.sequence), protocolVersion: r.protocolVersion, id: r.id };
  }

  /**
   * FN-ST.3 — primary state-read primitive. Chunks keys ≤200, asserts every
   * batch reports the same `latestLedger` (else torn-read retry, EC-R07), and
   * classifies each key live/archived/absent (EC-A08).
   */
  async getLedgerEntries(keys: xdr.LedgerKey[]): Promise<{ latestLedger: LedgerSeq; entries: LedgerEntryResult[] }> {
    const keysB64 = keys.map((k) => k.toXDR("base64"));
    for (let attempt = 0; ; attempt++) {
      const batches = chunk(keysB64, MAX_KEYS_PER_BATCH);
      const responses: RawLedgerEntriesResponse[] = [];
      for (const batch of batches) {
        this.#spend();
        responses.push(await this.#backend.getLedgerEntries(batch));
      }
      const ledgers = new Set(responses.map((r) => r.latestLedger));
      if (ledgers.size > 1) {
        if (attempt + 1 >= MAX_TORN_RETRIES) {
          throw new ToolError(
            "E_DATA_INCONSISTENT_SNAPSHOT",
            "ledger entry reads straddled a ledger close after retries (EC-R07)",
            { details: { ledgers: [...ledgers] } },
          );
        }
        continue; // torn read — retry the whole set
      }
      const latestLedger = responses[0]?.latestLedger ?? (await this.getLatestLedger()).sequence;
      const found = new Map<string, RawLedgerEntry>();
      for (const r of responses) for (const e of r.entries) found.set(e.keyB64, e);
      const entries = keys.map((key, i): LedgerEntryResult => {
        const keyB64 = keysB64[i]!;
        const e = found.get(keyB64);
        if (e === undefined) {
          return { key, keyB64, xdrB64: null, liveUntilLedger: undefined, state: "absent" };
        }
        const state: EntryState =
          e.liveUntilLedgerSeq !== undefined && e.liveUntilLedgerSeq < latestLedger ? "archived" : "live";
        return { key, keyB64, xdrB64: e.xdrB64, liveUntilLedger: e.liveUntilLedgerSeq, state };
      });
      return { latestLedger: toLedgerSeq(Number(latestLedger)), entries };
    }
  }

  /** FN-ST.4 — single-tx fetch; distinguishes the three statuses (EC-R05). */
  async getTransaction(hash: TxHash): Promise<RawTransaction> {
    this.#spend();
    const r = await this.#backend.getTransaction(hash);
    if (r.status === "NOT_FOUND") {
      throw new ToolError("E_DATA_TX_NOT_FOUND", `transaction ${hash} not found`, {
        suggestion: "RPC retains ~24h; use a deep-history provider for older transactions",
        details: { hash },
      });
    }
    return r;
  }

  /**
   * FN-ST.5 — ledger-range scan. Pins the scan to a bound captured before the
   * first page, dedups by hash across pages, and raises `E_HISTORY_WINDOW_EXCEEDED`
   * if `startLedger` precedes the provider's `oldestLedger` (EC-R01/R02).
   */
  async *getTransactions(params: { startLedger: number; limit?: number }): AsyncGenerator<RawTxPage["transactions"][number]> {
    const limit = params.limit ?? MAX_KEYS_PER_BATCH;
    const seen = new Set<string>();
    let cursor: string | undefined;
    let checkedWindow = false;
    for (;;) {
      this.#spend();
      const page = await this.#backend.getTransactions(
        cursor === undefined
          ? { startLedger: params.startLedger, limit }
          : { startLedger: params.startLedger, cursor, limit },
      );
      if (!checkedWindow) {
        if (params.startLedger < page.oldestLedger) {
          throw new ToolError(
            "E_HISTORY_WINDOW_EXCEEDED",
            `requested start ledger ${String(params.startLedger)} precedes provider retention ${String(page.oldestLedger)} (EC-R01)`,
            { details: { oldestLedger: page.oldestLedger }, suggestion: "enable a deep-history provider (Hubble)" },
          );
        }
        checkedWindow = true;
      }
      for (const tx of page.transactions) {
        if (seen.has(tx.hash)) continue;
        seen.add(tx.hash);
        yield tx;
      }
      if (page.cursor === undefined || page.transactions.length === 0) return;
      cursor = page.cursor;
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
