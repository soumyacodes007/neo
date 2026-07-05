# Volume 08 — Verification & Simulation (D1–D4)

Group D is where a candidate ruleset earns trust. Nothing reaches a plan (Vol 09) without a green `SimulationReport` and a `BypassReport` chained by hash to the exact ruleset. This is the answer to the Tyler-demo weakness (generated code whose semantics were never verified).

Tools: D1 `compile-policy` (build-only), D2 `generate-tests` (build-only, pure), D3 `run-simulation` (sim), D4 `detect-bypass` (sim + static). The sandbox that hosts D1/D3 is specified in §1.

---

## 1. Sandbox (`packages/sandbox`)

### 1.1 Image (`docker/sandbox.Dockerfile`)
Pinned-digest `rust:<ver>-slim` + `wasm32v1-none` target + pinned `stellar-cli` + `cargo-llvm-cov` + nightly rustfmt + a **vendored crates mirror** for the allowed dependency set (offline builds). Non-root user; workspace mounted at `/work` (only writable path).

### 1.2 Runtime contract (enforced by `SandboxRunner`, not by trust)
- `--network none` (no egress; supply-chain + determinism, EC-B02). Builds run `--locked --offline`; any fetch attempt fails loudly.
- Read-only rootfs except `/work`; CPU/memory/pids limits; per-phase wall timeouts (check 120 s, build 300 s, test 600 s) (EC-B05).
- Output truncation with a structured `truncated` flag; diagnostics parsed from `cargo --message-format=json` (EC-B06).
- **Native fallback:** only if a version handshake matches the pinned manifest exactly, else `E_BUILD_SANDBOX_UNAVAILABLE` with install instructions — never build on a drifted toolchain (EC-B01).
- Workspace lives on the Linux FS (`$XDG_STATE_HOME/ozpb/<session-uuid>`), never `/mnt/c` (WSL bind-mount quirks, EC-B07); per-session UUID dirs prevent cross-session bleed (EC-B08); the vendor dir is read-only shared.

### FN-D0.1 `SandboxRunner.run(phase, crate_paths, opts)`
- **Purpose:** Single entry to execute a cargo phase in the jailed container (or native fallback).
- **Algorithm:** resolve toolchain (Docker digest or native handshake); mount/copy crates into `/work`; run the phase command; capture JSON diagnostics + exit code; enforce timeout/limits; return `{ ok, diagnostics: Diagnostic[], truncated, toolchain_fingerprint }`. **Diff guard:** if the phase follows a codegen edit, verify no bytes changed outside `>>> GENERATED` markers (EC-B04) before running.
- **Edge cases:** EC-B01–B08.
- **Tests:** `T-D0.1-1` integration: fixture policy compiles in-image; `T-D0.1-2` unit: offline enforced (network attempt fails); `T-D0.1-3` unit: timeout kills; `T-D0.1-4` unit: marker diff-guard rejects out-of-fence edit; `T-D0.1-5` unit: version-handshake mismatch → `E_BUILD_SANDBOX_UNAVAILABLE`; `T-D0.1-6` unit: workspace relocated off `/mnt/c` with warning.

---

## 2. D1 — `compile-policy`

**MCP contract.** Name `compile-policy`; safety build-only. Input `{ workspace_id, crate_paths, mode: "check"|"build"|"lint" }`. Output `{ ok, diagnostics, wasm_hash?, toolchain_fingerprint }`. Errors `E_BUILD_COMPILE_FAILED`, `E_BUILD_TIMEOUT`, `E_BUILD_SANDBOX_UNAVAILABLE`.

### FN-D1.1 `compilePolicy(input, deps)`
- **Algorithm:** `check` → `cargo check` (fast repair loop); `lint` → `cargo +nightly fmt --check` + `cargo clippy --all-targets -D warnings`; `build` → `cargo build --target wasm32v1-none --release` then record `wasm_hash` of the optimized WASM. Structured diagnostics (capped, EC-B06) returned for the AI repair loop.
- **Repair loop** (FN-D1.2): on `check`/`lint`/`build` failure, the AI may patch **only** inside generated markers (diff-guarded); each iteration re-runs the full phase; max `MAX_REPAIR_ITERS (5)`; then `E_BUILD_COMPILE_FAILED` with the last diagnostics (honest stop, no infinite loop). Semantic correctness is **not** judged here — that's D2/D3.
- **Edge cases:** EC-B04 (marker guard), B05 (timeout counts as an iteration), B06 (diagnostic cap).
- **Tests:** `T-D1.1-1` integration: valid crate → ok + wasm_hash; `T-D1.1-2` integration: broken generated region → diagnostics; `T-D1.1-3` unit: 6th repair iteration → `E_BUILD_COMPILE_FAILED`; `T-D1.1-4` unit: clippy warning fails lint mode (no `#[allow]` escape, Vol 01 §3.1).

---

## 3. D2 — `generate-tests`

Deterministically derives the allow/deny suite from the ruleset + evidence + examples. This is where the mutation battery lives — the systematic "deny" coverage the demo lacked.

**MCP contract.** Name `generate-tests`; safety build-only, pure. Input `{ ruleset, evidence?, examples?, codegen_manifest? }`. Output `{ test_cases: SCH-TestCase[], rust_test_files: string[], coverage_plan }`. Errors `E_DOMAIN_COVERAGE_GAP`.

### FN-D2.1 `generateTests(input, deps)`
- **Algorithm:**
  1. **Allow cases:** each positive evidence context and each `examples.allow` context → a `TestCase{kind:"allow", expected:pass}` with its provenance (INV-Test-2).
  2. **Deny cases from examples:** each `examples.deny` → `TestCase{kind:"deny", expected: panic:<code>}` where the code is predicted from which constraint should reject it (verified in D3).
  3. **Mutation battery** (FN-D2.2): for each allow case, derive deny mutations via the operators (Vol 02 §8): `wrong_function`, `wrong_contract`, `wrong_token`, `amount_plus_epsilon`, `cumulative_overflow` (N calls summing over cap), `expired_window` (ledger_offset past `valid_until`, using `valid_until+1` per boundary EC-G05), `wrong_signer`, `arg_tamper` (flip an `in`/`eq` arg to an unlisted value), `extra_context`, `reordered_contexts`, `zero_amount` (expected **pass** — documents reality, EC-S12), `negative_amount`.
  4. **Coverage check:** every constraint must appear in ≥1 allow and ≥1 deny case (INV-Test-1); a constraint with no possible discriminating mutation (an arg that never varies and can't be tampered meaningfully) → `E_DOMAIN_COVERAGE_GAP` naming it (forces a clarification rather than a blind spot).
  5. **Emit Rust tests** (FN-D2.3): unit tests in `soroban_sdk::Env` (register the pb/generated policy + a mock account, `mock_all_auths` except the dedicated full-auth-path test EC-G09) and fork-test stubs; plus a **replay** test per evidence tx (FN-D2.4).
- **Edge cases:** EC-S12 (zero-amount pass), G05 (expiry boundary), P09 (double-context accumulation case included), coverage-gap.
- **Tests:** `T-D2.1-1` golden: Tier-1 ruleset → expected case set (allow 500, deny 501/other-contract/other-token/day-8); `T-D2.1-2` unit: every constraint covered both polarities; `T-D2.1-3` unit: uncoverable constraint → gap error; `T-D2.1-4` unit: zero-amount case expects pass; `T-D2.1-5` unit: expired case uses valid_until+1.

### FN-D2.2 `mutationBattery(allowCase, ruleset)` / FN-D2.3 `emitRustTests(cases)` / FN-D2.4 `emitReplayTest(trace, ruleset)`
- FN-D2.2: pure generator; each operator produces a mutated context + expected outcome; amount mutations respect decimals/i128 (EC-X07). Tests `T-D2.2-*` per operator.
- FN-D2.3: renders Rust test files; panic tests use numeric `#[should_panic(expected="Error(Contract, #<code>)")]` (Vol 01). Tests `T-D2.3-1` renders compilable tests.
- FN-D2.4: builds a replay that reconstructs the tx's auth entries under the new rules (FN-ST.19/20), correct digest (FN-ST.18), asserts allow (EC-G01/G02/G07). Tests `T-D2.4-1` replay stub for Blend tx covers all contexts.

---

## 4. D3 — `run-simulation`

**MCP contract.** Name `run-simulation`; safety sim (no user-account mutation). Input `{ ruleset, test_files, engines: ("unit"|"fork"|"testnet")[], snapshot?: {address_set, at_ledger} }`. Output `SCH-SimulationReport`. Errors `E_BUILD_SIMULATION_FAILED`, `E_NET_*`.

### FN-D3.1 `runSimulation(input, deps)`
- **Algorithm:**
  1. **unit engine:** `cargo test` in the sandbox over the generated + pb/generated-policy crates; parse per-test outcomes.
  2. **fork engine:** derive the snapshot address set (FN-ST.23), `createSnapshot` (FN-ST.24) at `at_ledger`; run fork tests with `Env::from_ledger_snapshot_file`; a **missing footprint entry** is classified `error` (not `fail`) so it isn't misread as a policy denial (EC-M02); snapshot staleness beyond threshold triggers re-snapshot (EC-M01).
  3. **testnet engine (optional):** deploy candidate policies + a scratch clone of the account to a friendbot-funded throwaway; install; replay via `simulateTransaction`; friendbot/fixtures down → engine reports `skipped` with reason (never blocks — fork is the verification of record, EC-R08/M05).
  4. **replay across engines:** each evidence tx's reconstructed auth (correct digest, all contexts) asserted allow; the wrong-preimage negative asserted fail with the diagnostic (EC-G01).
  5. Aggregate per-engine `cases[]`, compute `coverage`, set `verdict = all_green` iff every allow passes and every deny panics with the expected code (a deny that passes, or an allow that fails, → `failures`). Record `toolchain_fingerprint` per engine run. `verdict != all_green` hard-blocks E1 (INV-Test-3).
- **Edge cases:** EC-M01–M07, G01/G02/G07, S02 (fork proof that spending_limit misuse *denies* — `T-D3.1-4`).
- **Tests:** `T-D3.1-1` integration: Tier-1 ruleset all-green on unit+fork; `T-D3.1-2` fork: 501 denied `#3221`/`#3344`, 500 allowed; `T-D3.1-3` fork: missing footprint → `error` not `fail`; `T-D3.1-4` fork: spending_limit bound to a non-transfer context denies (proves EC-S02 misuse is safe-by-denial); `T-D3.1-5` unit: a deny-case that unexpectedly passes → `verdict:failures`; `T-D3.1-6` fork: replay of Blend tx passes all contexts; `T-D3.1-7` unit: testnet down → engine skipped, verdict from fork.

---

## 5. D4 — `detect-bypass`

Proves (or refutes) that no rule other than the proposed ones lets the grantee signer set do what the new ruleset restricts. Decidable because rule matching is exact-or-Default and rules are enumerable (Vol 02 §2.3, [code]).

**MCP contract.** Name `detect-bypass`; safety sim + static. Input `{ ruleset, account_snapshot, threat_model?: {extra_compromised: number} }`. Output `SCH-BypassReport`. Errors `E_INPUT_HASH_MISMATCH`.

### FN-D4.1 `detectBypass(input, deps)`
- **Algorithm:**
  1. Threat set `S` = grantee signers (+ `extra_compromised` abstract keys if configured). Context universe `U` = every context reachable under the new ruleset **plus** the admin contexts (`call_contract(account)` = `add_context_rule`/`upgrade`/`execute`, and the implicit `Default` scope) (EC-G04, INV-Rule-1).
  2. For each context `c ∈ U`, enumerate every **live** rule `r` in the snapshot with `context_type ∈ {Default, exact-match(c)}` and unexpired `valid_until` (expired-but-present rules noted separately as dormant/reactivatable, EC-A07). Include the new rules too (to confirm they behave), but findings focus on *other* rules.
  3. Classify `(r,c)` via FN-D4.2:
     - **no policies:** BYPASS iff `signers(r) ⊆ S` (N-of-N satisfiable by threat set).
     - **known-semantics policy** (OZ 3 + pb, by live WASM hash + read install state; hash re-checked now, EC-A05): evaluate symbolically — simple_threshold(t): BYPASS iff `|signers(r) ∩ S| ≥ t`; spending_limit/pb_call_cap: "permitted but capped" → reported as a *rate-limited* finding, not a clean SAFE, so the user sees it; pb_arg_guard/allowlist: evaluate config against `c` (does the guard admit `c`?).
     - **unknown policy or unknown verifier** (EC-A05/A06): verdict `UNKNOWN` — attempt a fork probe (drive the deployed policy's `enforce` with candidate contexts where install state allows) to strengthen to BYPASS/SAFE; if not probeable, stay `UNKNOWN` with a manual-review recommendation. **Never SAFE for unknown code** (INV-Bypass-1, fail-closed).
  4. Special findings: any `Default` rule satisfiable by S → **critical** (EC-G04); any rule granting `call_contract(account)` to S → admin-escalation critical; any allowed `execute` path → allow-everything critical; same-signer-weaker-policy overlaps on a target (EC-S15); owner's own stronger rules are **not** flagged (threat model is S, EC-S14).
  5. For each BYPASS, attach a recommendation (`remove_rule`/`expire_rule`/`raise_threshold`/`manual_review`) — but rules on `intent.preserve` (owner recovery) are never auto-remove-recommended; a preserve-conflict is a **blocking warning** instead (Vol 09).
  6. `exhaustive = true` iff every `(r,c)` was classified without an enumeration failure; any gap sets it false and lists the gap.
- **Proof form:** the report is a finite `rules × contexts` case analysis; "SAFE overall" means every case is ¬BYPASS with known semantics.
- **Edge cases:** EC-G04, A05, A06, A07, S14, S15, plus admin-context detection (Vol 02 §2.3.4/5).
- **Tests:** `T-D4.1-1` fork: planted permissive Default rule satisfiable by agent → BYPASS with path + critical; `T-D4.1-2` unit: owner N-of-N rule not satisfiable by agent → SAFE, not flagged; `T-D4.1-3` unit: same agent signer in old broad rule → BYPASS + remove recommendation; `T-D4.1-4` unit: unknown policy → UNKNOWN (never SAFE); `T-D4.1-5` unit: call_contract(self) rule for agent → admin-escalation critical; `T-D4.1-6` fork: upgraded policy hash mismatch → downgraded to UNKNOWN; `T-D4.1-7` unit: preserve-listed rule conflict → blocking warning not auto-remove; `T-D4.1-8` unit: exhaustive=false when a rule can't be classified.

### FN-D4.2 `classifyRuleAgainstContext(rule, context, S, deps)`
- Pure/symbolic core (+ optional fork probe hook). Isolated for exhaustive unit testing of the truth table. Tests `T-D4.2-*` enumerate: no-policy⊆S, no-policy⊄S, threshold met/unmet, spending-cap permitted-capped, arg-guard admits/denies, unknown→UNKNOWN.

---

## 6. The repair/verify loop (how D1–D3 compose in Tier-3)

```
generate_policy_code (C3)
  → compile-policy(check)   ──fail──▶ AI patches inside markers ──▶ (≤5×) ──fail──▶ E_BUILD_COMPILE_FAILED (stop)
  → compile-policy(lint,build)
  → generate-tests
  → run-simulation(unit,fork) ──failures──▶ report which case failed
        (a compile-clean but semantically wrong policy is caught HERE, not shipped)
  → detect-bypass
  → (all green + bypass handled) ──▶ eligible for E1
```
The loop never edits outside generated markers, never runs with network, and never advances to a plan on non-green simulation or unhandled BYPASS — the hash chain (Vol 02 §11) makes skipping mechanically impossible (E1 refuses without fresh matching report hashes, EC-T03).

## 7. Self-checklist

- [x] Sandbox runtime contract (offline, jailed, timeouts, marker diff-guard, WSL relocation) fully specified with tests.
- [x] Mutation battery enumerated; coverage gap is a hard error, not a silent hole (INV-Test-1).
- [x] Fork engine is the verification of record; testnet is best-effort/skippable (EC-R08/M05); missing footprint ≠ denial (EC-M02).
- [x] Bypass detection is a decidable finite case analysis with fail-closed UNKNOWN (INV-Bypass-1) and preserve-list protection.
- [x] Compile repair loop bounded and marker-guarded (EC-B04); semantic errors caught by D3 not D1.
- [x] Every FN has tests-first; all EC/FN/T refs consistent with Vols 02–07, 10.
