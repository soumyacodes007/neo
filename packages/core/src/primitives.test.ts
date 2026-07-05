import { describe, expect, it } from "vitest";
import {
  amountFitsI128,
  I128_MAX,
  toAccountId,
  toContractId,
  toLedgerSeq,
} from "./primitives.js";

const C = "C" + "A".repeat(55);
const G = "G" + "A".repeat(55);

describe("branded strkeys", () => {
  it("accepts a well-formed contract strkey and rejects other kinds", () => {
    expect(toContractId(C)).toBe(C);
    expect(() => toContractId(G)).toThrow(); // account strkey is not a contract id
    expect(() => toContractId("C" + "A".repeat(10))).toThrow(); // too short
    expect(() => toContractId("c" + "A".repeat(55))).toThrow(); // lowercase
  });

  it("accepts a well-formed account strkey", () => {
    expect(toAccountId(G)).toBe(G);
    expect(() => toAccountId(C)).toThrow();
  });

  it("bounds ledger sequence to uint32", () => {
    expect(toLedgerSeq(0)).toBe(0);
    expect(() => toLedgerSeq(-1)).toThrow();
    expect(() => toLedgerSeq(0x1_0000_0000)).toThrow();
  });
});

describe("amountFitsI128 (EC-X07 / INV-Common-1)", () => {
  it("scales a decimal by the token's decimals", () => {
    expect(amountFitsI128("500", 7)).toBe(5_000_000_000n);
    expect(amountFitsI128("1.5", 2)).toBe(150n);
    expect(amountFitsI128("0", 7)).toBe(0n);
  });

  it("rejects more fractional precision than the token supports", () => {
    expect(amountFitsI128("1.005", 2)).toBeNull();
  });

  it("rejects values that overflow i128", () => {
    const overMax = (I128_MAX + 1n).toString();
    expect(amountFitsI128(overMax, 0)).toBeNull();
    expect(amountFitsI128(I128_MAX.toString(), 0)).toBe(I128_MAX);
  });

  it("rejects malformed inputs", () => {
    expect(amountFitsI128("-1", 0)).toBeNull();
    expect(amountFitsI128("abc", 0)).toBeNull();
    expect(amountFitsI128("1", -1)).toBeNull();
    expect(amountFitsI128("1", 39)).toBeNull();
  });
});
