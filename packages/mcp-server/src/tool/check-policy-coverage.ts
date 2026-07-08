import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkPolicyCoverage } from "@ozpb/wallet-bridge";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";
import { CoveragePatternSchema } from "./product-flow-shared.js";

export function registerCheckPolicyCoverageTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_check_policy_coverage",
    {
      title: "Check policy coverage",
      description: "Routes an intended action to session-key execution if covered, otherwise to owner approval.",
      inputSchema: {
        action: z.object({
          contract: z.string(),
          fn: z.string(),
          amount_i128: z.string().optional(),
          recipient: z.string().optional(),
        }),
        installed: z.array(CoveragePatternSchema),
        current_ledger: z.number().int().optional(),
      },
    },
    withToolBoundary("ozpb_check_policy_coverage", (input) => checkPolicyCoverage(input)),
  );
}
