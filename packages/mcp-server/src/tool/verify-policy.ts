import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountSnapshot, BypassReport, CandidateRuleset, generateTests } from "@ozpb/core";
import { ForkHarnessEngine, detectBypass, runSimulation, type SimulationEngine } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerVerifyPolicyTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_verify_policy",
    {
      title: "Verify policy",
      description: "Runs generated permit/deny cases plus bypass detection before install.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown(),
        engine: z.enum(["fake", "fork"]).default("fake"),
        fake_outcome: z.enum(["pass", "fail", "error", "skipped"]).default("pass"),
      },
    },
    withToolBoundary("ozpb_verify_policy", async (input) => {
      const ruleset = CandidateRuleset.parse(input.ruleset);
      const accountSnapshot = AccountSnapshot.parse(input.account_snapshot);
      const cases = generateTests({ ruleset }, { allowCoverageGaps: false });
      const engine: SimulationEngine = input.engine === "fork"
        ? new ForkHarnessEngine({ rule: { id: 1, target_contract: ruleset.account }, policies: [] })
        : {
          engine: "unit",
          toolchainFingerprint: `mcp-product:${input.fake_outcome}`,
          async run(testCases) {
            return testCases.map((testCase) => ({
              case_id: testCase.id,
              outcome: input.fake_outcome,
              detail: input.fake_outcome === "pass" ? "deterministic MCP product engine" : "forced fake outcome",
            }));
          },
        };
      const simulationReport = await runSimulation({ ruleset, cases, engines: [engine] });
      const bypassReport = detectBypass({ ruleset, accountSnapshot });
      return {
        cases,
        simulation_report: simulationReport,
        bypass_report: BypassReport.parse(bypassReport),
        install_allowed: simulationReport.verdict === "all_green" && bypassReport.findings.every((f) => f.verdict !== "BYPASS"),
      };
    }),
  );
}
