import type { SigningPayload, SigningResult } from "./types.js";

export interface VerifySignedResultOk {
  ok: true;
}

export interface VerifySignedResultErr {
  ok: false;
  error: string;
}

export type VerifySignedResult = VerifySignedResultOk | VerifySignedResultErr;

export function verifySigningResult(payload: SigningPayload, result: SigningResult, planHash?: string): VerifySignedResult {
  if (planHash !== undefined && result.plan_hash !== planHash) {
    return { ok: false, error: "E_WALLET_BRIDGE_PLAN_HASH_MISMATCH" };
  }

  if (result.signed_steps.length !== payload.steps.length) {
    return { ok: false, error: "E_WALLET_BRIDGE_STEP_COVERAGE" };
  }

  const expected = new Map(payload.steps.map((step) => [step.order, step]));
  const seen = new Set<number>();
  for (const signed of result.signed_steps) {
    if (seen.has(signed.order)) return { ok: false, error: "E_WALLET_BRIDGE_DUPLICATE_STEP" };
    seen.add(signed.order);

    const step = expected.get(signed.order);
    if (!step) return { ok: false, error: "E_WALLET_BRIDGE_UNEXPECTED_STEP" };
    if (signed.step_hash !== step.step_hash) {
      return { ok: false, error: "E_WALLET_BRIDGE_STEP_HASH_MISMATCH" };
    }

    const hasSignedXdr = signed.signed_xdr !== undefined && signed.signed_xdr.length > 0;
    const hasTxHash = signed.tx_hash !== undefined && /^[0-9a-f]{64}$/iu.test(signed.tx_hash);
    // Passkey kit flows may submit in-browser and return a tx hash. Direct F1
    // flows return signed XDR for the MCP submit gate. Either way the result is
    // pinned to the E1 step hash and later verified by tracing the transaction.
    if (!hasSignedXdr && !hasTxHash) {
      return { ok: false, error: "E_WALLET_BRIDGE_EMPTY_SIGNED_XDR" };
    }
  }

  return { ok: true };
}

export function parseSigningResult(value: unknown): SigningResult | undefined {
  if (!isRecord(value)) return undefined;
  const sid = value["sid"];
  const planHash = value["plan_hash"];
  const account = value["account"];
  const wallet = value["wallet"];
  const signedStepsValue = value["signed_steps"];
  if (typeof sid !== "string") return undefined;
  if (planHash !== undefined && typeof planHash !== "string") return undefined;
  if (account !== undefined && typeof account !== "string") return undefined;
  if (!isRecord(wallet)) return undefined;
  const sdk = wallet["sdk"];
  const sdkVersion = wallet["sdk_version"];
  const signerKind = wallet["signer_kind"];
  const publicSignerRef = wallet["public_signer_ref"];
  if (sdk !== "smart-account-kit" && sdk !== "mock") return undefined;
  if (typeof sdkVersion !== "string") return undefined;
  if (
    signerKind !== "webauthn" &&
    signerKind !== "ed25519" &&
    signerKind !== "delegated"
  ) {
    return undefined;
  }
  if (!Array.isArray(signedStepsValue)) return undefined;
  const signedSteps = [];
  for (const step of signedStepsValue) {
    if (!isRecord(step)) return undefined;
    const order = step["order"];
    const stepHash = step["step_hash"];
    const signedXdr = step["signed_xdr"];
    const txHash = step["tx_hash"];
    const ledger = step["ledger"];
    if (typeof order !== "number" || !Number.isInteger(order)) return undefined;
    if (typeof stepHash !== "string") return undefined;
    if (signedXdr !== undefined && typeof signedXdr !== "string") return undefined;
    if (txHash !== undefined && typeof txHash !== "string") return undefined;
    if (ledger !== undefined && (typeof ledger !== "number" || !Number.isInteger(ledger))) return undefined;
    signedSteps.push({
      order,
      step_hash: stepHash,
      ...(typeof signedXdr === "string" ? { signed_xdr: signedXdr } : {}),
      ...(typeof txHash === "string" ? { tx_hash: txHash } : {}),
      ...(typeof ledger === "number" ? { ledger } : {}),
    });
  }
  return {
    sid,
    wallet: {
      sdk,
      sdk_version: sdkVersion,
      signer_kind: signerKind,
      ...(typeof publicSignerRef === "string" ? { public_signer_ref: publicSignerRef } : {}),
    },
    signed_steps: signedSteps,
    ...(typeof planHash === "string" ? { plan_hash: planHash } : {}),
    ...(typeof account === "string" ? { account } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
