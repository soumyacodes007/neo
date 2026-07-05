/**
 * XDR decode pipeline (Vol 03 §3, FN-ST.9–13). Pure functions: base64 in,
 * SCH-typed JSON out, lossless (every leaf keeps `xdr_b64`, INV-Trace-1).
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import {
  ToolError,
  toAmount,
  type ContractId,
  type DecodedEvent,
  type InvocationNodeT,
  type ScValJson,
  type TokenDelta,
} from "@ozpb/core";
import { assertContractId } from "./address.js";
import { toScValJson } from "./scval.js";

const MAX_XDR_BYTES = 1 << 20; // 1 MiB (EC-X04)

export interface DecodedOperation {
  type: string;
  detail: unknown;
}

export interface DecodedEnvelope {
  sourceAccount: string;
  feeBump: { feeSource: string } | undefined;
  operations: DecodedOperation[];
  /** The single InvokeHostFunctionOp's decoded root call, if present. */
  invocation: InvocationNodeT | undefined;
  authEntries: xdr.SorobanAuthorizationEntry[];
  rawInvokeHostFn: xdr.HostFunction | undefined;
}

function decodeB64(envelopeXdr: string): Buffer {
  const buf = Buffer.from(envelopeXdr, "base64");
  if (buf.length === 0) {
    throw new ToolError("E_DATA_MALFORMED_XDR", "empty or invalid base64 XDR (EC-X11)");
  }
  if (buf.length > MAX_XDR_BYTES) {
    throw new ToolError("E_DATA_MALFORMED_XDR", `XDR exceeds ${String(MAX_XDR_BYTES)} bytes (EC-X04)`);
  }
  return buf;
}

/**
 * FN-ST.9 — top-level decode: unwrap a fee-bump wrapper exactly once (EC-X01),
 * collect all operations (EC-X06), isolate the ≤1 InvokeHostFunctionOp.
 */
export function decodeTransactionEnvelope(envelopeXdr: string): DecodedEnvelope {
  const buf = decodeB64(envelopeXdr);
  let env: xdr.TransactionEnvelope;
  try {
    env = xdr.TransactionEnvelope.fromXDR(buf);
  } catch (cause) {
    throw new ToolError("E_DATA_MALFORMED_XDR", "could not decode TransactionEnvelope", { cause });
  }

  let feeBump: { feeSource: string } | undefined;
  let tx: xdr.Transaction;
  switch (env.switch().name) {
    case "envelopeTypeTxFeeBump": {
      const fb = env.feeBump().tx();
      feeBump = { feeSource: muxedToString(fb.feeSource()) };
      const inner = fb.innerTx();
      if (inner.switch().name !== "envelopeTypeTx") {
        throw new ToolError("E_DATA_MALFORMED_XDR", "nested fee-bump is not allowed (EC-X01)");
      }
      tx = inner.v1().tx();
      break;
    }
    case "envelopeTypeTx":
      tx = env.v1().tx();
      break;
    case "envelopeTypeTxV0":
      // Legacy classic-only envelope: no Soroban host function.
      return {
        sourceAccount: publicKeyToString(env.v0().tx().sourceAccountEd25519()),
        feeBump: undefined,
        operations: env.v0().tx().operations().map(decodeOperation),
        invocation: undefined,
        authEntries: [],
        rawInvokeHostFn: undefined,
      };
    default:
      throw new ToolError("E_DATA_MALFORMED_XDR", `unknown envelope type ${env.switch().name}`);
  }

  const operations = tx.operations().map(decodeOperation);
  let invocation: InvocationNodeT | undefined;
  let authEntries: xdr.SorobanAuthorizationEntry[] = [];
  let rawInvokeHostFn: xdr.HostFunction | undefined;
  for (const op of tx.operations()) {
    if (op.body().switch().name === "invokeHostFunction") {
      const ihf = op.body().invokeHostFunctionOp();
      rawInvokeHostFn = ihf.hostFunction();
      invocation = decodeInvocationTree(rawInvokeHostFn);
      authEntries = ihf.auth();
      break; // at most one per tx
    }
  }

  return {
    sourceAccount: muxedToString(tx.sourceAccount()),
    feeBump,
    operations,
    invocation,
    authEntries,
    rawInvokeHostFn,
  };
}

function decodeOperation(op: xdr.Operation): DecodedOperation {
  return { type: op.body().switch().name, detail: null };
}

/** FN-ST.10 — build the root invocation node from an InvokeContract host function. */
export function decodeInvocationTree(hf: xdr.HostFunction): InvocationNodeT | undefined {
  if (hf.switch().name !== "hostFunctionTypeInvokeContract") {
    // CreateContract* — not a contract call; represented at the op level (EC-X09).
    return undefined;
  }
  const ic = hf.invokeContract();
  return {
    contract: scAddressToContractId(ic.contractAddress()),
    fn_name: ic.functionName().toString(),
    args: ic.args().map(toScValJson),
    sub_invocations: [], // observed sub-calls are reconstructed from auth entries (FN-ST.11)
  };
}

export interface AuthEntryTraceRaw {
  credentials:
    | { kind: "source_account" }
    | { kind: "address"; address: string; nonce: string; signature_expiration_ledger: number };
  root_invocation: InvocationNodeT;
}

/** FN-ST.11 — decode credentials + the rootInvocation/subInvocations tree (EC-G07). */
export function decodeAuthEntries(auth: xdr.SorobanAuthorizationEntry[]): AuthEntryTraceRaw[] {
  return auth.map((entry) => {
    const creds = entry.credentials();
    let credentials: AuthEntryTraceRaw["credentials"];
    if (creds.switch().name === "sorobanCredentialsSourceAccount") {
      credentials = { kind: "source_account" };
    } else {
      const ac = creds.address();
      credentials = {
        kind: "address",
        address: scAddressToString(ac.address()),
        nonce: ac.nonce().toString(),
        signature_expiration_ledger: ac.signatureExpirationLedger(),
      };
    }
    return { credentials, root_invocation: decodeAuthorizedInvocation(entry.rootInvocation()) };
  });
}

function decodeAuthorizedInvocation(inv: xdr.SorobanAuthorizedInvocation): InvocationNodeT {
  const fn = inv.function();
  const sub = inv.subInvocations().map(decodeAuthorizedInvocation);
  if (fn.switch().name === "sorobanAuthorizedFunctionTypeContractFn") {
    const ic = fn.contractFn();
    return {
      contract: scAddressToContractId(ic.contractAddress()),
      fn_name: ic.functionName().toString(),
      args: ic.args().map(toScValJson),
      sub_invocations: sub,
    };
  }
  // create-contract authorized function — synthesize a marker node (EC-X09).
  return { contract: assertContractId(placeholderContract()), fn_name: "__create_contract__", args: [], sub_invocations: sub };
}

/**
 * FN-ST.13 — turn SEP-41/SAC transfer/mint/burn events into token deltas. `enrich`
 * supplies symbol/decimals; its failure drops only metadata, never the delta (EC-X10).
 */
export function deriveTokenDeltas(
  events: DecodedEvent[],
  enrich: (token: ContractId) => { decimals: number; symbol?: string } | undefined,
): TokenDelta[] {
  const deltas: TokenDelta[] = [];
  for (const ev of events) {
    if (ev.contract === undefined) continue;
    const topic0 = ev.topics[0];
    if (topic0 === undefined || topic0.type !== "scvSymbol") continue;
    const kind = topic0.value;
    if (kind !== "transfer" && kind !== "mint" && kind !== "burn") continue;
    const from = addressTopic(ev.topics[1]);
    const to = addressTopic(ev.topics[2]);
    const amount = i128FromData(ev.data);
    if (amount === undefined) continue;
    const meta = enrich(ev.contract);
    deltas.push({
      token: ev.contract,
      from: from ?? "",
      to: to ?? "",
      amount: toAmount(amount),
      decimals: meta?.decimals ?? 0,
      ...(meta?.symbol !== undefined ? { symbol: meta.symbol } : {}),
      source: "event",
    });
  }
  return deltas;
}

// --- helpers --------------------------------------------------------------

function addressTopic(t: ScValJson | undefined): string | undefined {
  return t !== undefined && t.type === "scvAddress" && typeof t.value === "string" ? t.value : undefined;
}

function i128FromData(data: ScValJson): string | undefined {
  // SAC amounts are bare i128; some events wrap the amount in a struct.
  if ((data.type === "scvI128" || data.type === "scvU128") && typeof data.value === "string") {
    return data.value;
  }
  return undefined;
}

function scAddressToString(a: xdr.ScAddress): string {
  return Address.fromScAddress(a).toString();
}
function scAddressToContractId(a: xdr.ScAddress): ContractId {
  return assertContractId(scAddressToString(a));
}
function muxedToString(m: xdr.MuxedAccount): string {
  return Address.account(m.switch().name === "keyTypeEd25519" ? m.ed25519() : m.med25519().ed25519()).toString();
}
function publicKeyToString(pk: Buffer): string {
  return Address.account(pk).toString();
}
function placeholderContract(): string {
  // Deterministic all-zero contract id used only as a create-contract marker.
  return Address.contract(Buffer.alloc(32, 0)).toString();
}
