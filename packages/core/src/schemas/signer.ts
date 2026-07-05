/** SCH-SignerModel (Vol 02 §1). Mirror of on-chain `Signer` [code storage.rs:96]. */
import { z } from "zod";
import { AccountId, ContractId } from "../primitives.js";

export const SignerModel = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delegated"), address: z.union([AccountId, ContractId]) }),
  z.object({
    type: z.literal("external"),
    verifier: ContractId,
    key_data_b64: z.string().base64(),
    verifier_kind: z.enum(["ed25519", "webauthn", "unknown"]),
  }),
]);
export type SignerModel = z.infer<typeof SignerModel>;

export const SignerRef = z.object({
  signer: SignerModel,
  signer_id: z.number().int().min(0).optional(), // global registry id when known
  canonical_hash: z.string().length(64), // sha256(XDR(signer)) hex — INV-Signer-1
});
export type SignerRef = z.infer<typeof SignerRef>;
