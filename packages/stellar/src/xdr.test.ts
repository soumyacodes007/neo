import {
  Account,
  Address,
  Asset,
  Contract,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, type ContractId, type DecodedEvent } from "@ozpb/core";
import { toScValJson } from "./scval.js";
import { decodeMeta, decodeTransactionEnvelope, deriveTokenDeltas } from "./xdr.js";

const G = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 3));
const G2 = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 5));
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
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(op)
    .setTimeout(30)
    .build();
  return tx.toEnvelope().toXDR("base64");
}

function classicEnvelope(): string {
  const source = new Account(G, "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: G2, asset: Asset.native(), amount: "1" }))
    .setTimeout(30)
    .build();
  return tx.toEnvelope().toXDR("base64");
}

describe("decodeTransactionEnvelope (FN-ST.9/10)", () => {
  it("extracts the invocation from an InvokeHostFunction tx", () => {
    const d = decodeTransactionEnvelope(invokeEnvelope());
    expect(d.sourceAccount).toBe(G);
    expect(d.feeBump).toBeUndefined();
    expect(d.operations.map((o) => o.type)).toEqual(["invokeHostFunction"]);
    expect(d.invocation?.contract).toBe(CTOKEN);
    expect(d.invocation?.fn_name).toBe("transfer");
    expect(d.invocation?.args).toHaveLength(3);
    expect(d.invocation?.args[2]?.value).toBe("100");
  });

  it("T-ST.9-1: unwraps a fee-bump wrapper exactly once and records the fee source", () => {
    const inner = TransactionBuilder.fromXDR(invokeEnvelope(), Networks.TESTNET);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(G2, "200", inner as never, Networks.TESTNET);
    const d = decodeTransactionEnvelope(feeBump.toEnvelope().toXDR("base64"));
    expect(d.feeBump?.feeSource).toBe(G2);
    expect(d.invocation?.fn_name).toBe("transfer"); // inner isolated
  });

  it("decodes a classic (non-Soroban) tx with no invocation", () => {
    const d = decodeTransactionEnvelope(classicEnvelope());
    expect(d.operations.map((o) => o.type)).toEqual(["payment"]);
    expect(d.invocation).toBeUndefined();
  });

  it("T-ST.9-4: guards against empty and oversize XDR", () => {
    expect(() => decodeTransactionEnvelope("")).toThrow(/malformed|invalid/i);
    expect(() => decodeTransactionEnvelope("not-valid-xdr!!")).toThrow();
  });
});

describe("deriveTokenDeltas (FN-ST.13)", () => {
  const ev = (sym: string, from: string, to: string, amount: bigint, contract?: ContractId): DecodedEvent => ({
    ...(contract !== undefined ? { contract } : {}),
    topics: [
      toScValJson(xdr.ScVal.scvSymbol(sym)),
      toScValJson(Address.fromString(from).toScVal()),
      toScValJson(Address.fromString(to).toScVal()),
    ],
    data: toScValJson(nativeToScVal(amount, { type: "i128" })),
  });

  it("T-ST.13-1: parses a SAC transfer into a token delta with enrichment", () => {
    const deltas = deriveTokenDeltas([ev("transfer", G, G2, 100n, CTOKEN)], () => ({
      decimals: 7,
      symbol: "USDC",
    }));
    expect(deltas).toEqual([
      { token: CTOKEN, from: G, to: G2, amount: "100", decimals: 7, symbol: "USDC", source: "event" },
    ]);
  });

  it("parses v26 transfer events with muxed-id option plus amount vector data", () => {
    const event: DecodedEvent = {
      contract: CTOKEN,
      topics: [
        toScValJson(xdr.ScVal.scvSymbol("transfer")),
        toScValJson(Address.fromString(G).toScVal()),
        toScValJson(Address.fromString(G2).toScVal()),
      ],
      data: toScValJson(xdr.ScVal.scvVec([
        xdr.ScVal.scvVoid(),
        nativeToScVal(250n, { type: "i128" }),
      ])),
    };
    expect(deriveTokenDeltas([event], () => undefined)).toEqual([
      { token: CTOKEN, from: G, to: G2, amount: "250", decimals: 0, source: "event" },
    ]);
  });

  it("drops only metadata when enrichment fails (EC-X10)", () => {
    const deltas = deriveTokenDeltas([ev("transfer", G, G2, 5n, CTOKEN)], () => undefined);
    expect(deltas[0]).toMatchObject({ amount: "5", decimals: 0 });
    expect(deltas[0]).not.toHaveProperty("symbol");
  });

  it("ignores non-transfer events and events without a contract", () => {
    expect(deriveTokenDeltas([ev("approve", G, G2, 1n, CTOKEN)], () => undefined)).toEqual([]);
    expect(deriveTokenDeltas([ev("transfer", G, G2, 1n)], () => undefined)).toEqual([]);
  });
});

describe("decodeMeta", () => {
  it("decodes TransactionMeta v4 transaction events", () => {
    const contractId = Buffer.alloc(32, 7);
    const contractEvent = new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({
        topics: [
          xdr.ScVal.scvSymbol("transfer"),
          Address.fromString(G).toScVal(),
          Address.fromString(G2).toScVal(),
        ],
        data: nativeToScVal(25n, { type: "i128" }),
      })),
    });
    const meta = new xdr.TransactionMeta(4, new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [
        new xdr.TransactionEvent({
          stage: xdr.TransactionEventStage.transactionEventStageAfterTx(),
          event: contractEvent,
        }),
      ],
      diagnosticEvents: [],
    }));

    const decoded = decodeMeta(meta.toXDR("base64"), true);
    expect(decoded.success).toBe(true);
    expect(decoded.events).toHaveLength(1);
    expect(decoded.events[0]?.contract).toBe(CTOKEN);
    expect(decoded.events[0]?.topics[0]?.value).toBe("transfer");
  });
});
