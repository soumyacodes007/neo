import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { toContractId, toWasmHash } from "@ozpb/core";
import { accountInstanceKey, contractCodeKey } from "../keys.js";
import { RpcClient, type RawLedgerEntriesResponse, type RpcBackend } from "../rpc.js";
import { extractSpecEntries, interfaceLookup, specToInterface } from "./interface-lookup.js";

const C = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
const H = Buffer.alloc(32, 0xcc);

function fnEntry(name: string, args: [string, () => xdr.ScSpecTypeDef][]): xdr.ScSpecEntry {
  return xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({
      doc: "",
      name,
      inputs: args.map(([n, t]) => new xdr.ScSpecFunctionInputV0({ doc: "", name: n, type: t() })),
      outputs: [],
    }),
  );
}

function leb(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function buildWasm(entries: xdr.ScSpecEntry[], sectionName = "contractspecv0"): Buffer {
  const specBytes = Buffer.concat(entries.map((e) => e.toXDR()));
  const name = Buffer.from(sectionName);
  const payload = Buffer.concat([leb(name.length), name, specBytes]);
  const section = Buffer.concat([Buffer.from([0x00]), leb(payload.length), payload]);
  const header = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return Buffer.concat([header, section]);
}

function contractDataEntry(key: xdr.ScVal, val: xdr.ScVal): string {
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: Address.fromString(C).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
      val,
    }),
  ).toXDR("base64");
}

function instanceEntry(executable: xdr.ContractExecutable): string {
  return contractDataEntry(
    xdr.ScVal.scvLedgerKeyContractInstance(),
    xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable, storage: [] })),
  );
}

function codeEntry(wasm: Buffer): string {
  return xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({ ext: new xdr.ContractCodeEntryExt(0), hash: H, code: wasm }),
  ).toXDR("base64");
}

class Backend implements RpcBackend {
  constructor(private readonly entries: Map<string, string>) {}
  getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }> {
    return Promise.resolve({ sequence: 1000, protocolVersion: 22, id: "x" });
  }
  getLedgerEntries(keysB64: string[]): Promise<RawLedgerEntriesResponse> {
    const entries = keysB64
      .map((k) => (this.entries.has(k) ? { keyB64: k, xdrB64: this.entries.get(k)!, liveUntilLedgerSeq: 5000 } : null))
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return Promise.resolve({ latestLedger: 1000, entries });
  }
  getTransaction(): Promise<never> {
    throw new Error("unused");
  }
  getTransactions(): Promise<never> {
    throw new Error("unused");
  }
}

const deps = (m: Map<string, string>): { rpc: RpcClient; network: "testnet" } => ({
  rpc: RpcClient.create(new Backend(m)),
  network: "testnet",
});

describe("interfaceLookup (B2)", () => {
  it("T-B2.1-1: SAC → fixed SEP-41 interface, trusted", async () => {
    const m = new Map([[accountInstanceKey(C).toXDR("base64"), instanceEntry(xdr.ContractExecutable.contractExecutableStellarAsset())]]);
    const spec = await interfaceLookup({ contract: C }, deps(m));
    expect(spec.kind).toBe("sac");
    expect(spec.trusted).toBe(true);
    expect(spec.functions.map((f) => f.name)).toContain("transfer");
  });

  it("T-B2.1-2: WASM → parsed contractspec, untrusted", async () => {
    const entries = [fnEntry("do_thing", [["amount", () => xdr.ScSpecTypeDef.scSpecTypeI128()]])];
    const m = new Map([
      [accountInstanceKey(C).toXDR("base64"), instanceEntry(xdr.ContractExecutable.contractExecutableWasm(H))],
      [contractCodeKey(toWasmHash(H.toString("hex"))).toXDR("base64"), codeEntry(buildWasm(entries))],
    ]);
    const spec = await interfaceLookup({ contract: C }, deps(m));
    expect(spec.kind).toBe("wasm");
    expect(spec.trusted).toBe(false);
    expect(spec.functions.map((f) => f.name)).toEqual(["do_thing"]);
    expect(spec.functions[0]?.args[0]).toEqual({ name: "amount", sc_type: "I128" });
  });

  it("T-B2.1-3: WASM without a contractspec → E_DATA_NO_SPEC", async () => {
    const emptyWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const m = new Map([
      [accountInstanceKey(C).toXDR("base64"), instanceEntry(xdr.ContractExecutable.contractExecutableWasm(H))],
      [contractCodeKey(toWasmHash(H.toString("hex"))).toXDR("base64"), codeEntry(emptyWasm)],
    ]);
    await expect(interfaceLookup({ contract: C }, deps(m))).rejects.toMatchObject({ code: "E_DATA_NO_SPEC" });
  });

  it("T-B2.1-4: hostile arg name is fenced", () => {
    const entries = [fnEntry("f", [["ab", () => xdr.ScSpecTypeDef.scSpecTypeU32()]])];
    const funcs = specToInterface(entries);
    expect(funcs[0]?.args[0]?.name).toBe("ab");
  });

  it("extractSpecEntries returns [] for non-WASM bytes", () => {
    expect(extractSpecEntries(Buffer.from("not wasm"))).toEqual([]);
  });
});
