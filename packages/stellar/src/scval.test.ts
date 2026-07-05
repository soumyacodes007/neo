import { Address, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { fromScValJson, parsePath, resolvePath, toScValJson } from "./scval.js";

const C = StrKey.encodeContract(Buffer.alloc(32, 7));

function sym(s: string): xdr.ScVal {
  return xdr.ScVal.scvSymbol(s);
}
function i128(n: string): xdr.ScVal {
  return nativeToScVal(BigInt(n), { type: "i128" });
}
function structVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields).map(
    ([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v }),
  );
  return xdr.ScVal.scvMap(entries);
}

// One representative of every ScVal variant we decode explicitly, plus an
// opaque one for the default arm.
const ALL_VARIANTS: Record<string, xdr.ScVal> = {
  bool: xdr.ScVal.scvBool(true),
  void: xdr.ScVal.scvVoid(),
  u32: nativeToScVal(5, { type: "u32" }),
  i32: nativeToScVal(-5, { type: "i32" }),
  u64: nativeToScVal(9007199254740993n, { type: "u64" }),
  i64: nativeToScVal(-42n, { type: "i64" }),
  timepoint: xdr.ScVal.scvTimepoint(xdr.Uint64.fromString("1700000000")),
  duration: xdr.ScVal.scvDuration(xdr.Uint64.fromString("86400")),
  u128: nativeToScVal(340282366920938463463374607431768211455n, { type: "u128" }),
  i128: i128("-170141183460469231731687303715884105728"),
  u256: nativeToScVal(1n, { type: "u256" }),
  i256: nativeToScVal(-1n, { type: "i256" }),
  bytes: nativeToScVal(Buffer.from("deadbeef", "hex"), { type: "bytes" }),
  string: nativeToScVal("hello", { type: "string" }),
  symbol: sym("transfer"),
  address: Address.fromString(C).toScVal(),
  vec: xdr.ScVal.scvVec([nativeToScVal(1, { type: "u32" }), nativeToScVal(2, { type: "u32" })]),
  emptyVec: xdr.ScVal.scvVec([]),
  map: structVal({ request_type: nativeToScVal(1, { type: "u32" }), amount: i128("100") }),
  emptyMap: xdr.ScVal.scvMap([]),
  // Nullable union arms — exercise the `?? []` fallback (EC-X02 defensiveness).
  nullVec: xdr.ScVal.scvVec(null),
  nullMap: xdr.ScVal.scvMap(null),
  opaque: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString("7") })),
};

describe("toScValJson / fromScValJson (FN-ST.14)", () => {
  it("T-ST.14-4: hits every variant arm and never throws", () => {
    for (const [label, scv] of Object.entries(ALL_VARIANTS)) {
      const json = toScValJson(scv);
      expect(json.xdr_b64.length).toBeGreaterThan(0);
      expect(typeof json.type).toBe("string");
      if (label === "opaque") {
        expect(json.type).toBe("scvLedgerKeyNonce");
        expect(json.value).toBeNull();
      }
    }
  });

  it("T-ST.14-1: round-trips byte-for-byte for all variants", () => {
    for (const scv of Object.values(ALL_VARIANTS)) {
      const back = fromScValJson(toScValJson(scv));
      expect(back.toXDR("base64")).toBe(scv.toXDR("base64"));
    }
  });

  it("T-ST.14-3: renders i128 extremes as decimal strings", () => {
    expect(toScValJson(i128("-170141183460469231731687303715884105728")).value).toBe(
      "-170141183460469231731687303715884105728",
    );
    expect(toScValJson(ALL_VARIANTS.u128!).value).toBe(
      "340282366920938463463374607431768211455",
    );
  });

  it("preserves address strkey kind (EC-X05)", () => {
    expect(toScValJson(ALL_VARIANTS.address!).value).toBe(C);
  });

  it("decodes symbol/string/bytes to their natural forms", () => {
    expect(toScValJson(ALL_VARIANTS.symbol!).value).toBe("transfer");
    expect(toScValJson(ALL_VARIANTS.string!).value).toBe("hello");
    expect(toScValJson(ALL_VARIANTS.bytes!).value).toBe("deadbeef");
  });
});

describe("resolvePath (FN-ST.22)", () => {
  const requests = xdr.ScVal.scvVec([
    structVal({ request_type: nativeToScVal(0, { type: "u32" }), amount: i128("100") }),
    structVal({ request_type: nativeToScVal(1, { type: "u32" }), amount: i128("200") }),
  ]);
  const submitArg = structVal({ requests });

  it("T-ST.22-1: `[*]` fans out over a vector", () => {
    const leaves = resolvePath(toScValJson(requests), "$[*].amount");
    expect(leaves.map((l) => l.value)).toEqual(["100", "200"]);
  });

  it("resolves a nested struct path", () => {
    const leaves = resolvePath(toScValJson(submitArg), "$.requests[*].request_type");
    expect(leaves.map((l) => l.value)).toEqual([0, 1]);
  });

  it("resolves a concrete index", () => {
    const leaves = resolvePath(toScValJson(requests), "$[0].amount");
    expect(leaves.map((l) => l.value)).toEqual(["100"]);
  });

  it("T-ST.22-2: missing key/index yields empty", () => {
    expect(resolvePath(toScValJson(submitArg), "$.nope")).toEqual([]);
    expect(resolvePath(toScValJson(requests), "$[9].amount")).toEqual([]);
    // key access on a non-map leaf yields nothing
    expect(resolvePath(toScValJson(i128("5")), "$.x")).toEqual([]);
    // wildcard on a non-vector leaf yields nothing
    expect(resolvePath(toScValJson(i128("5")), "$[*]")).toEqual([]);
  });
});

describe("parsePath", () => {
  it("rejects malformed paths", () => {
    expect(() => parsePath("x.y")).toThrow(); // no leading $
    expect(() => parsePath("$.a b")).toThrow(); // trailing junk
    expect(() => parsePath("$..a")).toThrow(); // unparseable segment
  });

  it("parses the mixed grammar", () => {
    expect(parsePath("$.requests[*][0]")).toEqual([
      { kind: "key", name: "requests" },
      { kind: "wild" },
      { kind: "index", index: 0 },
    ]);
  });
});
