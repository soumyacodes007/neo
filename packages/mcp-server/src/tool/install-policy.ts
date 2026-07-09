import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { submitSignedXdr } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS, type WalletInstallAction } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { InstallActionSchema, NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";
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
        install_action: InstallActionSchema.optional(),
        owner_credential_id: z.string().optional(),
        owner_public_key_hint: z.string().regex(/^[0-9a-f]+$/iu).optional(),
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
      const installAction: WalletInstallAction | undefined = input.install_action === undefined
        ? undefined
        : {
          ...input.install_action,
          ...(input.owner_credential_id !== undefined
            ? { owner_credential_id: input.owner_credential_id }
            : input.install_action.owner_credential_id !== undefined
              ? { owner_credential_id: input.install_action.owner_credential_id }
              : {}),
        } as WalletInstallAction;
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
          ...(installAction !== undefined ? { install_action: installAction } : {}),
          expected_signer: {
            signer_kind: "webauthn",
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.owner_credential_id !== undefined ? { credential_id: input.owner_credential_id } : {}),
            ...(input.owner_public_key_hint !== undefined ? { public_key_hint: input.owner_public_key_hint } : {}),
          },
          steps: input.steps ?? [],
        },
      });
    }),
  );
}
