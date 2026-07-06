# Volume 11 — Roadmap & Testing (test-first)

The build sequence: milestone → epic → work item (`WI-`) → the functions it delivers → **the tests that must exist before those functions are written**. Test-first is literal here: each WI's "Definition of Done" requires its named tests (from Vols 03–09) to be authored and red before implementation, then green after, at the coverage gate.

Milestones map to the parent plan (M0–M5). Estimates are relative sizing (S/M/L/XL), not calendar dates.

Legend: WI status ⬜ pending; each WI lists `delivers` (FN IDs), `tests-first` (T IDs — must be red first), `DoD`.

---

## M0 — Skeleton + Recorder (proves deterministic decode)

Goal: a running MCP server that can inspect an OZ account and decode transactions, with golden-tested XDR handling. No synthesis yet.

**Epic M0.E1 — Repo & CI foundation.**
- **WI-0.1** (M) Monorepo scaffolding: pnpm workspace, `tsconfig.base`, eslint flat strict config, vitest, tsup, package boundaries (Vol 01 §1–2). *Delivers:* project skeleton. *Tests-first:* `T-ci.boundaries` (import-rule lint fails on a forbidden import), `T-ci.strict-tsconfig` (a `number` amount fails typecheck). *DoD:* `tsc -b` + lint + empty vitest green in CI.
- **WI-0.2** (M) CI pipeline jobs 1–6 (Vol 01 §4.2) incl. the cross-ref integrity script (grep dangling EC/FN/T/SCH). *Tests-first:* `T-ci.xref` (a doc with a dangling `EC-Z99` fails the job), `T-ci.secret-grep-guard` (a planted `S...` key fails, EC-T04). *DoD:* all six jobs run on PR.
- **WI-0.3** (S) Canonical JSON + hashing (`core/canonical.ts`, Vol 02 §11). *Delivers:* hashing utility. *Tests-first:* `T-core-canon-1..4` (idempotence, key-order independence, exclusion correctness, determinism). *DoD:* property tests green.

**Epic M0.E2 — Schemas.**
- **WI-0.4** (L) All Vol 02 zod schemas + branded primitives + version machinery. *Delivers:* `SCH-*`. *Tests-first:* `T-core.amount-i128-bounds` (EC-X07), `T-core.range-nonneg` (EC-S11), per-schema invariant tests (INV-CR-3 refinement rejects spending_limit misuse; INV-Intent-3 rejects missing provenance). *DoD:* every INV with an enforceable check has a test; schema→JSON-Schema export works for MCP registration.

**Epic M0.E3 — Stellar integration core.**
- **WI-0.5** (L) `RpcClient` (FN-ST.1–7) with cassette tests. *Tests-first:* `T-ST.1-*`..`T-ST.7-*` (budget, torn-read retry, archived classification, tx status distinction, pagination dedup, window-exceeded). *DoD:* cassettes committed; torn-read + window-exceeded paths covered.
- **WI-0.6** (XL) XDR pipeline (FN-ST.9–13) + ScVal bridge (FN-ST.14) + ledger keys (FN-ST.15–17). *Tests-first:* `T-ST.9-*`..`T-ST.17-*` incl. the ScVal round-trip property (`T-ST.14-1`), fee-bump/multi-op/meta-version goldens, and the **fixture-account golden** (`T-ST.15-3`) pinning the `[inference]` enum ScVal encoding. *DoD:* golden corpus reviewed; ScVal bridge 100% branch coverage.
- **WI-0.7** (M) Digest + payload builder (FN-ST.18–21). *Tests-first:* `T-ST.18-2` (fork: correct digest authenticates), `T-ST.18-3` (wrong preimage fails with diagnostic, EC-G01), `T-ST.20-*` (rule-id alignment). *DoD:* a signature built with FN-ST.18 authenticates on the fixture account in a fork test.
- **WI-0.8** (M) HistoryProvider interface + RPC adapter + merging (FN-ST.8). *Tests-first:* `T-ST.8-*`. *DoD:* window-exceeded + partial-flag semantics tested. (Hubble/expert adapters deferred to M2.)

**Epic M0.E4 — Fixtures & inspection.**
- **WI-0.9** (M) Deploy the fixture OZ account + mock token + verifier from `examples/multisig-smart-account`; idempotent `fixtures-deploy` script (EC-M05). *Tests-first:* `T-fixtures.redeploy`. *DoD:* fixtures reconstruct after a testnet reset.
- **WI-0.10** (L) Tools A1–A4 (FN-A1.*–A4.*). *Tests-first:* `T-A1.*` (fingerprint incl. non-OZ rejection EC-A03, torn/gap, admin paths), `T-A2.*` (health, dormant), `T-A3.*` (window/partial/dedup), `T-A4.*` (fee-bump, sub-invocation, failed-tx, losslessness). *DoD:* full snapshot golden for the fixture; recorder golden for a Blend-shaped tx.

**M0 exit criteria:** `inspect-account` and `trace-transaction` produce golden-matched outputs against the fixture; the digest round-trips on a fork; CI green including cross-ref + secret guards.

---

## M1 — Tier 1 (intent → verified plan, OZ primitives only)

Goal: end-to-end for the transfer-cap case (Pollywallet-equivalent, no codegen).

**Epic M1.E1 — Intent & synthesis (primitives only).**
- **WI-1.1** (L) B2 `interface-lookup` (SAC + WASM spec) (FN-B2.1). *Tests-first:* `T-B2.1-*` incl. SAC fixed interface + hostile-name fencing. *DoD:* returns SEP-41 for native SAC.
- **WI-1.2** (XL) B3 `parse-intent` (FN-B3.1–4). *Tests-first:* `T-B3.1-*` (provenance/existence/symbol/decimals/expiry/contradiction), the full anti-hallucination battery. *DoD:* Tier-1 intent normalizes to a stable `intent_hash`; every gate tested.
- **WI-1.3** (XL) C1 `synthesize-ruleset` (intent-guided, FN-C1.1–2). *Tests-first:* `T-C1.1-1` (Tier-1 golden), `T-C1.1-4` (no Default), `T-C1.1-5` (determinism), `T-C1.2-*` (lattice). *DoD:* byte-identical ruleset across 3 runs.
- **WI-1.4** (L) C2 `match-policies` (OZ primitives + none_needed + decision table; pb routing stubs) (FN-C2.1–3). *Tests-first:* `T-C2.1-1` (transfer cap → spending_limit), `T-C2.1-2` (Blend cap NOT spending_limit — routes to pb, even if pb not built yet, as `requires_codegen`/pending), `T-C2.3-*` (pre-validation). *DoD:* spending_limit overreach structurally blocked (EC-S02 test green).

**Epic M1.E2 — Verification (unit+fork) & planning.**
- **WI-1.5** (XL) Sandbox runner + image (FN-D0.1) and D1 `compile-policy` (FN-D1.1). *Tests-first:* `T-D0.1-*` (offline, timeout, marker guard, WSL relocation), `T-D1.1-*`. *DoD:* fixture policy compiles in-image offline; repair loop bounded.
- **WI-1.6** (L) D2 `generate-tests` incl. mutation battery (FN-D2.1–4). *Tests-first:* `T-D2.1-*` (Tier-1 case set, coverage-gap error, zero-amount pass, expiry boundary). *DoD:* every constraint covered both polarities.
- **WI-1.7** (L) D3 `run-simulation` unit+fork engines + replay (FN-D3.1). *Tests-first:* `T-D3.1-1..6` (all-green Tier-1; 501 denied / 500 allowed; missing-footprint=error; spending_limit-misuse-denies; deny-passes→failures; replay). *DoD:* Tier-1 ruleset all-green; snapshot builder (FN-ST.23–24) wired.
- **WI-1.8** (L) E1/E2/E3 (FN-E1.*, E2.1, E3.*). *Tests-first:* `T-E1.1-*` (gate on fresh reports, token not in schema, ordering, plan-hash stability), `T-E3.1-*` (fencing, full addresses, risk completeness). *DoD:* Tier-1 produces plan + revocation + explanation; refuses without green sim.

**M1 exit criteria (matches parent acceptance #1):** from the Tier-1 prompt, a plan whose fork sim shows 500-cap enforced, Blend-only, 7-day expiry, working revocation — **no install performed**.

---

## M2 — Tier 2 (history-driven, bypass detection)

**Epic M2.E1 — Deep history.**
- **WI-2.1** (L) Hubble adapter (FN-ST.8 family) + stellar.expert fallback. *Tests-first:* `T-ST.hub-*`, `T-ST.exp-*` (cassettes) + freshness labels (EC-R04). *DoD:* 30-day window resolves or errors with a coverage report (EC-R01).
- **WI-2.2** (M) B1 `extract-auth-contexts` (FN-B1.1–2) — multi-tx evidence, sub-invocation contexts, polarity guard. *Tests-first:* `T-B1.1-*`. *DoD:* Blend+USDC workflow reconstructed from a 30-day fixture (golden).

**Epic M2.E2 — Evidence synthesis + bypass.**
- **WI-2.3** (L) C1 evidence/closure mode (FN-C1.1 evidence path). *Tests-first:* `T-C1.1-2` (no over-generalization), interface-drift split (EC-S07), no-evidence error (EC-S09). *DoD:* minimal closure over observed contexts.
- **WI-2.4** (XL) D4 `detect-bypass` v1 (no-policy rules + OZ-known + pb-known symbolic) (FN-D4.1–2). *Tests-first:* `T-D4.1-1..8` (planted Default BYPASS, owner-rule-not-flagged, same-signer-weaker, UNKNOWN-never-SAFE, admin-escalation, upgraded-hash→UNKNOWN, preserve-conflict, exhaustive flag). *DoD:* planted-permissive-rule scenario flagged with path; preserve list honored.
- **WI-2.5** (M) E1 removal sequencing + E3 policy diff (FN-E1.1 ordering, FN-E3.2). *Tests-first:* `T-E1.1-4/5`, `T-E3.2-*`. *DoD:* plan expires/removes the bypass rule, leaves owner rule untouched.

**M2 exit criteria (matches parent acceptance #2):** seeded 30-day account + planted permissive Default rule → workflow reconstructed exactly, planted rule flagged BYPASS, plan expires it, owner rule untouched.

---

## M3 — Parameterized policy library + Tier 3

**Epic M3.E1 — pb library (Rust).**
- **WI-3.1** (L) `pb_function_allowlist` (Vol 07 §1). *Tests-first:* `T-P.allow-*` full battery. *DoD:* ≥90% coverage, wasm builds, clippy clean.
- **WI-3.2** (XL) `pb_arg_guard` incl. path resolution + ∀ (Vol 07 §2). *Tests-first:* `T-P.arg-*` incl. `T-P.arg-path-parity` (shares fixtures with FN-ST.22). *DoD:* TS/Rust path resolution parity proven.
- **WI-3.3** (L) `pb_call_cap` (Vol 07 §3). *Tests-first:* `T-P.callcap-*` (window boundary, history cap, double-context, overflow, token filter). *DoD:* mirrors OZ spending_limit semantics + generalized amount source.
- **WI-3.4** (M) `pb_rate_limit` (Vol 07 §4). *Tests-first:* `T-P.rate-*`. *DoD:* battery green.
- **WI-3.5** (M) Composition + classification registry: `T-P.compose-blend-submit` (fork), WASM-hash registration for A1. *DoD:* Blend rule with 3 pb policies enforces on a fork; A1 classifies pb policies.

**Epic M3.E2 — Codegen + example-driven synthesis.**
- **WI-3.6** (L) C3 `generate-policy-code` + templates (FN-C3.1–3). *Tests-first:* `T-C3.1-*` (compiles, slug-sanitized, no build.rs, manifest maps regions, unexpressible→error, fenced markers). *DoD:* a simple custom guard compiles in-sandbox.
- **WI-3.7** (L) C1 example-driven mode + unsatisfiability (FN-C1.3). *Tests-first:* `T-C1.3-*` (12/8 separation, identical-pair unsat, amount-boundary discriminator). *DoD:* Tier-3 corpus separates; collisions reported honestly.
- **WI-3.8** (M) D4 v2 (pb-aware + fork probing of unknown policies) + D1 repair loop hardening. *Tests-first:* `T-D4.1-6` (fork probe), repair-loop bound `T-D1.1-3`. *DoD:* unknown policies probed or honestly UNKNOWN.

**M3 exit criteria (matches parent acceptance #3):** 12 allow / 8 deny → synthesized set passes 12 / denies 8 in fork sim; a fixture pair triggers `E_UNSATISFIABLE_BY_CONTEXT`; generated policy compiles clean with a constraint-mapped manifest.

---

## M4 — Demo & wallet integration

- **WI-4.1** (L) smart-account-kit integration through the Vol 14 browser companion bridge for record→generate→simulate→sign→install on testnet (F1 direct + relayer transports, FN-F1.1). *Tests-first:* `T-F1.1-*` incl. `T-F1.1-9` (@network E2E) plus `T-WB.*` bridge tests. *DoD:* a real testnet install of a Tier-1 grant via the wallet, gated by token.
- **WI-4.2** (M) Claude skill package (Vol 00 §3.3 grammar + hard rules). *Tests-first:* skill conformance tests (never calls submit without token; always runs verification). *DoD:* skill drives all three tiers.
- **WI-4.3** (L) Three documented walkthroughs (Vol 12). *DoD:* each runnable from a clean checkout (`docker pull` + `pnpm install`).

**M4 exit criteria:** end-to-end demo for all three tiers; walkthroughs reproducible.

---

## M5 — Production hardening

- **WI-5.1** (XL) Security audit of synthesizer + pb templates + generated-code templates (RFP requirement); remediate findings. *DoD:* audit report + fixes.
- **WI-5.2** (M) OZ maintainer review loop for pb library (upstream alignment). *DoD:* review feedback incorporated; upstream PR(s) opened.
- **WI-5.3** (M) Mainnet enablement behind flags; rate limits; telemetry-free logging; threat-model doc (Vol 09 §5). *DoD:* mainnet path gated + documented.
- **WI-5.4** (M) Versioned server endpoint + Agent-skill packaging; determinism canary (`T-ci.determinism`) + protocol canary (`T-ci.protocol-canary`, EC-M04). *DoD:* release cut, Apache-2.0, SCF submission package.

---

## Fixtures inventory (shared test assets)

| Fixture | Used by | Notes |
|---|---|---|
| OZ smart-account (from `examples/multisig-smart-account`) | ST.15/18, A1–A4, D3, F1 | deployed by `fixtures-deploy`; golden for enum ScVal encoding |
| Mock SEP-41 token + native SAC | B2, D3, pb tests | SAC exercises the no-WASM path (Tyler demo) |
| ed25519 + webauthn verifiers | A6, signer tests | known-hash registry entries |
| Blend-shaped `submit` tx corpus (success + failed) | A4, B1, C1, D2, pb compose | primary Tier-1/2 evidence |
| Tier-3 corpus: 12 allow + 8 deny txs | C1.3, D2, D3 | includes one intentionally colliding pair (unsat) |
| Hostile-string fixtures (rule names, token symbols, spec text) | T01/T02/T05 tests | prompt-injection battery |
| Ledger snapshots (account + Blend pool + tokens) | D3 fork, D4 | via `stellar snapshot create` |
| Planted permissive Default rule account | D4, M2 exit | the bypass scenario |
| XDR golden corpus (fee-bump, multi-op, meta V3/V4, SAC/custom events, opaque ScVal) | ST.9–14, A4 | reviewed by hand once |

## Coverage & quality gates (recap)

- TS: `core` 95% lines/branches, other packages 85%; ScVal bridge 100% branch (Vol 01 §2.8).
- Rust: ≥90% lines per crate (`cargo llvm-cov --fail-under-lines 90`); clippy `-D warnings`; nightly fmt; wasm32v1-none builds.
- Determinism: golden `synthesize-ruleset` corpus byte-identical across runs (CI job).
- Cross-ref integrity: no dangling EC/FN/T/SCH IDs (CI job).
- Every `E_*` code has ≥1 test proving it fires on its documented condition.

## Self-checklist

- [x] Milestones M0–M5 decomposed into epics → WIs → delivered FNs → tests-first → DoD.
- [x] Each milestone has explicit exit criteria; M1–M3 map to parent acceptance #1–#3.
- [x] Test-first is literal: WIs name red-first tests from Vols 03–09.
- [x] Fixtures inventory + coverage gates centralized.
- [x] All FN/T/EC references resolve to prior volumes.
