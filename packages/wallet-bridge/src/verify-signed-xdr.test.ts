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
});
