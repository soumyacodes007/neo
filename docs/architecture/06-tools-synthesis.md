# Volume 06 — Synthesis & Matching (C1–C3)

The core of the product: turn intent + evidence into a minimal, verifiable `CandidateRuleset`, prefer existing policies, and generate custom Rust only when nothing else fits. All of Group C is **pure and deterministic** — identical inputs yield a byte-identical `ruleset_hash` (parent acceptance criterion #4). No LLM inside these functions; the AI's only contribution (drafting intent) was already validated by B3.

Sections: the Constraint IR and the generalization lattice (§1), C1 synthesis incl. example-driven mode (§2), C2 matching (§3), C3 codegen (§4).

---

## 1. Constraint IR & the generalization lattice

### 1.1 IR recap

`SCH-Constraint` (Vol 02 §7) is the abstract language: `func_allowlist`, `arg_predicate` (`eq/in/range/addr_eq/addr_in` at an `arg_index` + optional `path`), `amount_cap` (token, cap, window, source), `rate_limit`, `threshold`, `expiry`. Every constraint carries `id` + `provenance[]`. Values are stored as **exact ScVal XDR** (`values_scval_b64`), never JSON approximations, so TS synthesis and Rust enforcement compare identical bytes (EC-X02, EC-S16).

### 1.2 The per-argument generalization lattice

For one `(contract, fn, arg_index[, path])`, the ordered lattice from most-specific to most-general:

```
eq(v)  ⊑  in{v1..vk}  ⊑  range[min,max]        (for ordered/numeric types)
eq(v)  ⊑  in{v1..vk}  ⊑  addr_in{...}  ⊑  any   (for address types)
eq(v)  ⊑  in{v1..vk}  ⊑  any                     (for enums/bytes)
opaque args: eq(v)  ⊑  any   ONLY  (no in/range — EC-X02)
```

Rules:
- **L1 (least general covering the positives):** the synthesized predicate is the *lowest* lattice point that admits every positive observation of that arg. One distinct value → `eq`; a small distinct set → `in`; numeric with spread → `range[observed_min, observed_max]` **only if intent authorizes a cap/range**, else stop at `in` or raise a clarification (EC-S04).
- **L2 (never jump to `any` for value-bearing args):** amounts, recipients, token addresses never generalize to `any` from evidence alone; `any` requires explicit user intent with provenance (EC-S04).
- **L3 (function allowlist):** the set of observed function names per contract is the allowlist; unobserved functions are excluded (minimality). "Use Blend" without a function list is a clarification (EC-U04), not `any function`.
- **L4 (context scope):** one `call_contract(target)` rule per distinct target contract; **never** `Default` (INV-CR-2/EC-S01). Sub-invocation targets get their own rules (EC-G07) — this is why Blend needs both the pool rule and the USDC rule.

### 1.3 Minimality objective (definition of "minimal safe policy")

The output is the lattice-minimal constraint set C such that: (a) every positive evidence context satisfies C; (b) every negative context and every mutation (Vol 08) violates C; (c) every constraint in C has provenance; (d) an `expiry` constraint is always present; (e) scope never exceeds `call_contract` of observed/stated targets. Ties broken deterministically by lattice rank then lexical constraint id.

---

## 2. C1 — `synthesize-ruleset`

**MCP contract.**
- Name: `synthesize-ruleset`. Safety: read-only / pure.
- Description: "Compute the minimal set of context rules and abstract constraints that permit exactly the intended/observed behavior and nothing more. Supports intent-only, evidence-guided, and positive/negative example modes. Deterministic. Returns a CandidateRuleset or an honest unsatisfiability error."
- Input: `{ intent: SCH-PolicyIntent, evidence?: SCH-AuthContextSet, negative_evidence?: SCH-AuthContextSet, examples?: { allow: SCH-AuthContextSet, deny: SCH-AuthContextSet }, account_snapshot?: SCH-AccountSnapshot }`.
- Output: `SCH-CandidateRuleset`.
- Errors: `E_UNSATISFIABLE_BY_CONTEXT`, `E_DOMAIN_NO_EVIDENCE`, `E_DOMAIN_COVERAGE_GAP`, `E_INPUT_HASH_MISMATCH`.

### FN-C1.1 `synthesizeRuleset(input, deps)`
- **Algorithm (dispatch by mode):**
  1. Verify hash chain: `evidence.evidence_hash`/`intent_hash` present and consistent; else `E_INPUT_HASH_MISMATCH`.
  2. **Group targets → rules:** one `CandidateRule` per distinct target contract (L4). Each rule's `signers = [intent.grantee.signer]` (plus `intent.quorum.of_signers` if a quorum was requested). Set `valid_until_ledger` from `intent.expiry` (+ current ledger) and add an `expiry` constraint (minimality (d)).
  3. **Per rule, synthesize constraints:**
     - `func_allowlist` = union of the target's functions from intent + evidence (L3).
     - For each function+arg with a constraint in intent or a stable observation in evidence, place the lattice-minimal `arg_predicate` (FN-C1.2). Intent constraints take precedence and set the ceiling; evidence tightens within it.
     - For each budget in intent, an `amount_cap` constraint with the right `source` (`transfer_arg2` for direct SEP-41 transfer caps; `call_arg{contract,fn,path}` for protocol-internal amounts like Blend `submit.requests[*].amount` — EC-S16).
     - `rate_limit`/`threshold` only if intent states them.
  4. **Example-driven refinement** (if `examples` present): run FN-C1.3 to find the discriminating constraint set; may tighten predicates below what intent alone implies, and reports collisions.
  5. **Coverage self-check:** every constraint must be exercised by ≥1 positive and ≥1 negative case in the (later) test set; C1 records which and flags `E_DOMAIN_COVERAGE_GAP` if a constraint is untestable (e.g. an arg that never varies) — surfaced as a clarification, not silently kept.
  6. **Minimality audit:** drop any constraint implied by another; ensure no constraint lacks provenance; ensure no `Default` (INV-CR-2).
  7. Compute `ruleset_hash`; attach `based_on` hashes; list any `unsatisfied` constraints (honest channel).
- **Edge cases:** EC-S01, S04, S05, S07, S08 (packing deferred to C2), S09, S16, G07, U04.
- **Tests:** `T-C1.1-1` golden: Tier-1 Blend intent → pool rule (func allowlist + expiry) + USDC rule (transfer cap + expiry), deterministic hash; `T-C1.1-2` unit: single observed transfer, no cap intent → clarification not `any` (EC-S04); `T-C1.1-3` unit: no evidence + no intent targets → `E_DOMAIN_NO_EVIDENCE`; `T-C1.1-4` unit: no Default emitted even when intent sloppy; `T-C1.1-5` property: rerun determinism (3× byte-identical); `T-C1.1-6` golden: Blend mixed-request submit → ∀ arg predicate on `request_type` + call_cap on `requests[*].amount` filtered by USDC (EC-S16); `T-C1.1-7` unit: coverage gap flagged.

### FN-C1.2 `synthesizeArgPredicate(argSummary, intentConstraint?)`
- **Purpose:** Pick the lattice-minimal predicate for one arg.
- **Algorithm:** if `intentConstraint` present, use it as the ceiling and verify evidence fits under it (else `E_INPUT_CONTRADICTION`-style report); from evidence, choose `eq` (1 value), `in` (small set ≤ `MAX_ENUM`), or `range` (numeric, only with cap authorization) per L1/L2; opaque args → `eq`/`any` only (EC-X02); addresses normalized (muxed, EC-X05); values stored as ScVal XDR.
- **Tests:** `T-C1.2-1` single value → eq; `T-C1.2-2` set → in; `T-C1.2-3` numeric w/ cap → range; `T-C1.2-4` numeric w/o cap → clarification; `T-C1.2-5` opaque → eq only.

### FN-C1.3 `synthesizeFromExamples(allow, deny)` (Tier-3 core)
- **Purpose:** Find the smallest constraint set separating positives from negatives; or prove it impossible at the context level.
- **Algorithm:**
  1. **Collision pre-check:** if any deny context is byte-identical (contract, fn, args ScVal) to any allow context → `E_UNSATISFIABLE_BY_CONTEXT` naming the exact colliding pair (EC-S05). Honest failure: no context-level policy can separate them; suggest a state-dependent custom policy or narrower intent.
  2. **Start from the allow-closure:** per-contract func allowlist + per-arg lattice-minimal predicate over all positives (FN-C1.2).
  3. **Discriminate:** for each negative not already excluded by the closure, tighten the offending arg one lattice step *downward* (more specific) if that still admits all positives, or add a discriminating predicate on an arg where positives and this negative differ. If no arg differs (only value magnitude), prefer a `range`/`amount_cap` boundary between max-positive and the negative.
  4. **Fixpoint:** repeat until all negatives excluded or a negative is indistinguishable (→ collision, step 1 recheck with tightened set).
  5. Emit the constraint set; record which negative each discriminator excludes (auditability).
- **Edge cases:** EC-S05 (unsat), S04 (don't over-generalize), S16 (vector ∀).
- **Tests:** `T-C1.3-1` golden: 12 allow / 8 deny → set passing all 12, denying all 8; `T-C1.3-2` unit: identical allow/deny pair → `E_UNSATISFIABLE_BY_CONTEXT` naming pair; `T-C1.3-3` unit: amount-only difference → cap boundary discriminator; `T-C1.3-4` property: synthesized set is closed under its own positives.

---

## 3. C2 — `match-policies`

Maps abstract constraints to concrete policies, strictly preferring existing primitives, then the pb library, then custom codegen. The "never stretch spending_limit" rule is enforced structurally (INV-CR-3), not by good intentions.

**MCP contract.**
- Name: `match-policies`. Safety: read-only / pure.
- Description: "Bind each abstract constraint to a concrete policy: prefer OpenZeppelin primitives, then the parameterized pb library, and only mark constraints for custom code generation when nothing else can express them exactly. Emits explicit limitations for any residual risk. Never claims a primitive covers behavior it does not."
- Input: `{ ruleset: SCH-CandidateRuleset, known_deployments?: { classification, address }[] }`.
- Output: `SCH-CandidateRuleset` (with `policy_bindings` filled) + `{ requires_codegen: string[] }`.
- Errors: `E_DOMAIN_MATCH_FAILED` (shouldn't occur — codegen is the fallback), `E_INPUT_SCHEMA`.

### FN-C2.1 `matchPolicies(input, deps)`
- **Algorithm (per rule):**
  1. **Structural satisfaction first:** if the rule's only constraints are `func_allowlist` covering the entire target interface + `expiry` + signer presence, and no arg/amount limits → `binding: none_needed` (a bare `call_contract` rule with signers and expiry suffices; cheapest, strongest — Vol 02 decision ladder step 1).
  2. **Threshold constraints** → OZ `simple_threshold` (equal weights) or `weighted_threshold` (weights present). Emit the drift warning as a `limitation` (EC-P01). Install params: `SimpleThresholdAccountParams{threshold}` / `WeightedThresholdAccountParams{signer_weights, threshold}` [code].
  3. **`amount_cap` with `source=transfer_arg2` on a `call_contract(token)` rule** → OZ `spending_limit`, params `{spending_limit: cap_i128, period_ledgers}` [code]. INV-CR-3 refinement gates this: any other `amount_cap` shape is **forbidden** from binding to spending_limit (EC-S02) → routes to pb_call_cap with a `limitation` note explaining the difference (direct-transfer budget vs protocol-internal budget).
  4. **`func_allowlist` (subset of interface)** → `pb_function_allowlist`.
  5. **`arg_predicate`(s)** → one `pb_arg_guard` per rule packing *all* arg predicates for that rule (∀ vector semantics, EC-S16) — minimizes policy count (EC-S08).
  6. **`amount_cap` with `source=call_arg`** (Blend/Soroswap internal amounts) → `pb_call_cap`.
  7. **`rate_limit`** → `pb_rate_limit`.
  8. Anything the IR can express but no primitive/pb policy implements (cross-call invariants, external oracle reads) → `binding: codegen` with a `codegen_ref`; add to `requires_codegen`.
  9. **Policy packing** (FN-C2.2): if bindings exceed `MAX_POLICIES=5` per rule, merge multi-constraint pb policies; if still >5, **split** the rule into multiple `call_contract(target)` rules (allowed — multiple rules per context [code]) and note the UX cost (EC-S08).
  10. **Pre-validate install params** in TS (FN-C2.3): cap>0, period>0, non-empty allowlist, threshold≤|signers|, paths resolve against ALL positive evidence (EC-P05, P08) — surface failures now, before any plan/compile.
  11. Aggregate `limitations[]` into the binding for the risk report; reuse `known_deployments` addresses where a matching pb/OZ policy is already deployed (avoid redundant deploys).
- **Edge cases:** EC-S02, S08, P01, P05, P08, plus decision-ladder ordering.
- **Tests:** `T-C2.1-1` unit: transfer cap on token rule → spending_limit; `T-C2.1-2` unit: Blend borrow cap → pb_call_cap + limitation (NOT spending_limit); `T-C2.1-3` unit: func subset → pb_function_allowlist; `T-C2.1-4` unit: many arg predicates → single pb_arg_guard; `T-C2.1-5` unit: >5 policies → rule split; `T-C2.1-6` unit: novel constraint → codegen ref; `T-C2.1-7` unit: full-interface allowlist + expiry → none_needed; `T-C2.1-8` unit: unresolvable path pre-validation fails.

### FN-C2.2 `packPolicies(bindings, maxPolicies)` / FN-C2.3 `preValidateInstallParams(binding, evidence)`
- FN-C2.2: greedy merge of compatible constraints into multi-constraint pb configs; split rules when packing can't fit 5. Tests: `T-C2.2-1` merge; `T-C2.2-2` split.
- FN-C2.3: mirrors each pb policy's on-chain `install` validation in TS + checks arg paths resolve against every positive evidence context (so a legitimate flow is never bricked by a bad path, EC-P08). Tests: `T-C2.3-1` invalid cap; `T-C2.3-2` path resolves on all positives; `T-C2.3-3` path missing on one positive → fail.

### 3.1 Decision table (normative)

| Constraint shape | Bind to | Condition | Limitation emitted |
|---|---|---|---|
| full-interface allowlist + expiry, no limits | `none_needed` (bare rule) | signers present | — |
| threshold, equal | `oz:simple_threshold` | — | drift (EC-P01) |
| threshold, weighted | `oz:weighted_threshold` | weights present | drift |
| amount_cap, transfer_arg2, token rule | `oz:spending_limit` | INV-CR-3 exactly | zero-amount always passes (EC-S12); 1000-entry cap (EC-P02) |
| amount_cap, transfer_arg2, non-token rule | `pb:call_cap` | — | "not on a token-scoped rule" |
| amount_cap, call_arg (Blend/Soroswap) | `pb:call_cap` | — | separate budget from direct transfers (EC-S16) |
| func allowlist (subset) | `pb:function_allowlist` | — | — |
| arg predicates | `pb:arg_guard` | packed | path-unresolved denies (EC-P08) |
| rate limit | `pb:rate_limit` | — | — |
| cross-call / oracle / stateful-novel | `codegen` | last resort | "custom, unaudited — review required" (EC + high risk) |

---

## 4. C3 — `generate-policy-code`

Only for `requires_codegen` residuals. Template-based; the free-form region is minimal and mechanically fenced (Vol 01 §3.2). Build-only; never deploys.

**MCP contract.**
- Name: `generate-policy-code`. Safety: build-only (writes to session workspace).
- Description: "Generate a minimal custom Soroban Policy contract for a constraint that no existing or pb policy can express. Fills an audited template; the generated region is fenced and mapped to its source constraint. Output is a compilable cargo crate plus a manifest — it is never deployed. Must be followed by compile and simulation."
- Input: `{ ruleset, codegen_refs: string[], workspace_id }`.
- Output: `{ crate_path, codegen_manifest: SCH-CodegenManifest }`.
- Errors: `E_BUILD_TEMPLATE`, `E_C3_UNEXPRESSIBLE` (constraint too complex even for templated codegen → honest stop).

### FN-C3.1 `generatePolicyCode(input, deps)`
- **Algorithm:**
  1. For each `codegen_ref`, select a template family (single-context guard, stateful accumulator, multi-arg predicate). If the constraint needs logic outside the template families (unbounded loops, external contract reads not in the allowlist) → `E_C3_UNEXPRESSIBLE` with an explanation (honest failure over unsafe generation).
  2. Emit a cargo crate from the fixed skeleton: `#![no_std]`, error enum in range **3400–3499** named `GeneratedPolicyError`, storage keyed `(smart_account, context_rule_id)`, `#[contractevent]` + `emit_*`, full `install/enforce/uninstall`, docs in OZ order — all frozen template text (Vol 01 §3.1/§3.2).
  3. Fill only inside `// >>> GENERATED: <constraint-id>` … `// <<< GENERATED` markers with the specific checks (arg path resolution mirroring FN-ST.22, comparisons, accumulation). Each generated check carries `// constraint: <id> — <semantics>`.
  4. Emit `Cargo.toml` from the fixed template: pinned versions matching the sandbox image, dependency allowlist = `soroban-sdk` (+ `stellar-accounts` if needed), **no build.rs, no proc-macro deps** (EC-B04).
  5. Slug-sanitize the crate/policy name (EC-B03); write via the workspace jail (EC-B03).
  6. Produce `codegen_manifest.json`: for each generated region, the constraint id, the semantics, the source lattice decision, and the fenced line range — the artifact the reviewer and `generate_tests` (Vol 08) both consume.
- **Edge cases:** EC-B03, B04, C3-unexpressible, plus P04 (tenant isolation baked into template), P08 (path-unresolved denies), G09 (single require_auth).
- **Tests:** `T-C3.1-1` golden: a simple custom guard → crate compiles (invoked in Vol 08 D1); `T-C3.1-2` unit: crate name slug-sanitized; `T-C3.1-3` unit: Cargo.toml has no build.rs and only allowed deps; `T-C3.1-4` unit: manifest maps every generated region to a constraint; `T-C3.1-5` unit: unexpressible constraint → `E_C3_UNEXPRESSIBLE`; `T-C3.1-6` unit: fenced markers present and non-overlapping.

### FN-C3.2 `renderTemplate(family, constraint)` / FN-C3.3 `buildCodegenManifest(regions)`
- FN-C3.2: pure template render (askama-style), input = constraint IR, output = fenced Rust fragment; property test: rendered fragment parses as valid Rust items in isolation. Tests: `T-C3.2-1..3` per family.
- FN-C3.3: assemble the manifest with line ranges; the diff-guard in the sandbox (Vol 08) uses these ranges to reject out-of-marker edits during the repair loop. Tests: `T-C3.3-1` ranges accurate after render.

---

## 5. Group-C invariants & self-checklist

- **Determinism is a contract:** C1/C2 are pure; `ruleset_hash` is stable across runs (property tests). This is what lets the whole hash chain (Vol 02 §11) work.
- **Existing-first is structural:** the decision table + INV-CR-3 make "prefer OZ, then pb, then codegen" a mechanical property, and make "never stretch spending_limit" impossible to violate by accident.
- **Honesty channels:** `E_UNSATISFIABLE_BY_CONTEXT` (examples collide), `E_C3_UNEXPRESSIBLE` (too complex to generate safely), `unsatisfied[]` (constraints with no binding), and `clarifications` (from B3/C1) — the system fails loudly rather than producing a plausible-but-wrong policy (the core Tyler-demo weakness).
- **Minimality is defined** (§1.3) and testable (coverage self-check + the mutation battery in Vol 08).

Checklist:
- [x] Constraint IR + lattice formalized with rules L1–L4 and the minimality objective.
- [x] Example-driven synthesis with explicit unsatisfiability proof (EC-S05).
- [x] Matching decision table normative; spending_limit overreach structurally blocked (EC-S02/INV-CR-3).
- [x] Codegen constrained to fenced regions, no-build.rs, manifest-mapped (EC-B04).
- [x] Every FN has a tests-first table; all EC/FN/T refs consistent with prior volumes.
