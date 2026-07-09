import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CandidateRuleset, TestCase } from "@ozpb/core";
import { ForkHarnessEngine, runSimulation, type SimulationEngine } from "@ozpb/plans";
import { withToolBoundary } from "../tool-boundary.js";
import type { McpToolContext } from "./types.js";

export function registerRunSimulationTool(server: McpServer, _context: McpToolContext): void {
  server.registerTool(
    "ozpb_run_simulation",
    {
      title: "Run simulation",
      description: "Runs generated cases through either the deterministic fake engine or the Rust fork harness.",
      inputSchema: {
        ruleset: z.unknown(),
        cases: z.array(z.unknown()),
        engine: z.enum(["fake", "fork"]).default("fake"),
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
    withToolBoundary("ozpb_run_simulation", async (input) => {
      const cases = input.cases.map((testCase) => TestCase.parse(testCase));
      const parsedRuleset = CandidateRuleset.parse(input.ruleset);
      const forkRule = input.fork?.rule === undefined
        ? { id: 1, target_contract: parsedRuleset.account }
        : {
          id: input.fork.rule.id,
          target_contract: input.fork.rule.target_contract,
          ...(input.fork.rule.valid_until !== undefined ? { valid_until: input.fork.rule.valid_until } : {}),
        };
      const engine: SimulationEngine = input.engine === "fork"
        ? new ForkHarnessEngine({
          ...(input.fork?.account !== undefined ? { account: input.fork.account } : {}),
          rule: forkRule,
          policies: (input.fork?.policies ?? []) as never,
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
          toolchainFingerprint: `mcp-fake:${input.fake_outcome}`,
          async run(testCases) {
            return testCases.map((testCase) => ({
              case_id: testCase.id,
              outcome: input.fake_outcome,
              detail: input.fake_outcome === "pass" ? "deterministic MCP fake engine" : "forced fake outcome",
            }));
          },
        };
      return runSimulation({ ruleset: parsedRuleset, cases, engines: [engine] });
    }),
  );
}
