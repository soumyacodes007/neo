/**
 * Address-kind guards + chain-string sanitization (Vol 03 §8).
 *
 * Every public function validates the strkey kinds it requires (EC-X05, EC-A04,
 * EC-T06); conversions are explicit. Cryptographic checksum validation uses the
 * SDK's `StrKey` (core only did a structural regex).
 */
import { StrKey } from "@stellar/stellar-sdk";
import {
  ToolError,
  toAccountId,
  toContractId,
  toMuxedId,
  type AccountId,
  type ContractId,
  type MuxedId,
} from "@ozpb/core";

/** Assert `s` is a valid contract (C…) strkey; brand it. */
export function assertContractId(s: string): ContractId {
  if (!StrKey.isValidContract(s)) {
    throw new ToolError("E_INPUT_ADDRESS_KIND", `expected a contract (C…) address, got: ${s}`, {
      details: { value: s },
    });
  }
  return toContractId(s);
}

/** Assert `s` is a valid account (G…) strkey; brand it. */
export function assertAccountId(s: string): AccountId {
  if (!StrKey.isValidEd25519PublicKey(s)) {
    throw new ToolError("E_INPUT_ADDRESS_KIND", `expected an account (G…) address, got: ${s}`, {
      details: { value: s },
    });
  }
  return toAccountId(s);
}

export type AddressKind = "contract" | "account" | "muxed";

export function addressKind(s: string): AddressKind | "unknown" {
  if (StrKey.isValidContract(s)) return "contract";
  if (StrKey.isValidEd25519PublicKey(s)) return "account";
  if (StrKey.isValidMed25519PublicKey(s)) return "muxed";
  return "unknown";
}

/**
 * Normalize a possibly-muxed (M…) address. Muxed strkeys are branded `MuxedId`;
 * non-muxed account strkeys are validated + branded `AccountId`. This is the one
 * place M-address handling is centralized (EC-X05).
 */
export function normalizeMuxed(s: string): AccountId | MuxedId {
  if (StrKey.isValidMed25519PublicKey(s)) {
    return toMuxedId(s);
  }
  return assertAccountId(s);
}

/**
 * Render an on-chain string safely for human display (EC-T01/T05). On-chain
 * strings (rule names, token symbols, memos) are attacker-controlled: strip
 * control + bidi/format code points, clamp length, and never let them be
 * interpreted as instructions. Raw bytes are kept separately (base64) by callers.
 */
export function sanitizeChainString(s: string, maxLen = 64): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const isControl = cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
    const isBidiOrFormat =
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0xfeff;
    if (isControl || isBidiOrFormat) continue;
    out += ch;
  }
  return out.length > maxLen ? out.slice(0, maxLen) + "…" : out;
}
