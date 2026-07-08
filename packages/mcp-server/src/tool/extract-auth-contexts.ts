import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { extractAuthContexts } from "@ozpb/stellar";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerExtractAuthContextsTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_extract_auth_contexts",
    {
      title: "Extract auth contexts",
      description: "Extracts positive or negative authorization-context evidence from decoded transaction traces.",
      inputSchema: {
        account: z.string(),
        polarity: z.enum(["positive", "negative"]).default("positive"),
        traces: z.array(z.unknown()).min(1),
      },
    },
    withToolBoundary("ozpb_extract_auth_contexts", (input) => extractAuthContexts(input as Parameters<typeof extractAuthContexts>[0])),
  );
}
