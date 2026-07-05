import {
  Account,
  Address,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, toTxHash, type InvocationNodeT } from "@ozpb/core";
import { RpcClient, type RawTransaction, type RpcBackend } from "../rpc.js";
import { traceTransaction, type TraceDeps } from "./trace-transaction.js";

const G = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const CTOKEN = toContractId(StrKey.encodeContract(Buffer.alloc(32, 7)));
const CDEST = toContractId(StrKey.encodeContract(Buffer.alloc(32, 9)));

function invokeEnvelope(): string {
  const source = new Account(G, "0");
  const op = new Contract(CTOKEN).call(
    "transfer",
    Address.fromString(G).toScVal(),
    Address.fromString(CDEST).toScVal(),
    nativeToScVal(100n, { type: "i128" }),
  );
  return new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(30)
    .build()
    .toEnvelope()
    .toXDR("base64");
}

class TxBackend implements RpcBackend {
  constructor(private readonly tx: RawTransaction) {}
  getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }> {
    return Promise.resolve({ sequence: 1000, protocolVersion: 22, id: "x" });
  }
  getLedgerEntries(): Promise<never> {
    throw new Error("unused");
  }
  getTransaction(): Promise<RawTransaction> {
    return Promise.resolve(this.tx);
  }
  getTransactions(): Promise<never> {
    throw new Error("unused");
  }
}

const deps = (tx?: RawTransaction): TraceDeps => ({
  rpc: RpcClient.create(new TxBackend(tx ?? { status: "NOT_FOUND" })),
  network: "testnet",
  now: () => "2026-07-05T00:00:00.000Z",
});

describe("traceTransaction (A4)", () => {
  it("decodes an invoke tx from raw envelope XDR", async () => {
    const trace = await traceTransaction({ source: { envelope_xdr: invokeEnvelope() } }, deps());
    expect(trace.source_account).toBe(G);
    expect(trace.operations.map((o) => o.type)).toEqual(["invokeHostFunction"]);
    const hf = trace.host_function as InvocationNodeT;
    expect(hf.contract).toBe(CTOKEN);
    expect(hf.fn_name).toBe("transfer");
    expect(hf.args[2]?.value).toBe("100");
    expect(trace.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(trace.successful).toBe(true);
  });

  it("fetches by hash and maps SUCCESS", async () => {
    const hash = toTxHash("ab".repeat(32));
    const trace = await traceTransaction(
      { source: { tx_hash: hash } },
      deps({ status: "SUCCESS", ledger: 900, createdAt: 1_800_000_000, envelopeXdr: invokeEnvelope() }),
    );
    expect(trace.tx_hash).toBe(hash);
    expect(trace.ledger).toBe(900);
    expect(trace.successful).toBe(true);
  });

  it("T-A4.1-3: a FAILED tx still decodes, marked successful:false", async () => {
    const hash = toTxHash("cd".repeat(32));
    const trace = await traceTransaction(
      { source: { tx_hash: hash } },
      deps({ status: "FAILED", ledger: 901, envelopeXdr: invokeEnvelope() }),
    );
    expect(trace.successful).toBe(false);
  });

  it("rejects malformed envelope XDR", async () => {
    await expect(
      traceTransaction({ source: { envelope_xdr: "" } }, deps()),
    ).rejects.toMatchObject({ code: "E_DATA_MALFORMED_XDR" });
  });
});
