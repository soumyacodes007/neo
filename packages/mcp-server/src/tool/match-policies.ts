import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateRuleset, matchPolicies } from "@ozpb/core";
import { encodeInstallParams } from "@ozpb/stellar";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerMatchPoliciesTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_match_policies",
    {
      title: "Match policies",
      description: "Composes known OZ/pb policy primitives for a synthesized ruleset and marks remaining constraints for codegen.",
      inputSchema: {
        ruleset: z.unknown(),
      },
    },
    withToolBoundary("ozpb_match_policies", (input) => matchPolicies(CandidateRuleset.parse(input.ruleset), { encodeInstallParams })),
  );
}
