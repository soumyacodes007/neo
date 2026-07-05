import { xdr } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeAuthDigest, contextRuleIdsToXdr, mapContextsToRuleIds } from "./auth.js";

const payload = (byte: number): Buffer => Buffer.alloc(32, byte);

describe("computeAuthDigest (FN-ST.18 / EC-G01)", () => {
  it("matches sha256(payload ‖ context_rule_ids.to_xdr())", () => {
    const p = payload(0xaa);
    const ids = [0, 2];
    const idsXdr = xdr.ScVal.scvVec(ids.map((i) => xdr.ScVal.scvU32(i))).toXDR();
    const expected = createHash("sha256").update(p).update(idsXdr).digest();
    expect(computeAuthDigest(p, ids)).toEqual(expected);
    expect(computeAuthDigest(p, ids)).toHaveLength(32);
  });

  it("is deterministic and binds the rule-id selection", () => {
    const p = payload(1);
    expect(computeAuthDigest(p, [1]).toString("hex")).toBe(computeAuthDigest(p, [1]).toString("hex"));
    // Changing the selected rule ids changes the digest (rule-selection downgrade guard).
    expect(computeAuthDigest(p, [1]).toString("hex")).not.toBe(
      computeAuthDigest(p, [2]).toString("hex"),
    );
  });

  it("rejects a non-32-byte payload", () => {
    expect(() => computeAuthDigest(Buffer.alloc(16), [0])).toThrow(/32 bytes/);
  });

  it("encodes context rule ids as an ScVal::Vec<U32>", () => {
    const bytes = contextRuleIdsToXdr([3, 7]);
    const decoded = xdr.ScVal.fromXDR(bytes);
    expect(decoded.switch().name).toBe("scvVec");
    expect((decoded.vec() ?? []).map((v) => v.u32())).toEqual([3, 7]);
  });
});

describe("mapContextsToRuleIds (FN-ST.20)", () => {
  it("aligns ids by index with the simulated context order", () => {
    const ctxs = ["a", "b", "c"];
    expect(mapContextsToRuleIds(ctxs, (_c, i) => i)).toEqual([0, 1, 2]);
  });

  it("rejects a non-u32 rule id", () => {
    expect(() => mapContextsToRuleIds(["a"], () => -1)).toThrow(/u32/);
    expect(() => mapContextsToRuleIds(["a"], () => 1.5)).toThrow(/u32/);
  });
});
