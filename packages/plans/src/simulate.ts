/**
 * D3 — `run-simulation` (Vol 08 §4). Executes the generated test suite through
 * one or more engines and aggregates a {@link SimulationReport}. The actual
 * execution (unit `Env`, fork against `stellar snapshot create`, testnet replay)
 * lives behind the injected {@link SimulationEngine} — the fork/unit Rust harness
 * and network are not available in this environment, so this module owns only the
 * deterministic orchestration + verdict logic, tested with a fake engine.
 *
 * INV-Test-3: a report whose verdict is not `all_green` hard-blocks E1.
 */
import { canonicalHash, type JsonValue } from "@ozpb/core";
import type { CandidateRuleset, SimulationReport, TestCase } from "@ozpb/core";

export interface EngineCaseResult {
  case_id: string;
  outcome: "pass" | "fail" | "error" | "skipped";
  detail?: string;
}

export interface SimulationEngine {
  readonly engine: "unit" | "fork" | "testnet";
  readonly toolchainFingerprint: string;
  run(cases: TestCase[]): Promise<EngineCaseResult[]>;
}

export interface RunSimulationInput {
  ruleset: CandidateRuleset;
  cases: TestCase[];
  engines: SimulationEngine[];
}

export async function runSimulation(input: RunSimulationInput): Promise<SimulationReport> {
  const engine_runs = [];
  let allGreen = true;
  for (const engine of input.engines) {
    const results = await engine.run(input.cases);
    if (results.length !== input.cases.length || results.some((r) => r.outcome !== "pass")) {
      allGreen = false;
    }
    engine_runs.push({
      engine: engine.engine,
      toolchain_fingerprint: engine.toolchainFingerprint,
      cases: results.map((r) => ({ case_id: r.case_id, outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}) })),
    });
  }
  // D2 already enforced two-polarity coverage (INV-Test-1); every constraint is exercised.
  const constraintIds = input.ruleset.rules.flatMap((r) => r.constraints.map((c) => c.id)).sort();

  const draft = {
    schema_version: "1" as const,
    ruleset_hash: input.ruleset.ruleset_hash,
    engine_runs,
    coverage: { constraints_exercised: constraintIds, constraints_total: constraintIds.length },
    verdict: (input.engines.length > 0 && allGreen ? "all_green" : "failures") as "all_green" | "failures",
    artifacts_dir: `sim/${input.ruleset.ruleset_hash.slice(0, 12)}`,
  };
  const report_hash = canonicalHash(draft as unknown as JsonValue);
  return { ...draft, report_hash };
}
