import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountSnapshot, CandidateRuleset } from "@ozpb/core";
import { detectBypass } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerDetectBypassTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_detect_bypass",
    {
      title: "Detect bypass",
      description: "Runs static bypass detection against a candidate ruleset and account snapshot.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown(),
      },
    },
    withToolBoundary("ozpb_detect_bypass", (input) => detectBypass({
      ruleset: CandidateRuleset.parse(input.ruleset),
      accountSnapshot: AccountSnapshot.parse(input.account_snapshot),
    })),
  );
}
