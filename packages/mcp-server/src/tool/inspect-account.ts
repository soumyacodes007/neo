import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryRegistry, inspectAccount, registerPbPolicies } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, WalletKitConfigSchema, rpcClient, type McpToolContext } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerInspectAccountTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_inspect_account",
    {
      title: "Inspect account",
      description: "Reads an OZ smart-account snapshot for verification and bypass detection.",
      inputSchema: {
        network: NetworkSchema.default("testnet"),
        account: z.string().min(1),
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        wallet_kit: WalletKitConfigSchema.optional(),
        account_wasm_hash: z.string().optional(),
        verifier_wasm_hashes: z.record(z.enum(["ed25519", "webauthn", "unknown"])).optional(),
        policy_wasm_hashes: z.record(z.string()).optional(),
        pb_wasm_hashes: z.record(z.string()).optional(),
      },
    },
    withToolBoundary("ozpb_inspect_account", async (input) => {
      const registry = new InMemoryRegistry()
        .registerAccountWasm(input.account_wasm_hash ?? input.wallet_kit?.account_wasm_hash ?? testnetDefaults.account_wasm_hash);

      for (const [hash, kind] of Object.entries(input.verifier_wasm_hashes ?? {})) {
        registry.registerVerifier(hash, kind);
      }
      for (const [hash, classification] of Object.entries(input.policy_wasm_hashes ?? {})) {
        registry.registerPolicy(hash, classification as never);
      }
      registerPbPolicies(registry, (input.pb_wasm_hashes ?? {}) as never);

      return inspectAccount(
        { account: input.account, resolve_policy_state: false },
        {
          rpc: rpcClient(input.rpc_url),
          registry,
          network: input.network,
          now: () => new Date().toISOString(),
        },
      );
    }),
  );
}
