import { StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { encodeInstallParams, encodeSpendingLimitParams } from "./install-params.js";

const C = StrKey.encodeContract(Buffer.alloc(32, 7));

function decode(b64: string): xdr.ScVal {
  return xdr.ScVal.fromXDR(b64, "base64");
}

describe("install-param encoder (C2)", () => {
  it("encodes spending_limit as a symbol-keyed struct map (host-sorted)", () => {
    const scv = encodeSpendingLimitParams({ spendingLimit: "500", periodLedgers: 100 });
    expect(scv.switch().name).toBe("scvMap");
    const keys = (scv.map() ?? []).map((e) => Buffer.from(e.key().sym() as unknown as Uint8Array).toString());
    // Lexicographic: period_ledgers before spending_limit.
    expect(keys).toEqual(["period_ledgers", "spending_limit"]);
  });

  it("dispatches by classification and produces decodable XDR", () => {
    const allow = decode(encodeInstallParams("pb:function_allowlist", { functions: ["claim", "submit"] }));
    expect(allow.switch().name).toBe("scvMap");
    const callCap = decode(
      encodeInstallParams("pb:call_cap", {
        cap: "500",
        periodLedgers: 100,
        fnName: "submit",
        amountPath: [{ kind: "index", index: 0 }],
        tokenFilterToken: C,
        tokenFilterPath: [{ kind: "index", index: 0 }],
      }),
    );
    expect(callCap.switch().name).toBe("scvMap");
  });

  it("throws for a classification with no encoder", () => {
    expect(() => encodeInstallParams("generated", {})).toThrow(/no install-param encoder/);
    expect(() => encodeInstallParams("unknown", {})).toThrow();
  });
});
