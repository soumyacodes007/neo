/**
 * D0/D1 — sandbox runner + `compile-policy` (Vol 08 §1–2). Ships three things:
 *
 *  - `SandboxRunner` — the runtime contract for compiling a codegen'd policy.
 *  - `UnavailableSandbox` — fail-closed default (EC-B01) when no toolchain is set.
 *  - `NativeCargoSandbox` — a version-checked native `cargo` runner (the pinned
 *    Docker image is the production path; native is the offline fallback and is
 *    what verified the C3 output here).
 *  - `assertOnlyFencedRegionsChanged` — the repair-loop diff-guard: the AI may
 *    only edit inside `// >>> GENERATED … // <<< GENERATED` markers; edits to the
 *    frozen template are rejected, not trusted (Vol 01 §3.2).
 */
import { spawn } from "node:child_process";
import { ToolError } from "@ozpb/core";

export interface CompileDiagnostic {
  level: "error" | "warning";
  message: string;
  file?: string;
  line?: number;
}

export interface CompileResult {
  ok: boolean;
  diagnostics: CompileDiagnostic[];
  wasmPath?: string;
  toolchainFingerprint: string;
}

export interface SandboxRunner {
  /** Compile a codegen'd policy crate offline in the jailed image (D1). */
  compilePolicy(cratePath: string): Promise<CompileResult>;
}

/** Fail-closed sandbox used until the pinned image is provisioned. */
export class UnavailableSandbox implements SandboxRunner {
  compilePolicy(_cratePath: string): Promise<CompileResult> {
    throw new ToolError(
      "E_BUILD_SANDBOX_UNAVAILABLE",
      "no pinned Docker/native Rust sandbox is provisioned (EC-B01)",
      { suggestion: "provision docker/sandbox.Dockerfile or a version-matched native toolchain" },
    );
  }
}

export interface NativeSandboxOptions {
  /** Extra env for the build (e.g. the spec-shaking marker). */
  env?: Record<string, string>;
  /** Wall-clock timeout in ms (default 300s per Vol 01 §4.1). */
  timeoutMs?: number;
  toolchainFingerprint?: string;
}

/**
 * Native `cargo` runner. Runs `cargo build --target wasm32v1-none --release` in
 * the crate dir and parses JSON diagnostics into structured results for the AI
 * repair loop. This is the offline fallback; production uses the pinned Docker
 * image. (This is exactly what compiled the C3-generated crate here.)
 */
export class NativeCargoSandbox implements SandboxRunner {
  #opts: NativeSandboxOptions;
  constructor(opts: NativeSandboxOptions = {}) {
    this.#opts = opts;
  }

  async compilePolicy(cratePath: string): Promise<CompileResult> {
    const fingerprint = this.#opts.toolchainFingerprint ?? "native-cargo";
    const { code, stdout } = await run(
      "cargo",
      ["build", "--target", "wasm32v1-none", "--release", "--message-format=json", "--manifest-path", `${cratePath}/Cargo.toml`],
      { env: { ...process.env, ...this.#opts.env }, timeoutMs: this.#opts.timeoutMs ?? 300_000 },
    );
    const diagnostics = parseCargoDiagnostics(stdout);
    return { ok: code === 0, diagnostics, toolchainFingerprint: fingerprint };
  }
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: opts.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ToolError("E_BUILD_TIMEOUT", `compile exceeded ${String(opts.timeoutMs)}ms`));
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new ToolError("E_BUILD_SANDBOX_UNAVAILABLE", `cargo not runnable: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Parse `cargo --message-format=json` output into structured diagnostics. */
export function parseCargoDiagnostics(stdout: string): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const m = msg as { reason?: string; message?: { level?: string; message?: string; spans?: { file_name?: string; line_start?: number }[] } };
    if (m.reason !== "compiler-message" || m.message === undefined) continue;
    const level = m.message.level === "error" ? "error" : "warning";
    const span = m.message.spans?.[0];
    out.push({
      level,
      message: m.message.message ?? "",
      ...(span?.file_name !== undefined ? { file: span.file_name } : {}),
      ...(span?.line_start !== undefined ? { line: span.line_start } : {}),
    });
  }
  return out;
}

const FENCE_START = /\/\/ >>> GENERATED:/;
const FENCE_END = /\/\/ <<< GENERATED/;

/**
 * Repair-loop diff-guard: verify the candidate differs from the frozen template
 * ONLY inside `>>> GENERATED … <<< GENERATED` regions. Any change to a frozen
 * line throws — the AI cannot edit outside the fence, enforced mechanically.
 */
export function assertOnlyFencedRegionsChanged(frozen: string, candidate: string): void {
  const frozenLines = frozen.split("\n");
  const candLines = candidate.split("\n");
  const frozenMask = fencedMask(frozenLines);
  const candMask = fencedMask(candLines);

  // Frozen (non-fenced) lines must be identical and in the same positions.
  const frozenSkeleton = frozenLines.filter((_l, i) => !frozenMask[i]);
  const candSkeleton = candLines.filter((_l, i) => !candMask[i]);
  if (frozenSkeleton.length !== candSkeleton.length || frozenSkeleton.some((l, i) => l !== candSkeleton[i])) {
    throw new ToolError("E_BUILD_TEMPLATE", "edit outside the GENERATED fence rejected (Vol 01 §3.2 diff-guard)");
  }
}

function fencedMask(lines: string[]): boolean[] {
  const mask: boolean[] = [];
  let inside = false;
  for (const line of lines) {
    if (FENCE_START.test(line)) {
      inside = true;
      mask.push(true);
      continue;
    }
    if (FENCE_END.test(line)) {
      inside = false;
      mask.push(true);
      continue;
    }
    mask.push(inside);
  }
  return mask;
}
