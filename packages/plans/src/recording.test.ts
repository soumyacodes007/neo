import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, toLedgerSeq, toTxHash, toXdrBase64, type TransactionTrace } from "@ozpb/core";
import { recordTransactionEvidence } from "./recording.js";

const ACCOUNT = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const TARGET = toContractId(StrKey.encodeContract(Buffer.alloc(32, 2)));
const ARG = { type: "scvSymbol", value: "claim", xdr_b64: toXdrBase64("AAAADwAAAAVjbGFpbQAAAA==") };

function simulatedTrace(): TransactionTrace {
  return {
    schema_version: "1",
    network: "testnet",
    tx_hash: toTxHash("11".repeat(32)),
    ledger: toLedgerSeq(123),
    closed_at: "2026-07-08T00:00:00.000Z",
    successful: true,
    source_account: ACCOUNT,
    operations: [{ type: "invokeHostFunction", detail: {} }],
    auth_entries: [{
      credentials: { kind: "source_account" },
      root_invocation: {
        contract: TARGET,
        fn_name: "claim",
        args: [ARG],
        sub_invocations: [],
      },
    }],
    events: [],
    token_deltas: [],
    raw: { envelope_xdr: toXdrBase64("AAAA") },
  };
}

describe("recordTransactionEvidence", () => {
  it("normalizes a decoded local simulated trace into the same evidence artifact as a recorded tx", async () => {
    const artifact = await recordTransactionEvidence(
      { account: ACCOUNT, polarity: "positive", source: { kind: "simulated_trace", trace: simulatedTrace() } },
      { network: "testnet", now: () => "2026-07-08T00:00:00.000Z" },
    );

    expect(artifact.source_kind).toBe("simulated_trace");
    expect(artifact.recording_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.evidence.account).toBe(ACCOUNT);
    expect(artifact.evidence.contexts).toHaveLength(1);
    expect(artifact.evidence.contexts[0]?.contract).toBe(TARGET);
    expect(artifact.evidence.contexts[0]?.fn_name).toBe("claim");
  });

  it("requires rpc only for tx_hash recording, not local simulated traces", async () => {
    await expect(recordTransactionEvidence(
      { account: ACCOUNT, polarity: "positive", source: { kind: "tx_hash", tx_hash: "22".repeat(32) } },
      { network: "testnet", now: () => "2026-07-08T00:00:00.000Z" },
    )).rejects.toMatchObject({ code: "E_NET_RPC_UNAVAILABLE" });
  });
});
