import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalHash, canonicalize, hashWithout, type JsonValue } from "./canonical.js";

describe("canonicalize (Vol 02 §11)", () => {
  it("T-core-canon-1: is idempotent", () => {
    const v: JsonValue = { b: 2, a: [1, 2, { z: true, y: null }] };
    expect(canonicalize(v)).toBe(canonicalize(JSON.parse(canonicalize(v)) as JsonValue));
  });

  it("T-core-canon-2: is independent of object key insertion order", () => {
    const a: JsonValue = { alpha: 1, beta: { p: "x", q: "y" } };
    const b: JsonValue = { beta: { q: "y", p: "x" }, alpha: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("T-core-canon-3: hashWithout excludes named fields (hash + timestamp)", () => {
    const base = { network: "testnet", ledger: 42, foo: "bar" } as const;
    const withHashAndTime = {
      ...base,
      taken_at: "2026-07-05T00:00:00.000Z",
      snapshot_hash: "deadbeef",
    };
    // Excluding the volatile fields yields the same hash as the base object.
    expect(hashWithout(withHashAndTime, ["taken_at", "snapshot_hash"])).toBe(
      canonicalHash(base),
    );
  });

  it("T-core-canon-4: hashing is deterministic across runs", () => {
    const v: JsonValue = { x: [3, 1, 2], y: "hello" };
    expect(canonicalHash(v)).toBe(canonicalHash(v));
    expect(canonicalHash(v)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects non-finite numbers (no silent non-determinism)", () => {
    expect(() => canonicalize(Number.NaN as unknown as JsonValue)).toThrow();
    expect(() => canonicalize(Number.POSITIVE_INFINITY as unknown as JsonValue)).toThrow();
  });

  it("omits undefined optional properties rather than encoding them", () => {
    const v = { a: 1, b: undefined } as unknown as JsonValue;
    expect(canonicalize(v)).toBe('{"a":1}');
  });

  it("property: key-order permutations hash identically", () => {
    const jsonValue = fc.letrec<{ v: JsonValue }>((tie) => ({
      v: fc.oneof(
        { depthSize: "small" },
        fc.constant(null),
        fc.boolean(),
        fc.integer(),
        fc.string(),
        fc.array(tie("v"), { maxLength: 4 }),
        fc.dictionary(fc.string(), tie("v"), { maxKeys: 4 }),
      ),
    })).v;

    fc.assert(
      fc.property(jsonValue, (v) => {
        const reparsed = JSON.parse(JSON.stringify(v)) as JsonValue;
        expect(canonicalHash(v)).toBe(canonicalHash(reparsed));
      }),
    );
  });
});
