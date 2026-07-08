import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountSnapshot, BypassReport, CandidateRuleset } from "@ozpb/core";
import { explainPolicy } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerExplainPolicyTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_explain_policy",
    {
      title: "Explain policy",
      description: "Renders deterministic human-readable policy explanation and risk report.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown().optional(),
        bypass_report: z.unknown().optional(),
        now_ledger: z.number().int().optional(),
      },
    },
    withToolBoundary("ozpb_explain_policy", (input) => explainPolicy({
      ruleset: CandidateRuleset.parse(input.ruleset),
      ...(input.account_snapshot !== undefined ? { accountSnapshot: AccountSnapshot.parse(input.account_snapshot) } : {}),
      ...(input.bypass_report !== undefined ? { bypassReport: BypassReport.parse(input.bypass_report) } : {}),
      ...(input.now_ledger !== undefined ? { nowLedger: input.now_ledger } : {}),
    })),
  );
}
