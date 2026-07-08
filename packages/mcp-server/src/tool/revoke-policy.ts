import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalHash, type CandidateRuleset } from "@ozpb/core";
import { submitSignedXdr } from "@ozpb/stellar";
import { buildRuleRevocationStep } from "@ozpb/plans";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { JsonRpcBackend, NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerRevokePolicyTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_revoke_policy",
    {
      title: "Revoke policy",
      description: "Builds an owner-approved context-rule expiry/removal request, or submits a browser-signed revocation XDR.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        account: z.string().min(1),
        rule_id: z.number().int().min(0),
        mode: z.enum(["expire_now", "remove"]).default("expire_now"),
        current_ledger: z.number().int().optional(),
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        wallet_kit: WalletKitConfigSchema.optional(),
        signed_xdr: z.string().optional(),
      },
    },
    withToolBoundary("ozpb_revoke_policy", async (input) => {
      if (input.signed_xdr !== undefined) {
        return {
          mode: "submitted_signed_revocation_xdr",
          submit: await submitSignedXdr({
            signed_xdr: input.signed_xdr,
            network_passphrase: input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase,
            rpc_url: input.rpc_url,
          }),
        };
      }
      const currentLedger = input.current_ledger ?? (await new JsonRpcBackend(input.rpc_url).getLatestLedger()).sequence;
      const step = buildRuleRevocationStep({
        account: input.account as CandidateRuleset["account"],
        network: input.network,
        ruleId: input.rule_id,
        currentLedger,
        mode: input.mode,
      });
      return context.bridge.createSigningRequest({
        kind: "sign_revocation_plan",
        network: input.network,
        account: input.account,
        payload: {
          human_summary_markdown: `${input.mode === "expire_now" ? "Expire" : "Remove"} context rule id ${String(input.rule_id)} on ${input.account}.`,
          policy_diff_markdown: `Rule id ${String(input.rule_id)} will no longer authorize the delegated/session signer after this transaction succeeds.`,
          risk_summary_markdown: "Revocation is an owner-approved state change. Recreate the policy through the normal install flow if needed later.",
          ...(input.wallet_kit !== undefined ? { wallet_kit: input.wallet_kit } : {}),
          expected_signer: { signer_kind: "webauthn", account: input.account },
          steps: [{
            order: step.order,
            step_hash: canonicalHash({ account: input.account, rule_id: input.rule_id, mode: input.mode, currentLedger } as never),
            unsigned_xdr: step.tx_xdr_unsigned,
            description: step.description,
            network_passphrase: input.wallet_kit?.network_passphrase ?? testnetDefaults.network_passphrase,
            auth_requirements: step.auth_requirements,
          }],
        },
      });
    }),
  );
}
