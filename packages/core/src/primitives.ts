/**
 * Branded primitive types (Vol 01 §2.3).
 *
 * These are the only sanctioned way to mint a typed strkey/hash/amount. Every
 * value is a plain string/number at runtime but is nominally distinct at the
 * type level, so a `G…` account address can never be passed where a `C…`
 * contract address is required, and a JS `number` can never stand in for an
 * on-chain amount (EC-X07).
 *
 * Structural validation only (shape + charset). Cryptographic checksum
 * validation of strkeys lives in `packages/stellar` (`assertContractId` etc.,
 * FN §8) which has access to `@stellar/stellar-sdk`'s `StrKey`; `core` stays
 * dependency-light (zod only).
 */
import { z } from "zod";

// Stellar strkeys are RFC4648 base32 (uppercase A–Z, digits 2–7), no padding.
// G/C keys are 56 chars; M (muxed) keys are 69 chars.
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const MUXED_RE = /^M[A-Z2-7]{68}$/;
const HASH64_RE = /^[0-9a-f]{64}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;
// Permissive base64 (std alphabet, optional padding). Byte-level validity is
// re-checked when the string is actually decoded in `packages/stellar`.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 2^127 − 1 — the maximum signed 128-bit integer (SAC/Soroban amount ceiling). */
export const I128_MAX = 170141183460469231731687303715884105727n;
/** −2^127 — the minimum signed 128-bit integer. */
export const I128_MIN = -170141183460469231731687303715884105728n;

export const ContractId = z
  .string()
  .regex(CONTRACT_RE, "expected a contract strkey (C…, 56 chars)")
  .brand<"ContractId">();
export type ContractId = z.infer<typeof ContractId>;

export const AccountId = z
  .string()
  .regex(ACCOUNT_RE, "expected an account strkey (G…, 56 chars)")
  .brand<"AccountId">();
export type AccountId = z.infer<typeof AccountId>;

export const MuxedId = z
  .string()
  .regex(MUXED_RE, "expected a muxed account strkey (M…, 69 chars)")
  .brand<"MuxedId">();
export type MuxedId = z.infer<typeof MuxedId>;

export const WasmHash = z
  .string()
  .regex(HASH64_RE, "expected a 32-byte hash as 64 lowercase hex chars")
  .brand<"WasmHash">();
export type WasmHash = z.infer<typeof WasmHash>;

export const TxHash = z
  .string()
  .regex(HASH64_RE, "expected a 32-byte tx hash as 64 lowercase hex chars")
  .brand<"TxHash">();
export type TxHash = z.infer<typeof TxHash>;

export const LedgerSeq = z
  .number()
  .int()
  .min(0)
  .max(0xffff_ffff)
  .brand<"LedgerSeq">();
export type LedgerSeq = z.infer<typeof LedgerSeq>;

/**
 * A non-negative decimal amount as a string. NEVER a JS `number` — 2^53 < i128
 * max, so numeric amounts silently lose precision (EC-X07). The fractional
 * scale lives in a separate `decimals` field on the containing object; use
 * {@link amountFitsI128} to enforce INV-Common-1.
 */
export const Amount = z
  .string()
  .regex(AMOUNT_RE, "expected a non-negative decimal string")
  .brand<"Amount">();
export type Amount = z.infer<typeof Amount>;

export const XdrBase64 = z
  .string()
  .regex(BASE64_RE, "expected base64-encoded XDR")
  .brand<"XdrBase64">();
export type XdrBase64 = z.infer<typeof XdrBase64>;

/** Mint helpers — the single entry points that validate + brand. */
export const toContractId = (s: string): ContractId => ContractId.parse(s);
export const toAccountId = (s: string): AccountId => AccountId.parse(s);
export const toMuxedId = (s: string): MuxedId => MuxedId.parse(s);
export const toWasmHash = (s: string): WasmHash => WasmHash.parse(s);
export const toTxHash = (s: string): TxHash => TxHash.parse(s);
export const toLedgerSeq = (n: number): LedgerSeq => LedgerSeq.parse(n);
export const toAmount = (s: string): Amount => Amount.parse(s);
export const toXdrBase64 = (s: string): XdrBase64 => XdrBase64.parse(s);

/**
 * INV-Common-1: the amount, scaled by `decimals`, must be a non-negative
 * integer that fits in i128. Returns the scaled `bigint` if valid.
 */
export function amountFitsI128(amount: string, decimals: number): bigint | null {
  if (!AMOUNT_RE.test(amount)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) return null;
  const [intPart, fracPart = ""] = amount.split(".");
  if (fracPart.length > decimals) return null; // more precision than the token supports
  const scaledStr = (intPart ?? "0") + fracPart.padEnd(decimals, "0");
  const scaled = BigInt(scaledStr);
  if (scaled < 0n || scaled > I128_MAX) return null;
  return scaled;
}
