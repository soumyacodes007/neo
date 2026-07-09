import { describe, expect, it } from "vitest";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { registerRequestOwnerApprovalTool } from "./request-owner-approval.js";

const account = "CBKK43WTYYG3CZT4PKCDQDYRVI4RLOJ7MM2BBGPN7W4YTEJEFQBO4TXM";
const pool = "CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF";
const credentialId = "2qMSQEyUL3-nVCVp_KBmZg";
const publicKeyHint = "04a81b100972bb28acd11e8fdb187d5a0e1b90060b4f2c4e53ea40c64814ca5ac598e876a53d314b38a14bb8f6e5db8e4bd7570b2e7a531876889c85b431aada8c";

describe("ozpb_request_owner_approval", () => {
  it("refuses browser Blend execution without pinned owner signer metadata", async () => {
    const { handler, bridge } = registerForTest();

    const response = await handler({
      network: "testnet",
      account,
      action: {
        kind: "blend_claim",
        account,
        pool_contract: pool,
        max_claim_i128: "100000",
      },
      wallet_kit: SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
    });

    const body = parseToolResult(response);
    expect(body.ok).toBe(true);
    expect(body.result.status).toBe("missing_owner_signer_metadata");
    expect(body.result.approval_created).toBe(false);
    expect(bridge.requests).toHaveLength(0);
  });

  it("pins account, credential id, and public key hint into the browser approval payload", async () => {
    const { handler, bridge } = registerForTest();

    const response = await handler({
      network: "testnet",
      account,
      owner_credential_id: credentialId,
      owner_public_key_hint: publicKeyHint,
      action: {
        kind: "blend_claim",
        account,
        pool_contract: pool,
        max_claim_i128: "100000",
      },
      wallet_kit: SMART_ACCOUNT_KIT_TESTNET_DEFAULTS,
    });

    const body = parseToolResult(response);
    expect(body.ok).toBe(true);
    expect(body.result.approval_url).toContain("/approve/");
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]).toMatchObject({
      kind: "sign_one_off_tx",
      network: "testnet",
      account,
      payload: {
        demo_action: {
          kind: "blend_submit",
          pool_contract: pool,
          request_type: "SupplyCollateral",
          amount_i128: "100000",
        },
        expected_signer: {
          account,
          credential_id: credentialId,
          public_key_hint: publicKeyHint,
          signer_kind: "webauthn",
        },
      },
    });
  });
});

function registerForTest(): {
  handler: (input: unknown) => Promise<unknown>;
  bridge: { requests: unknown[] };
} {
  let capturedHandler: ((input: unknown) => Promise<unknown>) | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, handler: (input: unknown) => Promise<unknown>) {
      capturedHandler = handler;
    },
  };
  const bridge = {
    requests: [] as unknown[],
    async createSigningRequest(input: unknown) {
      this.requests.push(input);
      return {
        sid: "sid",
        approval_url: "http://localhost:8787/approve/sid#token",
        expires_at_ms: Date.now() + 60_000,
      };
    },
  };

  registerRequestOwnerApprovalTool(server as never, { bridge: bridge as never });
  if (capturedHandler === undefined) throw new Error("tool handler was not registered");
  return { handler: capturedHandler, bridge };
}

interface ToolJsonBody {
  ok: boolean;
  result: {
    status?: string;
    approval_created?: boolean;
    approval_url?: string;
    [key: string]: unknown;
  };
}

function parseToolResult(value: unknown): ToolJsonBody {
  const content = (value as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}") as ToolJsonBody;
}
