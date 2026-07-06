import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { TestCase } from "@ozpb/core";
import { createSnapshot, type SnapshotProcessRunner } from "@ozpb/stellar";
import type { EngineCaseResult, SimulationEngine } from "./simulate.js";

export type ForkPathSeg =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" };

export type ForkPolicy =
  | { kind: "function_allowlist"; allowed: string[] }
  | {
      kind: "arg_guard";
      rules: {
        fn_name: string;
        arg_index: number;
        path: ForkPathSeg[];
        pred:
          | { kind: "u32_eq"; value: number }
          | { kind: "u32_in"; values: number[] }
          | { kind: "range"; min: string; max: string }
          | { kind: "addr_eq"; address: string }
          | { kind: "addr_in"; addresses: string[] };
        forall: boolean;
      }[];
    }
  | {
      kind: "call_cap";
      cap: string;
      period_ledgers: number;
      fn_name: string;
      amount_path: ForkPathSeg[];
      token_filter_path?: ForkPathSeg[];
      token_filter_token?: string;
    }
  | { kind: "rate_limit"; max_calls: number; period_ledgers: number; fn_scope?: string };

export interface ForkHarnessRule {
  id: number;
  target_contract: string;
  valid_until?: number;
}

export interface ForkHarnessEngineOptions {
  harnessManifestPath?: string;
  snapshotPath?: string;
  snapshot?: {
    addresses: string[];
    ledger?: number;
    network?: string;
    archiveUrl?: string;
    rpcUrl?: string;
    networkPassphrase?: string;
    stellarBin?: string;
    runProcess?: SnapshotProcessRunner;
  };
  account?: string;
  rule: ForkHarnessRule;
  policies: ForkPolicy[];
  command?: string;
  cwd?: string;
  runProcess?: ProcessRunner;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<ProcessResult>;

interface HarnessOutput {
  toolchain_fingerprint?: string;
  cases?: { case_id: string; outcome: EngineCaseResult["outcome"]; detail?: string }[];
}

export class ForkHarnessEngine implements SimulationEngine {
  readonly engine = "fork" as const;
  readonly toolchainFingerprint = "rust-harness";
  #opts: Required<Pick<ForkHarnessEngineOptions, "harnessManifestPath" | "command" | "cwd" | "runProcess">> &
    Omit<ForkHarnessEngineOptions, "harnessManifestPath" | "command" | "cwd" | "runProcess">;

  constructor(opts: ForkHarnessEngineOptions) {
    this.#opts = {
      ...opts,
      harnessManifestPath: opts.harnessManifestPath ?? resolve("rust/harness/Cargo.toml"),
      command: opts.command ?? "cargo",
      cwd: opts.cwd ?? process.cwd(),
      runProcess: opts.runProcess ?? runProcess,
    };
  }

  async run(cases: TestCase[]): Promise<EngineCaseResult[]> {
    const dir = await mkdtemp(join(tmpdir(), "ozpb-fork-"));
    const inputPath = join(dir, "input.json");
    try {
      const snapshotPath = await this.#snapshotPath(dir);
      await writeFile(inputPath, JSON.stringify(this.#input(cases, snapshotPath), null, 2));
      const result = await this.#opts.runProcess(
        this.#opts.command,
        ["run", "--quiet", "--manifest-path", this.#opts.harnessManifestPath, "--", inputPath],
        { cwd: this.#opts.cwd },
      );
      if (result.code !== 0) {
        return cases.map((c) => ({ case_id: c.id, outcome: "error", detail: result.stderr || result.stdout || `harness exited ${result.code}` }));
      }
      return parseHarnessOutput(result.stdout, cases);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #snapshotPath(dir: string): Promise<string | undefined> {
    if (this.#opts.snapshotPath !== undefined) return this.#opts.snapshotPath;
    if (this.#opts.snapshot === undefined) return undefined;
    const created = await createSnapshot({
      addresses: this.#opts.snapshot.addresses as never,
      outPath: join(dir, "snapshot.json"),
      ...(this.#opts.snapshot.ledger !== undefined ? { ledger: this.#opts.snapshot.ledger } : {}),
      ...(this.#opts.snapshot.network !== undefined ? { network: this.#opts.snapshot.network } : {}),
      ...(this.#opts.snapshot.archiveUrl !== undefined ? { archiveUrl: this.#opts.snapshot.archiveUrl } : {}),
      ...(this.#opts.snapshot.rpcUrl !== undefined ? { rpcUrl: this.#opts.snapshot.rpcUrl } : {}),
      ...(this.#opts.snapshot.networkPassphrase !== undefined ? { networkPassphrase: this.#opts.snapshot.networkPassphrase } : {}),
      ...(this.#opts.snapshot.stellarBin !== undefined ? { stellarBin: this.#opts.snapshot.stellarBin } : {}),
      ...(this.#opts.snapshot.runProcess !== undefined ? { runProcess: this.#opts.snapshot.runProcess } : {}),
      cwd: this.#opts.cwd,
    });
    return created.snapshot_path;
  }

  #input(cases: TestCase[], snapshotPath: string | undefined): unknown {
    return {
      ...(snapshotPath !== undefined ? { snapshot_path: snapshotPath } : {}),
      ...(this.#opts.account !== undefined ? { account: this.#opts.account } : {}),
      rule: this.#opts.rule,
      policies: this.#opts.policies,
      cases: cases.map((c) => ({
        id: c.id,
        kind: c.kind,
        context: c.context,
        signer_set: c.signer_set,
        ledger_offset: c.ledger_offset,
        expected: c.expected.kind === "pass" ? { kind: "pass" } : { kind: "panic", contract_error_code: c.expected.contract_error_code },
      })),
    };
  }
}

function parseHarnessOutput(stdout: string, cases: TestCase[]): EngineCaseResult[] {
  let parsed: HarnessOutput;
  try {
    parsed = JSON.parse(stdout) as HarnessOutput;
  } catch {
    return cases.map((c) => ({ case_id: c.id, outcome: "error", detail: "invalid harness JSON output" }));
  }
  if (!Array.isArray(parsed.cases)) {
    return cases.map((c) => ({ case_id: c.id, outcome: "error", detail: "harness output missing cases[]" }));
  }
  const byId = new Map(parsed.cases.map((c) => [c.case_id, c]));
  return cases.map((c) => {
    const r = byId.get(c.id);
    if (r === undefined) return { case_id: c.id, outcome: "error", detail: "harness omitted case" };
    return { case_id: r.case_id, outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}) };
  });
}

function runProcess(cmd: string, args: string[], opts: { cwd: string }): Promise<ProcessResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}
