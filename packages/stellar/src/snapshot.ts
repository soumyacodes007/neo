/**
 * Fork-snapshot helpers (Vol 03 §7, FN-ST.23/FN-ST.24).
 *
 * `deriveSnapshotAddressSet` is pure. `createSnapshot` is host-side only: it
 * shells out to `stellar snapshot create` before the network-jailed Rust harness
 * runs, so the harness can load the JSON with `Env::from_ledger_snapshot_file`.
 */
import { spawn } from "node:child_process";
import type { ContractId } from "@ozpb/core";

export interface SnapshotEvidence {
  /** Contract addresses seen in trace invocations. */
  invocationContracts?: ContractId[];
  /** Token contracts seen in token deltas. */
  tokens?: ContractId[];
  /** Target contracts / tokens / policies from a candidate ruleset. */
  ruleTargets?: ContractId[];
  policies?: ContractId[];
  /** Verifier contracts referenced by external signers. */
  verifiers?: ContractId[];
}

/** FN-ST.23: union every address a fork must materialize, deduped and sorted. */
export function deriveSnapshotAddressSet(account: ContractId, evidence: SnapshotEvidence): ContractId[] {
  const set = new Set<ContractId>([account]);
  for (const group of [
    evidence.invocationContracts,
    evidence.tokens,
    evidence.ruleTargets,
    evidence.policies,
    evidence.verifiers,
  ]) {
    for (const addr of group ?? []) set.add(addr);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface SnapshotProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SnapshotProcessRunner = (cmd: string, args: string[], opts: { cwd: string }) => Promise<SnapshotProcessResult>;

export interface CreateSnapshotInput {
  addresses: ContractId[];
  outPath: string;
  ledger?: number;
  network?: string;
  archiveUrl?: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  stellarBin?: string;
  cwd?: string;
  runProcess?: SnapshotProcessRunner;
}

export interface CreateSnapshotResult {
  snapshot_path: string;
  addresses: ContractId[];
  ledger: number | undefined;
  command: string[];
  stderr: string;
}

/** FN-ST.24: run `stellar snapshot create` for a complete address footprint. */
export async function createSnapshot(input: CreateSnapshotInput): Promise<CreateSnapshotResult> {
  const stellarBin = input.stellarBin ?? "stellar";
  const cwd = input.cwd ?? process.cwd();
  const addresses = [...new Set(input.addresses)].sort((a, b) => a.localeCompare(b));
  const args = ["snapshot", "create", "--output", "json", "--out", input.outPath];
  if (input.network !== undefined) args.push("--network", input.network);
  if (input.ledger !== undefined) args.push("--ledger", String(input.ledger));
  if (input.archiveUrl !== undefined) args.push("--archive-url", input.archiveUrl);
  if (input.rpcUrl !== undefined) args.push("--rpc-url", input.rpcUrl);
  if (input.networkPassphrase !== undefined) args.push("--network-passphrase", input.networkPassphrase);
  for (const address of addresses) args.push("--address", address);

  const runner = input.runProcess ?? runProcess;
  const result = await runner(stellarBin, args, { cwd });
  if (result.code !== 0) {
    throw new Error(`stellar snapshot create failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  return { snapshot_path: input.outPath, addresses, ledger: input.ledger, command: [stellarBin, ...args], stderr: result.stderr };
}

function runProcess(cmd: string, args: string[], opts: { cwd: string }): Promise<SnapshotProcessResult> {
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
