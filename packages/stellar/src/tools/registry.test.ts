import { describe, expect, it } from "vitest";
import { InMemoryRegistry, registerPbPolicies } from "./registry.js";

describe("registerPbPolicies (Vol 04 FN-A1.4)", () => {
  it("classifies registered pb WASM hashes and fails closed on unknowns", () => {
    const reg = registerPbPolicies(new InMemoryRegistry(), {
      "pb:function_allowlist": "aa".repeat(32),
      "pb:call_cap": "bb".repeat(32),
    });
    expect(reg.classifyPolicy("aa".repeat(32))).toBe("pb:function_allowlist");
    expect(reg.classifyPolicy("bb".repeat(32))).toBe("pb:call_cap");
    // A forked/upgraded deployment (unregistered hash) is never trusted.
    expect(reg.classifyPolicy("cc".repeat(32))).toBe("unknown");
  });
});
