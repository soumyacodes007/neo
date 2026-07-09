import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountSnapshot, BypassReport, CandidateRuleset, generateTests } from "@ozpb/core";
import { ForkHarnessEngine, detectBypass, runSimulation, type SimulationEngine } from "@ozpb/plans";
import { encodeI128ScValB64, mutateScValB64 } from "@ozpb/stellar";
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
        engine: z.enum(["fork", "fake"]).default("fork"),
        allow_fake: z.boolean().default(false),
        fake_outcome: z.enum(["pass", "fail", "error", "skipped"]).default("pass"),
        fork: z.object({
          account: z.string().optional(),
          rule: z.object({
            id: z.number().int(),
            target_contract: z.string(),
            valid_until: z.number().int().optional(),
          }),
          policies: z.array(z.unknown()),
          snapshot_path: z.string().optional(),
          snapshot: z.object({
            addresses: z.array(z.string()).min(1),
            ledger: z.number().int().optional(),
            network: z.string().optional(),
            archive_url: z.string().optional(),
            rpc_url: z.string().url().optional(),
            network_passphrase: z.string().optional(),
            stellar_bin: z.string().optional(),
          }).optional(),
          harness_manifest_path: z.string().optional(),
          command: z.string().optional(),
          docker: z.object({
            image: z.string().optional(),
            cpus: z.string().optional(),
            memory: z.string().optional(),
            network: z.enum(["none", "host"]).optional(),
            cargo_registry: z.string().optional(),
            cargo_git: z.string().optional(),
          }).optional(),
        }).optional(),
      },
    },
    withToolBoundary("ozpb_verify_policy", async (input) => {
      const ruleset = CandidateRuleset.parse(input.ruleset);
      const accountSnapshot = AccountSnapshot.parse(input.account_snapshot);
      const cases = generateTests(
        { ruleset },
        {
          allowCoverageGaps: false,
          encodeI128: encodeI128ScValB64,
          mutateScVal: mutateScValB64,
        },
      );
      if (input.engine === "fake" && input.allow_fake !== true) {
        throw new Error("fake verification is disabled unless allow_fake=true; use engine=fork for install-ready verification");
      }
      if (input.engine === "fork" && input.fork === undefined) {
        throw new Error("fork verification requires fork rule/policies/snapshot configuration");
      }
      const engine: SimulationEngine = input.engine === "fork"
        ? new ForkHarnessEngine({
          ...(input.fork?.account !== undefined ? { account: input.fork.account } : {}),
          rule: {
            id: input.fork!.rule.id,
            target_contract: input.fork!.rule.target_contract,
            ...(input.fork!.rule.valid_until !== undefined ? { valid_until: input.fork!.rule.valid_until } : {}),
          },
          policies: input.fork!.policies as never,
          ...(input.fork?.snapshot_path !== undefined ? { snapshotPath: input.fork.snapshot_path } : {}),
          ...(input.fork?.snapshot !== undefined ? {
            snapshot: {
              addresses: input.fork.snapshot.addresses,
              ...(input.fork.snapshot.ledger !== undefined ? { ledger: input.fork.snapshot.ledger } : {}),
              ...(input.fork.snapshot.network !== undefined ? { network: input.fork.snapshot.network } : {}),
              ...(input.fork.snapshot.archive_url !== undefined ? { archiveUrl: input.fork.snapshot.archive_url } : {}),
              ...(input.fork.snapshot.rpc_url !== undefined ? { rpcUrl: input.fork.snapshot.rpc_url } : {}),
              ...(input.fork.snapshot.network_passphrase !== undefined ? { networkPassphrase: input.fork.snapshot.network_passphrase } : {}),
              ...(input.fork.snapshot.stellar_bin !== undefined ? { stellarBin: input.fork.snapshot.stellar_bin } : {}),
            },
          } : {}),
          ...(input.fork?.harness_manifest_path !== undefined ? { harnessManifestPath: input.fork.harness_manifest_path } : {}),
          ...(input.fork?.command !== undefined ? { command: input.fork.command } : {}),
          ...(input.fork?.docker !== undefined ? {
            docker: {
              ...(input.fork.docker.image !== undefined ? { image: input.fork.docker.image } : {}),
              ...(input.fork.docker.cpus !== undefined ? { cpus: input.fork.docker.cpus } : {}),
              ...(input.fork.docker.memory !== undefined ? { memory: input.fork.docker.memory } : {}),
              ...(input.fork.docker.network !== undefined ? { network: input.fork.docker.network } : {}),
              ...(input.fork.docker.cargo_registry !== undefined ? { cargoRegistry: input.fork.docker.cargo_registry } : {}),
              ...(input.fork.docker.cargo_git !== undefined ? { cargoGit: input.fork.docker.cargo_git } : {}),
            },
          } : {}),
        })
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
