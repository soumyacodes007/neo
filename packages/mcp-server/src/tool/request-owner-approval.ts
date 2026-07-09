import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalHash } from "@ozpb/core";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";
import { ProductActionSchema, SigningStepSchema, buildProductActionPlan, normalizeProductAction } from "./product-flow-shared.js";

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
        owner_credential_id: z.string().optional(),
        owner_public_key_hint: z.string().optional(),
        action: ProductActionSchema.optional(),
        human_summary_markdown: z.string().optional(),
        risk_summary_markdown: z.string().default("This is a one-off owner approval. No reusable delegation is installed by this step."),
        wallet_kit: WalletKitConfigSchema.optional(),
        steps: z.array(SigningStepSchema).optional(),
      },
    },
    withToolBoundary("ozpb_request_owner_approval", async (input) => {
      const normalized = input.action === undefined ? undefined : normalizeProductAction(input.action);
      const actionPlan = input.action === undefined
        ? undefined
        : buildProductActionPlan(input.action, input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase);
      if (actionPlan?.transaction.status === "unsupported" && input.steps === undefined) {
        return {
          status: "unsupported_action",
          action: actionPlan.action,
          transaction: actionPlan.transaction,
          approval_created: false,
          next_tool: "ozpb_record_transaction",
        };
      }
      if (
        actionPlan?.transaction.status === "ready" &&
        actionPlan.transaction.builder === "blend-sdk.submit" &&
        (input.account === undefined || input.owner_credential_id === undefined || input.owner_public_key_hint === undefined)
      ) {
        return {
          status: "missing_owner_signer_metadata",
          approval_created: false,
          required_fields: ["account", "owner_credential_id", "owner_public_key_hint"],
          reason: "Blend browser execution uses known-signer WebAuthn signing to avoid unsupported account-rule discovery in smart-account-kit 0.2.10.",
          safe_next_step: "Call ozpb_connect_wallet_approval or use the previous create-wallet result, then retry with account, owner_credential_id, and owner_public_key_hint.",
        };
      }
      const steps = input.steps ?? (actionPlan?.transaction.status === "ready" ? [actionPlan.transaction.default_step] : [{
        order: 1,
        step_hash: canonicalHash({ kind: "one_off_action", action: input.action ?? input.human_summary_markdown ?? "owner_approval" } as never),
        unsigned_xdr: "external-wallet:prebuilt-one-off-action",
        description: normalized?.human_summary ?? input.human_summary_markdown ?? "Owner-approved one-off action",
        network_passphrase: input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase,
        auth_requirements: [{ kind: "owner_approval", reason: "prebuilt_external_action" }],
      }]);
      return context.bridge.createSigningRequest({
        kind: "sign_one_off_tx",
        network: input.network,
        ...(input.account !== undefined ? { account: input.account } : {}),
        payload: {
          human_summary_markdown: input.human_summary_markdown ?? normalized?.human_summary ?? "Approve one on-chain action.",
          policy_diff_markdown: "No policy is installed in this one-off approval.",
          risk_summary_markdown: input.risk_summary_markdown,
          ...(input.wallet_kit !== undefined ? { wallet_kit: input.wallet_kit } : {}),
          ...(actionPlan?.transaction.status === "ready" ? { demo_action: actionPlan.transaction.wallet_demo_action } : {}),
          expected_signer: {
            signer_kind: "webauthn",
            ...(input.account !== undefined ? { account: input.account } : {}),
            ...(input.owner_credential_id !== undefined ? { credential_id: input.owner_credential_id } : {}),
            ...(input.owner_public_key_hint !== undefined ? { public_key_hint: input.owner_public_key_hint } : {}),
          },
          steps,
        },
      });
    }),
  );
}
