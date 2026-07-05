/**
 * B2 — `interface-lookup` (Vol 05). Fetch a contract's interface from its on-chain
 * WASM contractspec, or the fixed SEP-41 interface for a Stellar Asset Contract
 * (as Tyler's demo hit with native XLM). Interface labels are advisory and
 * marked `trusted:false` for WASM specs — arg/function names are attacker-
 * controllable and are fenced for display (EC-T02/T05).
 */
import { cereal, xdr } from "@stellar/stellar-sdk";
import {
  ToolError,
  type ContractId,
  type InterfaceFunction,
  type InterfaceSpec,
  type Network,
} from "@ozpb/core";
import { assertContractId, sanitizeChainString } from "../address.js";
import {
  accountInstanceKey,
  contractCodeKey,
  decodeContractCodeWasm,
  decodeContractDataVal,
  instanceExecutableWasmHash,
} from "../keys.js";
import type { RpcClient } from "../rpc.js";

export interface InterfaceLookupDeps {
  rpc: RpcClient;
  network: Network;
}

/** SEP-41 fixed interface (SAC has no user WASM). */
const SEP41_FUNCTIONS: InterfaceFunction[] = [
  { name: "transfer", args: [arg("from", "Address"), arg("to", "Address"), arg("amount", "I128")] },
  { name: "approve", args: [arg("from", "Address"), arg("spender", "Address"), arg("amount", "I128"), arg("expiration_ledger", "U32")] },
  { name: "transfer_from", args: [arg("spender", "Address"), arg("from", "Address"), arg("to", "Address"), arg("amount", "I128")] },
  { name: "burn", args: [arg("from", "Address"), arg("amount", "I128")] },
  { name: "burn_from", args: [arg("spender", "Address"), arg("from", "Address"), arg("amount", "I128")] },
  { name: "balance", args: [arg("id", "Address")], is_read_only_hint: true },
  { name: "allowance", args: [arg("from", "Address"), arg("spender", "Address")], is_read_only_hint: true },
  { name: "decimals", args: [], is_read_only_hint: true },
  { name: "name", args: [], is_read_only_hint: true },
  { name: "symbol", args: [], is_read_only_hint: true },
];

function arg(name: string, sc_type: string): { name: string; sc_type: string } {
  return { name, sc_type };
}

export async function interfaceLookup(input: { contract: string }, deps: InterfaceLookupDeps): Promise<InterfaceSpec> {
  const contract = assertContractId(input.contract);
  const read = await deps.rpc.getLedgerEntries([accountInstanceKey(contract)]);
  const entry = read.entries[0];
  if (entry === undefined || entry.state !== "live" || entry.xdrB64 === null) {
    throw new ToolError("E_DATA_CONTRACT_NOT_FOUND", `no live contract instance for ${contract}`);
  }
  const wasmHash = instanceExecutableWasmHash(decodeContractDataVal(entry.xdrB64));
  if (wasmHash === null) {
    // Stellar-asset contract → fixed SEP-41.
    return { contract, kind: "sac", functions: SEP41_FUNCTIONS, trusted: true };
  }
  const codeRead = await deps.rpc.getLedgerEntries([contractCodeKey(wasmHash)]);
  const codeEntry = codeRead.entries[0];
  if (codeEntry === undefined || codeEntry.state !== "live" || codeEntry.xdrB64 === null) {
    throw new ToolError("E_DATA_NO_SPEC", `contract WASM code unavailable for ${contract}`);
  }
  const entries = extractSpecEntries(decodeContractCodeWasm(codeEntry.xdrB64));
  const functions = specToInterface(entries);
  if (functions.length === 0) {
    throw new ToolError("E_DATA_NO_SPEC", `contract ${contract} exposes no contractspec`, {
      suggestion: "rely on evidence-derived argument positions instead of names",
    });
  }
  return { contract, kind: "wasm", functions, wasm_hash: wasmHash, trusted: false };
}

/** Convert contractspec entries to interface functions (function entries only). */
export function specToInterface(entries: xdr.ScSpecEntry[]): InterfaceFunction[] {
  const out: InterfaceFunction[] = [];
  for (const entry of entries) {
    if (entry.switch().name !== "scSpecEntryFunctionV0") continue;
    const fn = entry.functionV0();
    out.push({
      name: sanitizeChainString(bufToStr(fn.name()), 60),
      args: fn.inputs().map((i) => ({
        name: sanitizeChainString(bufToStr(i.name()), 60),
        sc_type: i.type().switch().name.replace(/^scSpecType/, ""),
      })),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse the `contractspecv0` custom section out of a WASM module and stream its entries. */
export function extractSpecEntries(wasm: Buffer): xdr.ScSpecEntry[] {
  if (wasm.length < 8 || wasm.readUInt32BE(0) !== 0x0061736d) return []; // "\0asm"
  let off = 8;
  while (off < wasm.length) {
    const id = wasm[off];
    off += 1;
    const [sectionSize, sizeLen] = readLEB(wasm, off);
    off += sizeLen;
    const payloadEnd = off + sectionSize;
    if (id === 0) {
      // Custom section: name (vec) then data.
      const [nameLen, nameLenLen] = readLEB(wasm, off);
      let p = off + nameLenLen;
      const name = wasm.subarray(p, p + nameLen).toString("utf8");
      p += nameLen;
      if (name === "contractspecv0") {
        return streamEntries(wasm.subarray(p, payloadEnd));
      }
    }
    off = payloadEnd;
  }
  return [];
}

function streamEntries(bytes: Buffer): xdr.ScSpecEntry[] {
  const reader = new cereal.XdrReader(bytes);
  const out: xdr.ScSpecEntry[] = [];
  // `eof` is a getter on XdrReader.
  while (!(reader as unknown as { eof: boolean }).eof) {
    out.push((xdr.ScSpecEntry as unknown as { read: (r: unknown) => xdr.ScSpecEntry }).read(reader));
  }
  return out;
}

function readLEB(buf: Buffer, start: number): [value: number, length: number] {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    const byte = buf[i];
    if (byte === undefined) throw new ToolError("E_DATA_MALFORMED_XDR", "truncated LEB128 in WASM");
    i += 1;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, i - start];
}

function bufToStr(b: unknown): string {
  return Buffer.from(b as Uint8Array).toString("utf8");
}

export type { ContractId };
