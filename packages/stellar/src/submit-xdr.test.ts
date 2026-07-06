import { Account, Asset, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { submitSignedXdrWithBackend } from "./submit-xdr.js";

const SOURCE = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const DESTINATION = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));

function signedXdr(): string {
  return new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: DESTINATION, asset: Asset.native(), amount: "1" }))
    .setTimeout(30)
    .build()
    .toEnvelope()
    .toXDR("base64");
}

describe("submitSignedXdrWithBackend", () => {
  it("submits a signed XDR and polls the final ledger", async () => {
    let sent = false;
    const result = await submitSignedXdrWithBackend(
      {
        signed_xdr: signedXdr(),
        network_passphrase: Networks.TESTNET,
      },
      {
        async sendTransaction(transaction) {
          sent = true;
          expect(transaction.operations).toHaveLength(1);
          return { status: "PENDING", hash: "a".repeat(64) };
        },
        async pollTransaction(hash, options) {
          expect(hash).toBe("a".repeat(64));
          expect(options.attempts).toBe(10);
          return { status: "SUCCESS", ledger: 123 };
        },
      },
    );

    expect(sent).toBe(true);
    expect(result).toEqual({ success: true, hash: "a".repeat(64), status: "SUCCESS", ledger: 123 });
  });

  it("rejects malformed transaction XDR before submission", async () => {
    await expect(
      submitSignedXdrWithBackend(
        {
          signed_xdr: "not-xdr",
          network_passphrase: Networks.TESTNET,
        },
        {
          async sendTransaction() {
            throw new Error("must not submit");
          },
          async pollTransaction() {
            throw new Error("must not poll");
          },
        },
      ),
    ).rejects.toThrow(/valid transaction envelope/iu);
  });
});
