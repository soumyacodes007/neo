import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateRuleset, generateTests } from "@ozpb/core";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerGenerateTestsTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_generate_tests",
    {
      title: "Generate tests",
      description: "Generates deterministic permit/deny test cases for a synthesized ruleset.",
      inputSchema: {
        ruleset: z.unknown(),
        allow_coverage_gaps: z.boolean().default(false),
      },
    },
    withToolBoundary("ozpb_generate_tests", (input) => generateTests(
      { ruleset: CandidateRuleset.parse(input.ruleset) },
      { allowCoverageGaps: input.allow_coverage_gaps },
    )),
  );
}
