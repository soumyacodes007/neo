import { describe, expect, it } from "vitest";
import { ERROR_CODES, isToolError, runTool, toErrorEnvelope, ToolError } from "./errors.js";

describe("ToolError / taxonomy (Vol 01 §2.5)", () => {
  it("serializes to the wire envelope", () => {
    const e = new ToolError("E_HISTORY_WINDOW_EXCEEDED", "too far back", {
      details: { oldest: 100 },
      suggestion: "enable Hubble",
    });
    expect(e.toEnvelope()).toEqual({
      error: {
        code: "E_HISTORY_WINDOW_EXCEEDED",
        message: "too far back",
        details: { oldest: 100 },
        retryable: false,
        suggestion: "enable Hubble",
      },
    });
  });

  it("derives retryability from the E_NET_* family", () => {
    expect(new ToolError("E_NET_RPC_UNAVAILABLE", "x").retryable).toBe(true);
    expect(new ToolError("E_NET_RATE_LIMITED", "x").retryable).toBe(true);
    expect(new ToolError("E_INPUT_SCHEMA", "x").retryable).toBe(false);
  });

  it("allows an explicit retryable override", () => {
    expect(new ToolError("E_DATA_TX_NOT_FOUND", "x", { retryable: true }).retryable).toBe(true);
  });

  it("omits optional envelope fields when absent", () => {
    const env = new ToolError("E_INTERNAL", "boom").toEnvelope();
    expect(env.error).not.toHaveProperty("details");
    expect(env.error).not.toHaveProperty("suggestion");
  });

  it("is recognized by the type guard", () => {
    expect(isToolError(new ToolError("E_INTERNAL", "x"))).toBe(true);
    expect(isToolError(new Error("x"))).toBe(false);
  });

  it("every declared code is constructible and unique", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    for (const code of ERROR_CODES) {
      expect(new ToolError(code, "m").code).toBe(code);
    }
  });

  it("serializes unexpected exceptions as E_INTERNAL envelopes", () => {
    const env = toErrorEnvelope(new Error("boom"));
    expect(env.error).toEqual({
      code: "E_INTERNAL",
      message: "boom",
      retryable: false,
    });
  });

  it("runTool returns stable ok/error envelopes for agent adapters", async () => {
    await expect(runTool(() => 7)).resolves.toEqual({ ok: true, result: 7 });
    await expect(runTool(() => {
      throw new ToolError("E_DOMAIN_NO_EVIDENCE", "no evidence");
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "E_DOMAIN_NO_EVIDENCE",
        message: "no evidence",
        retryable: false,
      },
    });
  });
});
