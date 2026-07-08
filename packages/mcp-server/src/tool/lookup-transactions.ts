import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { JsonRpcBackend, type McpToolContext } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerLookupTransactionsTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_lookup_transactions",
    {
      title: "Lookup transactions",
      description: "Looks up real Stellar RPC transactions by hash. Contract-window lookup requires a deep-history provider and is intentionally not emulated.",
      inputSchema: {
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        hashes: z.array(z.string().length(64)).min(1),
      },
    },
    withToolBoundary("ozpb_lookup_transactions", async (input) => {
      const backend = new JsonRpcBackend(input.rpc_url);
      const records = [];
      for (const hash of input.hashes) {
        const tx = await backend.getTransaction(hash);
        records.push({
          hash,
          found: tx.status !== "NOT_FOUND",
          status: tx.status,
          ledger: tx.ledger ?? 0,
          provider: "rpc",
        });
      }
      return {
        records,
        window_covered: undefined,
        providers_used: ["rpc"],
        partial: records.some((record) => !record.found),
      };
    }),
  );
}
