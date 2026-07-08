import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withToolBoundary } from "../tool-boundary.js";
import { existingToolManifest } from "../tool-manifest.js";
import type { McpToolContext } from "./types.js";

export function registerHealthTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_health",
    {
      title: "OZ Policy Builder health",
      description: "Reports MCP server health and the deterministic tool manifest.",
      inputSchema: {},
    },
    withToolBoundary("ozpb_health", () => ({
      status: "ok",
      tools: existingToolManifest,
      wallet_bridge: "available",
    })),
  );
}
