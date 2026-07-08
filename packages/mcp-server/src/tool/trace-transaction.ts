import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { traceTransaction } from "@ozpb/stellar";
import { SMART_ACCOUNT_KIT_TESTNET_DEFAULTS } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, rpcClient, type McpToolContext, type NetworkName } from "./types.js";

const testnetDefaults = SMART_ACCOUNT_KIT_TESTNET_DEFAULTS;

export function registerTraceTransactionTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_trace_transaction",
    {
      title: "Trace transaction",
      description: "Traces a real on-chain transaction by hash through the deterministic recorder.",
      inputSchema: {
        rpc_url: z.string().url().default(testnetDefaults.rpc_url),
        network: NetworkSchema.default("testnet"),
        tx_hash: z.string().length(64),
      },
    },
    withToolBoundary("ozpb_trace_transaction", async (input) => traceTransaction(
      { source: { tx_hash: input.tx_hash } },
      { rpc: rpcClient(input.rpc_url), network: input.network as NetworkName, now: () => new Date().toISOString() },
    )),
  );
}
