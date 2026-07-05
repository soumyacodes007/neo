/**
 * Ledger-key construction + entry decoding (Vol 03 §4, FN-ST.15–17).
 *
 * Grounded in the verified OZ storage layout [code smart_account/storage.rs]:
 *
 *   #[contracttype] enum SmartAccountStorageKey {
 *     ContextRuleData(u32), NextId, Count, SignerData(u32), SignerLookup(BytesN),
 *     NextSignerId, PolicyData(u32), PolicyLookup(Address), NextPolicyId }
 *
 * Soroban encodes a `#[contracttype]` enum as `ScVal::Vec[Symbol(variant), …args]`
 * and a struct as `ScVal::Map` with symbol keys. The scalar counters live in the
 * contract's **instance** storage map; `ContextRuleData/SignerData/PolicyData`
 * are **persistent** ledger entries.
 *
 * The exact ScVal encoding of the enum is tagged `[inference]` in Vol 03 and is
 * pinned by a golden test against a deployed fixture (T-ST.15-3, pending). The
 * unit tests here validate key *shape* and decode against locally-encoded structs.
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import {
  ToolError,
  toWasmHash,
  type ContextType,
  type ContractId,
  type SignerModel,
  type WasmHash,
} from "@ozpb/core";
import { createHash } from "node:crypto";
import { assertAddress, assertContractId } from "./address.js";

// Soroban durability is only TEMPORARY | PERSISTENT. The contract-instance
// entry (which holds the scalar counters in its storage map) uses PERSISTENT
// durability with the special LedgerKeyContractInstance key.
const PERSISTENT = xdr.ContractDataDurability.persistent();

function symbolKey(name: string, ...args: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name), ...args]);
}

function contractDataKey(
  account: ContractId,
  key: xdr.ScVal,
  durability: xdr.ContractDataDurability,
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(account).toScAddress(),
      key,
      durability,
    }),
  );
}

/** The single instance-storage ledger entry (holds the scalar counters). */
export function accountInstanceKey(account: ContractId): xdr.LedgerKey {
  return contractDataKey(account, xdr.ScVal.scvLedgerKeyContractInstance(), PERSISTENT);
}

/** The contract's WASM code entry, by 32-byte wasm hash (hex). */
export function contractCodeKey(wasmHash: WasmHash): xdr.LedgerKey {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, "hex") }),
  );
}

/** Persistent key for `ContextRuleData(id)`. */
export function contextRuleDataKey(account: ContractId, id: number): xdr.LedgerKey {
  return contractDataKey(account, symbolKey("ContextRuleData", xdr.ScVal.scvU32(id)), PERSISTENT);
}

/** Batch of `ContextRuleData(0..count)` keys (FN-ST.16). Caller chunks ≤200. */
export function contextRuleDataKeys(account: ContractId, ids: readonly number[]): xdr.LedgerKey[] {
  return ids.map((id) => contextRuleDataKey(account, id));
}

export function signerDataKey(account: ContractId, id: number): xdr.LedgerKey {
  return contractDataKey(account, symbolKey("SignerData", xdr.ScVal.scvU32(id)), PERSISTENT);
}

export function policyDataKey(account: ContractId, id: number): xdr.LedgerKey {
  return contractDataKey(account, symbolKey("PolicyData", xdr.ScVal.scvU32(id)), PERSISTENT);
}

// --- Decoders -------------------------------------------------------------

function malformed(what: string): never {
  throw new ToolError("E_DATA_MALFORMED_XDR", `unexpected ${what} shape (fail-closed, EC-X02)`);
}

function symbolName(scv: xdr.ScVal): string | null {
  if (scv.switch().name !== "scvSymbol") return null;
  return Buffer.from(scv.sym() as unknown as Uint8Array).toString("utf8");
}

function vecArm(scv: xdr.ScVal): xdr.ScVal[] | null {
  if (scv.switch().name !== "scvVec") return null;
  return scv.vec() ?? [];
}

function structFields(scv: xdr.ScVal): Map<string, xdr.ScVal> {
  if (scv.switch().name !== "scvMap") malformed("struct (expected map)");
  const out = new Map<string, xdr.ScVal>();
  for (const entry of scv.map() ?? []) {
    const name = symbolName(entry.key());
    if (name === null) malformed("struct key (expected symbol)");
    out.set(name, entry.val());
  }
  return out;
}

function requireField(fields: Map<string, xdr.ScVal>, name: string): xdr.ScVal {
  const v = fields.get(name);
  if (v === undefined) malformed(`struct missing field "${name}"`);
  return v;
}

function u32(scv: xdr.ScVal): number {
  if (scv.switch().name !== "scvU32") malformed("u32");
  return scv.u32();
}

function u32Vec(scv: xdr.ScVal): number[] {
  const arm = vecArm(scv);
  if (arm === null) malformed("Vec<u32>");
  return arm.map(u32);
}

export interface InstanceScalars {
  present: boolean; // false ⇒ not an OZ account layout (fingerprint fails, EC-A03)
  nextId: number;
  count: number;
  nextSignerId: number;
  nextPolicyId: number;
}

/** Read the scalar counters from a contract-instance ScVal (`scvContractInstance`). */
export function decodeInstanceScalars(instanceVal: xdr.ScVal): InstanceScalars {
  if (instanceVal.switch().name !== "scvContractInstance") malformed("contract instance");
  const storage = instanceVal.instance().storage() ?? [];
  const scalars = new Map<string, number>();
  for (const entry of storage) {
    const arm = vecArm(entry.key());
    if (arm === null || arm.length !== 1) continue; // 1-symbol unit-variant keys only
    const name = symbolName(arm[0]!);
    if (name === null) continue;
    if (name === "NextId" || name === "Count" || name === "NextSignerId" || name === "NextPolicyId") {
      scalars.set(name, u32(entry.val()));
    }
  }
  const present =
    scalars.has("NextId") && scalars.has("Count") &&
    scalars.has("NextSignerId") && scalars.has("NextPolicyId");
  return {
    present,
    nextId: scalars.get("NextId") ?? 0,
    count: scalars.get("Count") ?? 0,
    nextSignerId: scalars.get("NextSignerId") ?? 0,
    nextPolicyId: scalars.get("NextPolicyId") ?? 0,
  };
}

export function decodeContextRuleType(scv: xdr.ScVal): ContextType {
  const arm = vecArm(scv);
  if (arm === null || arm.length === 0) malformed("ContextRuleType");
  const tag = symbolName(arm[0]!);
  switch (tag) {
    case "Default":
      return { kind: "default" };
    case "CallContract": {
      if (arm[1] === undefined) malformed("CallContract(address)");
      const address = assertContractId(Address.fromScVal(arm[1]).toString());
      return { kind: "call_contract", address };
    }
    case "CreateContract": {
      if (arm[1] === undefined) malformed("CreateContract(wasm_hash)");
      const hash = Buffer.from(arm[1].bytes() as unknown as Uint8Array).toString("hex");
      return { kind: "create_contract", wasm_hash: toWasmHash(hash) };
    }
    default:
      return malformed(`ContextRuleType tag "${tag ?? "?"}"`);
  }
}

export interface DecodedContextRuleEntry {
  name: string;
  context_type: ContextType;
  valid_until_ledger: number | undefined;
  signer_ids: number[];
  policy_ids: number[];
}

export function decodeContextRuleEntry(scv: xdr.ScVal): DecodedContextRuleEntry {
  const f = structFields(scv);
  const nameScv = requireField(f, "name");
  if (nameScv.switch().name !== "scvString") malformed("rule name");
  const name = Buffer.from(nameScv.str() as unknown as Uint8Array).toString("utf8");

  const validUntilScv = requireField(f, "valid_until");
  // Soroban Option<u32>: None ⇒ scvVoid, Some ⇒ scvU32.
  const valid_until_ledger =
    validUntilScv.switch().name === "scvVoid" ? undefined : u32(validUntilScv);

  return {
    name,
    context_type: decodeContextRuleType(requireField(f, "context_type")),
    valid_until_ledger,
    signer_ids: u32Vec(requireField(f, "signer_ids")),
    policy_ids: u32Vec(requireField(f, "policy_ids")),
  };
}

export interface DecodedSigner {
  signer: SignerModel;
  /** sha256(XDR(Signer)) hex — on-chain dedup identity (INV-Signer-1). */
  canonical_hash: string;
}

function decodeSignerValue(scv: xdr.ScVal): SignerModel {
  const arm = vecArm(scv);
  if (arm === null || arm.length === 0) malformed("Signer");
  const tag = symbolName(arm[0]!);
  switch (tag) {
    case "Delegated": {
      if (arm[1] === undefined) malformed("Delegated(address)");
      // A delegated signer may be a contract (C…) or an account (G…) address.
      return { type: "delegated", address: assertAddress(Address.fromScVal(arm[1]).toString()) };
    }
    case "External": {
      if (arm[1] === undefined || arm[2] === undefined) malformed("External(verifier,key)");
      const verifier = assertContractId(Address.fromScVal(arm[1]).toString());
      const key_data_b64 = Buffer.from(arm[2].bytes() as unknown as Uint8Array).toString("base64");
      // verifier_kind resolved by A1 against the verifier registry (INV-Signer-3).
      return { type: "external", verifier, key_data_b64, verifier_kind: "unknown" };
    }
    default:
      return malformed(`Signer tag "${tag ?? "?"}"`);
  }
}

export function decodeSigner(signerScv: xdr.ScVal): DecodedSigner {
  return {
    signer: decodeSignerValue(signerScv),
    canonical_hash: createHash("sha256").update(signerScv.toXDR()).digest("hex"),
  };
}

export interface DecodedSignerEntry extends DecodedSigner {
  count: number;
}

export function decodeSignerEntry(scv: xdr.ScVal): DecodedSignerEntry {
  const f = structFields(scv);
  const decoded = decodeSigner(requireField(f, "signer"));
  return { ...decoded, count: u32(requireField(f, "count")) };
}

export interface DecodedPolicyEntry {
  policy: ContractId;
  count: number;
}

export function decodePolicyEntry(scv: xdr.ScVal): DecodedPolicyEntry {
  const f = structFields(scv);
  const policyScv = requireField(f, "policy");
  if (policyScv.switch().name !== "scvAddress") malformed("policy address");
  return {
    policy: assertContractId(Address.fromScVal(policyScv).toString()),
    count: u32(requireField(f, "count")),
  };
}

/** Extract the stored ScVal from a ContractData ledger entry (base64 LedgerEntryData). */
export function decodeContractDataVal(entryXdrB64: string): xdr.ScVal {
  let data: xdr.LedgerEntryData;
  try {
    data = xdr.LedgerEntryData.fromXDR(entryXdrB64, "base64");
  } catch (cause) {
    throw new ToolError("E_DATA_MALFORMED_XDR", "could not decode LedgerEntryData", { cause });
  }
  if (data.switch().name !== "contractData") malformed("ledger entry (expected contractData)");
  return data.contractData().val();
}

/** Extract the WASM byte code from a ContractCode ledger entry (base64 LedgerEntryData). */
export function decodeContractCodeWasm(entryXdrB64: string): Buffer {
  let data: xdr.LedgerEntryData;
  try {
    data = xdr.LedgerEntryData.fromXDR(entryXdrB64, "base64");
  } catch (cause) {
    throw new ToolError("E_DATA_MALFORMED_XDR", "could not decode LedgerEntryData", { cause });
  }
  if (data.switch().name !== "contractCode") malformed("ledger entry (expected contractCode)");
  return Buffer.from(data.contractCode().code());
}

/** WASM hash (hex) of a contract from its instance ScVal, or null for a SAC/token. */
export function instanceExecutableWasmHash(instanceVal: xdr.ScVal): WasmHash | null {
  if (instanceVal.switch().name !== "scvContractInstance") malformed("contract instance");
  const exec = instanceVal.instance().executable();
  if (exec.switch().name !== "contractExecutableWasm") return null; // Stellar-asset contract
  return toWasmHash(Buffer.from(exec.wasmHash()).toString("hex"));
}
