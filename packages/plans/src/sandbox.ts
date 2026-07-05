/**
 * D0/D1 — sandbox runner + `compile-policy` (Vol 08 §1–2). The pinned Docker
 * image (rust + stellar-cli + wasm32v1-none) is not available in this environment,
 * so this module defines the runtime contract as an interface and ships an
 * explicit `UnavailableSandbox` that fails closed with `E_BUILD_SANDBOX_UNAVAILABLE`
 * (EC-B01) rather than silently building with a drifted toolchain.
 */
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
