import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerAwaitWalletResultTool(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "ozpb_await_wallet_result",
    {
      title: "Await wallet result",
      description: "Waits for a browser companion approval request to be completed or rejected.",
      inputSchema: {
        sid: z.string().min(1),
        timeout_ms: z.number().int().min(1).max(10 * 60 * 1000).default(10 * 60 * 1000),
      },
    },
    withToolBoundary("ozpb_await_wallet_result", async (input) => {
      const request = await context.bridge.waitForResult(input.sid, input.timeout_ms);
      return {
        sid: request.sid,
        status: request.status,
        result: request.result,
      };
    }),
  );
}
