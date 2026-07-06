import { describe, expect, it } from "vitest";
import { SigningRequestStore } from "./request-store.js";
import { samplePayload, sampleResult } from "./testkit.js";

describe("SigningRequestStore", () => {
  it("T-WB.request-token-single-use: successful result consumes bearer", () => {
    const store = new SigningRequestStore(() => 1_000);
    const { request, bearer } = store.create({ kind: "sign_install_plan", network: "testnet", payload: samplePayload() });
    const result = sampleResult(request.sid);

    expect(store.complete(request.sid, bearer, result)?.status).toBe("completed");
    expect(store.getPublic(request.sid, bearer)).toBeUndefined();
  });

  it("T-WB.request-expiry: expired request rejects all endpoints", () => {
    let now = 1_000;
    const store = new SigningRequestStore(() => now);
    const { request, bearer } = store.create({
      kind: "sign_install_plan",
      network: "testnet",
      payload: samplePayload(),
      ttl_ms: 10,
    });
    now = 1_011;

    expect(store.getPublic(request.sid, bearer)).toBeUndefined();
    expect(store.get(request.sid)?.status).toBe("expired");
  });
});
