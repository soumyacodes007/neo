import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PolicyIntent, canonicalHash, matchPolicies, synthesizeRuleset } from "@ozpb/core";
import { encodeInstallParams, extractAuthContexts } from "@ozpb/stellar";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerDraftPolicyFromRecordingTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_draft_policy_from_recording",
    {
      title: "Draft policy from recording",
      description: "Extracts evidence from recorded traces, synthesizes a ruleset, and maps it to existing policies when possible.",
      inputSchema: {
        account: z.string(),
        intent: z.unknown(),
        traces: z.array(z.unknown()).min(1),
        polarity: z.enum(["positive", "negative"]).default("positive"),
        snapshot_hash: z.string().length(64).optional(),
        current_ledger: z.number().int(),
      },
    },
    withToolBoundary("ozpb_draft_policy_from_recording", (input) => {
      const intent = PolicyIntent.parse(input.intent);
      const evidence = extractAuthContexts({ account: input.account, polarity: input.polarity, traces: input.traces as never });
      const ruleset = synthesizeRuleset(
        {
          intent,
          intentHash: canonicalHash(intent as never),
          evidence,
          ...(input.snapshot_hash !== undefined ? { snapshotHash: input.snapshot_hash } : {}),
        },
        { currentLedger: input.current_ledger },
      );
      const matched = matchPolicies(ruleset, { encodeInstallParams });
      return {
        evidence,
        ruleset: matched.ruleset,
        requires_codegen: matched.requires_codegen,
        mode: matched.requires_codegen.length === 0 ? "config_existing_policy" : "custom_policy_required",
        next_tool: matched.requires_codegen.length === 0 ? "ozpb_verify_policy" : "ozpb_generate_custom_policy_code",
      };
    }),
  );
}
