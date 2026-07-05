# Volume 04 — Inspection Tools (A1–A4)

The read-only Group A tools. Each is registered in `mcp-server` but its logic lives in `packages/core` / `packages/stellar` (thin server, Vol 01 §2.4). All are `read-only` safety level. Inputs/outputs reference SCH types from Vol 02; this volume never redefines them.

Per tool: MCP contract (name, description intent, input/output schema), the FN graph, function specs (`FN-A*`), edge cases, and the tests-first table.

---

## A1 — `inspect-account`

**MCP contract.**
- Name: `inspect-account`. Safety: read-only.
- Description (to model): "Read the full authorization state of an OpenZeppelin smart account: its context rules, signers, policies (classified), admin and recovery paths. Use before synthesizing or changing any policy. Returns an AccountSnapshot."
- Input: `{ network, account: ContractId, resolve_policy_state?: boolean (default true), max_rules?: number }`.
- Output: `SCH-AccountSnapshot`.
- Errors: `E_INPUT_ADDRESS_KIND`, `E_DATA_CONTRACT_NOT_FOUND`, `E_DOMAIN_UNSUPPORTED_ACCOUNT`, `E_DATA_ACCOUNT_TOO_LARGE`, `E_DATA_INCONSISTENT_SNAPSHOT`.

### FN-A1.1 `inspectAccount(input, deps)`
- **Purpose:** Orchestrate the full snapshot.
- **Algorithm:**
  1. `assertContractId(account)` (EC-A04) → else `E_INPUT_ADDRESS_KIND`.
  2. **Fingerprint** the account (FN-A1.2). If not an OZ account → `E_DOMAIN_UNSUPPORTED_ACCOUNT` (EC-A03). *Fail closed — never emit a partial snapshot for an unrecognized layout.*
  3. Read instance entry → `NextId`, `Count`, `NextSignerId`, `NextPolicyId` (FN-ST.15).
  4. Guard `NextId ≤ MAX_RULES_HARD (2000)` else `E_DATA_ACCOUNT_TOO_LARGE` (EC-A01).
  5. Enumerate rules (FN-A1.3): batch-read `ContextRuleData(0..NextId)`; gaps = removed rules; classify `live/archived/absent` (EC-A08).
  6. Resolve members: for each rule's `signer_ids`/`policy_ids`, read `SignerData`/`PolicyData`; build the global registries (deduped).
  7. Classify each policy (FN-A1.4) against the WASM-hash registry.
  8. If `resolve_policy_state`, read install-state for known policies (FN-A1.5) via simulated getter calls.
  9. Compute `privilege` per rule (INV-Rule-1), `admin_paths`, `recovery_paths` (FN-A1.6).
  10. Cross-check `Count` vs found entries (INV-Snap-2); mismatch → one re-read, then `E_DATA_INCONSISTENT_SNAPSHOT` (EC-A02).
  11. Sanitize rule names for output (EC-A09/EC-T01) — stored raw in a `name_raw_b64`, displayed fenced.
  12. Compute `snapshot_hash` (Vol 02 §11); stamp `ledger`, `taken_at`, `account_wasm_hash`.
- **Edge cases:** EC-A01, A02, A03, A08, A09, R07, T01.
- **Tests:** `T-A1.1-1` integration (fixture account): full snapshot matches golden; `T-A1.1-2` unit: non-OZ account → `E_DOMAIN_UNSUPPORTED_ACCOUNT`; `T-A1.1-3` unit: `Count` mismatch → re-read then error; `T-A1.1-4` unit: >2000 rules → too-large; `T-A1.1-5` unit: hostile rule name fenced in output.

### FN-A1.2 `fingerprintAccount(account, deps)`
- **Purpose:** Decide whether `account` is an OZ smart account we understand.
- **Algorithm:** read `account_wasm_hash` (contract instance → executable); check against the known-OZ-account-build registry **AND** probe presence of `SmartAccountStorageKey::NextId`/`Count` instance keys; **both** must agree (a known hash with missing keys, or keys with an unknown hash, → not-supported with the disagreement noted) (EC-A03).
- **Tests:** `T-A1.2-1` unit: known hash + keys → supported; `T-A1.2-2` unit: unknown hash → unsupported; `T-A1.2-3` unit: known hash but no keys → unsupported (disagreement reported).

### FN-A1.3 `enumerateRules(account, nextId, deps)`
- **Purpose:** Batch-read all rule entries, classify liveness, record gaps.
- **Algorithm:** `contextRuleDataKeys(account, 0..nextId)` (FN-ST.16), chunk ≤200, torn-read guard (FN-ST.3); decode each present entry (FN-ST.17); absent id → gap; archived → `status:"archived"` + warning (EC-A08).
- **Tests:** `T-A1.3-1` unit: gaps recorded; `T-A1.3-2` fork: archived entry flagged.

### FN-A1.4 `classifyPolicy(address, deps)`
- **Purpose:** Map a policy address to a `classification` by live WASM hash.
- **Algorithm:** read the policy contract's current `wasm_hash`; look up in the registry (OZ primitives, pb library, known generated templates); unknown → `classification:"unknown"` + `wasm_hash` recorded (EC-A05). **Never** classify by address or name.
- **Tests:** `T-A1.4-1` unit: OZ spending_limit hash → `oz:spending_limit`; `T-A1.4-2` unit: unknown hash → `unknown`.

### FN-A1.5 `readPolicyInstallState(rule, policyRef, deps)`
- **Purpose:** Read a known policy's config (thresholds, limits) via simulated read calls.
- **Algorithm:** dispatch by classification to the getter (e.g. `get_threshold(context_rule_id, account)` for simple/weighted; `get_spending_limit_data` for spending_limit — the example contracts expose these [code]); call via `simulateTransaction` (read-only, no submit); shape per Vol 02 §2.1. Unknown/generated → skip (no reads). Failure to read (archived state) → `install_state` absent + warning, not an error (EC-P03).
- **Tests:** `T-A1.5-1` fork: spending_limit state read; `T-A1.5-2` fork: threshold read; `T-A1.5-3` fork: archived state → absent + warning.

### FN-A1.6 `deriveAdminAndRecoveryPaths(rules, account)`
- **Purpose:** Flag admin-equivalent and recovery rules.
- **Algorithm:** `admin_paths` = rule ids with `privilege === "admin-equivalent"` (INV-Rule-1: `Default` or `call_contract(account)`). `recovery_paths` = heuristic subset: admin rules whose signers look like owner keys (no policies, N-of-N, long/absent expiry) — always advisory, surfaced for the user to confirm/mark `preserve`.
- **Edge cases:** EC-A07 (expired admin rules still listed as dormant), G04 (Default is admin).
- **Tests:** `T-A1.6-1` unit: Default rule → admin; `T-A1.6-2` unit: call_contract(self) → admin; `T-A1.6-3` unit: scoped rule → not admin.

---

## A2 — `inspect-rule`

**MCP contract.**
- Name: `inspect-rule`. Safety: read-only.
- Description: "Read one context rule in depth: members, policy install-state, expiry in ledgers and approximate wall-clock, and threshold-vs-signer-count health. Use to understand or debug a specific rule."
- Input: `{ network, account, rule_id }`.
- Output: `SCH-ContextRuleModel` + `{ health: RuleHealth }` where `RuleHealth = { threshold_ok?: boolean; note?: string; dormant?: boolean }`.
- Errors: `E_RULE_NOT_FOUND`, plus A1's read errors.

### FN-A2.1 `inspectRule(input, deps)`
- **Algorithm:** read the single `ContextRuleData(rule_id)`; `E_RULE_NOT_FOUND` if absent (mirror on-chain 3000 [code]); resolve members + classification + install-state (reuse FN-A1.4/A1.5); compute health (FN-A2.2); render expiry as `valid_until_ledger` + approx wall time (17280/day, "~" phrasing, EC-U05); mark `dormant` if expired (EC-A07).
- **Edge cases:** EC-A07, P01 (threshold drift health), U05 (time phrasing), G05 (expiry boundary in the wall-time note).
- **Tests:** `T-A2.1-1` fork: known rule round-trips; `T-A2.1-2` unit: missing → `E_RULE_NOT_FOUND`; `T-A2.1-3` unit: expired → `dormant:true`.

### FN-A2.2 `assessRuleHealth(rule)`
- **Purpose:** Detect threshold/signer drift (EC-P01/EC-A?) without judging intent.
- **Algorithm:** for threshold-class policies compare stored `threshold` vs `|signers|`: `threshold > |signers|` → `threshold_ok:false, note:"unreachable (DoS): threshold exceeds signer count"`; `threshold < |signers_at_install|` inferable only if install event known — else note "N-of-M where M = current signer count"; spending_limit near `MAX_HISTORY_ENTRIES` → capacity warning (EC-P02).
- **Tests:** `T-A2.2-1` unit: unreachable threshold; `T-A2.2-2` unit: healthy; `T-A2.2-3` unit: history near cap warning.

---

## A3 — `lookup-transactions`

**MCP contract.**
- Name: `lookup-transactions`. Safety: read-only.
- Description: "Find transactions by hash, or by account/contract/signer over a ledger or time window, using the best available history provider. Returns lightweight tx records; use trace-transaction for full decode. Fails explicitly if the requested window exceeds provider retention."
- Input: `{ network, by: { hashes: TxHash[] } | { account, signer?, window: {ledgers} | {days} } | { contract, window }, allow_partial?: boolean }`.
- Output: `{ records: TxRecord[]; window_covered: {from_ledger, to_ledger}; providers_used: string[]; partial: boolean }`.
- Errors: `E_HISTORY_WINDOW_EXCEEDED`, `E_NET_*`, `E_INPUT_SCHEMA`.

### FN-A3.1 `lookupTransactions(input, deps)`
- **Algorithm:**
  1. Resolve `window` to a ledger range: `{days}` → ledgers via 17280/day anchored at current ledger (FN-ST.2), `{ledgers}` as-is (EC-U05).
  2. Select the `MergingHistoryProvider` (FN-ST.8).
  3. For `by.hashes`: fetch each via `txByHash`; distinguish not-found (EC-R05) per hash (partial results allowed, each hash reports status).
  4. For account/signer or contract: stream `txsBySigner`/`txsByContract`; if union coverage < request and not `allow_partial` → `E_HISTORY_WINDOW_EXCEEDED` with a per-provider coverage report and suggestion ("enable Hubble for >7d") (EC-R01); if `allow_partial`, return covered subset and set `partial:true`, stamping `window_covered` (never silently truncate).
  5. Dedup by hash (EC-R02); sort by ledger; label provider per record (EC-R04).
  6. Sanitize any memo/text fields (EC-T01).
- **Edge cases:** EC-R01, R02, R04, R05, U05, T01.
- **Tests:** `T-A3.1-1` cassette: window within RPC returns all; `T-A3.1-2` cassette: 30-day window without deep provider → window error with report; `T-A3.1-3` cassette: `allow_partial` stamps real window; `T-A3.1-4` cassette: mixed found/not-found hashes; `T-A3.1-5` cassette: cross-provider dedup + labels.

---

## A4 — `trace-transaction`

**MCP contract.**
- Name: `trace-transaction`. Safety: read-only.
- Description: "Fully decode one transaction into a structured trace: invocation tree, Soroban auth entries (including sub-invocations), events, and token movements. This is the deterministic recorder — no interpretation of argument meaning is performed. Accepts a hash or raw XDR."
- Input: `{ network, source: { tx_hash } | { envelope_xdr, result_meta_xdr? } }`.
- Output: `SCH-TransactionTrace`.
- Errors: `E_DATA_TX_NOT_FOUND`, `E_DATA_MALFORMED_XDR`, `E_DATA_META_VERSION`.

### FN-A4.1 `traceTransaction(input, deps)`
- **Algorithm:**
  1. If `tx_hash`: `getTransaction` (FN-ST.4) → distinct not-found/failed/success (EC-R05); a `FAILED` tx still decodes, marked `successful:false` (usable only as negative evidence, INV-Trace-2, EC-S03).
  2. Decode envelope (FN-ST.9): fee-bump unwrap (EC-X01), size/hygiene guards (EC-X04/X11), all ops (EC-X06).
  3. Decode invocation tree (FN-ST.10), auth entries incl. sub-invocations (FN-ST.11, EC-G07), meta events + diffs (FN-ST.12, EC-X03).
  4. Derive token deltas (FN-ST.13): SAC→SEP-41→raw precedence, event/meta dedup, i128 via BigInt (EC-X05/X07/X08).
  5. Best-effort enrichment (symbol/decimals) — failures drop metadata only (EC-X10).
  6. Assemble `SCH-TransactionTrace` with lossless `xdr_b64` on every leaf (INV-Trace-1); retain `raw` XDR blocks.
- **Edge cases:** EC-X01–X11 (the whole family), R05, G07, S03.
- **Tests:** `T-A4.1-1` golden: relayer fee-bump tx; `T-A4.1-2` golden: Blend submit with sub-invocations + USDC transfer context; `T-A4.1-3` golden: failed tx decodes with `successful:false`; `T-A4.1-4` unit: malformed/oversize XDR; `T-A4.1-5` unit: unknown meta version; `T-A4.1-6` golden: SAC event delta; `T-A4.1-7` property: all leaves round-trip via `xdr_b64`.

### FN-A4.2 `unwrapFeeBump` / `classifyOps` (helpers)
- Covered by FN-ST.9 internals; called out because Tier-2 relayer history and multi-op classic txs both hit them (EC-X01, X06). Tests: `T-A4.2-1` fee-bump inner preserved; `T-A4.2-2` classic payment + soroban op both captured.

---

## Group-A invariants & self-checklist

- **No interpretation.** A-tools decode and classify by *hash*; they never infer argument meaning or trust names/symbols (that is B-group's job, and even there it is advisory). This is the anti-hallucination foundation: the recorder is dumb and exact.
- **Fail closed.** Unknown account layout, unknown policy WASM, unknown ScVal, torn/inconsistent reads → explicit errors or `unknown` markers, never a confident-looking partial.
- **Every output is snapshot-stamped** (`ledger`, `taken_at`, `network`, hash) so downstream tools consume artifacts, not live state (Vol 01 §2.6).

Checklist:
- [x] Each tool: MCP contract + FN graph + tests-first table.
- [x] Fingerprinting (EC-A03) prevents the catastrophic "non-OZ account looks empty" failure.
- [x] Classification is WASM-hash-based (EC-A05), never name/address.
- [x] Recorder losslessness (INV-Trace-1) has a property test.
- [x] All referenced ECs exist in Vol 10; all FN test IDs feed Vol 11.
