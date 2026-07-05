/**
 * Encoders for the OZ smart-account management ABI (mirror of the decoders in
 * `keys.ts`), used to build unsigned install/revocation transactions (Vol 09 E1/E2).
 *
 *   add_context_rule(context_type: ContextRuleType, name: String,
 *                    valid_until: Option<u32>, signers: Vec<Signer>,
 *                    policies: Map<Address, Val>) [code smart_account/mod.rs:238]
 *
 * The exact byte-level match against a deployed account is pinned by a testnet
 * rehearsal (F1 / Phase 8); these encoders mirror the verified storage layout.
 */
import { Account, Address, Contract, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { ContextType, ContractId, Network, SignerModel, XdrBase64 } from "@ozpb/core";

const PASSPHRASE: Record<Network, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  local: Networks.STANDALONE,
};

export function encodeContextRuleType(ct: ContextType): xdr.ScVal {
  switch (ct.kind) {
    case "default":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Default")]);
    case "call_contract":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), Address.fromString(ct.address).toScVal()]);
    case "create_contract":
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CreateContract"), xdr.ScVal.scvBytes(Buffer.from(ct.wasm_hash, "hex"))]);
  }
}

export function encodeSigner(s: SignerModel): xdr.ScVal {
  if (s.type === "delegated") {
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated"), Address.fromString(s.address).toScVal()]);
  }
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(s.verifier).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(s.key_data_b64, "base64")),
  ]);
}

export interface PolicyMapEntry {
  address: ContractId;
  installParams: XdrBase64;
}

/** Build the `Map<Address, Val>` policies argument. */
export function encodePolicyMap(entries: PolicyMapEntry[]): xdr.ScVal {
  const mapEntries = entries
    .map((e) => new xdr.ScMapEntry({ key: Address.fromString(e.address).toScVal(), val: xdr.ScVal.fromXDR(e.installParams, "base64") }))
    // Soroban maps require key-sorted entries.
    .sort((a, b) => a.key().toXDR("base64").localeCompare(b.key().toXDR("base64")));
  return xdr.ScVal.scvMap(mapEntries);
}

export interface AddContextRuleArgs {
  contextType: ContextType;
  name: string;
  validUntil: number;
  signers: SignerModel[];
  policies: PolicyMapEntry[];
}

export function encodeAddContextRuleArgs(a: AddContextRuleArgs): xdr.ScVal[] {
  return [
    encodeContextRuleType(a.contextType),
    xdr.ScVal.scvString(a.name),
    xdr.ScVal.scvU32(a.validUntil), // Option<u32>::Some(v) ⇒ the inner value
    xdr.ScVal.scvVec(a.signers.map(encodeSigner)),
    encodePolicyMap(a.policies),
  ];
}

/** Build an unsigned invocation transaction envelope (base64) for a management call. */
export function buildUnsignedInvoke(
  account: ContractId,
  fn: string,
  args: xdr.ScVal[],
  network: Network,
): { envelopeXdr: string; op: xdr.Operation } {
  const op = new Contract(account).call(fn, ...args);
  // Source is the account itself; sequence 0 is a placeholder for an unsigned tx.
  const source = new Account(placeholderG(), "0");
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: PASSPHRASE[network] })
    .addOperation(op)
    .setTimeout(0)
    .build();
  return { envelopeXdr: tx.toEnvelope().toXDR("base64"), op };
}

// A deterministic placeholder source account for unsigned envelopes (never signs).
function placeholderG(): string {
  return Address.account(Buffer.alloc(32, 0)).toString();
}
