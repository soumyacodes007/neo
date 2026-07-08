import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { JsonRpcBackend, NetworkSchema, WalletKitConfigSchema, type McpToolContext } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerWalletStatusTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_wallet_status",
    {
      title: "Wallet status",
      description: "Reports the configured OZ smart-account wallet context without exposing owner or session secrets.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        account: z.string().optional(),
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        wallet_kit: WalletKitConfigSchema.default(testnetDefaults),
      },
    },
    withToolBoundary("ozpb_wallet_status", async (input) => {
      const latest = await new JsonRpcBackend(input.rpc_url).getLatestLedger();
      return {
        network: input.network,
        account: input.account ?? null,
        latest_ledger: latest.sequence,
        wallet_kit: {
          rpc_url: input.wallet_kit.rpc_url,
          account_wasm_hash: input.wallet_kit.account_wasm_hash,
          webauthn_verifier_address: input.wallet_kit.webauthn_verifier_address,
          ed25519_verifier_address: input.wallet_kit.ed25519_verifier_address,
          native_token_contract: input.wallet_kit.native_token_contract,
          threshold_policy_address: input.wallet_kit.threshold_policy_address,
          spending_limit_policy_address: input.wallet_kit.spending_limit_policy_address,
        },
        secrets_visible_to_mcp: false,
      };
    }),
  );
}
