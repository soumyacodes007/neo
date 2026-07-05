/**
 * Classification registry (Vol 04 FN-A1.4, Vol 02 INV-Rule-4 / INV-Signer-3).
 *
 * Policies and verifiers are classified ONLY by their live WASM hash — never by
 * address or name (EC-A05). An unknown hash is `unknown` (fail-closed), which
 * makes any rule containing it `UNKNOWN` for later bypass analysis.
 */
import type { PolicyClassification } from "@ozpb/core";

export type VerifierKind = "ed25519" | "webauthn" | "unknown";

export interface ClassificationRegistry {
  classifyPolicy(wasmHashHex: string): PolicyClassification;
  classifyVerifier(wasmHashHex: string): VerifierKind;
  /** True iff this WASM hash is a recognized OZ smart-account build. */
  isKnownAccountWasm(wasmHashHex: string): boolean;
}

export class InMemoryRegistry implements ClassificationRegistry {
  #policies = new Map<string, PolicyClassification>();
  #verifiers = new Map<string, VerifierKind>();
  #accountWasms = new Set<string>();

  registerPolicy(wasmHashHex: string, classification: PolicyClassification): this {
    this.#policies.set(wasmHashHex, classification);
    return this;
  }
  registerVerifier(wasmHashHex: string, kind: VerifierKind): this {
    this.#verifiers.set(wasmHashHex, kind);
    return this;
  }
  registerAccountWasm(wasmHashHex: string): this {
    this.#accountWasms.add(wasmHashHex);
    return this;
  }

  classifyPolicy(wasmHashHex: string): PolicyClassification {
    return this.#policies.get(wasmHashHex) ?? "unknown";
  }
  classifyVerifier(wasmHashHex: string): VerifierKind {
    return this.#verifiers.get(wasmHashHex) ?? "unknown";
  }
  isKnownAccountWasm(wasmHashHex: string): boolean {
    return this.#accountWasms.has(wasmHashHex);
  }
}
