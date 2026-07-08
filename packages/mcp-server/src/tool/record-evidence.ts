import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordTransactionEvidence } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import { NetworkSchema, rpcClient, type McpToolContext } from "./types.js";

const SourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tx_hash"), tx_hash: z.string().length(64) }),
  z.object({ kind: z.literal("simulated_xdr"), envelope_xdr: z.string().min(1), result_meta_xdr: z.string().optional() }),
  z.object({ kind: z.literal("simulated_trace"), trace: z.unknown() }),
]);

export function registerRecordEvidenceTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_record_evidence",
    {
      title: "Record evidence",
      description: "Records real tx-hash or local simulated transaction evidence into the same deterministic evidence artifact.",
      inputSchema: {
        account: z.string().min(1),
        network: NetworkSchema.default("testnet"),
        polarity: z.enum(["positive", "negative"]).default("positive"),
        rpc_url: z.string().url().optional(),
        source: SourceSchema,
      },
    },
    withToolBoundary("ozpb_record_evidence", async (input) => recordTransactionEvidence(
      {
        account: input.account,
        polarity: input.polarity,
        source: input.source as never,
      },
      {
        network: input.network,
        now: () => new Date().toISOString(),
        ...(input.rpc_url !== undefined ? { rpc: rpcClient(input.rpc_url) } : {}),
      },
    )),
  );
}
