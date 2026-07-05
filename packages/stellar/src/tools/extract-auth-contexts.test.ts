import { StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, toLedgerSeq, toTxHash, type ScValJson, type TransactionTrace } from "@ozpb/core";
import { extractAuthContexts } from "./extract-auth-contexts.js";

const C_ACCOUNT = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const C_BLEND = toContractId(StrKey.encodeContract(Buffer.alloc(32, 2)));
const C_USDC = toContractId(StrKey.encodeContract(Buffer.alloc(32, 3)));
const TX = toTxHash("ab".repeat(32));

const scv = (v: xdr.ScVal): ScValJson => ({
  type: v.switch().name,
  value: v.switch().name === "scvI128" ? v.i128().lo().toString() : v.switch().name,
  xdr_b64: v.toXDR("base64") as ScValJson["xdr_b64"],
});

function trace(overrides: Partial<TransactionTrace> = {}): TransactionTrace {
  const amount = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("500") }));
  return {
    schema_version: "1",
    network: "testnet",
    tx_hash: TX,
    ledger: toLedgerSeq(5000),
    closed_at: "2026-07-05T00:00:00.000Z",
    successful: true,
    source_account: "G".padEnd(56, "A"),
    operations: [],
    auth_entries: [
      {
        credentials: { kind: "address", address: C_ACCOUNT, nonce: "1", signature_expiration_ledger: toLedgerSeq(6000) },
        root_invocation: {
          contract: C_BLEND,
          fn_name: "submit",
          args: [scv(xdr.ScVal.scvU32(1))],
          sub_invocations: [{ contract: C_USDC, fn_name: "transfer", args: [scv(amount)], sub_invocations: [] }],
        },
      },
    ],
    events: [],
    token_deltas: [{ token: C_USDC, from: C_ACCOUNT, to: C_BLEND, amount: "500" as never, decimals: 7, symbol: "USDC", source: "event" }],
    raw: { envelope_xdr: "AAAAAA==" as never },
    ...overrides,
  };
}

describe("extractAuthContexts (B1)", () => {
  it("extracts root and sub-invocation contexts with evidence hash", () => {
    const set = extractAuthContexts({
      account: C_ACCOUNT,
      polarity: "positive",
      traces: [trace()],
      interface_hints: [{ contract: C_USDC, kind: "sac", trusted: true, functions: [{ name: "transfer", args: [{ name: "amount", sc_type: "I128" }] }] }],
    });
    expect(set.contexts.map((c) => `${c.contract}:${c.fn_name}`).sort()).toEqual([
      `${C_BLEND}:submit`,
      `${C_USDC}:transfer`,
    ]);
    const transfer = set.contexts.find((c) => c.contract === C_USDC)!;
    expect(transfer.depth).toBe("sub");
    expect(transfer.arg_summary[0]?.name).toBe("amount");
    expect(transfer.arg_summary[0]?.numeric_range).toEqual({ min: "500", max: "500" });
    expect(transfer.token_meta?.symbol).toBe("USDC");
    expect(set.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects failed traces as positive evidence", () => {
    expect(() => extractAuthContexts({ account: C_ACCOUNT, polarity: "positive", traces: [trace({ successful: false })] })).toThrowError(
      expect.objectContaining({ code: "E_S03_FAILED_TX_AS_POSITIVE" }),
    );
  });
});
