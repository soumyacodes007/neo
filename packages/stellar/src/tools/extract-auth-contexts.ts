/**
 * B1 — extract-auth-contexts (Vol 05). Pure evidence extraction from decoded
 * traces: walks account auth trees, keeps sub-invocations, merges by
 * (contract, fn, arity), and summarizes observed ScVal argument bytes.
 */
import {
  AuthContextSet,
  ToolError,
  canonicalHash,
  toLedgerSeq,
  type ArgSummary,
  type AuthContextEvidence,
  type AuthContextOccurrence,
  type ContractId,
  type InterfaceSpec,
  type InvocationNodeT,
  type JsonValue,
  type Network,
  type ScValJson,
  type SignerModel,
  type TransactionTrace,
  type XdrBase64,
} from "@ozpb/core";
import { assertContractId } from "../address.js";

export interface ExtractAuthContextsInput {
  account: string;
  traces: TransactionTrace[];
  polarity: "positive" | "negative";
  filter_signer?: SignerModel;
  interface_hints?: InterfaceSpec[];
}

interface SeenContext {
  contract: ContractId;
  fn_name: string;
  arity: number;
  depths: Set<"root" | "sub">;
  args: ScValJson[][];
  occurrences: AuthContextOccurrence[];
}

export function extractAuthContexts(input: ExtractAuthContextsInput): AuthContextSet {
  const account = assertContractId(input.account);
  if (input.traces.length === 0) {
    throw new ToolError("E_DOMAIN_NO_EVIDENCE", "no traces supplied for auth-context extraction (EC-S09)");
  }
  const network = commonNetwork(input.traces);
  for (const trace of input.traces) {
    if (input.polarity === "positive" && !trace.successful) {
      throw new ToolError("E_S03_FAILED_TX_AS_POSITIVE", "failed transaction cannot be positive evidence (EC-S03)", {
        details: { tx_hash: trace.tx_hash },
      });
    }
  }

  const hints = new Map((input.interface_hints ?? []).map((h) => [h.contract, h]));
  const merged = new Map<string, SeenContext>();
  let contextIndex = 0;
  for (const trace of input.traces) {
    if (input.filter_signer !== undefined && !traceMentionsSigner(trace, input.filter_signer)) continue;
    for (const entry of trace.auth_entries) {
      if (!entryAuthorizesAccount(entry.credentials, trace.source_account, account)) continue;
      for (const walked of walk(entry.root_invocation, "root")) {
        const key = `${walked.node.contract}:${walked.node.fn_name}:${String(walked.node.args.length)}`;
        let seen = merged.get(key);
        if (seen === undefined) {
          seen = {
            contract: walked.node.contract,
            fn_name: walked.node.fn_name,
            arity: walked.node.args.length,
            depths: new Set(),
            args: [],
            occurrences: [],
          };
          merged.set(key, seen);
        }
        seen.depths.add(walked.depth);
        seen.args.push(walked.node.args);
        seen.occurrences.push({
          tx_hash: trace.tx_hash,
          ledger: trace.ledger,
          context_index: contextIndex,
          depth: walked.depth,
          successful: trace.successful,
          provenance: { kind: "observed_tx", tx_hash: trace.tx_hash, context_index: contextIndex },
        });
        contextIndex++;
      }
    }
  }

  if (merged.size === 0) {
    throw new ToolError("E_DOMAIN_NO_EVIDENCE", "no account authorization contexts found (EC-S09)", {
      details: { account },
    });
  }

  const contexts: AuthContextEvidence[] = [...merged.values()]
    .sort((a, b) => a.contract.localeCompare(b.contract) || a.fn_name.localeCompare(b.fn_name) || a.arity - b.arity)
    .map((ctx) => {
      const hint = hints.get(ctx.contract);
      const fnHint = hint?.functions.find((f) => f.name === ctx.fn_name && f.args.length === ctx.arity);
      const arg_summary = summarizeArgs(ctx.args, fnHint);
      return {
        context_type: { kind: "call_contract", address: ctx.contract },
        contract: ctx.contract,
        fn_name: ctx.fn_name,
        arity: ctx.arity,
        depth: ctx.depths.size === 1 ? [...ctx.depths][0]! : "mixed",
        arg_summary,
        occurrences: ctx.occurrences.sort((a, b) => a.ledger - b.ledger || a.context_index - b.context_index),
        ...(tokenMeta(ctx.contract, ctx.fn_name, input.traces) ?? {}),
      };
    });

  const ledgers = input.traces.map((t) => t.ledger);
  const draft = {
    schema_version: "1" as const,
    account,
    network,
    polarity: input.polarity,
    contexts,
    window: {
      from_ledger: toLedgerSeq(Math.min(...ledgers)),
      to_ledger: toLedgerSeq(Math.max(...ledgers)),
    },
  };
  const evidence_hash = canonicalHash(draft as unknown as JsonValue);
  return AuthContextSet.parse({ ...draft, evidence_hash });
}

export function summarizeArg(index: number, observed: ScValJson[], hint?: { name: string; sc_type: string }): ArgSummary {
  const byXdr = new Map<string, ScValJson>();
  for (const arg of observed) if (!byXdr.has(arg.xdr_b64)) byXdr.set(arg.xdr_b64, arg);
  const distinct = [...byXdr.keys()].sort().slice(0, 64) as XdrBase64[];
  const numeric = numericRange([...byXdr.values()]);
  return {
    index,
    ...(hint?.name !== undefined ? { name: hint.name } : {}),
    sc_type: hint?.sc_type ?? commonScType([...byXdr.values()]),
    distinct_values_scval_b64: distinct,
    observed_count: observed.length,
    ...(numeric !== undefined ? { numeric_range: numeric } : {}),
    opaque: hint === undefined && distinct.length === 0,
  };
}

function summarizeArgs(rows: ScValJson[][], fnHint: { args: { name: string; sc_type: string }[] } | undefined): ArgSummary[] {
  const arity = rows[0]?.length ?? 0;
  const out: ArgSummary[] = [];
  for (let i = 0; i < arity; i++) {
    out.push(summarizeArg(i, rows.map((r) => r[i]!).filter((a): a is ScValJson => a !== undefined), fnHint?.args[i]));
  }
  return out;
}

function* walk(node: InvocationNodeT, depth: "root" | "sub"): Generator<{ node: InvocationNodeT; depth: "root" | "sub" }> {
  yield { node, depth };
  for (const child of node.sub_invocations) yield* walk(child, "sub");
}

function entryAuthorizesAccount(
  credentials: TransactionTrace["auth_entries"][number]["credentials"],
  sourceAccount: string,
  account: ContractId,
): boolean {
  if (credentials.kind === "source_account") return sourceAccount === account;
  return credentials.address === account;
}

function traceMentionsSigner(trace: TransactionTrace, signer: SignerModel): boolean {
  if (signer.type !== "delegated") return true;
  return trace.auth_entries.some((e) => e.credentials.kind === "address" && e.credentials.address === signer.address);
}

function commonNetwork(traces: TransactionTrace[]): Network {
  const first = traces[0]?.network;
  if (first === undefined) throw new ToolError("E_DOMAIN_NO_EVIDENCE", "no traces supplied");
  if (traces.some((t) => t.network !== first)) throw new ToolError("E_INPUT_SCHEMA", "all traces must share one network");
  return first;
}

function commonScType(values: ScValJson[]): string {
  const types = new Set(values.map((v) => v.type));
  return types.size === 1 ? values[0]?.type ?? "opaque" : "mixed";
}

function numericRange(values: ScValJson[]): { min: string; max: string } | undefined {
  let min: bigint | undefined;
  let max: bigint | undefined;
  for (const v of values) {
    if (!/^scv[IU](32|64|128)$/.test(v.type)) continue;
    const raw = typeof v.value === "string" || typeof v.value === "number" ? String(v.value) : undefined;
    if (raw === undefined) continue;
    if (!/^-?\d+$/.test(raw)) continue;
    const n = BigInt(raw);
    if (n < 0n) continue;
    min = min === undefined || n < min ? n : min;
    max = max === undefined || n > max ? n : max;
  }
  return min === undefined || max === undefined ? undefined : { min: min.toString(), max: max.toString() };
}

function tokenMeta(contract: ContractId, fnName: string, traces: TransactionTrace[]): { token_meta: AuthContextEvidence["token_meta"] } | undefined {
  if (fnName !== "transfer" && fnName !== "approve") return undefined;
  const delta = traces.flatMap((t) => t.token_deltas).find((d) => d.token === contract);
  if (delta === undefined) return undefined;
  return { token_meta: { token: contract, decimals: delta.decimals, ...(delta.symbol !== undefined ? { symbol: delta.symbol } : {}) } };
}
