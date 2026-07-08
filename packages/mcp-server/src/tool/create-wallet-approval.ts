import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CreateSigningRequestInput } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, SignerKindSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";

export function registerCreateWalletApprovalTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_create_wallet_approval",
    {
      title: "Create wallet approval",
      description: "Creates a browser companion approval request for creating or connecting an OZ smart account.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        owner_signer_kind: SignerKindSchema.default("webauthn"),
        wallet_kit: WalletKitConfigSchema.default({}),
      },
    },
    withToolBoundary("ozpb_create_wallet_approval", async (input) => {
      const request: CreateSigningRequestInput = {
        kind: "create_wallet",
        network: input.network,
        payload: {
          human_summary_markdown: "Create or connect an OpenZeppelin Stellar smart account.",
          policy_diff_markdown: "No policy grant is installed by wallet creation.",
          risk_summary_markdown: "The owner key remains in the browser/passkey wallet. The MCP receives public account metadata only.",
          wallet_kit: input.wallet_kit,
          expected_signer: { signer_kind: input.owner_signer_kind },
          steps: [{
            order: 1,
            step_hash: "wallet_deploy",
            unsigned_xdr: "smart-account-kit:create_wallet",
            description: "Deploy the OZ smart account controlled by this browser passkey.",
            network_passphrase: input.wallet_kit.network_passphrase,
            auth_requirements: [],
          }],
        },
      };
      return context.bridge.createSigningRequest(request);
    }),
  );
}
