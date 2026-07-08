import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { submitSignedXdr } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";
import { SigningStepSchema } from "./product-flow-shared.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerInstallPolicyTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_install_policy",
    {
      title: "Install policy",
      description: "Starts owner approval for a prepared install plan, or submits a browser-signed install XDR.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        account: z.string().optional(),
        plan_hash: z.string().length(64).optional(),
        human_summary_markdown: z.string(),
        policy_diff_markdown: z.string(),
        risk_summary_markdown: z.string(),
        wallet_kit: WalletKitConfigSchema.optional(),
        steps: z.array(SigningStepSchema).optional(),
        signed_xdr: z.string().optional(),
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
      },
    },
    withToolBoundary("ozpb_install_policy", async (input) => {
      if (input.signed_xdr !== undefined) {
        return {
          mode: "submitted_signed_install_xdr",
          submit: await submitSignedXdr({
            signed_xdr: input.signed_xdr,
            network_passphrase: input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase,
            rpc_url: input.rpc_url,
          }),
        };
      }
      return context.bridge.createSigningRequest({
        kind: "sign_install_plan",
        network: input.network,
        ...(input.plan_hash !== undefined ? { plan_hash: input.plan_hash } : {}),
        ...(input.account !== undefined ? { account: input.account } : {}),
        payload: {
          human_summary_markdown: input.human_summary_markdown,
          policy_diff_markdown: input.policy_diff_markdown,
          risk_summary_markdown: input.risk_summary_markdown,
          ...(input.wallet_kit !== undefined ? { wallet_kit: input.wallet_kit } : {}),
          expected_signer: { signer_kind: "webauthn", ...(input.account !== undefined ? { account: input.account } : {}) },
          steps: input.steps ?? [],
        },
      });
    }),
  );
}
