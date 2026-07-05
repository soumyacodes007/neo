import { describe, expect, it } from "vitest";
import { accountInstanceKey } from "../keys.js";
import { RpcClient } from "../rpc.js";
import { InMemoryRegistry } from "./registry.js";
import { inspectAccount, type InspectDeps } from "./inspect-account.js";
import {
  ACCOUNT,
  FixtureBackend,
  H_ACCT,
  H_SPENDING,
  TARGET,
  buildFixture,
  instanceVal,
  ledgerEntry,
  makeInspectDeps,
} from "./testkit.js";

describe("inspectAccount (A1)", () => {
  it("T-A1.1-1: produces a full snapshot of the fixture account", async () => {
    const snap = await inspectAccount({ account: ACCOUNT }, makeInspectDeps(buildFixture()));
    expect(snap.account).toBe(ACCOUNT);
    expect(snap.account_wasm_hash).toBe(H_ACCT.toString("hex"));
    expect(snap.next_rule_id).toBe(2);
    expect(snap.rule_count).toBe(2);
    expect(snap.rules.map((r) => r.privilege)).toEqual(["admin-equivalent", "scoped"]);
    expect(snap.rules[1]?.context_type).toEqual({ kind: "call_contract", address: TARGET });
    expect(snap.rules[1]?.policies[0]?.classification).toBe("oz:spending_limit");
    expect(snap.rules[1]?.policies[0]?.wasm_hash).toBe(H_SPENDING.toString("hex"));
    expect(snap.admin_paths).toEqual([0]);
    expect(snap.recovery_paths).toEqual([0]);
    expect(snap.signer_registry).toHaveLength(1);
    expect(snap.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T-A1.1-5: fences a hostile rule name", async () => {
    const snap = await inspectAccount({ account: ACCOUNT }, makeInspectDeps(buildFixture({ ruleName: "agent‮" })));
    expect(snap.rules[1]?.name).toBe("agent");
  });

  it("INV-Snap-3: snapshot_hash is deterministic and excludes taken_at", async () => {
    const s1 = await inspectAccount({ account: ACCOUNT }, makeInspectDeps(buildFixture(), () => "2026-07-05T00:00:00.000Z"));
    const s2 = await inspectAccount({ account: ACCOUNT }, makeInspectDeps(buildFixture(), () => "2027-01-01T00:00:00.000Z"));
    expect(s1.snapshot_hash).toBe(s2.snapshot_hash);
    expect(s1.taken_at).not.toBe(s2.taken_at);
  });

  it("T-A1.1-2: rejects a non-OZ account (unknown wasm, EC-A03)", async () => {
    await expect(
      inspectAccount({ account: ACCOUNT }, makeInspectDeps(buildFixture(), undefined, false)),
    ).rejects.toMatchObject({ code: "E_DOMAIN_UNSUPPORTED_ACCOUNT" });
  });

  it("reports E_DATA_CONTRACT_NOT_FOUND when the instance is absent", async () => {
    await expect(inspectAccount({ account: ACCOUNT }, makeInspectDeps(new Map()))).rejects.toMatchObject({
      code: "E_DATA_CONTRACT_NOT_FOUND",
    });
  });

  it("T-A1.1-3: Count mismatch → inconsistent snapshot", async () => {
    const entries = buildFixture();
    entries.set(
      accountInstanceKey(ACCOUNT).toXDR("base64"),
      ledgerEntry(ACCOUNT, accountInstanceKey(ACCOUNT).contractData().key(),
        instanceVal(H_ACCT, { NextId: 2, Count: 3, NextSignerId: 1, NextPolicyId: 1 })),
    );
    const registry = new InMemoryRegistry()
      .registerAccountWasm(H_ACCT.toString("hex"))
      .registerPolicy(H_SPENDING.toString("hex"), "oz:spending_limit");
    const deps: InspectDeps = {
      rpc: RpcClient.create(new FixtureBackend(entries)),
      registry,
      network: "testnet",
      now: () => "2026-07-05T00:00:00.000Z",
    };
    await expect(inspectAccount({ account: ACCOUNT }, deps)).rejects.toMatchObject({
      code: "E_DATA_INCONSISTENT_SNAPSHOT",
    });
  });
});
