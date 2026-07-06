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

/** The four `pb_*` policy classifications produced by the Rust library (Vol 07). */
const PB_CLASSIFICATIONS = [
  "pb:function_allowlist",
  "pb:arg_guard",
  "pb:call_cap",
  "pb:rate_limit",
] as const;

/**
 * Register the audited `pb_*` policy WASM hashes so A1 can classify them on-chain
 * (Vol 04 FN-A1.4). `hashes` maps each `pb:*` classification to the sha256 of its
 * deployed WASM (see `rust/pb-wasm-hashes.json`). Any hash not registered here
 * classifies as `unknown` — a forked/upgraded deployment is never trusted (EC-A05).
 */
export function registerPbPolicies(
  registry: InMemoryRegistry,
  hashes: Partial<Record<(typeof PB_CLASSIFICATIONS)[number], string>>,
): InMemoryRegistry {
  for (const classification of PB_CLASSIFICATIONS) {
    const hash = hashes[classification];
    if (hash !== undefined) registry.registerPolicy(hash, classification);
  }
  return registry;
}
