import type { SigningPayload, SigningResult } from "./types.js";

export function samplePayload(): SigningPayload {
  return {
    human_summary_markdown: "Allow transfer up to 400 XLM to James.",
    risk_summary_markdown: "Session key is scoped and expires.",
    policy_diff_markdown: "Adds one rule.",
    expected_signer: { signer_kind: "webauthn", account: "C_ACCOUNT" },
    steps: [
      {
        order: 1,
        step_hash: "step-1",
        unsigned_xdr: "AAAA",
        description: "install context rule",
        network_passphrase: "Test SDF Network ; September 2015",
        auth_requirements: [],
      },
    ],
  };
}

export function sampleResult(sid: string, planHash?: string): SigningResult {
  return {
    sid,
    ...(planHash !== undefined ? { plan_hash: planHash } : {}),
    wallet: { sdk: "mock", sdk_version: "0.0.0", signer_kind: "webauthn" },
    signed_steps: [{ order: 1, step_hash: "step-1", signed_xdr: "mock-signed:AAAA" }],
  };
}
