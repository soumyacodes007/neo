/**
 * Structured error taxonomy (Vol 01 §2.5).
 *
 * Tools never throw bare strings across the boundary. Domain code throws a
 * {@link ToolError}; the server's `withToolBoundary` wrapper (Vol 01 §2.4)
 * converts it to the wire envelope. Unexpected exceptions map to `E_INTERNAL`.
 */

/** The stable, machine-readable error codes referenced across Vols 03–09. */
export const ERROR_CODES = [
  // E_INPUT_* — the caller (model) sent invalid/mismatched input.
  "E_INPUT_SCHEMA",
  "E_INPUT_ADDRESS_KIND",
  "E_INPUT_HASH_MISMATCH",
  "E_INPUT_PROVENANCE_MISSING",
  "E_INPUT_NETWORK_MISMATCH",
  "E_INPUT_SCHEMA_VERSION",
  "E_INPUT_CONTRADICTION",
  // E_NET_* — upstream transient; retryable.
  "E_NET_RPC_UNAVAILABLE",
  "E_NET_RATE_LIMITED",
  "E_NET_BUDGET",
  // E_DATA_* — requested data not available / inconsistent.
  "E_DATA_TX_NOT_FOUND",
  "E_DATA_CONTRACT_NOT_FOUND",
  "E_DATA_MALFORMED_XDR",
  "E_DATA_META_VERSION",
  "E_DATA_NO_SPEC",
  "E_DATA_ENTRY_ARCHIVED",
  "E_DATA_INCONSISTENT_SNAPSHOT",
  "E_DATA_ACCOUNT_TOO_LARGE",
  "E_HISTORY_WINDOW_EXCEEDED",
  // E_DOMAIN_* — valid request, domain says no (the honest-failure channel).
  "E_DOMAIN_UNSUPPORTED_ACCOUNT",
  "E_DOMAIN_NO_EVIDENCE",
  "E_RULE_NOT_FOUND",
  "E_S03_FAILED_TX_AS_POSITIVE",
  "E_UNSATISFIABLE_BY_CONTEXT",
  "E_POLICY_SEMANTICS_UNPROVABLE",
  "E_DOMAIN_COVERAGE_GAP",
  "E_DOMAIN_BYPASS_UNHANDLED",
  "E_C3_UNEXPRESSIBLE",
  // E_BUILD_* — sandbox/compilation outcomes.
  "E_BUILD_COMPILE_FAILED",
  "E_BUILD_TEMPLATE",
  "E_BUILD_TIMEOUT",
  "E_BUILD_SANDBOX_UNAVAILABLE",
  "E_BUILD_SIMULATION_FAILED",
  // E_GATE_* — approval-machinery refusals (never retryable by the model alone).
  "E_GATE_SUBMIT_DISABLED",
  "E_GATE_TOKEN_MISMATCH",
  "E_GATE_STALE_ARTIFACTS",
  "E_GATE_PLAN_EXPIRED",
  "E_GATE_AUTH_EXPIRED",
  // Catch-all.
  "E_INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
    readonly retryable: boolean;
    readonly suggestion?: string;
  };
}

export type ToolResult<T> =
  | { readonly ok: true; readonly result: T }
  | ({ readonly ok: false } & ErrorEnvelope);

const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "E_NET_RPC_UNAVAILABLE",
  "E_NET_RATE_LIMITED",
]);

export interface ToolErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly suggestion?: string;
  /** Override the default retryability derived from the code family. */
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/** The one error type domain code throws; carries a machine-readable code. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly suggestion: string | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: ToolErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ToolError";
    this.code = code;
    this.details = opts.details;
    this.suggestion = opts.suggestion;
    this.retryable = opts.retryable ?? RETRYABLE_CODES.has(code);
  }

  /** Serialize to the wire envelope (Vol 01 §2.5). */
  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        retryable: this.retryable,
        ...(this.suggestion !== undefined ? { suggestion: this.suggestion } : {}),
      },
    };
  }
}

export function isToolError(e: unknown): e is ToolError {
  return e instanceof ToolError;
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (isToolError(error)) return error.toEnvelope();
  const message = error instanceof Error ? error.message : String(error);
  return new ToolError("E_INTERNAL", message).toEnvelope();
}

export async function runTool<T>(fn: () => Promise<T> | T): Promise<ToolResult<T>> {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    return { ok: false, ...toErrorEnvelope(error) };
  }
}
