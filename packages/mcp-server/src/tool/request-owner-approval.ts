import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalHash } from "@ozpb/core";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";
import { ProductActionSchema, SigningStepSchema, normalizeProductAction } from "./product-flow-shared.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerRequestOwnerApprovalTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_request_owner_approval",
    {
      title: "Request owner approval",
      description: "Starts the browser wallet bridge for a one-off owner-approved action when no installed policy covers it.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        account: z.string().optional(),
        action: ProductActionSchema.optional(),
        human_summary_markdown: z.string().optional(),
        risk_summary_markdown: z.string().default("This is a one-off owner approval. No reusable delegation is installed by this step."),
        wallet_kit: WalletKitConfigSchema.optional(),
        steps: z.array(SigningStepSchema).optional(),
      },
    },
    withToolBoundary("ozpb_request_owner_approval", async (input) => {
      const normalized = input.action === undefined ? undefined : normalizeProductAction(input.action);
      const steps = input.steps ?? [{
        order: 1,
        step_hash: canonicalHash({ kind: "one_off_action", action: input.action ?? input.human_summary_markdown ?? "owner_approval" } as never),
        unsigned_xdr: "wallet-bridge:one-off-action",
        description: normalized?.human_summary ?? input.human_summary_markdown ?? "Owner-approved one-off action",
        network_passphrase: input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase,
        auth_requirements: [],
      }];
      return context.bridge.createSigningRequest({
        kind: "sign_one_off_tx",
        network: input.network,
        ...(input.account !== undefined ? { account: input.account } : {}),
        payload: {
          human_summary_markdown: input.human_summary_markdown ?? normalized?.human_summary ?? "Approve one on-chain action.",
          policy_diff_markdown: "No policy is installed in this one-off approval.",
          risk_summary_markdown: input.risk_summary_markdown,
          ...(input.wallet_kit !== undefined ? { wallet_kit: input.wallet_kit } : {}),
          ...(input.action?.kind === "native_transfer" ? {
            demo_action: {
              kind: "xlm_transfer",
              token_contract: input.action.token_contract,
              recipient: input.action.recipient,
              amount_xlm: Number(input.action.amount_xlm),
            },
          } : {}),
          expected_signer: {
            signer_kind: "webauthn",
            ...(input.account !== undefined ? { account: input.account } : {}),
          },
          steps,
        },
      });
    }),
  );
}
