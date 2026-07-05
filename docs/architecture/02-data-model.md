# Volume 02 — Data Model

Every cross-tool artifact, field by field. All schemas live in `packages/core/src/schemas/`; TS types are `z.infer` derivations. Tools **reference** these (`SCH-` IDs); they never redefine them. Field descriptions below are normative — the zod `.describe()` strings are generated from this volume.

Notation: zod snippets are abbreviated (`.describe()` omitted); `?` marks optional; branded primitives are from Vol 01 §2.3 (`ContractId`, `AccountId`, `TxHash`, `WasmHash`, `LedgerSeq`, `Amount`, `XdrBase64`).

---

## 0. SCH-Common — shared primitives

```ts
const Network = z.enum(["testnet", "mainnet", "local"]);
const SchemaVersion = z.literal("1");
const Provenance = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("observed_tx"), tx_hash: TxHash, context_index: z.number().int().min(0) }),
  z.object({ kind: z.literal("user_intent"), quote: z.string().max(500) }),
  z.object({ kind: z.literal("default"),  rule: z.string() }),   // e.g. "expiry-required-default"
]);
const TokenAmount = z.object({ token: ContractId, amount: Amount, decimals: z.number().int().min(0).max(38), symbol: z.string().max(32).optional() });
const LedgerWindow = z.object({ ledgers: z.number().int().positive() }); // canonical unit; days are converted at parse time
```

Invariants:
- **INV-Common-1** `Amount` string is a non-negative decimal with ≤ `decimals` fractional digits; the scaled integer fits in `i128`.
- **INV-Common-2** Every artifact object carries `schema_version` and (where produced from chain reads) `network`, `ledger: LedgerSeq`, `taken_at` (ISO-8601, from injected clock).
- **INV-Common-3** `symbol` is decorative only; equality/logic always uses `token` (`ContractId`). See EC-S06 (symbol spoofing).

---

## 1. SCH-SignerModel

Mirror of on-chain `Signer` [code storage.rs:96] plus off-chain identity helpers.

```ts
const SignerModel = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delegated"), address: z.union([AccountId, ContractId]) }),
  z.object({ type: z.literal("external"), verifier: ContractId, key_data_b64: z.string().base64(),
             verifier_kind: z.enum(["ed25519", "webauthn", "unknown"]) }),
]);
const SignerRef = z.object({ signer: SignerModel, signer_id: z.number().int().min(0).optional(),  // global registry id when known
                             canonical_hash: z.string().length(64) });                             // sha256(XDR(signer)) hex
```

Invariants:
- **INV-Signer-1** `canonical_hash` = SHA-256 of the XDR of the `Signer` value, matching on-chain dedup identity [code storage.rs:231]. Computed by `packages/stellar`, never by hand.
- **INV-Signer-2** `key_data_b64` decoded length ≤ 256 bytes (`MAX_EXTERNAL_KEY_SIZE` [code mod.rs:528]); ed25519 = exactly 32 bytes, webauthn = exactly 65 bytes [docs].
- **INV-Signer-3** `verifier_kind` is derived from the verifier contract's WASM hash against the known-verifier registry; `unknown` verifiers make any rule containing them `UNKNOWN` for bypass purposes (EC-A06).

---

## 2. SCH-ContextRuleModel

Off-chain mirror of `ContextRuleEntry` + resolved members [code storage.rs:60,152].

```ts
const ContextType = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("default") }),
  z.object({ kind: z.literal("call_contract"), address: ContractId }),
  z.object({ kind: z.literal("create_contract"), wasm_hash: WasmHash }),
]);
const PolicyRef = z.object({
  address: ContractId, policy_id: z.number().int().min(0).optional(),
  classification: z.enum(["oz:simple_threshold","oz:weighted_threshold","oz:spending_limit",
                          "pb:function_allowlist","pb:arg_guard","pb:call_cap","pb:rate_limit",
                          "generated","unknown"]),
  wasm_hash: WasmHash.optional(),
  install_state: z.unknown().optional(),      // typed per classification, see §2.1
});
const ContextRuleModel = z.object({
  id: z.number().int().min(0), name: z.string().max(20),
  context_type: ContextType,
  valid_until_ledger: LedgerSeq.optional(), expires_at_approx: z.string().datetime().optional(),
  signers: z.array(SignerRef).max(15), policies: z.array(PolicyRef).max(5),
  privilege: z.enum(["admin-equivalent", "scoped"]),
  status: z.enum(["active", "expired"]),
});
```

### 2.1 `install_state` shapes (read via simulated getter calls, Vol 04)

| classification | shape |
|---|---|
| `oz:simple_threshold` | `{ threshold: u32 }` |
| `oz:weighted_threshold` | `{ threshold: u32, weights: {signer_id: u32, weight: u32}[] }` |
| `oz:spending_limit` | `{ spending_limit: Amount-i128, period_ledgers: u32, cached_total_spent: Amount-i128, history_len: u32 }` |
| `pb:*` | per Vol 07 |
| `generated`/`unknown` | absent — reads not attempted |

Invariants:
- **INV-Rule-1** `privilege = "admin-equivalent"` iff `context_type.kind === "default"` OR (`call_contract` AND `address === <the account itself>`). Rationale: those rules can authorize `add_context_rule`/`upgrade`/`execute` on the account [inference from code; verified by fork test T-D4.*].
- **INV-Rule-2** `status = "expired"` iff `valid_until_ledger < snapshot.ledger` — strict `<`, matching on-chain check [code storage.rs:282]; `valid_until == current` is **still valid** (boundary EC-G05).
- **INV-Rule-3** `signers.length ≥ 1 OR policies.length ≥ 1` (mirror of `NoSignersAndPolicies` [code]).
- **INV-Rule-4** `classification` comes only from the WASM-hash registry; a matching *address* with unverified hash stays `unknown` (EC-A05: same address, upgraded code).

---

## 3. SCH-AccountSnapshot

```ts
const AccountSnapshot = z.object({
  schema_version: SchemaVersion, network: Network,
  account: ContractId, ledger: LedgerSeq, taken_at: z.string().datetime(),
  account_wasm_hash: WasmHash,
  rules: z.array(ContextRuleModel),                 // sorted by id asc
  next_rule_id: z.number().int(), rule_count: z.number().int(),
  signer_registry: z.array(SignerRef),              // deduped, sorted by canonical_hash
  policy_registry: z.array(PolicyRef),              // deduped, sorted by address
  admin_paths: z.array(z.number().int()),           // rule ids with privilege=admin-equivalent
  recovery_paths: z.array(z.number().int()),        // subset of admin_paths flagged by user or heuristics
  warnings: z.array(z.object({ code: z.string(), message: z.string(), rule_id: z.number().int().optional() })),
  snapshot_hash: z.string().length(64),
});
```

Invariants:
- **INV-Snap-1** `rules` includes **expired** rules (marked); bypass analysis needs them only to warn about `update_context_rule_valid_until` reactivation, which requires admin auth — noted, not treated as live (EC-A07).
- **INV-Snap-2** Enumeration completeness: rules are read for ids `0..next_rule_id`; missing entries are removed rules (gaps recorded in a `gaps` debug field). `rule_count` must equal number of found entries; mismatch → `E_DATA_INCONSISTENT_SNAPSHOT` + re-read once (EC-A02: pagination across a ledger boundary).
- **INV-Snap-3** `snapshot_hash` = canonical hash (§11) over everything except `taken_at` and `snapshot_hash` itself. Downstream artifacts pin this hash; F1 revalidates freshness by re-reading (Vol 09).
- **INV-Snap-4** `account_wasm_hash` recorded so plans can refuse if the account was upgraded between snapshot and submit (EC-L03).

---

## 4. SCH-TransactionTrace

```ts
const ScValJson = z.object({ type: z.string(), value: z.unknown(), xdr_b64: XdrBase64 }); // lossless: always carries raw XDR
const InvocationNode: z.ZodType<InvocationNodeT> = z.lazy(() => z.object({
  contract: ContractId, fn_name: z.string(), args: z.array(ScValJson),
  sub_invocations: z.array(InvocationNode),
}));
const AuthEntryTrace = z.object({
  credentials: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("source_account") }),
    z.object({ kind: z.literal("address"), address: z.union([AccountId, ContractId]),
               nonce: z.string(), signature_expiration_ledger: LedgerSeq }),
  ]),
  root_invocation: InvocationNode,
});
const TokenDelta = z.object({ token: ContractId, from: z.string(), to: z.string(),
                              amount: Amount, decimals: z.number().int(), symbol: z.string().optional(),
                              source: z.enum(["event", "meta"]) });
const TransactionTrace = z.object({
  schema_version: SchemaVersion, network: Network,
  tx_hash: TxHash, ledger: LedgerSeq, closed_at: z.string().datetime(),
  successful: z.boolean(),
  source_account: z.string(),                         // G or M strkey
  fee_bump: z.object({ fee_source: z.string() }).optional(),   // present if unwrapped from fee-bump envelope
  operations: z.array(z.object({ type: z.string(), detail: z.unknown() })),
  host_function: z.unknown().optional(),              // decoded InvokeHostFunctionOp payload
  auth_entries: z.array(AuthEntryTrace),
  events: z.array(z.object({ contract: ContractId.optional(), topics: z.array(ScValJson), data: ScValJson })),
  token_deltas: z.array(TokenDelta),
  raw: z.object({ envelope_xdr: XdrBase64, result_xdr: XdrBase64.optional(), result_meta_xdr: XdrBase64.optional() }),
});
```

Invariants:
- **INV-Trace-1** Lossless: every decoded `ScValJson` retains `xdr_b64`; consumers needing exact bytes re-decode from it (unknown ScVal types survive round-trip — EC-X02).
- **INV-Trace-2** `successful=false` traces are decodable and usable as **negative** evidence, but tools must never feed them into positive closure (EC-S03).
- **INV-Trace-3** Fee-bump envelopes are unwrapped exactly once; `fee_bump.fee_source` preserved (relayer flows — EC-X01).
- **INV-Trace-4** `token_deltas.source="event"` entries come from SEP-41 `transfer`/`mint`/`burn` events; `"meta"` entries from ledger-entry diffs when events are absent. Both listed; dedup by (token, from, to, amount) with event priority.

---

## 5. SCH-AuthContextSet (output of B1 `extract_auth_contexts`)

```ts
const ExtractedContext = z.object({
  context_type: ContextType,                 // derived: call_contract | create_contract
  contract: ContractId.optional(), fn_name: z.string().optional(),
  args: z.array(ScValJson),
  arg_summary: z.array(z.object({
    index: z.number().int(), name: z.string().optional(), sc_type: z.string(),
    observed: z.array(z.unknown()).max(64),  // distinct observed values (clamped)
    numeric_range: z.object({ min: z.string(), max: z.string() }).optional(),
  })),
  token_meta: TokenAmount.partial().optional(),
  occurrences: z.array(Provenance),          // every observation
  depth: z.enum(["root", "sub"]),            // sub-invocation contexts matter too (EC-G07)
});
const AuthContextSet = z.object({
  schema_version: SchemaVersion, account: ContractId, filter_signer: SignerModel.optional(),
  contexts: z.array(ExtractedContext),       // merged & sorted by (contract, fn_name)
  window: z.object({ from_ledger: LedgerSeq, to_ledger: LedgerSeq }),
  evidence_hash: z.string().length(64),
});
```

Invariants:
- **INV-Ctx-1** Merging: two observations merge iff same `(contract, fn_name, arity)`; differing arity is kept as separate entries (contract version drift — EC-S07).
- **INV-Ctx-2** `arg_summary.name` filled only when `interface_lookup` supplied a contractspec; absence is explicit, never guessed.
- **INV-Ctx-3** `evidence_hash` pins the exact evidence; `CandidateRuleset` records it so synthesis is auditable and re-runnable.

---

## 6. SCH-PolicyIntent

The **only** artifact the AI authors (then normalized by B3). Field-by-field:

```ts
const ArgConstraintSpec = z.object({
  index: z.number().int().min(0),
  path: z.string().regex(/^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[\*\]|\[\d+\])*$/).optional(), // JSONPath-lite into ScVal
  op: z.enum(["any", "eq", "in", "range", "addr_eq", "addr_in"]),
  values: z.array(z.unknown()).optional(), min: z.string().optional(), max: z.string().optional(),
  provenance: Provenance,
});
const IntentFunction = z.object({ name: z.string().min(1).max(60), arg_constraints: z.array(ArgConstraintSpec) });
const IntentTarget = z.object({ contract: ContractId, label: z.string().max(80).optional(),
                                functions: z.array(IntentFunction).min(1), provenance: Provenance });
const IntentBudget = z.object({ token: ContractId, cap: Amount, decimals: z.number().int(),
                                window: LedgerWindow, scope: z.enum(["outflow_via_transfer", "per_call_arg"]),
                                arg_source: z.object({ contract: ContractId, fn: z.string(), path: z.string() }).optional(),
                                provenance: Provenance });
const PolicyIntent = z.object({
  schema_version: SchemaVersion, network: Network, account: ContractId,
  grantee: z.object({ signer: SignerModel, label: z.string().max(80) }),
  targets: z.array(IntentTarget).min(1),
  budgets: z.array(IntentBudget),
  quorum: z.object({ threshold: z.number().int().min(1), of_signers: z.array(SignerModel) }).optional(),
  expiry: z.object({ ledgers: z.number().int().positive() }),      // REQUIRED — no unbounded grants
  preserve: z.array(z.number().int()),                             // rule ids that must not be touched
  allow_default_context: z.literal(false).default(false),          // may only be true via explicit override flow (Vol 06)
  explicit_denies: z.array(z.object({ description: z.string(), provenance: Provenance })),
  clarifications_resolved: z.array(z.object({ question: z.string(), answer: z.string() })),
});
```

Invariants:
- **INV-Intent-1** `expiry` is required. "No expiry" requires the override flow (double-confirmed user quote recorded in `clarifications_resolved`) which rewrites it to `ledgers: MAX_GRANT_LEDGERS` (constant, 1 year) — never truly unbounded (EC-U03).
- **INV-Intent-2** `scope="per_call_arg"` requires `arg_source`; `outflow_via_transfer` forbids it. Cross-field check in zod `.superRefine`.
- **INV-Intent-3** Every leaf carries `provenance`; B3 rejects (`E_INPUT_PROVENANCE_MISSING`) rather than defaulting — this is the anti-hallucination seam (EC-U01).
- **INV-Intent-4** `targets[].contract` must exist on-chain at parse time (footprint check via `getLedgerEntries`); nonexistent → `E_DATA_CONTRACT_NOT_FOUND` (EC-U02: model-invented address).

---

## 7. SCH-Constraint (the IR) and SCH-CandidateRuleset

```ts
const Constraint = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("func_allowlist"), contract: ContractId, functions: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("arg_predicate"), contract: ContractId, fn: z.string(),
             arg_index: z.number().int(), path: z.string().optional(),
             op: z.enum(["eq","in","range","addr_eq","addr_in"]),
             values_scval_b64: z.array(XdrBase64).optional(),        // exact ScVal encodings, not JSON approximations
             min_i128: z.string().optional(), max_i128: z.string().optional() }),
  z.object({ kind: z.literal("amount_cap"), token: ContractId, cap_i128: z.string(),
             window: LedgerWindow, source: z.discriminatedUnion("kind", [
               z.object({ kind: z.literal("transfer_arg2") }),
               z.object({ kind: z.literal("call_arg"), contract: ContractId, fn: z.string(), path: z.string(),
                          token_filter_path: z.string().optional() }),
             ]) }),
  z.object({ kind: z.literal("rate_limit"), max_calls: z.number().int().positive(), window: LedgerWindow }),
  z.object({ kind: z.literal("threshold"), m: z.number().int().min(1), weighted: z.boolean(),
             weights: z.array(z.object({ signer: SignerModel, weight: z.number().int() })).optional() }),
  z.object({ kind: z.literal("expiry"), valid_until_ledger: LedgerSeq }),
]).and(z.object({ id: z.string(), provenance: z.array(Provenance).min(1) }));

const PolicyBinding = z.object({
  constraint_ids: z.array(z.string()).min(1),
  binding: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none_needed") }),                                  // satisfied by rule structure itself
    z.object({ kind: z.literal("existing"), classification: PolicyRef.shape.classification,
               address: ContractId.optional(),                                     // known deployment if any
               install_params_scval_b64: XdrBase64 }),                             // exact Val for Map<Address,Val>
    z.object({ kind: z.literal("codegen"), codegen_ref: z.string() }),             // points into codegen_manifest
  ]),
  limitations: z.array(z.object({ code: z.string(), message: z.string() })),
});
const CandidateRule = z.object({
  name: z.string().max(20),                       // on-chain limit [code mod.rs:526]
  context_type: ContextType, valid_until_ledger: LedgerSeq,
  signers: z.array(SignerModel).min(0).max(15),
  constraints: z.array(Constraint), policy_bindings: z.array(PolicyBinding).max(5),
});
const CandidateRuleset = z.object({
  schema_version: SchemaVersion, account: ContractId, network: Network,
  based_on: z.object({ snapshot_hash: z.string().optional(), evidence_hash: z.string().optional(), intent_hash: z.string() }),
  rules: z.array(CandidateRule).min(1),
  removals: z.array(z.object({ rule_id: z.number().int(), reason: z.string() })),
  updates: z.array(z.object({ rule_id: z.number().int(), set_valid_until: LedgerSeq })),
  unsatisfied: z.array(z.object({ constraint_id: z.string(), reason: z.string() })),  // honest-failure channel
  ruleset_hash: z.string().length(64),
});
```

Invariants:
- **INV-CR-1** Every `Constraint.id` referenced by exactly one `PolicyBinding` per rule; every constraint of a rule is covered or listed in `unsatisfied` (nothing silently dropped).
- **INV-CR-2** `context_type.kind === "default"` is forbidden unless intent had the double-confirmed override (INV-Intent-1 analog; EC-S01).
- **INV-CR-3** `binding.kind="existing" ∧ classification="oz:spending_limit"` requires: constraint is `amount_cap` with `source.kind="transfer_arg2"` AND the rule's `context_type = call_contract(token)`. Encoded as a refinement — the "never stretch spending_limit" rule is *in the schema*, not just in prose (EC-S02).
- **INV-CR-4** `policy_bindings.length ≤ 5` and `signers.length ≤ 15` per on-chain limits; constraints requiring >5 policies must be merged (pb policies are multi-constraint capable, Vol 07) or the ruleset is split across rules (EC-S08).
- **INV-CR-5** `ruleset_hash` = canonical hash over rules+removals+updates+based_on. Determinism criterion: identical inputs → identical hash.
- **INV-CR-6** Every rule has an `expiry` constraint reflected in `valid_until_ledger`; both must agree.

---

## 8. SCH-TestCase & SCH-SimulationReport

```ts
const TestCase = z.object({
  id: z.string(),                                   // T-... naming from Vol 00 §2
  kind: z.enum(["allow", "deny"]),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("observed"), provenance: Provenance }),
    z.object({ kind: z.literal("user_example"), provenance: Provenance }),
    z.object({ kind: z.literal("mutation"), operator: z.enum([
      "wrong_function","wrong_contract","wrong_token","amount_plus_epsilon","cumulative_overflow",
      "expired_window","wrong_signer","arg_tamper","extra_context","reordered_contexts","zero_amount","negative_amount",
    ]), base_case: z.string() }),
  ]),
  context: z.object({ contract: ContractId, fn_name: z.string(), args_scval_b64: z.array(XdrBase64) }),
  signer_set: z.array(SignerModel),
  ledger_offset: z.number().int().default(0),       // relative ledger time for window tests
  expected: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pass") }),
    z.object({ kind: z.literal("panic"), contract_error_code: z.number().int() }),  // e.g. 3221
  ]),
});
const SimulationReport = z.object({
  schema_version: SchemaVersion, ruleset_hash: z.string(),
  engine_runs: z.array(z.object({ engine: z.enum(["unit","fork","testnet"]),
    toolchain_fingerprint: z.string(),              // sandbox image digest + crate versions
    cases: z.array(z.object({ case_id: z.string(), outcome: z.enum(["pass","fail","error","skipped"]),
                              detail: z.string().optional() })) })),
  coverage: z.object({ constraints_exercised: z.array(z.string()), constraints_total: z.number().int() }),
  verdict: z.enum(["all_green", "failures"]),
  artifacts_dir: z.string(), report_hash: z.string().length(64),
});
```

Invariants:
- **INV-Test-1** Every constraint id appears in ≥1 allow and ≥1 deny case (`coverage` check; missing → D2 fails with `E_DOMAIN_COVERAGE_GAP`, never a silent gap).
- **INV-Test-2** `expected.panic.contract_error_code` uses the numeric `Error(Contract, #code)` convention (Vol 01 §3.1).
- **INV-Test-3** A `SimulationReport` with `verdict != "all_green"` hard-blocks E1 (checked by hash chain, §11).

---

## 9. SCH-BypassReport & SCH-RiskReport

```ts
const BypassFinding = z.object({
  rule_id: z.number().int(), context: z.object({ kind: z.string(), target: z.string().optional(), fn_name: z.string().optional() }),
  verdict: z.enum(["SAFE", "BYPASS", "UNKNOWN"]),
  path: z.string().optional(),                      // human-readable chain: "rule 3 (Default, threshold 1) ← agent signer"
  reasoning: z.object({ policy_semantics: z.enum(["none","known","unknown"]), threat_keys: z.number().int() }),
  recommendation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("remove_rule"), rule_id: z.number().int() }),
    z.object({ kind: z.literal("expire_rule"), rule_id: z.number().int(), at: LedgerSeq }),
    z.object({ kind: z.literal("raise_threshold"), rule_id: z.number().int(), to: z.number().int() }),
    z.object({ kind: z.literal("manual_review"), note: z.string() }),
    z.object({ kind: z.literal("none") }),
  ]),
});
const BypassReport = z.object({ schema_version: SchemaVersion, snapshot_hash: z.string(), ruleset_hash: z.string(),
  threat_model: z.object({ grantee_signers: z.array(SignerModel), extra_compromised: z.number().int().default(0) }),
  findings: z.array(BypassFinding), exhaustive: z.boolean(),       // false iff any enumeration failed
  report_hash: z.string().length(64) });

const RiskReport = z.object({ schema_version: SchemaVersion, ruleset_hash: z.string(),
  residual_risks: z.array(z.object({ severity: z.enum(["critical","high","medium","low","info"]),
    code: z.string(), description: z.string(), evidence: z.string().optional() })),
  limitations: z.array(z.object({ code: z.string(), message: z.string() })),   // aggregated from PolicyBinding.limitations
  unknown_policies: z.array(PolicyRef),
  bypass_summary: z.object({ safe: z.number().int(), bypass: z.number().int(), unknown: z.number().int() }),
  irreversibility_notes: z.array(z.string()),
  expiry_summary: z.string(), revocation_summary: z.string(),
  report_hash: z.string().length(64) });
```

Invariants:
- **INV-Bypass-1** `verdict="SAFE"` requires `policy_semantics ∈ {"none","known"}` for every rule on the path — `UNKNOWN` semantics can never yield SAFE (fail-closed, Vol 01 §5.6).
- **INV-Bypass-2** Any `BYPASS` finding without a matching entry in `CandidateRuleset.removals/updates` (or an explicit user-accepted risk in RiskReport) blocks E1.
- **INV-Risk-1** RiskReport is derived data only — every entry traces to a limitation, bypass finding, unknown policy, or schema-defined rule (e.g. "custom codegen present ⇒ high: unaudited code"); the renderer cannot invent risks and cannot omit mapped ones.

---

## 10. SCH-InstallPlan & SCH-RevocationPlan

```ts
const AuthRequirement = z.object({ rule_id: z.number().int(), signers: z.array(SignerModel),
  digest_note: z.literal("sign sha256(signature_payload || context_rule_ids.to_xdr()) — see Vol 03 §digest") });
const PlanStep = z.object({
  order: z.number().int().min(1),
  kind: z.enum(["deploy_wasm", "invoke"]),
  description: z.string(),
  tx_xdr_unsigned: XdrBase64,
  invoke: z.object({ contract: ContractId, fn: z.string(), args_scval_b64: z.array(XdrBase64) }).optional(),
  auth_requirements: z.array(AuthRequirement),
  simulated: z.object({ fee_stroops: z.string(), footprint_hash: z.string(), at_ledger: LedgerSeq }),
  reversible: z.boolean(), revert_step_ref: z.number().int().optional(),
  irreversibility_note: z.string().optional(),
});
const InstallPlan = z.object({
  schema_version: SchemaVersion, network: Network, account: ContractId,
  plan_hash: z.string().length(64),
  approval_token_ref: z.string(),                    // pointer to token FILE in workspace — token value itself is NOT in this schema
  steps: z.array(PlanStep).min(1),
  depends_on: z.object({ snapshot_hash: z.string(), ruleset_hash: z.string(),
                         simulation_report_hash: z.string(), bypass_report_hash: z.string(), risk_report_hash: z.string() }),
  pre_state: z.object({ rules_snapshot: z.array(ContextRuleModel) }),   // for manual restore after removals
  revocation_plan: z.lazy(() => RevocationPlan),
  expires_at_ledger: LedgerSeq,                      // plan staleness bound (footprints/fees drift)
});
const RevocationPlan = z.object({ steps: z.array(PlanStep), summary: z.string() });
```

Invariants:
- **INV-Plan-1** Step ordering laws: deploys before installs; `set_threshold`-style updates **before** `remove_signer` and **after** `add_signer` (threshold drift [code simple_threshold.rs:36-46]); removals of bypass rules after the new rule is installed (no window where the agent has zero valid path if user wanted continuity, and no window where both old-permissive and nothing-new exist).
- **INV-Plan-2** `plan_hash` covers steps + depends_on + pre_state (canonical, §11). F1 recomputes and compares; any drift → `E_GATE_STALE_ARTIFACTS`.
- **INV-Plan-3** The approval token value never appears in any schema'd artifact returned to the model — only `approval_token_ref` (a filename). The token is printed inside the human-facing plan file (EC-L01).
- **INV-Plan-4** Every step with `reversible=false` carries `irreversibility_note`; F1 requires an extra confirmation phrase for plans containing any such step (Vol 09).
- **INV-Plan-5** `expires_at_ledger` defaults to plan ledger + 17280 (1 day); F1 refuses expired plans (`E_GATE_PLAN_EXPIRED`) — re-run E1 to refresh fees/footprints (EC-L02).

---

## 11. Canonicalization & hashing (normative)

1. Canonical form: JCS-style — UTF-8, object keys sorted lexicographically, no insignificant whitespace, numbers as shortest round-trip decimal (amounts are strings anyway), arrays in schema-documented sort order *before* serialization.
2. Hash = lowercase hex SHA-256 of canonical bytes.
3. Hash-field exclusion: a `*_hash` field is computed over the object with that field and any `taken_at`/timestamp fields removed. Implemented once (`core/src/canonical.ts`), property-tested (idempotence, key-order independence, exclusion correctness — T-core-canon-1..4).
4. Hash chain: `PolicyIntent →(intent_hash)→ CandidateRuleset →(ruleset_hash)→ {SimulationReport, BypassReport, RiskReport} →(report hashes)→ InstallPlan →(plan_hash)→ F1`. Every arrow is verified by the consumer; a broken link is `E_GATE_STALE_ARTIFACTS` (at F1) or `E_INPUT_HASH_MISMATCH` (elsewhere).

## 12. Schema versioning & migration

- `schema_version` is a string literal per schema, bumped independently. Bump rules: additive-optional = no bump; semantic change or required-field addition = bump.
- Parsers accept version N and N−1 (N−1 via a registered `migrate_{name}_vN-1_to_vN` pure function with its own golden tests). Older → `E_INPUT_SCHEMA_VERSION` with upgrade instructions.
- Artifacts on disk embed their version; the workspace loader migrates on read, never rewrites files in place.

## 13. Session-1 self-checklist

- [x] Every schema has zod, field semantics, and ≥1 invariant; invariants numbered INV-*.
- [x] On-chain limits mirrored with [code] refs (15/5/20/256, error 3221 shape, strict `<` expiry).
- [x] Anti-hallucination seams encoded structurally (INV-Intent-3, INV-CR-3, INV-Risk-1, INV-Plan-3).
- [x] Hash-chain + determinism rules normative (§11) and referenced by INV-CR-5, INV-Plan-2.
- [x] ECs referenced (X01, X02, X07, A02, A05–A07, G05, G07, S01–S03, S06–S08, U01–U03, L01–L03) registered in Vol 10.
