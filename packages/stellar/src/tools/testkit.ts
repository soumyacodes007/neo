/**
 * Shared test fixtures for the A-tools (not part of the shipped build — excluded
 * in tsconfig). Builds an OZ smart-account fixture entirely from locally-encoded
 * ledger entries, so the inspection tools can be exercised offline.
 */
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import { toContractId } from "@ozpb/core";
import { accountInstanceKey, contextRuleDataKey, policyDataKey, signerDataKey } from "../keys.js";
import { RpcClient, type RawLedgerEntriesResponse, type RpcBackend } from "../rpc.js";
import { InMemoryRegistry } from "./registry.js";
import type { InspectDeps } from "./inspect-account.js";

export const ACCOUNT = toContractId(StrKey.encodeContract(Buffer.alloc(32, 1)));
export const TARGET = toContractId(StrKey.encodeContract(Buffer.alloc(32, 2)));
export const POLICY = toContractId(StrKey.encodeContract(Buffer.alloc(32, 3)));
export const G_AGENT = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 4));
export const H_ACCT = Buffer.alloc(32, 0xaa);
export const H_SPENDING = Buffer.alloc(32, 0xbb);

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);
const struct = (f: Record<string, xdr.ScVal>): xdr.ScVal =>
  xdr.ScVal.scvMap(Object.entries(f).map(([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v })));

export function ledgerEntry(contract: string, key: xdr.ScVal, val: xdr.ScVal): string {
  const cd = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(contract).toScAddress(),
    key,
    durability: xdr.ContractDataDurability.persistent(),
    val,
  });
  return xdr.LedgerEntryData.contractData(cd).toXDR("base64");
}

export function instanceVal(wasm: Buffer, storage: Record<string, number>): xdr.ScVal {
  return xdr.ScVal.scvContractInstance(
    new xdr.ScContractInstance({
      executable: xdr.ContractExecutable.contractExecutableWasm(wasm),
      storage: Object.entries(storage).map(
        ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([sym(k)]), val: u32(v) }),
      ),
    }),
  );
}

export interface FixtureOpts {
  ruleName?: string;
  /** valid_until for the scoped agent rule (rule 1); default 500. */
  agentValidUntil?: number;
}

export function buildFixture(opts: FixtureOpts = {}): Map<string, string> {
  const m = new Map<string, string>();
  const put = (key: xdr.LedgerKey, contract: string, val: xdr.ScVal): void => {
    m.set(key.toXDR("base64"), ledgerEntry(contract, key.contractData().key(), val));
  };

  put(accountInstanceKey(ACCOUNT), ACCOUNT, instanceVal(H_ACCT, { NextId: 2, Count: 2, NextSignerId: 1, NextPolicyId: 1 }));
  put(accountInstanceKey(POLICY), POLICY, instanceVal(H_SPENDING, {}));

  put(
    contextRuleDataKey(ACCOUNT, 0),
    ACCOUNT,
    struct({
      name: xdr.ScVal.scvString("owner"),
      context_type: xdr.ScVal.scvVec([sym("Default")]),
      valid_until: xdr.ScVal.scvVoid(),
      signer_ids: xdr.ScVal.scvVec([u32(0)]),
      policy_ids: xdr.ScVal.scvVec([]),
    }),
  );
  put(
    contextRuleDataKey(ACCOUNT, 1),
    ACCOUNT,
    struct({
      name: xdr.ScVal.scvString(opts.ruleName ?? "agent"),
      context_type: xdr.ScVal.scvVec([sym("CallContract"), Address.fromString(TARGET).toScVal()]),
      valid_until: u32(opts.agentValidUntil ?? 500),
      signer_ids: xdr.ScVal.scvVec([u32(0)]),
      policy_ids: xdr.ScVal.scvVec([u32(0)]),
    }),
  );
  put(
    signerDataKey(ACCOUNT, 0),
    ACCOUNT,
    struct({ signer: xdr.ScVal.scvVec([sym("Delegated"), Address.fromString(G_AGENT).toScVal()]), count: u32(2) }),
  );
  put(policyDataKey(ACCOUNT, 0), ACCOUNT, struct({ policy: Address.fromString(POLICY).toScVal(), count: u32(1) }));
  return m;
}

export class FixtureBackend implements RpcBackend {
  constructor(private readonly entries: Map<string, string>, private readonly latest = 1000) {}
  getLatestLedger(): Promise<{ sequence: number; protocolVersion: number; id: string }> {
    return Promise.resolve({ sequence: this.latest, protocolVersion: 22, id: "x" });
  }
  getLedgerEntries(keysB64: string[]): Promise<RawLedgerEntriesResponse> {
    const entries = keysB64
      .map((k) => {
        const xdrB64 = this.entries.get(k);
        return xdrB64 === undefined ? null : { keyB64: k, xdrB64, liveUntilLedgerSeq: this.latest + 1000 };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
    return Promise.resolve({ latestLedger: this.latest, entries });
  }
  getTransaction(): Promise<never> {
    throw new Error("unused");
  }
  getTransactions(): Promise<never> {
    throw new Error("unused");
  }
}

export function makeInspectDeps(
  entries: Map<string, string>,
  now: () => string = () => "2026-07-05T00:00:00.000Z",
  registerWasm = true,
  latest = 1000,
): InspectDeps {
  const registry = new InMemoryRegistry().registerPolicy(H_SPENDING.toString("hex"), "oz:spending_limit");
  if (registerWasm) registry.registerAccountWasm(H_ACCT.toString("hex"));
  return { rpc: RpcClient.create(new FixtureBackend(entries, latest)), registry, network: "testnet", now };
}
