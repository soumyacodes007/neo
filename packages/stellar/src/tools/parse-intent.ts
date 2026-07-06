/**
 * B3 — `parse-intent` (Vol 05). The gate between the model's language and the
 * deterministic synthesizer. It fills NOTHING silently: missing provenance,
 * nonexistent contracts, or contradictions come back as structured errors or
 * clarifications. Days are normalized to ledgers; expiry is mandatory.
 *
 * Symbol→address resolution and on-chain decimals reads are Phase-5 enrichments;
 * this implementation validates an address-resolved draft (the common path) and
 * enforces the structural anti-hallucination invariants.
 */
import { z } from "zod";
import {
  ToolError,
  canonicalHash,
  PolicyIntent,
  type ContractId,
  type Network,
  type JsonValue,
} from "@ozpb/core";

const LEDGERS_PER_DAY = 17280;

const Duration = z.union([
  z.object({ ledgers: z.number().int().positive() }),
  z.object({ days: z.number().int().positive() }),
]);
type Duration = z.infer<typeof Duration>;

function toLedgers(d: Duration): number {
  return "ledgers" in d ? d.ledgers : d.days * LEDGERS_PER_DAY;
}

export interface ResolvedSymbol {
  address: string;
  decimals?: number;
  source?: string;
}

export interface ParseIntentDeps {
  /** True iff the contract exists on-chain (footprint probe). */
  existsContract: (contract: ContractId) => Promise<boolean>;
  /** Curated per-network symbol→address registry (FN-B3.2). Absent ⇒ no symbol resolution. */
  resolveSymbol?: (symbol: string, network: Network) => ResolvedSymbol | null;
  /** Read a token's on-chain decimals for reconciliation (FN-B3.3). */
  readDecimals?: (token: ContractId) => Promise<number | null>;
}

export interface Clarification {
  question: string;
  field?: string;
}

export type ParseIntentResult =
  | { intent: PolicyIntent; intent_hash: string }
  | { clarifications_needed: Clarification[] };

export async function parseIntent(
  input: { draft: unknown; network: Network },
  deps: ParseIntentDeps,
): Promise<ParseIntentResult> {
  const raw = input.draft;

  // 1. Provenance pre-check (INV-Intent-3 / EC-U01) — explicit, before schema coercion.
  const missing = findMissingProvenance(raw);
  if (missing.length > 0) {
    throw new ToolError("E_INPUT_PROVENANCE_MISSING", "every constraint leaf must carry provenance", {
      details: { paths: missing },
    });
  }

  // 1.5. Symbol resolution (FN-B3.2): a budget given by symbol resolves through
  // the curated registry and is ALWAYS echoed as a confirmation — never auto-
  // accepted (EC-S06/T08). This runs before the schema parse (which needs addresses).
  const symbolClarifs = collectSymbolClarifications(raw, input.network, deps.resolveSymbol);
  if (symbolClarifs.length > 0) {
    return { clarifications_needed: symbolClarifs };
  }

  // 2. Structural parse of the loose draft.
  const parsed = DraftIntent.safeParse(raw);
  if (!parsed.success) {
    throw new ToolError("E_INPUT_SCHEMA", "draft intent failed validation", {
      details: { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  const d = parsed.data;

  const clarifications: Clarification[] = [];

  // 3. Existence check (EC-U02).
  for (const t of d.targets) {
    if (!(await deps.existsContract(t.contract))) {
      throw new ToolError("E_DATA_CONTRACT_NOT_FOUND", `target contract ${t.contract} does not exist`, {
        details: { contract: t.contract }, suggestion: "check the address / network",
      });
    }
  }
  for (const b of d.budgets) {
    if (!(await deps.existsContract(b.token))) {
      throw new ToolError("E_DATA_CONTRACT_NOT_FOUND", `budget token ${b.token} does not exist`, {
        details: { token: b.token },
      });
    }
    // Decimals reconciliation (FN-B3.3): the stated decimals must match on-chain,
    // so cap_i128 is computed against the true scale (EC-S10).
    if (deps.readDecimals !== undefined) {
      const onChain = await deps.readDecimals(b.token);
      if (onChain !== null && onChain !== b.decimals) {
        clarifications.push({
          question: `Token ${b.token} has ${String(onChain)} decimals on-chain, but the intent states ${String(b.decimals)}. Confirm the correct scale.`,
          field: "budgets.decimals",
        });
      }
    }
  }

  // 4. Expiry required (INV-Intent-1).
  if (d.expiry === undefined) {
    clarifications.push({ question: "How long should this grant last before it expires?", field: "expiry" });
  }

  // 5. Contradiction check (FN-B3.4): same token, different cap/window.
  const byToken = new Map<string, { cap: string; ledgers: number }>();
  for (const b of d.budgets) {
    const prev = byToken.get(b.token);
    const cur = { cap: b.cap, ledgers: toLedgers(b.window) };
    if (prev !== undefined && (prev.cap !== cur.cap || prev.ledgers !== cur.ledgers)) {
      throw new ToolError("E_INPUT_CONTRADICTION", `conflicting budgets for token ${b.token}`, {
        details: { token: b.token, first: prev, second: cur },
        suggestion: "record a clarifications_resolved entry so the latest wins",
      });
    }
    byToken.set(b.token, cur);
  }

  if (clarifications.length > 0) {
    return { clarifications_needed: clarifications };
  }

  // 6. Normalize to the canonical PolicyIntent (all durations in ledgers).
  const intent = PolicyIntent.parse({
    schema_version: "1",
    network: input.network,
    account: d.account,
    grantee: d.grantee,
    targets: d.targets,
    budgets: d.budgets.map((b) => ({
      token: b.token,
      cap: b.cap,
      decimals: b.decimals,
      window: { ledgers: toLedgers(b.window) },
      scope: b.scope,
      ...(b.arg_source !== undefined ? { arg_source: b.arg_source } : {}),
      provenance: b.provenance,
    })),
    ...(d.quorum !== undefined ? { quorum: d.quorum } : {}),
    expiry: { ledgers: toLedgers(d.expiry!) },
    preserve: d.preserve,
    allow_default_context: false, // default-scope guard (INV-Intent-2 / EC-S01)
    explicit_denies: d.explicit_denies,
    clarifications_resolved: d.clarifications_resolved,
  });
  const intent_hash = canonicalHash(intent as unknown as JsonValue);
  return { intent, intent_hash };
}

const C_ADDR_RE = /^C[A-Z2-7]{55}$/;

/**
 * Collect confirmation clarifications for budgets given by `token_symbol` instead
 * of a resolved address. A known symbol echoes the resolved address (never auto-
 * accepted, EC-S06); an unknown symbol requires the user to supply an address.
 */
function collectSymbolClarifications(
  raw: unknown,
  network: Network,
  resolveSymbol: ParseIntentDeps["resolveSymbol"],
): Clarification[] {
  const out: Clarification[] = [];
  if (typeof raw !== "object" || raw === null) return out;
  const budgets = Array.isArray((raw as Record<string, unknown>)["budgets"])
    ? ((raw as Record<string, unknown>)["budgets"] as unknown[])
    : [];
  budgets.forEach((b, i) => {
    if (typeof b !== "object" || b === null) return;
    const rec = b as Record<string, unknown>;
    const sym = rec["token_symbol"];
    const hasAddr = typeof rec["token"] === "string" && C_ADDR_RE.test(rec["token"]);
    if (typeof sym !== "string" || hasAddr) return;
    const resolved = resolveSymbol?.(sym, network) ?? null;
    out.push(
      resolved !== null
        ? {
            question: `Confirm token '${sym}' resolves to ${resolved.address}${resolved.decimals !== undefined ? ` (decimals ${String(resolved.decimals)})` : ""}${resolved.source !== undefined ? ` [source: ${resolved.source}]` : ""}. Re-submit with 'token' set to this address.`,
            field: `budgets[${String(i)}].token`,
          }
        : {
            question: `Unknown token symbol '${sym}' on ${network}; provide its contract address.`,
            field: `budgets[${String(i)}].token`,
          },
    );
  });
  return out;
}

/** Scan raw draft for target/budget entries missing a `provenance` field. */
function findMissingProvenance(raw: unknown): string[] {
  const out: string[] = [];
  if (typeof raw !== "object" || raw === null) return out;
  const obj = raw as Record<string, unknown>;
  const targets = Array.isArray(obj["targets"]) ? obj["targets"] : [];
  targets.forEach((t, i) => {
    if (typeof t === "object" && t !== null && !("provenance" in t)) out.push(`targets[${String(i)}].provenance`);
  });
  const budgets = Array.isArray(obj["budgets"]) ? obj["budgets"] : [];
  budgets.forEach((b, i) => {
    if (typeof b === "object" && b !== null && !("provenance" in b)) out.push(`budgets[${String(i)}].provenance`);
  });
  return out;
}

// Loose draft schema — durations may be {ledgers} or {days}; expiry optional.
const ProvenanceLoose = z.object({ kind: z.string() }).passthrough();
const DraftBudget = z.object({
  token: PolicyIntent.shape.account, // ContractId brand
  cap: z.string(),
  decimals: z.number().int(),
  window: Duration,
  scope: z.enum(["outflow_via_transfer", "per_call_arg"]),
  arg_source: z.object({ contract: PolicyIntent.shape.account, fn: z.string(), path: z.string() }).optional(),
  provenance: ProvenanceLoose,
});
const DraftIntent = z.object({
  account: PolicyIntent.shape.account,
  grantee: PolicyIntent.shape.grantee,
  targets: PolicyIntent.shape.targets,
  budgets: z.array(DraftBudget),
  quorum: PolicyIntent.shape.quorum,
  expiry: Duration.optional(),
  preserve: z.array(z.number().int()),
  explicit_denies: PolicyIntent.shape.explicit_denies,
  clarifications_resolved: PolicyIntent.shape.clarifications_resolved,
});
