import { describe, expect, it } from "vitest";
import { toTxHash } from "@ozpb/core";
import { contextRuleDataKey } from "./keys.js";
import {
  RpcClient,
  type RawLedgerEntriesResponse,
  type RawTransaction,
  type RawTxPage,
  type RpcBackend,
} from "./rpc.js";
import { StrKey } from "@stellar/stellar-sdk";
import { toContractId } from "@ozpb/core";

const C = toContractId(StrKey.encodeContract(Buffer.alloc(32, 7)));

class FakeBackend implements RpcBackend {
  batchSizes: number[] = [];
  ledgerQueue: number[] = [];
  entriesFor: (keysB64: string[], latest: number) => RawLedgerEntriesResponse["entries"] = () => [];
  txByHash: Record<string, RawTransaction> = {};
  pages: RawTxPage[] = [];
  #pageIdx = 0;

  getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }> {
    return Promise.resolve({ sequence: 1000, protocolVersion: 22, id: "abc" });
  }
  getLedgerEntries(keysB64: string[]): Promise<RawLedgerEntriesResponse> {
    this.batchSizes.push(keysB64.length);
    const latestLedger = this.ledgerQueue.length > 0 ? this.ledgerQueue.shift()! : 1000;
    return Promise.resolve({ latestLedger, entries: this.entriesFor(keysB64, latestLedger) });
  }
  getTransaction(hash: string): Promise<RawTransaction> {
    return Promise.resolve(this.txByHash[hash] ?? { status: "NOT_FOUND" });
  }
  getTransactions(): Promise<RawTxPage> {
    const page = this.pages[this.#pageIdx] ?? { transactions: [], cursor: undefined, latestLedger: 1000, oldestLedger: 0 };
    this.#pageIdx += 1;
    return Promise.resolve(page);
  }
}

describe("RpcClient budget (FN-ST.1 / EC-R03)", () => {
  it("T-ST.1-1: exhausting the budget raises E_NET_BUDGET", async () => {
    const c = RpcClient.create(new FakeBackend(), { budget: 2 });
    await c.getLatestLedger();
    await c.getLatestLedger();
    await expect(c.getLatestLedger()).rejects.toMatchObject({ code: "E_NET_BUDGET" });
  });
});

describe("getLedgerEntries (FN-ST.3)", () => {
  it("T-ST.3-1: chunks >200 keys into ≤200 batches", async () => {
    const fake = new FakeBackend();
    const c = RpcClient.create(fake, { budget: 100 });
    const keys = Array.from({ length: 250 }, (_v, i) => contextRuleDataKey(C, i));
    await c.getLedgerEntries(keys);
    expect(fake.batchSizes).toEqual([200, 50]);
  });

  it("T-ST.3-3/3-4: classifies live, archived, and absent", async () => {
    const fake = new FakeBackend();
    fake.entriesFor = (keysB64, latest) => [
      { keyB64: keysB64[0]!, xdrB64: "AAAA", liveUntilLedgerSeq: latest + 100 }, // live
      { keyB64: keysB64[1]!, xdrB64: "BBBB", liveUntilLedgerSeq: latest - 1 }, // archived
      // keysB64[2] omitted → absent
    ];
    const c = RpcClient.create(fake, { budget: 100 });
    const { entries } = await c.getLedgerEntries([
      contextRuleDataKey(C, 0),
      contextRuleDataKey(C, 1),
      contextRuleDataKey(C, 2),
    ]);
    expect(entries.map((e) => e.state)).toEqual(["live", "archived", "absent"]);
  });

  it("T-ST.3-2: divergent latestLedger across batches → torn-read error", async () => {
    const fake = new FakeBackend();
    // 250 keys → 2 batches per attempt; feed divergent ledgers on every attempt.
    fake.ledgerQueue = [1000, 1001, 1000, 1001, 1000, 1001];
    const c = RpcClient.create(fake, { budget: 100 });
    const keys = Array.from({ length: 250 }, (_v, i) => contextRuleDataKey(C, i));
    await expect(c.getLedgerEntries(keys)).rejects.toMatchObject({ code: "E_DATA_INCONSISTENT_SNAPSHOT" });
  });
});

describe("getTransaction (FN-ST.4 / EC-R05)", () => {
  it("distinguishes NOT_FOUND from SUCCESS/FAILED", async () => {
    const fake = new FakeBackend();
    const hash = toTxHash("ab".repeat(32));
    fake.txByHash[hash] = { status: "SUCCESS", ledger: 900, envelopeXdr: "env" };
    const c = RpcClient.create(fake, { budget: 100 });
    expect((await c.getTransaction(hash)).status).toBe("SUCCESS");
    await expect(c.getTransaction(toTxHash("cd".repeat(32)))).rejects.toMatchObject({
      code: "E_DATA_TX_NOT_FOUND",
    });
  });
});

describe("getTransactions (FN-ST.5 / EC-R01/R02)", () => {
  const tx = (hash: string, ledger: number): RawTxPage["transactions"][number] => ({
    hash,
    ledger,
    createdAt: 0,
    envelopeXdr: "e",
  });

  it("dedups by hash across overlapping pages", async () => {
    const fake = new FakeBackend();
    fake.pages = [
      { transactions: [tx("h1", 10), tx("h2", 11)], cursor: "c1", latestLedger: 20, oldestLedger: 0 },
      { transactions: [tx("h2", 11), tx("h3", 12)], cursor: undefined, latestLedger: 20, oldestLedger: 0 },
    ];
    const c = RpcClient.create(fake, { budget: 100 });
    const out: string[] = [];
    for await (const t of c.getTransactions({ startLedger: 5 })) out.push(t.hash);
    expect(out).toEqual(["h1", "h2", "h3"]);
  });

  it("T-ST.5-2: start before oldestLedger → window exceeded", async () => {
    const fake = new FakeBackend();
    fake.pages = [{ transactions: [], cursor: undefined, latestLedger: 20, oldestLedger: 15 }];
    const c = RpcClient.create(fake, { budget: 100 });
    const iter = c.getTransactions({ startLedger: 5 });
    await expect(iter.next()).rejects.toMatchObject({ code: "E_HISTORY_WINDOW_EXCEEDED" });
  });
});
