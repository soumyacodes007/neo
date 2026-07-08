import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PolicyIntent, canonicalHash, synthesizeRuleset } from "@ozpb/core";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerSynthesizeRulesetTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_synthesize_ruleset",
    {
      title: "Synthesize ruleset",
      description: "Synthesizes a candidate context-rule/policy ruleset from a normalized intent and optional evidence.",
      inputSchema: {
        intent: z.unknown(),
        evidence: z.unknown().optional(),
        snapshot_hash: z.string().length(64).optional(),
        current_ledger: z.number().int(),
      },
    },
    withToolBoundary("ozpb_synthesize_ruleset", (input) => {
      const intent = PolicyIntent.parse(input.intent);
      return synthesizeRuleset(
        {
          intent,
          intentHash: canonicalHash(intent as never),
          ...(input.snapshot_hash !== undefined ? { snapshotHash: input.snapshot_hash } : {}),
          ...(input.evidence !== undefined ? { evidence: input.evidence as never } : {}),
        },
        { currentLedger: input.current_ledger },
      );
    }),
  );
}
