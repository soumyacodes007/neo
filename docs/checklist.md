# Volume 13 — Phase-by-Phase Implementation Checklist

**Purpose.** A build-order checklist that re-cuts the Vol 11 roadmap (milestones M0–M5) into **10 sequential phases**. For each phase this volume answers three questions only:

1. **Build** — which functions/artifacts to implement, and **which volume is the reference spec** for them.
2. **Test** — which tests must be written **first** (red), then made green, and **which volume defines them**.
3. **Gate** — the exit condition that must hold before the next phase starts.

This volume adds no new specs. Every `FN-`, `T-`, `EC-`, `WI-` ID resolves to Vols 03–12; when in doubt, the linked volume is authoritative. Phases are strictly ordered — each depends on the artifacts of the one before. Within a phase, sub-items may proceed in parallel unless a dependency arrow (`→`) is shown.

**How to read a row.** *Build item* → *reference volume* — *the tests that gate it* → *reference volume*. Nothing is "done" until its named tests are green at the coverage gate (Vol 11 §Coverage & quality gates).

**Test-first is literal.** For every build item, author its `T-` tests from the reference volume **before** the implementation, confirm they fail, implement, confirm they pass. CI enforces coverage: `core` 95%, other TS packages 85%, ScVal bridge 100% branch, Rust ≥90% lines (Vol 01 §2.8, Vol 11).

---

## Phase → milestone map (orientation)

| Phase | Theme | Rolls up | Parent acceptance |
|------|-------|----------|-------------------|
| 0 | Foundation: repo, CI, schemas, hashing | M0.E1–E2 | — |
| 1 | Stellar integration core (decode/digest) | M0.E3 | — |
| 2 | Fixtures + inspection tools (A1–A4) | M0.E4 | M0 exit |
| 3 | Intent + synthesis, OZ primitives (B2,B3,C1,C2) | M1.E1 | — |
| 4 | Verify + plan, Tier 1 end-to-end (D0–D3,E1–E3) | M1.E2 | **#1** |
| 5 | History, evidence, bypass detection (B1,D4,E1-seq) | M2 | **#2** |
| 6 | pb policy library in Rust (pb_*) | M3.E1 | — |
| 7 | Codegen + example-driven synthesis + bypass v2 (C3,C1.3,D4v2) | M3.E2 | **#3** |
| 8 | Wallet integration + skill + walkthroughs (F1) | M4 | M4 exit |
| 9 | Production hardening: audit, mainnet, release | M5 | M5 exit |

---

## Phase 0 — Foundation (repo, CI, schemas, hashing)

**Reference volumes:** Vol 01 (standards, CI), Vol 02 (schemas, hashing).

**Build**
- [ ] Monorepo scaffold — pnpm workspace, `tsconfig.base` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), eslint flat strict, vitest, tsup, package boundaries. **Ref: Vol 01 §1–2.** *(WI-0.1)*
- [ ] CI pipeline jobs 1–6 incl. cross-ref integrity (dangling `EC-/FN-/T-/SCH-`) + secret grep-guard. **Ref: Vol 01 §4.2.** *(WI-0.2)*
- [ ] `core/canonical.ts` — canonical JSON + hashing utility (the hash chain's root). **Ref: Vol 02 §11.** *(WI-0.3)*
- [ ] All zod schemas + branded primitives + schema-version machinery; zod→JSON-Schema export for MCP registration. **Ref: Vol 02 (all `SCH-`, `INV-`).** *(WI-0.4)*

**Test (write first)**
- [ ] `T-ci.boundaries`, `T-ci.strict-tsconfig` — forbidden import fails lint; a `number` amount fails typecheck. **Ref: Vol 11 / Vol 01.**
- [ ] `T-ci.xref` (dangling `EC-Z99` fails), `T-ci.secret-grep-guard` (planted `S…` key fails, EC-T04). **Ref: Vol 11.**
- [ ] `T-core-canon-1..4` — idempotence, key-order independence, exclusion, determinism. **Ref: Vol 02 §11.**
- [ ] `T-core.amount-i128-bounds` (EC-X07), `T-core.range-nonneg` (EC-S11), per-schema invariant tests incl. **INV-CR-3** (spending_limit misuse rejected) and **INV-Intent-3** (missing provenance rejected). **Ref: Vol 02.**

**Gate:** `tsc -b` + lint + vitest green in CI; every enforceable `INV-` has a passing test; schema export produces valid MCP `inputSchema`/`outputSchema`.

---

## Phase 1 — Stellar integration core

**Reference volume:** Vol 03 (all `FN-ST.*`).

**Build**
- [ ] `RpcClient` FN-ST.1–7 — budget, torn-read retry, archived classification, tx-status distinction, pagination dedup, window-exceeded. **Ref: Vol 03.** *(WI-0.5)*
- [ ] XDR pipeline FN-ST.9–13 + **ScVal bridge FN-ST.14** + ledger-key construction FN-ST.15–17. **Ref: Vol 03.** *(WI-0.6)*
- [ ] Digest + AuthPayload builder FN-ST.18–21 (`sha256(payload ‖ context_rule_ids.to_xdr())`). **Ref: Vol 03; digest formula Vol 00 glossary.** *(WI-0.7)*
- [ ] HistoryProvider interface + RPC adapter + merging FN-ST.8 (Hubble/expert deferred to Phase 5). **Ref: Vol 03.** *(WI-0.8)*

**Test (write first)**
- [ ] `T-ST.1-*…T-ST.7-*` cassette tests (budget, torn read, archived, status, pagination, window-exceeded). **Ref: Vol 03.**
- [ ] `T-ST.9-*…T-ST.17-*` incl. ScVal round-trip property `T-ST.14-1`, fee-bump/multi-op/meta-version goldens, **fixture-account golden `T-ST.15-3`** (pins the `[inference]` enum ScVal encoding). **Ref: Vol 03; corpus in Vol 11 fixtures.**
- [ ] `T-ST.18-2` (fork: correct digest authenticates), `T-ST.18-3` (wrong preimage fails, EC-G01), `T-ST.20-*` (rule-id alignment). **Ref: Vol 03.**
- [ ] `T-ST.8-*` — window-exceeded + partial-flag semantics. **Ref: Vol 03.**

**Gate:** ScVal bridge **100% branch** coverage; XDR golden corpus reviewed by hand once; a digest built by FN-ST.18 authenticates on the fixture account in a fork test.

---

## Phase 2 — Fixtures + inspection tools (A1–A4)

**Reference volume:** Vol 04 (`FN-A1.*–A4.*`); Vol 03 for the RPC/ledger-key calls used.

**Build**
- [ ] `fixtures-deploy` — idempotent deploy of the OZ account + mock SEP-41 token + verifier from `examples/multisig-smart-account` (EC-M05). **Ref: Vol 11 fixtures inventory.** *(WI-0.9)* → prerequisite for the golden tests below.
- [ ] A1 `inspect-account` — enumerate rules (`NextId`+`ContextRuleData(i)`), resolve signers/policies, classify by **WASM hash** (not name), fingerprint non-OZ accounts (EC-A03), detect admin/recovery paths. **Ref: Vol 04.** *(WI-0.10)*
- [ ] A2 `inspect-rule`, A3 `lookup-transactions`, A4 `trace-transaction` (the deterministic recorder). **Ref: Vol 04.** *(WI-0.10)*

**Test (write first)**
- [ ] `T-fixtures.redeploy` — fixtures reconstruct after a testnet reset. **Ref: Vol 11.**
- [ ] `T-A1.*` (fingerprint + non-OZ rejection EC-A03, torn/gap read, admin paths), `T-A2.*` (health, dormant), `T-A3.*` (window/partial/dedup), `T-A4.*` (fee-bump unwrap, sub-invocation tree, failed-tx, lossless decode). **Ref: Vol 04.**
- [ ] Full-snapshot golden for the fixture account; recorder golden for a Blend-shaped tx. **Ref: Vol 04 / Vol 11.**

**Gate (M0 exit):** `inspect-account` and `trace-transaction` produce golden-matched output against the fixture; digest round-trips on a fork; CI green incl. cross-ref + secret guards.

---

## Phase 3 — Intent + synthesis (OZ primitives only)

**Reference volumes:** Vol 05 (B2–B3), Vol 06 (C1–C2), Vol 02 (`PolicyIntent`, Constraint IR, `CandidateRuleset`).

**Build**
- [ ] B2 `interface-lookup` FN-B2.1 — SAC fixed SEP-41 + WASM contractspec parse; correct arg-index selection (fixes Tyler's "3 args of any type"). **Ref: Vol 05.** *(WI-1.1)*
- [ ] B3 `parse-intent` FN-B3.1–4 — the **anti-hallucination gate**: provenance/existence/symbol/decimals/expiry/contradiction checks; `clarifications_needed[]`, stable `intent_hash`. **Ref: Vol 05.** *(WI-1.2)*
- [ ] C1 `synthesize-ruleset` (intent-guided) FN-C1.1–2 — `call_contract` rules only (never Default), generalization lattice L1–L4, minimal closure. **Ref: Vol 06 §1–2.** *(WI-1.3)*
- [ ] C2 `match-policies` FN-C2.1–3 — OZ primitives + `none_needed` + decision table; pb routing stubs mark `requires_codegen`/pending. **Ref: Vol 06 §3.** *(WI-1.4)*

**Test (write first)**
- [ ] `T-B2.1-*` incl. SAC fixed interface + hostile-name fencing (EC-T05). **Ref: Vol 05.**
- [ ] `T-B3.1-*` — the full anti-hallucination battery (provenance, existence, symbol confirm EC-S06, decimals, expiry bounds, contradiction). **Ref: Vol 05.**
- [ ] `T-C1.1-1` (Tier-1 golden), `T-C1.1-4` (no Default ever), `T-C1.1-5` (determinism ×3), `T-C1.2-*` (lattice). **Ref: Vol 06.**
- [ ] `T-C2.1-1` (transfer cap → `spending_limit`), `T-C2.1-2` (Blend cap **NOT** spending_limit — routes to pb), `T-C2.3-*` (install-param pre-validation), EC-S02 overreach blocked. **Ref: Vol 06.**

**Gate:** `synthesize-ruleset` byte-identical across 3 runs on the same inputs; spending_limit overreach structurally impossible (INV-CR-3 + EC-S02 tests green); intent normalizes to a stable hash.

---

## Phase 4 — Verify + plan (Tier 1 end-to-end)

**Reference volumes:** Vol 08 (D0–D3), Vol 09 (E1–E3), Vol 07 (only the pb *contract references* the sandbox compiles — full pb build is Phase 6).

**Build**
- [ ] D0 sandbox runner + pinned Docker image (offline, jailed, marker diff-guard) FN-D0.1 → D1 `compile-policy` FN-D1.1 (bounded repair loop). **Ref: Vol 08 §1–2.** *(WI-1.5)*
- [ ] D2 `generate-tests` FN-D2.1–4 — deterministic allow set + mutation battery (wrong fn/contract/token, amount+ε, over-window, expired, wrong signer, arg tamper). **Ref: Vol 08 §3.** *(WI-1.6)*
- [ ] D3 `run-simulation` FN-D3.1 — unit + fork engines + replay; snapshot builder FN-ST.23–24 wired. **Ref: Vol 08 §4; Vol 03 snapshot.** *(WI-1.7)*
- [ ] E1 `prepare-install-plan` + E2 `prepare-revocation-plan` + E3 `explain-policy` FN-E1.*/E2.1/E3.*. **Ref: Vol 09 §1–3.** *(WI-1.8)*

**Test (write first)**
- [ ] `T-D0.1-*` (offline, timeout, marker guard, WSL relocation), `T-D1.1-*` (compile diagnostics, repair bound). **Ref: Vol 08.**
- [ ] `T-D2.1-*` (Tier-1 case set both polarities, coverage-gap error, zero-amount pass, expiry boundary). **Ref: Vol 08.**
- [ ] `T-D3.1-1..6` (all-green Tier-1; 501 denied `#3221` / 500 allowed; missing-footprint→error; spending_limit-misuse denies; deny-pass→failures; replay). **Ref: Vol 08.**
- [ ] `T-E1.1-1..8` (gate on fresh reports, token **not** in schema, threshold ordering, preserve honored, plan-hash stable under resource changes, per-step fork sim); `T-E3.1-*` (hostile-name fencing, full addresses, risk completeness). **Ref: Vol 09.**

**Gate (M1 exit = parent acceptance #1):** from the Tier-1 prompt (Walkthrough A, Vol 12), a plan whose fork sim shows the 500 USDC/day cap enforced, Blend-only, 7-day expiry, working revocation — **no install performed**; E1 refuses without a fresh green sim.

---

## Phase 5 — History, evidence, bypass detection

**Reference volumes:** Vol 03 (Hubble/expert adapters), Vol 05 (B1), Vol 08 (D4), Vol 09 (E1 sequencing, E3 diff).

**Build**
- [ ] Hubble adapter + stellar.expert fallback (FN-ST.8 family) with freshness labels (EC-R04). **Ref: Vol 03.** *(WI-2.1)*
- [ ] B1 `extract-auth-contexts` FN-B1.1–2 — multi-tx evidence, sub-invocation contexts, polarity guard (EC-S03). **Ref: Vol 05.** *(WI-2.2)*
- [ ] C1 evidence/closure mode (FN-C1.1 evidence path) — minimal closure, interface-drift split (EC-S07), no-evidence error (EC-S09). **Ref: Vol 06.** *(WI-2.3)*
- [ ] D4 `detect-bypass` **v1** FN-D4.1–2 — no-policy rules + OZ-known + pb-known symbolic; fail-closed UNKNOWN. **Ref: Vol 08 §5.** *(WI-2.4)*
- [ ] E1 removal sequencing (remove-after-install, drift order) + E3 policy diff FN-E3.2. **Ref: Vol 09 §1 ordering laws.** *(WI-2.5)*

**Test (write first)**
- [ ] `T-ST.hub-*`, `T-ST.exp-*` cassettes + freshness (EC-R04); 30-day window resolves or errors with a coverage report (EC-R01). **Ref: Vol 03.**
- [ ] `T-B1.1-*` — Blend+USDC workflow reconstructed from a 30-day fixture (golden). **Ref: Vol 05.**
- [ ] `T-C1.1-2` (no over-generalization). **Ref: Vol 06.**
- [ ] `T-D4.1-1..8` — planted Default BYPASS, owner-rule not flagged, same-signer-weaker, **UNKNOWN-never-SAFE**, admin-escalation, upgraded-hash→UNKNOWN, preserve-conflict, exhaustive flag. **Ref: Vol 08.**
- [ ] `T-E1.1-4/5`, `T-E3.2-*` — threshold ordering, preserve never removed, diff table. **Ref: Vol 09.**

**Gate (M2 exit = parent acceptance #2):** seeded 30-day account + planted permissive Default rule → workflow reconstructed exactly (golden), planted rule flagged **BYPASS** with the concrete path, plan expires it, owner rule untouched.

---

## Phase 6 — pb policy library (Rust)

**Reference volume:** Vol 07 (all four pb contracts); Vol 01 §Rust standards (OZ code-quality checklist).

**Build**
- [ ] `pb_function_allowlist` (Vol 07 §1) — error range 3300–3319. *(WI-3.1)*
- [ ] `pb_arg_guard` (Vol 07 §2) — path resolution + `∀`; error range 3320–3339. *(WI-3.2)*
- [ ] `pb_call_cap` (Vol 07 §3) — rolling cap over `(fn, arg_path)`; error range 3340–3359. *(WI-3.3)*
- [ ] `pb_rate_limit` (Vol 07 §4) — N calls/window; error range 3360–3379. *(WI-3.4)*
- [ ] Composition + classification registry: register pb WASM hashes for A1; Blend rule with 3 pb policies. **Ref: Vol 07 composition; Vol 04 A1 classification.** *(WI-3.5)*

**Test (write first)**
- [ ] `T-P.allow-*` full battery. **Ref: Vol 07 §1.**
- [ ] `T-P.arg-*` incl. **`T-P.arg-path-parity`** (shares fixtures with FN-ST.22 — TS/Rust path resolution parity). **Ref: Vol 07 §2.**
- [ ] `T-P.callcap-*` (window boundary, 1000-entry history cap, double-context, i128 overflow, token filter). **Ref: Vol 07 §3.**
- [ ] `T-P.rate-*`. **Ref: Vol 07 §4.**
- [ ] `T-P.compose-blend-submit` (fork) — Blend rule with 3 pb policies enforces. **Ref: Vol 07 / Vol 11.**

**Gate:** each crate ≥90% lines (`cargo llvm-cov --fail-under-lines 90`), clippy `-D warnings`, nightly fmt, wasm32v1-none builds; A1 classifies pb policies by hash; TS/Rust path-resolution parity proven.

---

## Phase 7 — Codegen + example-driven synthesis + bypass v2

**Reference volumes:** Vol 06 §4 (C3 codegen, C1.3 example-driven), Vol 08 §5 (D4 v2).

**Build**
- [ ] C3 `generate-policy-code` + templates FN-C3.1–3 — fenced markers, `codegen_manifest` maps each check to a constraint, no build.rs, slug-sanitized names. **Ref: Vol 06 §4.** *(WI-3.6)*
- [ ] C1 example-driven mode + unsatisfiability FN-C1.3 — allow-closure over positives, tighten against negatives, honest `E_UNSATISFIABLE_BY_CONTEXT` on indistinguishable pairs. **Ref: Vol 06.** *(WI-3.7)*
- [ ] D4 v2 (pb-aware symbolic + fork probing of unknown policies) + D1 repair-loop hardening. **Ref: Vol 08 §5.** *(WI-3.8)*

**Test (write first)**
- [ ] `T-C3.1-*` — compiles in sandbox, slug-sanitized, no build.rs, manifest maps regions, unexpressible→error, fenced markers respected. **Ref: Vol 06.**
- [ ] `T-C1.3-*` — 12/8 separation, identical-pair `E_UNSATISFIABLE_BY_CONTEXT`, amount-boundary discriminator. **Ref: Vol 06.**
- [ ] `T-D4.1-6` (fork probe), repair-loop bound `T-D1.1-3`. **Ref: Vol 08.**

**Gate (M3 exit = parent acceptance #3):** 12 allow / 8 deny corpus → synthesized set passes 12 / denies 8 in fork sim; a fixture pair triggers `E_UNSATISFIABLE_BY_CONTEXT`; generated policy compiles clean (`clippy -D warnings`) with a constraint-mapped manifest.

---

## Phase 8 — Wallet integration, skill, walkthroughs

**Reference volumes:** Vol 09 §4 (F1), Vol 00 §3.3 (skill grammar + hard rules), Vol 12 (walkthroughs).

**Build**
- [ ] F1 `submit-plan` FN-F1.1 — approval-gated, `--enable-submit` off by default; disk-loaded hash-chain re-verify, constant-time token compare, live pre-flight, resumable idempotent steps; `direct` + `relayer` transports. **Never signs.** **Ref: Vol 09 §4.** *(WI-4.1)*
- [ ] smart-account-kit integration: record→generate→simulate→sign→install on testnet. **Ref: Vol 09 §4; parent §2.4.** *(WI-4.1)*
- [ ] Claude skill package — tool grammar + hard rules (never submit without quoted token; always run verification). **Ref: Vol 00 §3.3.** *(WI-4.2)*
- [ ] Three documented walkthroughs (Blend / SEP-41 subscription / Soroswap) runnable from a clean checkout. **Ref: Vol 12.** *(WI-4.3)*

**Test (write first)**
- [ ] `T-F1.1-1..10` — disabled→gate-first no side effects, wrong token, tampered artifact, expired plan, account-upgraded blocked, network mismatch, resume skips satisfied predicate, auth-expired re-sign gate, **`T-F1.1-9` @network E2E testnet install**, irreversible-step extra phrase. **Ref: Vol 09.**
- [ ] Skill conformance tests — never calls submit without token; always runs verification chain. **Ref: Vol 11 / Vol 00 §3.3.**
- [ ] Walkthrough integration assertions (Vol 12 cross-walkthrough table). **Ref: Vol 12.**

**Gate (M4 exit):** a real testnet install of a Tier-1 grant via the wallet, token-gated; skill drives all three tiers; each walkthrough reproducible from `docker pull` + `pnpm install`.

---

## Phase 9 — Production hardening

**Reference volumes:** Vol 09 §5 (threat model), Vol 01 (release/versioning), Vol 07 (pb upstream), Vol 11 (canaries).

**Build**
- [ ] Security audit of synthesizer + pb templates + generated-code templates; remediate findings (RFP requirement). *(WI-5.1)*
- [ ] OZ maintainer review loop for the pb library; open upstream PR(s). **Ref: Vol 07.** *(WI-5.2)*
- [ ] Mainnet enablement behind flags; rate limits; telemetry-free logging; threat-model doc. **Ref: Vol 09 §5.** *(WI-5.3)*
- [ ] Versioned server endpoint + Agent-skill packaging; determinism + protocol canaries. *(WI-5.4)*

**Test (write first)**
- [ ] `T-ci.determinism` — golden `synthesize-ruleset` corpus byte-identical across runs. **Ref: Vol 11.**
- [ ] `T-ci.protocol-canary` (EC-M04) — MCP protocol regression tripwire. **Ref: Vol 11.**
- [ ] Every `E_*` code has ≥1 test proving it fires on its documented condition (audit sweep). **Ref: Vol 01 §5 / Vol 11.**

**Gate (M5 exit):** audit report + fixes landed; upstream feedback incorporated; mainnet path gated + documented; release cut (Apache-2.0) + SCF submission package.

---

## Cross-phase invariants (must hold from Phase 0 onward)

These are not phase-scoped — every phase's CI enforces them:

- [ ] **No hallucinated facts** — every synthesized constraint carries provenance (INV-Intent-3); the AI never produces a fact a tool should (Vol 09 §5).
- [ ] **Determinism** — decode→plan is deterministic given pinned inputs; golden corpus byte-identical (Vol 00 §3.5, Vol 11).
- [ ] **No secrets in schemas** — CI grep-guard; F1 accepts signed XDR only (EC-T04).
- [ ] **Fail-closed** — unknown policy/verifier/ScVal → UNKNOWN, never SAFE (Vol 08 §5, Vol 03 ScVal bridge).
- [ ] **No install without approval** — F1 gated on `--enable-submit` + disk hash-chain + human-quoted token (Vol 09 §4).
- [ ] **Cross-ref integrity** — no dangling `EC-/FN-/T-/SCH-` IDs (CI job `T-ci.xref`).

## Self-checklist

- [x] 10 phases (0–9), each mapped to Vol 11 milestones/WIs and, where applicable, a parent acceptance criterion.
- [x] Every phase states **Build (+ reference volume)**, **Test-first (+ reference volume)**, and an exit **Gate**.
- [x] All `FN-/T-/EC-/WI-` IDs resolve to Vols 03–12; no new specs introduced here.
- [x] Cross-phase invariants pulled out so they're enforced from Phase 0, not deferred.
