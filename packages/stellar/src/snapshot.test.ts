import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { toContractId } from "@ozpb/core";
import { deriveSnapshotAddressSet } from "./snapshot.js";

const mk = (b: number): ReturnType<typeof toContractId> =>
  toContractId(StrKey.encodeContract(Buffer.alloc(32, b)));

describe("deriveSnapshotAddressSet (FN-ST.23)", () => {
  it("unions account + evidence addresses, deduped and sorted", () => {
    const account = mk(1);
    const token = mk(2);
    const pool = mk(3);
    const verifier = mk(4);
    const set = deriveSnapshotAddressSet(account, {
      invocationContracts: [pool, token],
      tokens: [token], // duplicate
      ruleTargets: [pool],
      verifiers: [verifier],
    });
    expect(set).toEqual([account, token, pool, verifier].sort((a, b) => a.localeCompare(b)));
    expect(new Set(set).size).toBe(set.length); // deduped
  });

  it("always includes the account even with no evidence", () => {
    const account = mk(1);
    expect(deriveSnapshotAddressSet(account, {})).toEqual([account]);
  });
});
