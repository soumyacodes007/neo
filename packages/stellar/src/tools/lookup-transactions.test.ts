import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, toLedgerSeq, toTxHash, type LedgerSeq } from "@ozpb/core";
import {
  MergingHistoryProvider,
  type Coverage,
  type HistoryProvider,
  type ProviderKind,
  type RawTx,
} from "../history.js";
import { lookupTransactions } from "./lookup-transactions.js";

const C = toContractId(StrKey.encodeContract(Buffer.alloc(32, 7)));
const h = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);

function raw(hash: string, ledger: number, provider: ProviderKind = "rpc"): RawTx {
  return { hash: toTxHash(hash), ledger: toLedgerSeq(ledger), createdAt: 0, envelopeXdr: "e", provider };
}

class FakeProvider implements HistoryProvider {
  constructor(
    readonly kind: ProviderKind,
    private readonly cov: { oldest: number; newest: number },
    private readonly txs: RawTx[],
  ) {}
  coverage(): Promise<Coverage> {
    return Promise.resolve({
      oldestLedger: toLedgerSeq(this.cov.oldest),
      newestLedger: toLedgerSeq(this.cov.newest),
      asOf: "2026-07-05T00:00:00.000Z",
    });
  }
  txByHash(hash: string): Promise<RawTx | null> {
    return Promise.resolve(this.txs.find((t) => t.hash === hash) ?? null);
  }
  async *txsByContract(params: { from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    for (const t of this.txs) if (t.ledger >= params.from && t.ledger <= params.to) yield t;
  }
}

describe("lookupTransactions (A3)", () => {
  it("resolves a contract window and stamps coverage", async () => {
    const provider = new FakeProvider("rpc", { oldest: 0, newest: 1000 }, [raw(h(1), 100), raw(h(2), 900)]);
    const res = await lookupTransactions(
      { by: { contract: C, window: { ledgers: 1000 } } },
      { history: new MergingHistoryProvider([provider]), currentLedger: 1000 },
    );
    expect(res.records.map((r) => r.hash)).toEqual([h(1), h(2)]);
    expect(res.window_covered).toEqual({ from_ledger: 0, to_ledger: 1000 });
    expect(res.partial).toBe(false);
  });

  it("looks up hashes, marking not-found as partial (EC-R05)", async () => {
    const provider = new FakeProvider("rpc", { oldest: 0, newest: 1000 }, [raw(h(1), 100)]);
    const res = await lookupTransactions(
      { by: { hashes: [h(1), h(2)] } },
      { history: new MergingHistoryProvider([provider]), currentLedger: 1000 },
    );
    expect(res.records.find((r) => r.hash === h(1))?.found).toBe(true);
    expect(res.records.find((r) => r.hash === h(2))?.found).toBe(false);
    expect(res.partial).toBe(true);
  });

  it("converts a {days} window and raises window-exceeded past retention", async () => {
    const provider = new FakeProvider("rpc", { oldest: 990, newest: 1000 }, []);
    await expect(
      lookupTransactions(
        { by: { contract: C, window: { days: 30 } } }, // 30d ≫ 10-ledger coverage
        { history: new MergingHistoryProvider([provider]), currentLedger: 1000 },
      ),
    ).rejects.toMatchObject({ code: "E_HISTORY_WINDOW_EXCEEDED" });
  });
});
