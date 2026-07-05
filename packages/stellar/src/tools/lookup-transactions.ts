/**
 * A3 — `lookup-transactions` (Vol 04). Find transactions by hash, or by contract
 * over a ledger/time window, via the best available history provider. Fails
 * explicitly with `E_HISTORY_WINDOW_EXCEEDED` when the window exceeds retention
 * rather than silently truncating (EC-R01); `allow_partial` stamps the real
 * covered window.
 */
import { ToolError, toLedgerSeq, toTxHash, type LedgerSeq, type TxHash } from "@ozpb/core";
import type { ContractId } from "@ozpb/core";
import type { MergingHistoryProvider, ProviderKind, RawTx } from "../history.js";
import { assertContractId } from "../address.js";

const LEDGERS_PER_DAY = 17280;

export interface LookupDeps {
  history: MergingHistoryProvider;
  /** Current ledger, used to resolve `{days}` windows (EC-U05). */
  currentLedger: number;
}

export type LookupInput =
  | { by: { hashes: string[] } }
  | { by: { contract: string; window: { ledgers: number } | { days: number } }; allow_partial?: boolean };

export interface TxRecord {
  hash: TxHash;
  ledger: LedgerSeq;
  provider: ProviderKind;
  found: boolean;
}

export interface LookupResult {
  records: TxRecord[];
  window_covered: { from_ledger: LedgerSeq; to_ledger: LedgerSeq } | undefined;
  providers_used: ProviderKind[];
  partial: boolean;
}

export async function lookupTransactions(input: LookupInput, deps: LookupDeps): Promise<LookupResult> {
  const by = input.by;
  if ("hashes" in by) {
    return lookupByHashes(by.hashes, deps);
  }
  const allowPartial = "allow_partial" in input ? input.allow_partial ?? false : false;
  return lookupByContract(by.contract, by.window, allowPartial, deps);
}

async function lookupByHashes(hashes: string[], deps: LookupDeps): Promise<LookupResult> {
  const records: TxRecord[] = [];
  const providers = new Set<ProviderKind>();
  for (const raw of hashes) {
    const hash = toTxHash(raw);
    const tx = await deps.history.txByHash(hash);
    if (tx === null) {
      // Per-hash not-found is a partial result, not a hard error (EC-R05).
      records.push({ hash, ledger: toLedgerSeq(0), provider: "rpc", found: false });
    } else {
      providers.add(tx.provider);
      records.push({ hash, ledger: tx.ledger, provider: tx.provider, found: true });
    }
  }
  return {
    records: records.sort(byLedgerThenHash),
    window_covered: undefined,
    providers_used: [...providers],
    partial: records.some((r) => !r.found),
  };
}

async function lookupByContract(
  contract: string,
  window: { ledgers: number } | { days: number },
  allowPartial: boolean,
  deps: LookupDeps,
): Promise<LookupResult> {
  const target: ContractId = assertContractId(contract);
  const spanLedgers = "days" in window ? window.days * LEDGERS_PER_DAY : window.ledgers;
  const to = deps.currentLedger;
  const from = Math.max(0, to - spanLedgers);
  if (spanLedgers <= 0) {
    throw new ToolError("E_INPUT_SCHEMA", "window must be positive");
  }
  const res = await deps.history.txsByContract({
    contract: target,
    from: toLedgerSeq(from),
    to: toLedgerSeq(to),
    allowPartial,
  });
  return {
    records: res.txs
      .map((tx: RawTx): TxRecord => ({ hash: tx.hash, ledger: tx.ledger, provider: tx.provider, found: true }))
      .sort(byLedgerThenHash),
    window_covered: { from_ledger: res.windowCovered.from, to_ledger: res.windowCovered.to },
    providers_used: res.providersUsed,
    partial: res.partial,
  };
}

function byLedgerThenHash(a: TxRecord, b: TxRecord): number {
  return a.ledger - b.ledger || a.hash.localeCompare(b.hash);
}
