import { describe, expect, it } from "vitest";
import { samplePayload, sampleResult } from "./testkit.js";
import { verifySigningResult } from "./verify-signed-xdr.js";

describe("verifySigningResult", () => {
  it("T-WB.step-coverage: missing or duplicate signed step rejected", () => {
    const payload = samplePayload();
    const result = sampleResult("sid-1");
    result.signed_steps = [];

    expect(verifySigningResult(payload, result).ok).toBe(false);
  });

  it("T-WB.tampered-plan-hash: mismatched plan hash rejected", () => {
    const payload = samplePayload();
    const result = sampleResult("sid-1");
    result.plan_hash = "b".repeat(64);

    expect(verifySigningResult(payload, result, "a".repeat(64))).toEqual({
      ok: false,
      error: "E_WALLET_BRIDGE_PLAN_HASH_MISMATCH",
    });
  });

  it("accepts a browser-submitted tx hash pinned to the step hash", () => {
    const payload = samplePayload();
    const result = sampleResult("sid-1", "a".repeat(64));
    result.signed_steps = [{
      order: 1,
      step_hash: payload.steps[0]?.step_hash ?? "",
      tx_hash: "b".repeat(64),
      ledger: 123,
    }];

    expect(verifySigningResult(payload, result, "a".repeat(64))).toEqual({ ok: true });
  });

  it("accepts real smart-account-kit passkey creation metadata", () => {
    const payload = samplePayload();
    const result = sampleResult("sid-1", "a".repeat(64));
    result.wallet = {
      sdk: "smart-account-kit",
      sdk_version: "0.2.10",
      signer_kind: "webauthn",
      public_signer_ref: "credential-base64url",
      public_key_hint: "04" + "a".repeat(128),
    };
    result.account = "C_ACCOUNT";
    result.signed_steps = [{
      order: 1,
      step_hash: payload.steps[0]?.step_hash ?? "",
      signed_xdr: "AAAA-signed-deploy-xdr",
      tx_hash: "b".repeat(64),
      ledger: 123,
    }];

    expect(verifySigningResult(payload, result, "a".repeat(64))).toEqual({ ok: true });
  });

  it("rejects smart-account-kit callbacks without a public signer ref", () => {
    const payload = samplePayload();
    const result = sampleResult("sid-1", "a".repeat(64));
    result.wallet = {
      sdk: "smart-account-kit",
      sdk_version: "0.2.10",
      signer_kind: "webauthn",
    };

    expect(verifySigningResult(payload, result, "a".repeat(64))).toEqual({
      ok: false,
      error: "E_WALLET_BRIDGE_MISSING_PUBLIC_SIGNER",
    });
  });

  it("rejects callbacks for the wrong expected account or signer kind", () => {
    const payload = samplePayload({
      expected_signer: {
        account: "CAQDTHE55MGS5XX5GV7QSWXM4BKXCUF5D2E5CHH6T2UDU4NP7Z3O62HG",
        signer_kind: "webauthn",
      },
    });
    const result = sampleResult("sid-1", "a".repeat(64));
    result.account = "CBQDTHE55MGS5XX5GV7QSWXM4BKXCUF5D2E5CHH6T2UDU4NP7Z3O62HH";
    expect(verifySigningResult(payload, result, "a".repeat(64))).toEqual({
      ok: false,
      error: "E_WALLET_BRIDGE_ACCOUNT_MISMATCH",
    });

    result.account = "CAQDTHE55MGS5XX5GV7QSWXM4BKXCUF5D2E5CHH6T2UDU4NP7Z3O62HG";
    result.wallet.signer_kind = "ed25519";
    expect(verifySigningResult(payload, result, "a".repeat(64))).toEqual({
      ok: false,
      error: "E_WALLET_BRIDGE_SIGNER_KIND_MISMATCH",
    });
  });
});
