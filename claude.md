# OZ Policy Builder MCP — Architecture Plan

Status: research complete, decision-complete build plan. No code written yet.
Evidence base: `stellar-contracts` @ `d2c884d` (2026-07-03), OZ docs (5 accounts pages), the-rfp.md, Tyler's Pollywallet demo transcript, kalepail/pollywallet + kalepail/smart-account-kit repos, Stellar RPC/CLI/Hubble docs, OZ Relayer docs.

Legend for claims: **[code]** verified in the cloned repo, **[docs]** from OZ docs, **[web]** from external docs/repos, **[inference]** my conclusion, to be re-verified during implementation.

---

## 1. Executive summary

**What it is.** A deterministic policy-engineering toolkit for OpenZeppelin Stellar smart accounts, exposed as an MCP server plus a thin Claude skill. The AI assistant is the *planner*: it converses, interprets intent, and chooses which tools to call. The MCP owns everything that must not be hallucinated: transaction fetching and XDR decoding, auth-context extraction, account/rule inspection, policy synthesis from evidence, existing-policy matching, Rust codegen from audited templates, compile/test loops in a sandbox, allow/deny simulation, bypass analysis, install-plan construction, and risk explanation. The output of every flow is a **reviewable plan** (code + unsigned transactions + plain-English risk report), never a silent installation.

**Why it matters.** OZ's smart-account framework decomposes authorization into context rules, signers, and policies. That is expressive enough for agent delegation, session keys, subscriptions, and treasury rails — but authoring a correct policy today means writing a Soroban contract implementing the `Policy` trait, segregating storage by `(smart_account, context_rule_id)`, and getting it audited. This MCP collapses that to: show a transaction (or state an intent, or give examples), review the generated setup, approve, install. It directly answers the Q2-2026 SCF RFP ("record-and-generate"), and extends Pollywallet from a one-week MVP into a production tool.

**What it can safely do.**
- Read anything: accounts, rules, signers, policies, transactions, events (read-only tools).
- Deterministically extract auth contexts from real/simulated transactions (no AI in the loop).
- Synthesize a rule + policy plan, preferring OZ's audited primitives and a small library of *parameterized* policies we ship and audit once; generate custom Rust only as a last resort, from constrained templates.
- Compile, unit-test, replay-test, and snapshot-fork-simulate everything before any network touch.
- Prove or refute bypass via existing rules for the known policy set; flag unknown policies honestly.
- Produce an install plan (unsigned XDR + human summary + diff + revocation plan). Submission is a separate, explicitly approval-gated step that is off by default.

What it will **not** do: hold user keys, auto-install, silently widen scope, or pretend `spending_limit` covers non-`transfer` calls.

---

## 2. Domain findings

### 2.1 Verified account model (code, `packages/accounts/src`)

All of the brief's "known findings" were confirmed against `smart_account/storage.rs`, `smart_account/mod.rs`, `policies/*`, `verifiers/*`, and `examples/multisig-smart-account`, with one correction (see 2.3).

- **AuthPayload** = `{ signers: Map<Signer, Bytes>, context_rule_ids: Vec<u32> }` **[code]** (`storage.rs:133`).
- `context_rule_ids` is mandatory, index-aligned 1:1 with `auth_contexts`; length mismatch → error 3014 **[code]** (`do_check_auth`, `storage.rs:468`).
- **Digest binding**: `auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())`; signers sign the digest, not the raw payload — prevents rule-selection downgrade **[code]** (`storage.rs:492-495`). Any client we build (or reuse) must compute this exactly; signing the raw payload fails.
- **No rule auto-discovery** during auth; the caller selects rule IDs explicitly **[code]**.
- `ContextRuleType` = `Default | CallContract(Address) | CreateContract(BytesN<32>)` **[code]** (`storage.rs:143`). **A `Default` rule matches ANY context** (`storage.rs:303`).
- `Signer` = `Delegated(Address) | External(verifier_address, key_data)` **[code]**. Delegated authenticates via `require_auth_for_args((auth_digest,))`; External via verifier contract `verify(digest, key, sig)` **[code]** (`authenticate`, `storage.rs:341`).
- Rule with **no policies** → *all* rule signers must be among authenticated signers (N-of-N) **[code]** (`storage.rs:316-321`). Rule **with policies** → signer validation is fully delegated to policies; matched signers are passed to `enforce` **[code]**.
- All policies on the matched rule must pass (all-or-nothing) **[code]** (`do_check_auth` policy loop).
- Signers in the payload that belong to **no** selected rule are rejected (error 3016) — blocks attacker-controlled verifier calls **[code]**.
- Limits: `MAX_SIGNERS=15`, `MAX_POLICIES=5`, `MAX_NAME_SIZE=20` bytes, `MAX_EXTERNAL_KEY_SIZE=256` bytes **[code]** (`mod.rs:521-528`). No cap on total rules per account **[docs]**.
- Signers/policies are deduplicated via global registries with reference counts; signer identity = `sha256(XDR(signer))`, plus **canonical key dedup** via `batch_canonicalize_key` on the verifier — prevents one key registering as multiple "distinct" signers to beat thresholds **[code]** (`validate_no_canonical_duplicates`).
- `valid_until` is a **ledger sequence** (~5s/ledger; `DAY_IN_LEDGERS = 17280`), not a timestamp **[code]**. Expired rules rejected at auth time (`valid_until < current_sequence`).
- Rule management (`add_context_rule`, `add_signer`, `add_policy`, `remove_*`, `update_*`) is **self-administered**: each requires `e.current_contract_address().require_auth()` **[code]** (`mod.rs`). So an install plan = a transaction invoking these functions *on the account*, authorized through an existing (admin) rule.
- `ExecutionEntryPoint::execute(target, fn, args)` also self-authorizes and then `invoke_contract`s arbitrarily **[code]** (`mod.rs:509`).
- Storage layout (matters for off-chain inspection): instance keys `NextId`, `Count`, `NextSignerId`, `NextPolicyId`; persistent `ContextRuleData(u32) → ContextRuleEntry{name, context_type, valid_until, signer_ids, policy_ids}`, `SignerData(u32)`, `PolicyData(u32)`, lookup maps **[code]**. Rules are enumerable off-chain: read `NextId`, then `getLedgerEntries` for `ContextRuleData(0..NextId)` (gaps = removed rules). Full event set exists for indexing (`ContextRuleAdded/Removed`, `SignerAdded/Removed`, `PolicyAdded/Removed`, registrations) **[code]**.

### 2.2 Verified policy primitives (code, `policies/`)

- **Policy trait** = `enforce(context, authenticated_signers, context_rule, smart_account)`, `install(install_params, ...)`, `uninstall(...)` **[code]** (`policies/mod.rs:47`). `enforce` panics to deny and may mutate state; all three should `smart_account.require_auth()` (safe because direct contract→contract invocations are pre-authorized in Soroban; that's also why `ExecutionEntryPoint` exists) **[code doc-comments]**.
- **simple_threshold**: M-of-N over `authenticated_signers.len()`; storage keyed `(smart_account, context_rule_id)`; explicit security warning: **threshold state drifts** when signers are added/removed (DoS or silent weakening) **[code]**.
- **weighted_threshold**: per-signer weights, sum ≥ threshold; same drift caveat **[code]**.
- **spending_limit**: rolling-window (ledger-based) cumulative cap. Critically narrow: matches **only** `Context::Contract` with `fn_name == "transfer"` and reads `args[2]` as `i128`; anything else → `NotAllowed` panic. Install allowed **only** on `CallContract` rules (pins to one token). Max 1000 history entries. Zero-amount transfers always pass **[code]** (`spending_limit.rs:222-302`). It is a SEP-41 `transfer` cap, **not** a generic DeFi spend policy — it cannot meter `approve`, `submit` (Blend), `swap` (Soroswap), or multi-asset flows.
- Example contract wiring **[code]** (`examples/multisig-smart-account/account/src/contract.rs`): `__check_auth` → `smart_account::do_check_auth`; constructor creates one **`Default`** rule named "multisig". Policies/verifiers ship as separate thin contracts wrapping library functions. Note the example account is `Upgradeable` where `upgrade` is also self-authorized.
- Verifiers: `ed25519` (32-byte keys, 64-byte sigs) and `webauthn` (65-byte uncompressed P-256 keys; sig data = signature + authenticatorData + clientDataJSON, XDR-encoded) **[code+docs]**.

### 2.3 Contradictions, gaps, productization opportunities

1. **RFP inaccuracy — `can_enforce` does not exist.** The RFP says the lifecycle is "install / can_enforce / enforce / uninstall". Current OZ code has no `can_enforce` anywhere (grep across the repo: zero hits) **[code]**. It's `install/enforce/uninstall`. (A `can_enforce`-style dry-run appears in kalepail's earlier passkey-kit policy design; do not design against it.) Consequence: **there is no on-chain dry-run hook** — "would this pass?" must be answered off-chain by simulation, which our architecture treats as a first-class tool.
2. **Context rules scope to a whole contract, not to functions or arguments.** `CallContract(Address)` is the finest native granularity **[code]**. *Any* "only these two functions" / "only these args" requirement — the heart of record-and-generate — **requires a policy**. This is the single most important design driver: the RFP's "context rule scope: which contracts and functions" overstates what rules do; functions/args live in policy logic.
3. **New strict rules do not disable old permissive rules.** Because the caller picks the rule ID, adding a tight rule changes nothing about what an attacker/agent can authorize via an existing rule. Real "least privilege" = install new + remove/expire old. Bypass detection is therefore a core tool, not a nice-to-have.
4. **`Default` rules are super-user scoped**: they match every context including self-administration (`add_context_rule`, `upgrade`, `execute`). Any signer set that can satisfy a Default rule can rewrite the whole account. Risk reports must always surface this.
5. **Self-administration is itself a context.** Calling `add_context_rule` on account `A` is `Context::Contract{contract: A, fn_name: "add_context_rule"}` → matched by `Default` rules or `CallContract(A)` rules **[inference from code]**. So: (a) install plans are ordinary invocations authorized by the owner rule; (b) a `CallContract(A)` rule is privilege escalation; (c) `ExecutionEntryPoint::execute` reachable through any rule = arbitrary calls. Bypass analysis must treat `CallContract(account_itself)` and `Default` as admin-equivalent.
6. **Threshold state drift** (2.2) means install plans that touch signer sets must sequence threshold updates correctly (update threshold BEFORE removing signers / AFTER adding) **[code doc-comments]** — the plan generator encodes this ordering rule.
7. **Opportunity — parameterized policy library.** The gap between "OZ's 3 primitives" and "generate custom Rust every time" is where this product wins. We ship a small, **audited-once, parameterized** policy set (see §6): function allowlist, argument matcher, call-amount cap for arbitrary functions/arg-paths, rate limit. Most record-and-generate outputs become *configuration* of these, not fresh code. Fresh codegen remains for genuinely novel logic. This is also the natural "upstream to OZ" story the RFP asks for.
8. **History retention constraint.** Stellar RPC retains ~24h of transactions and ≤7 days of events **[web: Stellar docs]**. Tier-2's "last 30 days" needs Horizon (limited Soroban detail), **Hubble** (SDF's public BigQuery, full history, 30-min freshness) **[web]**, Mercury, or self-indexing via events. Design: pluggable `HistoryProvider` (RPC-window default; Hubble/stellar.expert adapters for deep history).
9. **Fork simulation exists and is cheap**: `stellar snapshot create --address C... --output json` then Rust tests with `Env::from_ledger_snapshot_file(...)` **[web: Stellar docs "Fork Testing"]**. This is the backbone of the deny/allow harness — no local network needed for most verification.

### 2.4 Tyler / Pollywallet findings

From the transcript + repo **[web]**:
- Flow demonstrated: tx hash → deterministic on-chain lookup → extracted "pattern" → user-editable schema (per-arg constraints: any / exact / range; comments) → LLM (Kimi on Cloudflare) generates a policy contract → Cloudflare sandbox with Rust + stellar-cli compiles, tests, feeds errors back → deploy to testnet → install as new context rule (policy + session G-address signer, stored in localStorage as a session token; suggested ~24h expiry) → auto-policy signing without popups; 101 XLM blocked, 100 allowed. Gasless via OZ Relayer.
- Tyler's own points we adopt: schema-first determinism; "this should be an MCP/skills, not a web UI"; generated code is a *starting point* needing review; the OAuth analogy (short-lived, scoped session rules); repeated-approval fatigue is itself an attack surface.
- Weaknesses to fix (some acknowledged in the demo): the generated policy checked "transfer with 3 args of any type" rather than the intended constraint — i.e., **unverified codegen semantics**; no deny-case battery; no bypass analysis of pre-existing rules; single-tx evidence only; hardcoded rather than parameterized policies; wallet-coupled UI.
- Pollywallet stack worth reusing: OZ Relayer (Channels) integration, passkey → AuthPayload encoding, multisig-account TS bindings, Apache-2.0 license.
- **kalepail/smart-account-kit** (TypeScript) already provides: `createWallet/connectWallet`, `ContextRuleManager` CRUD, `signAndSubmit` with internal AuthPayload construction and digest computation **[web]**. Strong reuse candidate for the client/signing layer and the wallet-integration deliverable.

---

## 3. MCP tool design

### 3.1 Principles

- **Composable, single-purpose tools.** No "generate policy" mega-tool. Each tool is deterministic given inputs (the LLM sits *between* tools, not inside them; the one LLM-adjacent tool — codegen — is template-constrained and always followed by mandatory verification tools).
- **Safety levels**: `read-only` (network reads, pure transforms) → `build-only` (writes only to a per-session workspace dir; compiles/tests in sandbox) → `sim` (testnet/fork simulation, no state mutation on real accounts) → `approval-gated` (anything that could change on-chain state or spend fees).
- **Evidence-carrying outputs.** Every synthesized constraint carries provenance (`observed_tx:<hash>`, `user_intent`, `default`). Every plan carries a content hash; the approval-gated submit tool only accepts a hash the user has explicitly approved via a token shown to the user out-of-band of the model.
- **Machine-readable errors** with stable codes (`E_RULE_NOT_FOUND`, `E_HISTORY_WINDOW_EXCEEDED`, `E_POLICY_SEMANTICS_UNPROVABLE`, `E_UNSATISFIABLE_BY_CONTEXT`, ...).
- All schemas are JSON Schema-validated at the boundary; malformed AI input is rejected, never "fixed up" silently.

### 3.2 Tool surface (16 tools)

Common conventions: every tool takes `network: "testnet"|"mainnet"|"local"`; addresses are strkeys; amounts are decimal strings + `decimals`; all outputs include `schema_version`.

**Group A — Inspection (read-only)**

| # | Tool | Purpose |
|---|------|---------|
| A1 | `inspect_account` | Full account snapshot: enumerate context rules via `getLedgerEntries` (`NextId` + `ContextRuleData(i)`), resolve signers/policies, classify each policy address against a registry of known WASM hashes (OZ primitives, our parameterized library, unknown), detect admin/recovery rules. |
| A2 | `inspect_rule` | One rule in depth incl. policy install-state reads (e.g. `get_threshold`, `get_spending_limit_data` via read-fn simulation) and expiry status in ledgers + approximate wall time. |
| A3 | `lookup_transactions` | Fetch txs by hash list, or search by account/contract/signer over a time window via pluggable HistoryProvider (RPC ≤ retention; Hubble/stellar.expert for deep history). Returns envelopes + result/meta XDR + decoded summaries. Fails explicitly with `E_HISTORY_WINDOW_EXCEEDED` + provider suggestions rather than silently truncating. |
| A4 | `trace_transaction` | Decode one tx fully: operations, `InvokeHostFunctionOp.host_function`, **`SorobanAuthorizationEntry` trees** (`root_invocation` + sub-invocations), which address authorized which context, events (incl. SAC `transfer`), state changes, token deltas. This is the deterministic "recorder". |

- Input (A4): `{tx_hash | envelope_xdr [+ result_meta_xdr], network}` → Output: `TransactionTrace` (§4.3).
- Must never: guess argument semantics; unknown arg types are reported as raw `ScVal` XDR + type tag.
- Failure modes: tx not found / meta unavailable (needs archival provider), malformed XDR, fee-bump wrappers (relayer-wrapped txs — unwrap inner tx).

**Group B — Extraction & intent (read-only / pure)**

| # | Tool | Purpose |
|---|------|---------|
| B1 | `extract_auth_contexts` | From one or more `TransactionTrace`s (filtered to a given authorizing address, e.g. the smart account, and optionally a specific signer), produce the multiset of `(contract, fn_name, args)` contexts equivalent to what `__check_auth` would see, mapped to `ContextRuleType`, with per-arg observed values and SEP-41 token metadata (symbol, decimals via contract reads). Pure + deterministic. |
| B2 | `interface_lookup` | Fetch a contract's WASM (`getLedgerEntries` ContractCode) and parse the contractspec: full function list, arg names/types. Enables "which other functions exist on this contract" and correct arg-index selection (fixes Tyler's "3 args of any type" bug). Handles SAC specially (fixed SEP-41 interface). |
| B3 | `parse_intent` | Validating compiler from a **structured** `PolicyIntent` draft (produced by the AI from conversation) into a canonical, normalized `PolicyIntent`: resolves token symbols→addresses, days→ledgers, checks contradictions, fills nothing silently — missing required fields come back as `clarifications_needed[]`. The AI does language; this tool does normalization + validation only. |

**Group C — Synthesis & matching (pure, deterministic)**

| # | Tool | Purpose |
|---|------|---------|
| C1 | `synthesize_ruleset` | Core synthesizer: `PolicyIntent` + optional evidence (`extract_auth_contexts` output, allow/deny example sets) → `CandidateRuleset`: context rules (one `CallContract` rule per target contract; never `Default` unless explicitly demanded + double-confirmed), signer bindings, and per-rule policy requirements expressed as abstract `Constraint`s (function allowlist, arg predicates, amount caps w/ window, expiry, threshold). Bias: smallest closure over evidence (see §12 Q4). Deterministic: same inputs → same output. |
| C2 | `match_policies` | Maps abstract `Constraint`s to concrete policies: OZ primitives first (spending_limit only iff the constraint is exactly "cap `transfer` arg[2] on one token"), then our parameterized library, else marks `requires_custom_policy` with a precise statement of the residual constraint. Emits explicit `limitations[]` (e.g. "spending_limit cannot meter Blend submit; residual risk: unmetered outflow via pool within rule"). Never stretches a primitive beyond verified semantics. |
| C3 | `generate_policy_code` | Only for `requires_custom_policy` residuals. Fills audited Rust templates (Policy trait impl, storage segregated by `(smart_account, ctx_rule_id)`, events, errors) with constraint-specific checks; the free-form part is minimal and clearly delimited. Output: a cargo workspace in the build dir + `codegen_manifest.json` mapping each generated check to its source constraint (for review + test generation). Build-only; never deploys. |

**Group D — Verification (build-only / sim)**

| # | Tool | Purpose |
|---|------|---------|
| D1 | `compile_policy` | `cargo check` / `cargo build --target wasm32v1-none --release` (+ clippy `-D warnings`, fmt) inside the sandbox. Returns structured diagnostics for the AI repair loop (bounded retries; every iteration re-verified). |
| D2 | `generate_tests` | Deterministically derives a test suite from the `CandidateRuleset` + evidence: allow cases (each observed/positive context must pass `enforce`), deny cases (mutation battery: wrong function, wrong contract, wrong token, amount+ε, over-window cumulative, expired rule, wrong signer, arg tampering; plus user-provided negative examples). Emits Rust tests (unit `Env` + snapshot-fork tests). |
| D3 | `run_simulation` | Executes the suite: (a) unit tests, (b) fork tests against `stellar snapshot create` state, (c) optional live-testnet rehearsal (deploy to a scratch account, replay flows). Also runs **replay**: rebuilds each evidence tx's auth entries under the proposed rules and `simulateTransaction`s them. Output: `SimulationReport` — every allow/deny case with pass/fail + raw diffs. |
| D4 | `detect_bypass` | Static + simulated bypass analysis of a `CandidateRuleset` against the live `AccountSnapshot` (§8). Output: `BypassReport` with per-rule verdicts `SAFE / BYPASS(path) / UNKNOWN(reason)` and recommended removals/expiries. |

**Group E — Planning & explanation (build-only)**

| # | Tool | Purpose |
|---|------|---------|
| E1 | `prepare_install_plan` | Orders concrete steps: deploy policy WASMs (if any), `add_context_rule` invocations with exact `Map<Address, Val>` install params, removals/updates of conflicting rules (correctly sequenced re: threshold drift), each as **unsigned** tx XDR + simulation-derived footprint/fees + required auth (which rule/signers must sign, incl. the digest formula). Includes `plan_hash` + `approval_token`. Refuses to build if `run_simulation` or `detect_bypass` haven't been run on this exact ruleset (staleness checked by hash). |
| E2 | `prepare_revocation_plan` | The inverse, always generated alongside E1: `remove_context_rule` / `update_context_rule_valid_until(now)` txs to kill the grant instantly; also "break-glass": what the owner rule can always do. |
| E3 | `explain_policy` | Deterministic renderer (templates over the data model — not LLM): plain-English description of the ruleset, **policy diff** (account permissions before/after), residual-risk report (§4.7) incl. every `limitations[]` and `UNKNOWN` bypass verdict, expiry in local time, revocation instructions. |

**Group F — Approval-gated**

| # | Tool | Purpose |
|---|------|---------|
| F1 | `submit_plan` | Optional, **disabled by default** (server flag `--enable-submit`). Takes `plan_hash` + user-quoted approval token (printed in the plan file, not returned to the model as data it can quote) + signed XDRs produced by the user's wallet (smart-account-kit / Pollywallet flow), or routes them through OZ Relayer. Verifies signatures exist and plan hash matches before submitting. Never signs anything itself. |

For every tool, "must never do" includes globally: hold or request private keys/seed phrases; submit any transaction (except F1 under its gates); mutate files outside the per-session build dir; report a check as passed without underlying tool evidence.

### 3.3 The Claude skill

Thin conversational wrapper (per RFP): knows the tool grammar (recorder → synthesize → match → [codegen] → tests → sim → bypass → plan → explain), when to ask clarifying questions ("cap at the observed 50 USDC, or a budget like 100/week?"), and hard rules: never skip verification tools, always show `explain_policy` output before mentioning install, never call `submit_plan` without the user quoting the approval token.

---

## 4. Data model (all JSON Schema'd; abbreviated)

**4.1 `AccountSnapshot`** — `{account, network, ledger, taken_at, rules: ContextRuleModel[], signer_registry, policy_registry: {address, classification: "oz:spending_limit"|"oz:simple_threshold"|"oz:weighted_threshold"|"pb:<parameterized>"|"unknown", wasm_hash, install_state?}, admin_paths: RuleRef[], recovery_paths: RuleRef[], warnings[]}`

**4.2 `ContextRuleModel`** — `{id, name, context_type: {kind:"default"} | {kind:"call_contract", address} | {kind:"create_contract", wasm_hash}, valid_until_ledger?, expires_at_approx?, signers: SignerModel[], policies: PolicyRef[], privilege: "admin-equivalent"|"scoped"}` — `privilege` = admin-equivalent iff kind=default or call_contract(self).

**4.3 `TransactionTrace`** — `{tx_hash, ledger, fee_info, source, fee_bump_wrapper?, invocations: InvocationNode[] (tree: contract, fn, args as typed ScVal JSON, sub_invocations), auth_entries: {credentials: source_account | address{addr, nonce, sig_exp}, root_invocation}[], events: TokenTransfer|Raw[], token_deltas: {token, from, to, amount, decimals, symbol}[]}`

**4.4 `PolicyIntent`** (the minimal schema — answer to Q2):
```json
{
  "schema_version": "1",
  "account": "C...", "network": "testnet",
  "grantee": {"signer": {"type":"delegated|external", "...": "..."}, "label":"AI trading agent"},
  "targets": [{
    "contract": "C...", "label": "Blend pool",
    "functions": [{"name":"submit", "arg_constraints":[{"index":3,"path":"requests[*].request_type","op":"in","values":[0,1]}]}],
    "provenance": "observed_tx:abc123 | user_intent | default"
  }],
  "budgets": [{"token":"C...USDC","cap":"500","decimals":7,"window":{"days":1},"scope":"outflow_via_transfer|per_call_arg","provenance":"user_intent"}],
  "expiry": {"days": 7},
  "revocable_by": ["owner_rule_ref"],
  "preserve": ["rule_id:0 (owner/recovery)"],
  "explicit_denies": [{"description":"any other contract","provenance":"default"}]
}
```
Everything downstream consumes only this + evidence; the AI's free text never reaches the synthesizer.

**4.5 `CandidateRuleset`** — `{ruleset_hash, rules: [{context_type, name, valid_until_ledger, signers, constraints: Constraint[], policy_bindings: [{constraint_refs, policy: known-address+params | codegen_ref, limitations[]}]}], removals: [{rule_id, reason}], updates: [...]}` — `Constraint` is the abstract IR: `func_allowlist | arg_predicate(eq/in/range/addr_is, path) | amount_cap(token, window, arg_source) | rate_limit(n, window) | threshold(m, of) | expiry`.

**4.6 `TestCase` / `SimulationReport`** — `{id, kind:"allow"|"deny", origin:"observed|mutation:<op>|user_example", context: {contract, fn, args}, expected:"pass"|"panic:<error_code>", result?, engine:"unit|fork|testnet"}`; report = `{ruleset_hash, cases[], coverage: {constraints_exercised}, verdict:"all_green"|"failures", artifacts_dir}`.

**4.7 `RiskReport`** — `{ruleset_hash, residual_risks: [{severity, code, description, evidence}], unknown_policies[], bypass: BypassReport, limitations[], irreversibility_notes[], expiry_summary, revocation_summary}`.

**4.8 `InstallPlan`** — `{plan_hash, approval_token, steps: [{order, kind:"deploy_wasm|invoke", tx_xdr_unsigned, description, auth_requirements:[{rule_id, signers, digest_note}], simulated_fee, reversible: bool, revert_step?}], depends_on: {simulation_report, bypass_report, risk_report hashes}, revocation_plan}`.

---

## 5. Tier support plan

**Tier 1 — intent only** ("agent can use Blend, max 500 USDC/day, only this contract, expires 7 days, revocable"):
1. AI drafts `PolicyIntent` → `parse_intent` normalizes (USDC → C-address, 7 days → `current_ledger + 7*17280`), returns `clarifications_needed` if e.g. the Blend contract or the agent signer key is unstated.
2. `interface_lookup` on the Blend pool → function list; "use Blend" is ambiguous → the skill asks once which functions.
3. `synthesize_ruleset` → two rules: `CallContract(blend_pool)` [func allowlist + expiry + agent signer] and `CallContract(usdc)` [transfer cap 500/day + expiry + agent signer].
4. `match_policies` → USDC rule: OZ `spending_limit` fits exactly (transfer/arg[2]/single token ✔). Blend rule: func-allowlist → parameterized library policy (or codegen fallback in MVP); emits limitation: "spending_limit does not meter USDC moved *by Blend* via `submit`; the 500/day cap applies to direct transfers by the agent" — surfaced in the risk report.
5. `generate_tests` → `run_simulation` (unit + fork: 501 denied, 500 allowed, other contract denied, day-8 call denied) → `detect_bypass` (verifies owner rule remains, no Default leak) → `prepare_install_plan` + `prepare_revocation_plan` + `explain_policy`. **Stop.** User reviews; nothing installed.

**Tier 2 — from account + 30-day history**:
1. `inspect_account` → snapshot incl. existing rules, owner/recovery classification.
2. `lookup_transactions(signer=agent, window=30d)` via Hubble/stellar.expert provider (explicit `E_HISTORY_WINDOW_EXCEEDED` on plain RPC) → `trace_transaction` batch → `extract_auth_contexts(authorizer=account, signer=agent)` → observed workflow set (Blend submit/claim shapes, USDC transfers, arg distributions).
3. AI + `parse_intent` merge observed evidence with stated caps (500/day, 7d) → `synthesize_ruleset` computes the **minimal closure**: only observed functions; arg constraints where stable across evidence (e.g. `to == account` on every claim); caps from user intent.
4. `detect_bypass` against the live snapshot → flags e.g. an old permissive `Default` session rule the agent signer satisfies → plan includes its removal/expiry, never touching rules on the `preserve` list (owner recovery untouched).
5. `generate_tests` (allow = replay of the 30-day contexts under fork; deny = mutation battery + "workflows not in evidence") → `run_simulation` incl. tx replay → `prepare_install_plan` + `prepare_revocation_plan` + `explain_policy` with plain-English residual risks. **Stop** for approval.

**Tier 3 — positive/negative examples** (12 good, 8 malicious):
1. `trace_transaction` + `extract_auth_contexts` on all 20 → labeled context sets.
2. `synthesize_ruleset` in example-driven mode: find the smallest `Constraint` set with `∀allow: pass ∧ ∀deny: fail`. Algorithm: start from the allow-closure (per-contract func allowlist + per-arg generalization lattice: exact → enum → range → any, generalizing only as far as needed to cover all positives); then check every negative; for each covered negative, tighten along the lattice or add a discriminating predicate; if a negative is *indistinguishable* from a positive at the auth-context level (same contract/fn/args; differs only in ordering or external state), return `E_UNSATISFIABLE_BY_CONTEXT` with the exact colliding pair — honest failure instead of a fake policy. Deterministic, no LLM.
3. `match_policies` → primitives/parameterized where possible; else `generate_policy_code` → `compile_policy` repair loop (AI patches only the delimited region, bounded iterations).
4. `generate_tests` embeds all 20 examples as allow/deny cases + mutation battery → `run_simulation`.
5. `detect_bypass` produces the "prove no older rule bypasses" verdict per rule (§8) — `SAFE` proofs where policy semantics are known, `UNKNOWN` honestly otherwise with a removal recommendation.
6. "Signed install plan" = `prepare_install_plan` output handed to the user's wallet for signing (the MCP never signs); `submit_plan` only if enabled + token quoted.

---

## 6. Existing vs custom policy strategy (answers Q1, Q6)

Decision ladder (strict order):
1. **No policy at all** — if the need is "these exact signers must all sign for contract X, until T": bare `CallContract` rule + signers + `valid_until`. Cheapest, strongest.
2. **OZ `simple_threshold`** — M-of-N over rule signers, any context type. Use when quorum is the only constraint. Install plans always carry the drift warning (§2.3.6).
3. **OZ `weighted_threshold`** — role-weighted quorum. For tiered human orgs; rarely for agents.
4. **OZ `spending_limit`** — use **iff** the constraint is exactly: cap cumulative `transfer(from,to,amount)` `arg[2]` on ONE token contract over a rolling ledger window, on a `CallContract(token)` rule. Anything else (Blend `submit`, `swap`, `approve`, multi-token) → **must not** be mapped to it; `match_policies` hard-codes this check and emits the limitation text.
5. **Parameterized policy-builder library (ours, new)** — `pb_function_allowlist` (allowed fn set per rule), `pb_arg_guard` (per-fn arg predicates: eq/in/range/address-equals, incl. nested path extraction for e.g. Blend `Request` vectors), `pb_call_cap` (rolling cumulative cap reading amount from a configured `(fn, arg_path)`, covering Blend/Soroswap amounts), `pb_rate_limit` (N calls per window). Audited once; installs are pure config. This is our proposed upstream contribution to OZ.
6. **Custom Rust codegen** — last resort, only for residuals the IR can't express (cross-call invariants, external state reads like oracle-priced slippage). Template-based, `codegen_manifest` links code↔constraints, mandatory compile/test/sim/bypass pipeline, and the explain step marks it "custom, unaudited — review required".

**Blend specifics (Q6)**: Blend interactions flow through `submit(from, spender, to, requests: Vec<Request{request_type, address, amount}>)` and `claim(from, reserve_token_ids, to)` **[inference — verify against the deployed Blend ABI via `interface_lookup` during implementation]**. Correct enforcement = `pb_arg_guard` on `request_type ∈ allowed_ops` (+ `address == USDC reserve`) + `pb_call_cap` over `requests[*].amount` filtered by token — and the risk report must state that USDC outflow *via Blend* is metered there while direct USDC transfers are metered by `spending_limit`; these are separate budgets unless one `pb_call_cap` instance is deliberately shared across rules (documented v2 feature, not MVP).

---

## 7. Simulation & testing strategy

- **Sandbox choice (Q7): local-first Docker.** A pinned image (`rust` + `stellar-cli` + `wasm32v1-none` target + vendored `stellar-accounts` crate) run by the MCP with no network by default; native cargo fallback when Docker is absent; Cloudflare Containers as an optional hosted profile for the SCF demo (parity with Pollywallet). Rationale: reproducibility + offline determinism + auditability of the toolchain beat serverless convenience for a security tool.
- **Layers**: (1) `cargo check`/clippy fast loop → (2) unit tests in `soroban_sdk::Env` (policy enforce/install/uninstall against synthetic contexts) → (3) **fork tests** with `Env::from_ledger_snapshot_file` (snapshot of the real account + target contracts + token state; replay observed contexts through a locally registered account contract carrying the candidate rules) → (4) optional live-testnet rehearsal: deploy candidate policies + a scratch smart-account clone, install there, replay via `simulateTransaction`, opt-in real submissions from throwaway keys.
- **Replay tests**: for each evidence tx, reconstruct the `SorobanAuthorizationEntry` under the new rules (correct `context_rule_ids`, digest = `sha256(payload || rule_ids.to_xdr())`) and assert allow; apply the mutation battery and assert the exact panic code (e.g. `Error(Contract, #3221)`).
- **Repair loop**: structured `compile_policy`/`run_simulation` failures → AI patches only inside the delimited template region → full re-run; max 5 iterations, then honest failure with diagnostics attached.
- **Synthesizer self-tests** (RFP audit requirement): golden corpus of tx shapes → expected `CandidateRuleset` fixtures; property tests (the allow-closure always passes its own evidence; deny mutations never pass; determinism across runs).

---

## 8. Bypass detection (answers Q5)

Model: for grantee signer set S and each context `c` = (kind, target) reachable under the new ruleset **plus** the admin contexts (`CallContract(self)`, i.e. `add_context_rule`/`upgrade`/`execute`, and `Default`), enumerate every live rule `r` on the account with `context_type ∈ {Default, exact match of c}` and unexpired `valid_until`. For each `(r, c)`:
- **No policies on r** → bypass iff `signers(r) ⊆ S ∪ K`, where K = extra keys the threat model grants the attacker (default: none beyond S; a "compromised-agent+N" mode is configurable).
- **Known-semantics policies** (OZ 3 + pb library, identified by WASM hash, install state read on-chain): evaluate symbolically — simple_threshold(t): bypass iff `|signers(r) ∩ (S∪K)| ≥ t`; spending_limit: allowed-but-rate-limited (reported as "permits transfers ≤ limit/window — intended?"); pb policies: evaluate stored config against `c`.
- **Unknown policy contract** → verdict `UNKNOWN`: attempt dynamic probing on a fork (deploy nothing; drive `enforce` with candidate contexts where install state permits), else report "cannot prove; recommend removal or manual review". **Never claim SAFE for unknown code.**
- Special detections: any `Default` rule satisfiable by S (**critical**); any rule granting `CallContract(account_itself)` (admin-equivalent → full account rewrite); `ExecutionEntryPoint::execute` reachability (an allowed `execute` = allow-everything); same-signer-with-weaker-policy overlaps on the same target; overlapping rules of different strictness on one contract.
- **Proof form**: a finite case analysis (rules × contexts) — genuinely exhaustive because rules are enumerable on-chain and matching is exact-match-or-Default **[code]**. "Proven safe" = every case ¬bypass with known semantics; everything else is listed with a path or an `UNKNOWN` reason. Recommendations (remove rule / expire now / raise threshold) are sequenced into the install plan; rules on the `preserve` list are never auto-removed — conflicts there become blocking warnings.

---

## 9. Security & trust model (answers Q8, Q9)

- **Deterministic (MCP-owned)**: XDR decode, context extraction, interface parsing, synthesis, matching, test generation, simulation execution, bypass math, plan/XDR construction, explanation rendering. **AI-owned**: conversation, `PolicyIntent` drafting (validated by B3), tool orchestration (skill-guided), template-region code repair (always re-verified). The AI can *propose*; only tools *attest*.
- **Approval matrix**: reads/traces — free. Build/compile/test/fork-sim — free (workspace-scoped). Testnet deploys of candidate policies to *scratch* accounts — allowed within a per-session faucet budget; still zero user-account mutation. Anything touching a user account (install/update/remove rules), anything mainnet, any relayer submission — approval-gated: `plan_hash` + human-quoted `approval_token` + `--enable-submit` + fresh same-hash simulation/bypass/risk artifacts.
- **Reversible vs irreversible**: every plan step carries `reversible` + a revert step where possible. Rule *addition* is reversible (remove). Rule *removal* is restorable only because the plan embeds the pre-state snapshot (manual restore). `upgrade` and signer-set changes on the owner rule are flagged irreversible-without-owner and require an extra confirmation phrase in F1.
- **Key handling**: the MCP holds no user keys, ever. Signing happens in the user's wallet (smart-account-kit / Pollywallet / any C-address wallet) against the unsigned XDRs + digest instructions we emit. Grantee session keys are generated client-side; the MCP sees only public keys. Scratch testnet keys are per-session, friendbot-funded, discarded.
- **Relayer**: OZ Relayer supported as a *submission* path in F1 (fee-bump of user-signed XDR; Soroban gas abstraction via a FeeForwarder auth entry that the *user* signs) **[web: OZ Relayer docs]**. The relayer cannot forge `__check_auth` signatures; residual risk is fee spend + censorship, and the risk report says exactly that.
- **Revocation**: every install plan ships with a ready revocation plan (E2) and a one-liner in the explanation ("to revoke: sign & submit revoke-1.xdr"). Preference: short `valid_until` (self-expiring session grants) first, explicit removal second; both provided.

---

## 10. Implementation roadmap

- **M0 — Skeleton + recorder (~2 wks)**: TS MCP server (official `@modelcontextprotocol/sdk`; stdio + streamable-HTTP), `@stellar/stellar-sdk` RPC client; tools A1–A4, B1, B2 working on testnet against a fixture smart account deployed from `examples/multisig-smart-account`. Golden-file tests for XDR decoding.
- **M1 — Tier 1 (~3 wks)**: B3, C1, C2 (OZ primitives only), D2/D3 unit+fork layers, E1–E3; Docker sandbox image; E2E demo: intent → verified plan for the XLM/USDC transfer-cap case (Pollywallet-equivalent without codegen).
- **M2 — Tier 2 (~3 wks)**: HistoryProvider adapters (RPC, Hubble, stellar.expert fallback), multi-tx evidence closure in C1, D4 bypass v1 (no-policy rules + OZ-known policies), removal sequencing in E1, policy diff in E3.
- **M3 — Parameterized policy library + Tier 3 (~4 wks)**: `pb_function_allowlist`, `pb_arg_guard`, `pb_call_cap`, `pb_rate_limit` contracts + tests (+ audit budget); example-driven synthesis incl. unsatisfiability reporting; C3+D1 codegen path with repair loop; bypass v2 (pb-aware symbolic + fork probing).
- **M4 — Demo & wallet integration (~2 wks)**: smart-account-kit integration for record→generate→simulate→sign→install E2E on testnet; Claude skill packaging; three documented walkthroughs (Blend yield claim, SEP-41 subscription billing, Soroswap bounded delegation); scripted demos for all three tiers.
- **M5 — Production hardening**: security audit of the synthesizer + policy templates (RFP requirement), OZ maintainer review loop, mainnet behind flags, versioned server endpoint, rate limiting, threat-model doc, Apache-2.0, SCF submission package.

**MVP** = M0+M1: proves record→synthesize→verify→plan with zero hallucination surface. **Highest-production** = M5 with the audited pb library proposed upstream to OZ.

---

## 11. Acceptance criteria

1. **Tier-1 script**: from the exact Tier-1 prompt, the system produces a plan whose fork simulation shows the 500-USDC/day cap enforced (501 denied `#3221`, 500 allowed), Blend-only calls (other contracts denied `#3002`), expiry at +7d ledgers (a day-8 call denied), and a working owner revocation tx. No install occurred.
2. **Tier-2 script**: on a seeded account with 30 days of synthetic history + a planted permissive `Default` session rule, the system (a) reconstructs the observed workflow set exactly (golden file), (b) flags the planted rule `BYPASS` with the concrete path, (c) plans its expiry while leaving the owner rule untouched.
3. **Tier-3 script**: 12 allow + 8 deny fixture txs → synthesized set passes 12/12 and denies 8/8 in fork sim; at least one fixture pair triggers `E_UNSATISFIABLE_BY_CONTEXT` honestly; generated custom policy compiles clean (`clippy -D warnings`) and its manifest maps every check to a constraint.
4. **Determinism**: byte-identical `CandidateRuleset` across 3 runs on the same inputs; all tool I/O validates against the published JSON Schemas.
5. **Safety**: with `--enable-submit` off, no code path can submit (tested); with it on, a wrong/missing approval token or stale artifact hashes are rejected (tested).
6. **Replay**: every evidence tx replays under the new rules via `simulateTransaction` with digests computed as `sha256(payload || rule_ids.to_xdr())` and signatures produced by smart-account-kit.
7. **Docs**: three end-to-end walkthroughs runnable from a clean checkout with one `docker pull` + `pnpm install`.

---

## 12. The ten architectural questions — direct answers

1. **Custom Rust vs composition?** Existing-first, always: bare rule/signers/expiry → OZ primitives → parameterized pb library → codegen last (§6).
2. **Minimal intent schema?** `PolicyIntent` (§4.4): grantee, targets(contract/fn/arg-constraints), budgets, expiry, preserve-list — with provenance on every field.
3. **Allow/deny representation?** Labeled auth-context test cases with origin + expected exact error code (§4.6); deny cases largely machine-generated by mutation.
4. **"Minimal safe policy" operationally?** The least-general point in the constraint lattice that (a) covers all positive evidence, (b) excludes all negative evidence and the mutation battery, (c) contains no constraint without provenance, (d) always adds expiry + revocation, (e) never widens context beyond `CallContract` of observed/stated targets (never `Default`).
5. **Proving old rules can't bypass?** Exhaustive rule×context case analysis — decidable because matching is exact-or-Default and rules are enumerable; symbolic for known policies, fork-probed or honestly `UNKNOWN` for unknown ones (§8).
6. **Blend beyond spending_limit?** `pb_arg_guard` + `pb_call_cap` over `submit.requests[*]`; never claim spending_limit covers it; dual-budget caveat in the risk report (§6).
7. **Sandbox?** Local pinned Docker primary, native cargo fallback, Cloudflare profile only for the hosted demo (§7).
8. **What needs approval?** Any user-account mutation, anything mainnet, any relayer submission — gated on plan hash + human-quoted token + fresh verification artifacts (§9).
9. **MCP vs AI boundary?** AI = language, planning, template repair; MCP = every fact, transform, check, and artifact; the validated `PolicyIntent` is the only crossing point (§9).
10. **MVP vs max?** M0+M1 vs M5 (§10).

---

## 13. Research log (primary sources)

- **Code** @ `d2c884d`: `packages/accounts/src/smart_account/{mod,storage}.rs`, `policies/{mod,simple_threshold,spending_limit,weighted_threshold}.rs`, `verifiers/mod.rs`, `examples/multisig-smart-account/account/src/contract.rs`.
- **OZ docs**: docs.openzeppelin.com/stellar-contracts/accounts/{smart-account, context-rules, signers-and-verifiers, policies, authorization-flow}. Docs and code agree on all checked points; docs additionally note the delegated-signer client burden may ease with CAP-71.
- **RFP**: `the-rfp.md`; **demo**: `pollywallet-demo.md` + https://youtu.be/vmFnCtkqQJA.
- **Repos**: github.com/kalepail/pollywallet (Apache-2.0; TanStack + CF Workers + OZ Relayer + passkeys); github.com/kalepail/smart-account-kit (TS SDK: wallet create/connect, ContextRuleManager CRUD, AuthPayload + digest signing).
- **Stellar**: RPC methods (getTransactions ~24h retention, ≤200/page; getEvents ≤7d; getLedgerEntries for contract state/WASM) — developers.stellar.org/docs/data/apis/rpc; fork testing — developers.stellar.org/docs/build/guides/testing/fork-testing (`stellar snapshot create`, `Env::from_ledger_snapshot_file`); Hubble (BigQuery, full history, ~30-min freshness) for deep lookback.
- **OZ Relayer (Stellar)**: docs.openzeppelin.com/relayer — fee-bump of signed XDR; Soroban gas abstraction via user-signed FeeForwarder auth entry.
- **Discrepancies found**: RFP's `can_enforce` lifecycle step absent from current OZ code; RFP's "context rule scope: which contracts *and functions*" — function-level scope is policy territory, not rule territory; Tyler's demo policy under-constrained args (validated the need for interface-aware, test-verified synthesis).
