import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountSnapshot, BypassReport, CandidateRuleset, RiskReport, SimulationReport } from "@ozpb/core";
import { prepareInstallPlan } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerPrepareInstallPlanTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_prepare_install_plan",
    {
      title: "Prepare install plan",
      description: "Prepares unsigned install-plan XDR after verification artifacts are green and hash-matched.",
      inputSchema: {
        ruleset: z.unknown(),
        account_snapshot: z.unknown(),
        simulation_report: z.unknown(),
        bypass_report: z.unknown(),
        risk_report: z.unknown(),
        current_ledger: z.number().int(),
        policy_addresses: z.record(z.string()).optional(),
      },
    },
    withToolBoundary("ozpb_prepare_install_plan", async (input) => prepareInstallPlan(
      {
        ruleset: CandidateRuleset.parse(input.ruleset),
        accountSnapshot: AccountSnapshot.parse(input.account_snapshot),
        simulationReport: SimulationReport.parse(input.simulation_report),
        bypassReport: BypassReport.parse(input.bypass_report),
        riskReport: RiskReport.parse(input.risk_report),
        ...(input.policy_addresses !== undefined ? { policyAddresses: input.policy_addresses as never } : {}),
      },
      {
        currentLedger: input.current_ledger,
        entropy: () => "MCP_APPROVAL_TOKEN_WRITE_TO_PLAN_FILE",
        simulateStep: async () => ({
          fee_stroops: "0",
          footprint_hash: "mcp-not-live-simulated",
          at_ledger: input.current_ledger,
        }),
      },
    )),
  );
}
