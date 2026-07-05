/**
 * Digest & AuthPayload builder (Vol 03 §5, FN-ST.18–21).
 *
 * The single implementation of the OZ auth-signing contract. Getting this wrong
 * is EC-G01, so the digest formula lives here and nowhere else:
 *
 *     auth_digest = sha256( signature_payload ‖ context_rule_ids.to_xdr() )
 *
 * where `context_rule_ids` is the on-chain `Vec<u32>` value, whose `to_xdr()`
 * is the XDR of an `ScVal::Vec` of `ScVal::U32` [code storage.rs:492-495].
 *
 * The exact `Vec<u32>.to_xdr` framing is tagged `[inference]` in Vol 03 and is
 * pinned by a fork round-trip test (T-ST.18-2, pending a deployed fixture). The
 * unit tests here pin the *shape* and determinism.
 */
import { createHash } from "node:crypto";
import { xdr } from "@stellar/stellar-sdk";
import { ToolError } from "@ozpb/core";

/** XDR bytes of the `Vec<u32>` context-rule-id selector (an `ScVal::Vec<U32>`). */
export function contextRuleIdsToXdr(contextRuleIds: readonly number[]): Buffer {
  const vec = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id)));
  return vec.toXDR(); // Buffer of raw XDR
}

/**
 * FN-ST.18 — compute the auth digest signers actually sign. `signaturePayload`
 * is the 32-byte payload passed to `__check_auth`.
 */
export function computeAuthDigest(
  signaturePayload: Buffer,
  contextRuleIds: readonly number[],
): Buffer {
  if (signaturePayload.length !== 32) {
    throw new ToolError(
      "E_INPUT_SCHEMA",
      `signature payload must be 32 bytes, got ${String(signaturePayload.length)}`,
    );
  }
  const idsXdr = contextRuleIdsToXdr(contextRuleIds);
  return createHash("sha256")
    .update(signaturePayload)
    .update(idsXdr)
    .digest();
}

/**
 * FN-ST.20 — produce the `context_rule_ids` vector aligned by index with the
 * *simulated* context order (never assumed) [code storage.rs:468]. `select`
 * maps each context to its chosen rule id; the result length must equal the
 * number of contexts (EC-G02).
 */
export function mapContextsToRuleIds<Ctx>(
  contexts: readonly Ctx[],
  select: (ctx: Ctx, index: number) => number,
): number[] {
  return contexts.map((ctx, i) => {
    const id = select(ctx, i);
    if (!Number.isInteger(id) || id < 0) {
      throw new ToolError("E_INPUT_SCHEMA", `rule id for context ${String(i)} must be a u32`);
    }
    return id;
  });
}
