import { describe, expect, it } from "vitest";
import { canonicalHash, hashWithout, type JsonValue } from "../canonical.js";
import { AccountSnapshot } from "./account-snapshot.js";
import { ContextType } from "./context-rule.js";
import { SignerModel } from "./signer.js";

const C = "C" + "A".repeat(55);
const G = "G" + "A".repeat(55);
const HASH = "a".repeat(64);

describe("SCH-SignerModel", () => {
  it("discriminates delegated vs external", () => {
    expect(SignerModel.parse({ type: "delegated", address: G }).type).toBe("delegated");
    const ext = SignerModel.parse({
      type: "external",
      verifier: C,
      key_data_b64: Buffer.from("k").toString("base64"),
      verifier_kind: "ed25519",
    });
    expect(ext.type).toBe("external");
  });

  it("rejects an unknown signer type", () => {
    expect(() => SignerModel.parse({ type: "nope" })).toThrow();
  });
});

describe("SCH-ContextType", () => {
  it("parses each variant and rejects malformed call_contract", () => {
    expect(ContextType.parse({ kind: "default" }).kind).toBe("default");
    expect(ContextType.parse({ kind: "call_contract", address: C }).kind).toBe("call_contract");
    expect(() => ContextType.parse({ kind: "call_contract", address: G })).toThrow();
  });
});

describe("SCH-AccountSnapshot", () => {
  const base = {
    schema_version: "1" as const,
    network: "testnet" as const,
    account: C,
    ledger: 100,
    taken_at: "2026-07-05T00:00:00.000Z",
    account_wasm_hash: HASH,
    rules: [],
    next_rule_id: 0,
    rule_count: 0,
    signer_registry: [],
    policy_registry: [],
    admin_paths: [],
    recovery_paths: [],
    warnings: [],
  };

  it("round-trips a minimal snapshot", () => {
    const snap = AccountSnapshot.parse({ ...base, snapshot_hash: HASH });
    expect(snap.account).toBe(C);
  });

  it("INV-Snap-3: snapshot_hash excludes taken_at + itself", () => {
    // The hash is stable regardless of when the snapshot was taken.
    const at1 = { ...base, taken_at: "2026-07-05T00:00:00.000Z" } as unknown as {
      [k: string]: JsonValue;
    };
    const at2 = { ...base, taken_at: "2027-01-01T12:00:00.000Z" } as unknown as {
      [k: string]: JsonValue;
    };
    const h1 = hashWithout(at1, ["taken_at", "snapshot_hash"]);
    const h2 = hashWithout(at2, ["taken_at", "snapshot_hash"]);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(canonicalHash(at1 as JsonValue)); // taken_at would change the naive hash
  });
});
