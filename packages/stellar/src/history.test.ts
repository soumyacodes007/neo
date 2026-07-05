import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { toContractId, toLedgerSeq, toTxHash, type LedgerSeq } from "@ozpb/core";
import {
  MergingHistoryProvider,
  type Coverage,
  type HistoryProvider,
  type ProviderKind,
  type RawTx,
} from "./history.js";

const C = toContractId(StrKey.encodeContract(Buffer.alloc(32, 7)));

// Valid 64-hex tx hashes; `h(n)` is stable and sortable.
const h = (n: number): string => n.toString(16).padStart(2, "0").repeat(32);
const H1 = h(1);
const H2 = h(2);
const H3 = h(3);

function raw(hash: string, ledger: number, provider: ProviderKind): RawTx {
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
  txByHash(): Promise<RawTx | null> {
    return Promise.resolve(null);
  }
  async *txsBySigner(params: { from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    for (const t of this.txs) if (t.ledger >= params.from && t.ledger <= params.to) yield t;
  }
  async *txsByContract(params: { from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx> {
    for (const t of this.txs) if (t.ledger >= params.from && t.ledger <= params.to) yield t;
  }
}

describe("MergingHistoryProvider (FN-ST.8)", () => {
  it("dedups across providers, RPC winning ties, sorted by ledger", async () => {
    const rpc = new FakeProvider("rpc", { oldest: 900, newest: 1000 }, [raw(H2, 950, "rpc"), raw(H3, 990, "rpc")]);
    const hubble = new FakeProvider("hubble", { oldest: 0, newest: 1000 }, [
      raw(H1, 100, "hubble"),
      raw(H2, 950, "hubble"), // duplicate of rpc's h2 — rpc must win
    ]);
    const merged = new MergingHistoryProvider([hubble, rpc]);
    const res = await merged.txsByContract({ contract: C, from: toLedgerSeq(0), to: toLedgerSeq(1000) });
    expect(res.txs.map((t) => t.hash)).toEqual([H1, H2, H3]);
    expect(res.txs.find((t) => t.hash === H2)?.provider).toBe("rpc");
    expect(res.partial).toBe(false);
    expect(res.providersUsed).toEqual(["rpc", "hubble"]);
  });

  it("raises window-exceeded on a coverage gap", async () => {
    const rpc = new FakeProvider("rpc", { oldest: 900, newest: 1000 }, []);
    const merged = new MergingHistoryProvider([rpc]);
    await expect(
      merged.txsByContract({ contract: C, from: toLedgerSeq(0), to: toLedgerSeq(1000) }),
    ).rejects.toMatchObject({ code: "E_HISTORY_WINDOW_EXCEEDED" });
  });

  it("allow_partial stamps the real covered window", async () => {
    const rpc = new FakeProvider("rpc", { oldest: 900, newest: 1000 }, [raw(H1, 950, "rpc")]);
    const merged = new MergingHistoryProvider([rpc]);
    const res = await merged.txsByContract({
      contract: C,
      from: toLedgerSeq(0),
      to: toLedgerSeq(1000),
      allowPartial: true,
    });
    expect(res.partial).toBe(true);
    expect(res.windowCovered).toEqual({ from: 900, to: 1000 });
  });

  it("supports signer-window lookup with the same provider priority", async () => {
    const rpc = new FakeProvider("rpc", { oldest: 900, newest: 1000 }, [raw(H2, 950, "rpc")]);
    const hubble = new FakeProvider("hubble", { oldest: 0, newest: 1000 }, [raw(H1, 100, "hubble"), raw(H2, 950, "hubble")]);
    const merged = new MergingHistoryProvider([hubble, rpc]);
    const res = await merged.txsBySigner({ account: C, from: toLedgerSeq(0), to: toLedgerSeq(1000) });
    expect(res.txs.map((t) => t.hash)).toEqual([H1, H2]);
    expect(res.txs.find((t) => t.hash === H2)?.provider).toBe("rpc");
  });
});
