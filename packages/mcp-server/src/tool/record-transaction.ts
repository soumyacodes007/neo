import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { traceTransaction } from "@ozpb/stellar";
import { withToolBoundary } from "../tool-boundary.js";
import { JsonRpcBackend, NetworkSchema, rpcClient, type McpToolContext, type NetworkName } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerRecordTransactionTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_record_transaction",
    {
      title: "Record transaction",
      description: "Looks up and traces a real Stellar transaction so it can become policy evidence.",
      inputSchema: {
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        network: NetworkSchema.default("testnet"),
        tx_hash: z.string().length(64),
      },
    },
    withToolBoundary("ozpb_record_transaction", async (input) => {
      const backend = new JsonRpcBackend(input.rpc_url);
      const lookup = await backend.getTransaction(input.tx_hash);
      const trace = await traceTransaction(
        { source: { tx_hash: input.tx_hash } },
        { rpc: rpcClient(input.rpc_url), network: input.network as NetworkName, now: () => new Date().toISOString() },
      );
      return {
        lookup: { hash: input.tx_hash, status: lookup.status, ledger: lookup.ledger ?? 0, provider: "rpc" },
        trace,
      };
    }),
  );
}
