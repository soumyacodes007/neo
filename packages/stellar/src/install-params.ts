/**
 * Install-param ScVal encoders (Vol 06 C2). Turns the abstract install params
 * C2 produces into the exact '#[contracttype]' ScVal each policy's 'install'
 * expects. A Soroban struct encodes as an 'ScVal::Map' with SYMBOL keys (sorted
 * by the host ordering); an enum as 'ScVal::Vec[Symbol(variant), ...args]';
 * 'Option<T>' as the value (Some) or 'Void' (None).
 *
 * Correctness is pinned by a Rust parity test (in the pb policy crates) that decodes
 * this XDR back into the real param structs - so ordering/shape is host-verified,
 * not assumed.
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { toXdrBase64, type PolicyClassification, type XdrBase64 } from "@ozpb/core";
import { encodeSigner } from "./encode.js";
import type { SignerModel } from "@ozpb/core";

const sym = (s: string): xdr.ScVal => xdr.ScVal.scvSymbol(s);
const u32 = (n: number): xdr.ScVal => xdr.ScVal.scvU32(n);
const i128 = (v: string | bigint): xdr.ScVal => nativeToScVal(BigInt(v), { type: "i128" });
const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();
const vec = (items: xdr.ScVal[]): xdr.ScVal => xdr.ScVal.scvVec(items);

/** Build a contracttype struct value: symbol-keyed map, host-sorted. */
function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.entries(fields).map(
    ([k, v]) => new xdr.ScMapEntry({ key: sym(k), val: v }),
  );
  entries.sort((a, b) => compareSymbolKey(a.key(), b.key()));
  return xdr.ScVal.scvMap(entries);
}

/**
 * Soroban orders map keys by host Val comparison, which for symbols is a
 * lexicographic comparison of the character sequence (uniform across small and
 * object symbols). For the snake_case identifier charset all our policy structs
 * use ([a-z_]), the Soroban char-code order ('_' before lowercase) equals plain
 * string order, so a lexicographic string compare is exact. Verified by the Rust
 * parity test that decodes this XDR into the real param structs.
 *
 * (If a field name ever used digits or uppercase, this would need the explicit
 * char-code order '_'<0-9<A-Z<a-z; none do.)
 */
function compareSymbolKey(a: xdr.ScVal, b: xdr.ScVal): number {
  const sa = Buffer.from(a.sym() as unknown as Uint8Array).toString("utf8");
  const sb = Buffer.from(b.sym() as unknown as Uint8Array).toString("utf8");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// --- PathSeg / Predicate enum encoders (shared by arg_guard + call_cap) ------

export type PathSegInput =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

function pathSeg(seg: PathSegInput): xdr.ScVal {
  switch (seg.kind) {
    case "field":
      return vec([sym("Field"), sym(seg.name)]);
    case "index":
      return vec([sym("Index"), u32(seg.index)]);
    case "wildcard":
      return vec([sym("Wildcard")]);
  }
}
const pathVal = (path: PathSegInput[]): xdr.ScVal => vec(path.map(pathSeg));

export type PredicateInput =
  | { kind: "u32_eq"; value: number }
  | { kind: "u32_in"; values: number[] }
  | { kind: "range"; min: string; max: string }
  | { kind: "addr_eq"; address: string }
  | { kind: "addr_in"; addresses: string[] };

function predicate(p: PredicateInput): xdr.ScVal {
  switch (p.kind) {
    case "u32_eq":
      return vec([sym("U32Eq"), u32(p.value)]);
    case "u32_in":
      return vec([sym("U32In"), vec(p.values.map(u32))]);
    case "range":
      return vec([sym("Range"), i128(p.min), i128(p.max)]);
    case "addr_eq":
      return vec([sym("AddrEq"), addr(p.address)]);
    case "addr_in":
      return vec([sym("AddrIn"), vec(p.addresses.map(addr))]);
  }
}

// --- Per-policy param encoders ----------------------------------------------

export function encodeSpendingLimitParams(p: { spendingLimit: string; periodLedgers: number }): xdr.ScVal {
  return struct({ spending_limit: i128(p.spendingLimit), period_ledgers: u32(p.periodLedgers) });
}

export function encodeSimpleThresholdParams(p: { threshold: number }): xdr.ScVal {
  return struct({ threshold: u32(p.threshold) });
}

export function encodeWeightedThresholdParams(p: {
  threshold: number;
  weights: { signer: SignerModel; weight: number }[];
}): xdr.ScVal {
  const entries = p.weights.map((w) => new xdr.ScMapEntry({ key: encodeSigner(w.signer), val: u32(w.weight) }));
  return struct({ signer_weights: xdr.ScVal.scvMap(entries), threshold: u32(p.threshold) });
}

export function encodeFunctionAllowlistParams(p: { allowed: string[] }): xdr.ScVal {
  return struct({ allowed: vec(p.allowed.map(sym)) });
}

export function encodeRateLimitParams(p: { maxCalls: number; periodLedgers: number; fnScope?: string }): xdr.ScVal {
  return struct({
    max_calls: u32(p.maxCalls),
    period_ledgers: u32(p.periodLedgers),
    fn_scope: p.fnScope !== undefined ? sym(p.fnScope) : xdr.ScVal.scvVoid(),
  });
}

export function encodeCallCapParams(p: {
  cap: string;
  periodLedgers: number;
  fnName: string;
  amountPath: PathSegInput[];
  tokenFilterPath?: PathSegInput[];
  tokenFilterToken?: string;
}): xdr.ScVal {
  return struct({
    cap: i128(p.cap),
    period_ledgers: u32(p.periodLedgers),
    fn_name: sym(p.fnName),
    amount_path: pathVal(p.amountPath),
    token_filter_path: pathVal(p.tokenFilterPath ?? []),
    token_filter_token: p.tokenFilterToken !== undefined ? addr(p.tokenFilterToken) : xdr.ScVal.scvVoid(),
  });
}

export interface ArgRuleInput {
  fnName: string;
  argIndex: number;
  path: PathSegInput[];
  pred: PredicateInput;
  forall: boolean;
}

export function encodeArgGuardParams(p: { rules: ArgRuleInput[] }): xdr.ScVal {
  const rules = p.rules.map((r) =>
    struct({
      fn_name: sym(r.fnName),
      arg_index: u32(r.argIndex),
      path: pathVal(r.path),
      pred: predicate(r.pred),
      forall: xdr.ScVal.scvBool(r.forall),
    }),
  );
  return struct({ rules: vec(rules) });
}

/** Base64 XDR helper for callers writing install params into a plan/binding. */
export function toParamsB64(scv: xdr.ScVal): XdrBase64 {
  return toXdrBase64(scv.toXDR("base64"));
}

/** Dispatcher matching C2's 'encodeInstallParams(classification, params)' signature. */
export function encodeInstallParams(classification: PolicyClassification, params: Record<string, unknown>): XdrBase64 {
  const p = params as Record<string, never>;
  switch (classification) {
    case "oz:spending_limit":
      return toParamsB64(encodeSpendingLimitParams({ spendingLimit: String(params["spending_limit"]), periodLedgers: Number(params["period_ledgers"]) }));
    case "oz:simple_threshold":
      return toParamsB64(encodeSimpleThresholdParams({ threshold: Number(params["threshold"]) }));
    case "pb:function_allowlist":
      return toParamsB64(encodeFunctionAllowlistParams({ allowed: params["functions"] as string[] }));
    case "pb:rate_limit":
      return toParamsB64(encodeRateLimitParams({ maxCalls: Number(params["max_calls"]), periodLedgers: Number(params["window"]), ...(params["fn_scope"] !== undefined ? { fnScope: String(params["fn_scope"]) } : {}) }));
    case "pb:call_cap":
      return toParamsB64(encodeCallCapParams(params as never));
    case "pb:arg_guard":
      return toParamsB64(encodeArgGuardParams({ rules: (params["rules"] as ArgRuleInput[] | undefined) ?? [] }));
    default:
      void p;
      throw new Error("no install-param encoder for classification " + classification);
  }
}
