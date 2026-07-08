import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";

export function registerConnectWalletApprovalTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_connect_wallet_approval",
    {
      title: "Connect wallet approval",
      description: "Creates a browser companion approval request for connecting an existing OZ smart account.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        wallet_kit: WalletKitConfigSchema.default({}),
      },
    },
    withToolBoundary("ozpb_connect_wallet_approval", async (input) => context.bridge.createSigningRequest({
      kind: "connect_wallet",
      network: input.network,
      payload: {
        human_summary_markdown: "Connect an existing OpenZeppelin Stellar smart account.",
        policy_diff_markdown: "No policy grant is installed by wallet connection.",
        risk_summary_markdown: "The owner key remains in the browser/passkey wallet. The MCP receives public account metadata only.",
        wallet_kit: input.wallet_kit,
        expected_signer: { signer_kind: "webauthn" },
        steps: [],
      },
    })),
  );
}
