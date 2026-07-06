import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import { toContractId } from "@ozpb/core";
import { createSnapshot, deriveSnapshotAddressSet } from "./snapshot.js";

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

describe("createSnapshot (FN-ST.24)", () => {
  it("passes the complete sorted address set to stellar snapshot create", async () => {
    const account = mk(1);
    const token = mk(2);
    const seen: { cmd: string; args: string[] }[] = [];
    const result = await createSnapshot({
      addresses: [token, account, token],
      outPath: "/tmp/snapshot.json",
      ledger: 123,
      network: "testnet",
      stellarBin: "stellar",
      runProcess: async (cmd, args) => {
        seen.push({ cmd, args });
        return { code: 0, stdout: "", stderr: "ok" };
      },
    });

    expect(result.snapshot_path).toBe("/tmp/snapshot.json");
    expect(result.addresses).toEqual([account, token].sort((a, b) => a.localeCompare(b)));
    expect(seen[0]?.args).toEqual([
      "snapshot",
      "create",
      "--output",
      "json",
      "--out",
      "/tmp/snapshot.json",
      "--network",
      "testnet",
      "--ledger",
      "123",
      "--address",
      account,
      "--address",
      token,
    ]);
  });

  it("surfaces CLI failures as infrastructure errors", async () => {
    await expect(
      createSnapshot({
        addresses: [mk(1)],
        outPath: "/tmp/snapshot.json",
        runProcess: async () => ({ code: 2, stdout: "", stderr: "bad address" }),
      }),
    ).rejects.toThrow(/stellar snapshot create failed.*bad address/);
  });
});
