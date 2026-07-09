import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";
import { ProductActionSchema, buildProductActionPlan } from "./product-flow-shared.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerPrepareActionTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_prepare_action",
    {
      title: "Prepare action",
      description: "Normalizes a user intent into a contract/function/action surface that can be policy-checked and then signed.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        action: ProductActionSchema,
        wallet_kit: WalletKitConfigSchema.optional(),
      },
    },
    withToolBoundary("ozpb_prepare_action", (input) => {
      const networkPassphrase = input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase;
      const plan = buildProductActionPlan(input.action, networkPassphrase);
      return {
        network: input.network,
        action: plan.action,
        coverage_query: plan.coverage_query,
        transaction: plan.transaction,
        owner_approval_requirements: plan.transaction.status === "ready" && plan.transaction.builder === "blend-sdk.submit"
          ? {
            required_fields: ["account", "owner_credential_id", "owner_public_key_hint"],
            source: "Use the account, wallet.public_signer_ref, and wallet.public_key_hint returned by ozpb_create_wallet_approval or ozpb_connect_wallet_approval.",
          }
          : {
            required_fields: ["account"],
            source: "Use the account returned by the wallet approval/connect result.",
          },
        adapter_status: plan.transaction.status === "ready"
          ? "transaction_builder_ready"
          : "transaction_builder_not_available",
        next_tool: plan.transaction.status === "ready" ? "ozpb_request_owner_approval" : "ozpb_record_transaction",
      };
    }),
  );
}
