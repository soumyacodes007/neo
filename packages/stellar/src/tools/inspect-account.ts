/**
 * A1 — `inspect-account` (Vol 04). Reads the full authorization state of an OZ
 * smart account into a deterministic {@link AccountSnapshot}: rules, signers,
 * policies (classified by WASM hash), admin/recovery paths. Fails closed on an
 * unrecognized account layout (EC-A03) — never a confident-looking partial.
 */
import {
  AccountSnapshot as AccountSnapshotSchema,
  ToolError,
  hashWithout,
  toLedgerSeq,
  type AccountSnapshot,
  type ContextRuleModel,
  type JsonValue,
  type Network,
  type PolicyRef,
  type SignerRef,
  type SnapshotWarning,
  type WasmHash,
} from "@ozpb/core";
import { assertContractId, sanitizeChainString } from "../address.js";
import {
  accountInstanceKey,
  contextRuleDataKeys,
  decodeContextRuleEntry,
  decodeContractDataVal,
  decodeInstanceScalars,
  decodePolicyEntry,
  decodeSignerEntry,
  instanceExecutableWasmHash,
  policyDataKey,
  signerDataKey,
  type DecodedContextRuleEntry,
} from "../keys.js";
import type { RpcClient } from "../rpc.js";
import type { ClassificationRegistry } from "./registry.js";

const MAX_RULES_HARD = 2000;

export interface InspectDeps {
  rpc: RpcClient;
  registry: ClassificationRegistry;
  network: Network;
  /** ISO-8601 timestamp source (only stamped into `taken_at`, excluded from the hash). */
  now: () => string;
}

export interface InspectAccountInput {
  account: string;
}

export async function inspectAccount(
  input: InspectAccountInput,
  deps: InspectDeps,
): Promise<AccountSnapshot> {
  const account = assertContractId(input.account);
  const warnings: SnapshotWarning[] = [];

  // 1. Fingerprint via the instance entry (EC-A03).
  const instanceRead = await deps.rpc.getLedgerEntries([accountInstanceKey(account)]);
  const ledger = instanceRead.latestLedger;
  const instanceEntry = instanceRead.entries[0];
  if (instanceEntry === undefined || instanceEntry.state !== "live" || instanceEntry.xdrB64 === null) {
    throw new ToolError("E_DATA_CONTRACT_NOT_FOUND", `no live contract instance for ${account}`);
  }
  const instanceVal = decodeContractDataVal(instanceEntry.xdrB64);
  const accountWasm = instanceExecutableWasmHash(instanceVal);
  if (accountWasm === null) {
    throw new ToolError("E_DOMAIN_UNSUPPORTED_ACCOUNT", "target is a Stellar-asset contract, not a smart account");
  }
  const scalars = decodeInstanceScalars(instanceVal);
  if (!scalars.present || !deps.registry.isKnownAccountWasm(accountWasm)) {
    throw new ToolError("E_DOMAIN_UNSUPPORTED_ACCOUNT", "not a recognized OpenZeppelin smart account (EC-A03)", {
      details: { storage_keys_present: scalars.present, known_wasm: deps.registry.isKnownAccountWasm(accountWasm) },
    });
  }

  // 2. Bound + enumerate rules (EC-A01/A02/A08).
  if (scalars.nextId > MAX_RULES_HARD) {
    throw new ToolError("E_DATA_ACCOUNT_TOO_LARGE", `nextId ${String(scalars.nextId)} exceeds ${String(MAX_RULES_HARD)}`);
  }
  const ruleIds = range(scalars.nextId);
  const ruleRead = await deps.rpc.getLedgerEntries(contextRuleDataKeys(account, ruleIds));
  const gaps: number[] = [];
  const decodedRules = new Map<number, DecodedContextRuleEntry>();
  for (let i = 0; i < ruleIds.length; i++) {
    const id = ruleIds[i]!;
    const entry = ruleRead.entries[i]!;
    if (entry.state === "absent") {
      gaps.push(id);
      continue;
    }
    if (entry.state === "archived") {
      warnings.push({ code: "rule_archived", message: `rule ${String(id)} storage is archived`, rule_id: id });
    }
    if (entry.xdrB64 === null) unreachable();
    decodedRules.set(id, decodeContextRuleEntry(decodeContractDataVal(entry.xdrB64)));
  }

  if (decodedRules.size !== scalars.count) {
    throw new ToolError("E_DATA_INCONSISTENT_SNAPSHOT", `found ${String(decodedRules.size)} rules but Count=${String(scalars.count)} (EC-A02)`);
  }

  // 3. Resolve referenced signers + policies.
  const signerIds = new Set<number>();
  const policyIds = new Set<number>();
  for (const rule of decodedRules.values()) {
    for (const s of rule.signer_ids) signerIds.add(s);
    for (const p of rule.policy_ids) policyIds.add(p);
  }
  const signerById = await resolveSigners(account, [...signerIds], deps);
  const policyById = await resolvePolicies(account, [...policyIds], deps);

  // 4. Classify each policy + enrich verifier kinds via instance reads.
  const classifiable = [
    ...[...policyById.values()].map((p) => p.address as string),
    ...collectVerifiers(signerById),
  ];
  const contractWasm = await readContractWasmHashes([...new Set(classifiable)], deps);
  for (const p of policyById.values()) {
    const wasm = contractWasm.get(p.address);
    p.wasm_hash = wasm ?? undefined;
    p.classification = wasm === undefined ? "unknown" : deps.registry.classifyPolicy(wasm);
  }
  for (const ref of signerById.values()) {
    if (ref.signer.type === "external") {
      const wasm = contractWasm.get(ref.signer.verifier);
      ref.signer.verifier_kind = wasm === undefined ? "unknown" : deps.registry.classifyVerifier(wasm);
    }
  }

  // 5. Assemble rule models.
  const rules: ContextRuleModel[] = [...decodedRules.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, r]) => buildRuleModel(id, r, account, ledger, signerById, policyById));

  const adminPaths = rules.filter((r) => r.privilege === "admin-equivalent").map((r) => r.id);
  const recoveryPaths = rules
    .filter((r) => r.privilege === "admin-equivalent" && r.policies.length === 0 && r.signers.length >= 1)
    .map((r) => r.id);

  const signerRegistry = dedupSigners([...signerById.values()]);
  const policyRegistry = [...policyById.values()].sort((a, b) => a.address.localeCompare(b.address));

  const draft = {
    schema_version: "1" as const,
    network: deps.network,
    account,
    ledger,
    account_wasm_hash: accountWasm,
    rules,
    next_rule_id: scalars.nextId,
    rule_count: scalars.count,
    signer_registry: signerRegistry,
    policy_registry: policyRegistry,
    admin_paths: adminPaths,
    recovery_paths: recoveryPaths,
    warnings,
    ...(gaps.length > 0 ? { gaps } : {}),
  };
  const snapshot_hash = hashWithout(draft as unknown as { [k: string]: JsonValue }, ["taken_at", "snapshot_hash"]);
  return AccountSnapshotSchema.parse({ ...draft, taken_at: deps.now(), snapshot_hash });
}

function buildRuleModel(
  id: number,
  r: DecodedContextRuleEntry,
  account: string,
  ledger: number,
  signerById: Map<number, SignerRef>,
  policyById: Map<number, PolicyRef>,
): ContextRuleModel {
  const isAdmin =
    r.context_type.kind === "default" ||
    (r.context_type.kind === "call_contract" && r.context_type.address === account);
  const expired = r.valid_until_ledger !== undefined && r.valid_until_ledger < ledger;
  return {
    id,
    name: sanitizeChainString(r.name, 20),
    context_type: r.context_type,
    ...(r.valid_until_ledger !== undefined ? { valid_until_ledger: toLedgerSeq(r.valid_until_ledger) } : {}),
    signers: r.signer_ids.map((sid) => signerById.get(sid) ?? unreachable()),
    policies: r.policy_ids.map((pid) => policyById.get(pid) ?? unreachable()),
    privilege: isAdmin ? "admin-equivalent" : "scoped",
    status: expired ? "expired" : "active",
  };
}

async function resolveSigners(account: string, ids: number[], deps: InspectDeps): Promise<Map<number, SignerRef>> {
  const out = new Map<number, SignerRef>();
  if (ids.length === 0) return out;
  const read = await deps.rpc.getLedgerEntries(ids.map((id) => signerDataKey(assertContractId(account), id)));
  read.entries.forEach((entry, i) => {
    const id = ids[i]!;
    if (entry.state === "absent" || entry.xdrB64 === null) return;
    const decoded = decodeSignerEntry(decodeContractDataVal(entry.xdrB64));
    out.set(id, { signer: decoded.signer, signer_id: id, canonical_hash: decoded.canonical_hash });
  });
  return out;
}

async function resolvePolicies(account: string, ids: number[], deps: InspectDeps): Promise<Map<number, PolicyRef>> {
  const out = new Map<number, PolicyRef>();
  if (ids.length === 0) return out;
  const read = await deps.rpc.getLedgerEntries(ids.map((id) => policyDataKey(assertContractId(account), id)));
  read.entries.forEach((entry, i) => {
    const id = ids[i]!;
    if (entry.state === "absent" || entry.xdrB64 === null) return;
    const decoded = decodePolicyEntry(decodeContractDataVal(entry.xdrB64));
    out.set(id, { address: decoded.policy, policy_id: id, classification: "unknown" });
  });
  return out;
}

async function readContractWasmHashes(
  contracts: string[],
  deps: InspectDeps,
): Promise<Map<string, WasmHash>> {
  const out = new Map<string, WasmHash>();
  if (contracts.length === 0) return out;
  const read = await deps.rpc.getLedgerEntries(contracts.map((c) => accountInstanceKey(assertContractId(c))));
  read.entries.forEach((entry, i) => {
    const c = contracts[i]!;
    if (entry.state === "absent" || entry.xdrB64 === null) return;
    const wasm = instanceExecutableWasmHash(decodeContractDataVal(entry.xdrB64));
    if (wasm !== null) out.set(c, wasm);
  });
  return out;
}

function collectVerifiers(signerById: Map<number, SignerRef>): string[] {
  const out: string[] = [];
  for (const ref of signerById.values()) if (ref.signer.type === "external") out.push(ref.signer.verifier);
  return out;
}

function dedupSigners(refs: SignerRef[]): SignerRef[] {
  const byHash = new Map<string, SignerRef>();
  for (const r of refs) if (!byHash.has(r.canonical_hash)) byHash.set(r.canonical_hash, r);
  return [...byHash.values()].sort((a, b) => a.canonical_hash.localeCompare(b.canonical_hash));
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_v, i) => i);
}
function unreachable(): never {
  throw new ToolError("E_INTERNAL", "unreachable: referenced member not resolved");
}
