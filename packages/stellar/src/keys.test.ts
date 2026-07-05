import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  accountInstanceKey,
  contextRuleDataKey,
  contextRuleDataKeys,
  contractCodeKey,
  decodeContextRuleEntry,
  decodeInstanceScalars,
  decodePolicyEntry,
  decodeSigner,
  decodeSignerEntry,
  signerDataKey,
} from "./keys.js";
import { toContractId, toWasmHash } from "@ozpb/core";

const C = toContractId(StrKey.encodeContract(Buffer.alloc(32, 7)));
const C2 = toContractId(StrKey.encodeContract(Buffer.alloc(32, 9)));

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);
const structVal = (fields: Record<string, xdr.ScVal>): xdr.ScVal =>
  xdr.ScVal.scvMap(Object.entries(fields).map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));

describe("ledger-key construction (FN-ST.15/16)", () => {
  it("T-ST.16-1: ContextRuleData(id) key is Vec[Symbol, U32] on the account", () => {
    const key = contextRuleDataKey(C, 3);
    const cd = key.contractData();
    expect(cd.durability().name).toBe("persistent");
    const arm = cd.key().vec() ?? [];
    expect(Buffer.from(arm[0]!.sym() as unknown as Uint8Array).toString()).toBe("ContextRuleData");
    expect(arm[1]!.u32()).toBe(3);
  });

  it("builds a batch of rule-data keys in order", () => {
    const keys = contextRuleDataKeys(C, [0, 1, 2]);
    expect(keys.map((k) => k.contractData().key().vec()![1]!.u32())).toEqual([0, 1, 2]);
  });

  it("instance key uses the LedgerKeyContractInstance ScVal", () => {
    const key = accountInstanceKey(C);
    expect(key.contractData().key().switch().name).toBe("scvLedgerKeyContractInstance");
  });

  it("signer-data key names the SignerData variant", () => {
    const arm = signerDataKey(C, 4).contractData().key().vec() ?? [];
    expect(Buffer.from(arm[0]!.sym() as unknown as Uint8Array).toString()).toBe("SignerData");
  });

  it("contract-code key carries the wasm hash bytes", () => {
    const h = toWasmHash("ab".repeat(32));
    expect(contractCodeKey(h).contractCode().hash().toString("hex")).toBe("ab".repeat(32));
  });
});

describe("decodeInstanceScalars (FN-ST.15)", () => {
  const buildInstance = (scalars: Record<string, number>): xdr.ScVal => {
    const storage = Object.entries(scalars).map(
      ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([sym(k)]), val: u32(v) }),
    );
    const instance = new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 1)),
      storage,
    });
    return xdr.ScVal.scvContractInstance(instance);
  };

  it("reads all four counters when present (OZ layout)", () => {
    const v = buildInstance({ NextId: 5, Count: 3, NextSignerId: 2, NextPolicyId: 1 });
    expect(decodeInstanceScalars(v)).toEqual({
      present: true,
      nextId: 5,
      count: 3,
      nextSignerId: 2,
      nextPolicyId: 1,
    });
  });

  it("reports present=false for a non-OZ instance (EC-A03 fingerprint)", () => {
    const v = buildInstance({ SomethingElse: 1 });
    expect(decodeInstanceScalars(v).present).toBe(false);
  });
});

describe("entry decoders (FN-ST.17)", () => {
  it("decodes a CallContract ContextRuleEntry", () => {
    const entry = structVal({
      name: xdr.ScVal.scvString("owner"),
      context_type: xdr.ScVal.scvVec([sym("CallContract"), Address.fromString(C2).toScVal()]),
      valid_until: xdr.ScVal.scvVoid(),
      signer_ids: xdr.ScVal.scvVec([u32(0), u32(1)]),
      policy_ids: xdr.ScVal.scvVec([]),
    });
    expect(decodeContextRuleEntry(entry)).toEqual({
      name: "owner",
      context_type: { kind: "call_contract", address: C2 },
      valid_until_ledger: undefined,
      signer_ids: [0, 1],
      policy_ids: [],
    });
  });

  it("decodes Some(valid_until) and Default context", () => {
    const entry = structVal({
      name: xdr.ScVal.scvString("session"),
      context_type: xdr.ScVal.scvVec([sym("Default")]),
      valid_until: u32(120960),
      signer_ids: xdr.ScVal.scvVec([u32(2)]),
      policy_ids: xdr.ScVal.scvVec([u32(0)]),
    });
    const d = decodeContextRuleEntry(entry);
    expect(d.context_type).toEqual({ kind: "default" });
    expect(d.valid_until_ledger).toBe(120960);
  });

  it("decodes a Delegated signer with the on-chain canonical hash", () => {
    const signerScv = xdr.ScVal.scvVec([sym("Delegated"), Address.fromString(C2).toScVal()]);
    const expected = createHash("sha256").update(signerScv.toXDR()).digest("hex");
    expect(decodeSigner(signerScv)).toEqual({
      signer: { type: "delegated", address: C2 },
      canonical_hash: expected,
    });
  });

  it("decodes an External signer entry with ref count", () => {
    const key = Buffer.alloc(32, 4);
    const signerScv = xdr.ScVal.scvVec([
      sym("External"),
      Address.fromString(C2).toScVal(),
      xdr.ScVal.scvBytes(key),
    ]);
    const entry = structVal({ signer: signerScv, count: u32(2) });
    const d = decodeSignerEntry(entry);
    expect(d.count).toBe(2);
    expect(d.signer).toEqual({
      type: "external",
      verifier: C2,
      key_data_b64: key.toString("base64"),
      verifier_kind: "unknown",
    });
  });

  it("decodes a PolicyEntry", () => {
    const entry = structVal({ policy: Address.fromString(C2).toScVal(), count: u32(1) });
    expect(decodePolicyEntry(entry)).toEqual({ policy: C2, count: 1 });
  });

  it("fails closed on a malformed entry (EC-X02)", () => {
    expect(() => decodeContextRuleEntry(xdr.ScVal.scvU32(1))).toThrow(/malformed|struct/i);
    const badType = structVal({
      name: xdr.ScVal.scvString("x"),
      context_type: xdr.ScVal.scvVec([sym("Nope")]),
      valid_until: xdr.ScVal.scvVoid(),
      signer_ids: xdr.ScVal.scvVec([]),
      policy_ids: xdr.ScVal.scvVec([]),
    });
    expect(() => decodeContextRuleEntry(badType)).toThrow();
  });
});
