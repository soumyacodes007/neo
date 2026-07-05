# Volume 09 — Planning, Approval & Security (E1–E3, F1)

Group E turns a verified ruleset into reviewable, unsigned transactions and plain-English explanations. F1 is the single approval-gated path to the network — off by default, and even when on, mechanically impossible to trigger without a fresh, hash-matched, human-approved plan. This volume also states the full threat model.

---

## 1. E1 — `prepare-install-plan`

**MCP contract.** Name `prepare-install-plan`; safety build-only (constructs unsigned XDR, no submission). Input `{ ruleset, account_snapshot, simulation_report, bypass_report, risk_report, workspace_id }`. Output `SCH-InstallPlan` (with paired `RevocationPlan`). Errors `E_GATE_STALE_ARTIFACTS`, `E_DOMAIN_BYPASS_UNHANDLED`, `E_BUILD_SIMULATION_FAILED`, `E_INPUT_HASH_MISMATCH`.

### FN-E1.1 `prepareInstallPlan(input, deps)`
- **Algorithm:**
  1. **Gate on fresh verification** (EC-T03): recompute and match `ruleset_hash`, `simulation_report.ruleset_hash`, `bypass_report.ruleset_hash`; the simulation `verdict` must be `all_green` (INV-Test-3) and every `BYPASS` finding must have a matching entry in `ruleset.removals/updates` or a user-accepted risk (INV-Bypass-2) — else `E_DOMAIN_BYPASS_UNHANDLED`. No fresh matching artifacts → refuse (this is why "just give me the tx" can't skip tests, EC-U06).
  2. **Step synthesis:**
     - `deploy_wasm` steps for each codegen'd policy and any pb policy not already deployed on this network (reuse known deployments otherwise).
     - `add_context_rule` invoke steps: exact `context_type`, `name` (≤20 bytes), `valid_until`, `signers`, and `policies: Map<Address, Val>` with **exact install-param ScVal** (`install_params_scval_b64` from the binding). Each install param round-trips through the pb/OZ `install` validation (already pre-checked in C2, re-asserted here).
     - `remove_context_rule` / `update_context_rule_valid_until` steps for bypass rules (from `removals`/`updates`), respecting `preserve` (a preserve-conflict blocks with a warning, never auto-removes — INV, EC-D4).
  3. **Ordering laws (INV-Plan-1):** deploys → installs → threshold `set_*` **before** `remove_signer` / **after** `add_signer` (drift, EC-P01) → remove/expire old permissive rules **after** the new rule is live (no gap where the agent has neither the old nor the new path if continuity is wanted, and no window where only the permissive path exists). Multi-context-splitting: steps needing different signer sets go in separate transactions (EC-G10).
  4. **Simulate each step** (FN-ST.6): capture `minResourceFee`, `sorobanData` footprint, `at_ledger`; attach `auth_requirements` (which rule id + signers must sign, with the digest note pointing at FN-ST.18) — including the delegated-signer nested-entry skeleton where needed (EC-G08).
  5. **Reversibility:** mark each step `reversible` + `revert_step_ref` (add_rule↔remove_rule); mark `upgrade`/owner-signer changes irreversible with a note (INV-Plan-4).
  6. **Idempotency predicates** (FN-E1.2): each step gets a read-back predicate ("rule named X with context Y and policy set Z exists") for resume/replay-guard (EC-L04/L05).
  7. **Pre-state capture:** embed `pre_state.rules_snapshot` so removals are manually restorable (INV-Snap "restore").
  8. **Approval token:** generate a high-entropy token (injected entropy), write it to the **human-facing plan file only**; the schema carries `approval_token_ref` (filename), never the value (INV-Plan-3, EC-L01).
  9. Set `expires_at_ledger` (plan ledger + 1 day, INV-Plan-5); compute `plan_hash` over steps+depends_on+pre_state (resource fields excluded so re-sim at submit doesn't break the hash — EC-M03); build the paired `RevocationPlan` (E2).
- **Edge cases:** EC-T03, U06, P01, G08, G10, L04, L05, M03, D4 preserve-conflict.
- **Tests:** `T-E1.1-1` unit: missing/stale reports → refuse; `T-E1.1-2` unit: unhandled BYPASS → `E_DOMAIN_BYPASS_UNHANDLED`; `T-E1.1-3` golden: Tier-1 plan = [deploy pb policies?, add pool rule, add USDC rule] with correct install params + auth reqs; `T-E1.1-4` unit: threshold ordering (set before remove_signer); `T-E1.1-5` unit: preserve-listed rule never in removals; `T-E1.1-6` unit: token not present in returned schema (grep); `T-E1.1-7` unit: plan_hash stable under resource-field changes; `T-E1.1-8` fork: each step simulates and its auth requirement is correct.

### FN-E1.2 `stepPredicate(step)` / FN-E1.3 `simulateStep(step, deps)`
- FN-E1.2: pure — derives the read-back predicate from the step (rule existence by (name, context, policy set); policy deployment by wasm_hash). Tests `T-E1.2-*`.
- FN-E1.3: wraps FN-ST.6; classifies simulation errors; surfaces `restorePreamble` if archived entries need restoring first (adds a restore step). Tests `T-E1.3-1` fee/footprint captured; `T-E1.3-2` restore-preamble → restore step inserted.

---

## 2. E2 — `prepare-revocation-plan`

**MCP contract.** Name `prepare-revocation-plan`; safety build-only. Input `{ install_plan | ruleset+snapshot }`. Output `SCH-RevocationPlan`. Always produced alongside E1; also callable standalone to revoke an existing grant.

### FN-E2.1 `prepareRevocationPlan(input, deps)`
- **Algorithm:** for each rule the plan **adds**, emit the inverse: preferred `update_context_rule_valid_until(now)` (instant self-expiry, cheapest) and/or `remove_context_rule(id)` (full removal + policy uninstall, which calls `try_uninstall` — best-effort, plus explicit pb-state cleanup calls where the policy exposes them, EC-P07). Include a "break-glass" note: the owner/admin rule can always remove any rule (self-administration [code]). Order removals so the account is never left without an admin path.
- **Edge cases:** EC-P07 (uninstall best-effort + explicit cleanup), preserve owner path.
- **Tests:** `T-E2.1-1` unit: expire-then-remove steps for each added rule; `T-E2.1-2` fork: revocation actually revokes (agent context denied after); `T-E2.1-3` unit: cleanup steps for stateful pb policies.

---

## 3. E3 — `explain-policy`

Deterministic renderer over the data model — **no LLM** (so the explanation can't drift from the artifacts). Produces the human-facing plan file (carrying the approval token), the policy diff, and the risk report.

**MCP contract.** Name `explain-policy`; safety build-only (writes the human plan file). Input `{ ruleset, account_snapshot, install_plan, simulation_report, bypass_report, risk_report }`. Output `{ plan_file_path, markdown, risk_report: SCH-RiskReport }`.

### FN-E3.1 `explainPolicy(input, deps)`
- **Algorithm:**
  1. **Plain-English ruleset:** per rule, render "grantee <label> may call <functions> on <contract (full address + registry label)>, limited to <arg predicates in words>, up to <cap human + raw> per <window in ledgers ~time>, until ledger <valid_until> (~date)." Amounts always dual-form (EC-S10); time always "~approx" (EC-U05); addresses always full, never truncated (EC-T06); on-chain strings fenced as untrusted data (EC-T01/T05).
  2. **Policy diff** (FN-E3.2): before/after account permission set — new rules, removed rules, unchanged admin/recovery paths — as a table the user can scan.
  3. **Risk report** (FN-E3.3): derived strictly from limitations + bypass findings + unknown policies + schema rules (INV-Risk-1). Every `PolicyBinding.limitation`, every `UNKNOWN`/rate-limited bypass finding, "custom unaudited code present" (if codegen used), the dual-budget Blend caveat, dormant reactivatable rules (EC-A07), and irreversibility notes appear; the renderer can neither invent nor omit a mapped risk.
  4. **Expiry & revocation summaries:** last-valid ledger + approx time; the one-line revoke instruction ("to revoke now: sign & submit `revoke-1.xdr`").
  5. **Approval token block:** print the token from `approval_token_ref` into the plan file (the only place it appears), with instructions that F1 requires the user to quote it.
- **Edge cases:** EC-T01, T05, T06, S10, U05, A07, A09 (label vs classification shown side by side).
- **Tests:** `T-E3.1-1` golden: Tier-1 explanation matches snapshot; `T-E3.1-2` unit: hostile rule name fenced; `T-E3.1-3` unit: full addresses (no truncation); `T-E3.1-4` unit: risk report contains every limitation + bypass finding (no omission); `T-E3.1-5` unit: token appears only in the plan file; `T-E3.1-6` golden: policy diff table for a plan that removes an old rule.

### FN-E3.2 `renderPolicyDiff` / FN-E3.3 `buildRiskReport`
- FN-E3.2: pure diff of before/after `AccountSnapshot`-projected permissions. Tests `T-E3.2-*`.
- FN-E3.3: pure mapping to `SCH-RiskReport`; severity rules table-driven (Default-satisfiable → critical; unknown policy/verifier → high; custom codegen → high; rate-limited-only bypass → medium; dual-budget/zero-amount caveats → info). Tests `T-E3.3-1` completeness (maps all inputs), `T-E3.3-2` severities correct.

---

## 4. F1 — `submit-plan` (approval-gated, disabled by default)

The only tool that touches the network with state changes. Server flag `--enable-submit` (default off). It never signs — it accepts user-signed XDR (from the wallet / smart-account-kit / Pollywallet flow) or routes through OZ Relayer.

**MCP contract.** Name `submit-plan`; safety approval-gated. Input `{ plan_hash, approval_token, signed_steps: { order, signed_xdr }[], transport: "direct"|"relayer", relayer_config? }`. Output `{ results: { order, status, tx_hash|relayer_id, detail }[] }`. Errors `E_GATE_SUBMIT_DISABLED`, `E_GATE_TOKEN_MISMATCH`, `E_GATE_STALE_ARTIFACTS`, `E_GATE_PLAN_EXPIRED`, `E_GATE_AUTH_EXPIRED`, `E_INPUT_NETWORK_MISMATCH`.

### FN-F1.1 `submitPlan(input, deps)`
- **Algorithm (gates first, before any side effect):**
  1. `--enable-submit` off → `E_GATE_SUBMIT_DISABLED` immediately (EC-L07). The skill then hands the plan to the user out-of-band.
  2. Load the plan + all five dependency artifacts **from disk** (not from conversation, EC-T03/T07) by `plan_hash`; recompute every hash in the chain (Vol 02 §11.4) — any mismatch → `E_GATE_STALE_ARTIFACTS` naming the file (tamper/drift detection, EC-T07).
  3. Constant-time compare `approval_token` against the token file → mismatch `E_GATE_TOKEN_MISMATCH` (EC-L01). The model cannot supply this unless the human quoted it.
  4. Plan freshness: `current_ledger ≤ expires_at_ledger` else `E_GATE_PLAN_EXPIRED` (regen E1) (EC-L02).
  5. **Live pre-flight:** re-read the account (FN-A1) — `account_wasm_hash` unchanged (EC-L03), and no plan-referenced rule id / admin path changed since the snapshot; any delta → `E_GATE_STALE_ARTIFACTS` with a diff (rule ids are stable/never-reused [code], making this sound).
  6. Network equality across all artifacts and the target (INV-Common-2) → else `E_INPUT_NETWORK_MISMATCH` (EC-L08).
  7. For plans containing any `reversible:false` step, require an extra confirmation phrase (also token-file-gated) (INV-Plan-4).
  8. **Per step, in order, resumable:** check the step predicate (FN-E1.2) — if already satisfied, skip (idempotent resume / duplicate-submit guard, EC-L04/L05) unless `--force-reapply`. Verify the signed XDR's auth-entry expiration ≥ current (EC-G03) else `E_GATE_AUTH_EXPIRED` (re-sign). Re-simulate to patch resources if state drifted (semantic content unchanged only; else abort — EC-M03). Submit via `direct` (`sendTransaction`) or `relayer` (fee-bump wrap of the signed XDR; Soroban gas via user-signed FeeForwarder entry — the relayer can't forge `__check_auth`, EC-L06); track by tx hash + relayer id. On submit failure, **read back** the predicate before any retry (sim success ≠ submit success, EC-M06); never blind-retry a state change.
  9. Audit-log every gate result and submission id (no secrets).
- **Edge cases:** EC-L01–L08, T03, T07, G03, M03, M06.
- **Tests:** `T-F1.1-1` unit: disabled → gate first, no parsing side effects; `T-F1.1-2` unit: wrong token → mismatch; `T-F1.1-3` unit: tampered artifact → stale; `T-F1.1-4` unit: expired plan → gate; `T-F1.1-5` fork: account upgraded since snapshot → blocked; `T-F1.1-6` unit: network mismatch → error; `T-F1.1-7` integration: resume skips satisfied predicate; `T-F1.1-8` unit: auth-entry expired → re-sign gate; `T-F1.1-9` @network: end-to-end install on testnet fixture; `T-F1.1-10` unit: irreversible step needs extra phrase.

---

## 5. Threat model (consolidated)

| Actor / vector | Capability assumed | Mitigation (with EC) |
|---|---|---|
| **Compromised AI / prompt injection via chain data** | Can read tool outputs poisoned by attacker-written rule names, token symbols, contract spec text, memos | Sanitize + data-fence every chain string at consuming boundary (EC-T01/T02/T05); model told fenced content is data; names/specs never interpolated into code/paths/prompts as instructions; arg names slug-validated (EC-B03) |
| **Model fabricating results** | Claims tests passed / plan safe without evidence | Verification is mechanical: E1 refuses without fresh matching report hashes; F1 re-verifies the chain from disk (EC-T03/T07); skill rule: cite report hashes |
| **Malicious target contract** | Lying contractspec, upgraded policy code, fake verifier, spoofed token symbol | Classification by live WASM hash (EC-A05); unknown verifier ⇒ signer-strength UNKNOWN (EC-A06); constraints bind to arg *positions* + evidence types, spec names advisory (EC-T05); symbol logic keyed by address + confirmation (EC-S06/T08) |
| **Compromised grantee (session key leak)** | Attacker holds S | Minimality (least privilege) + expiry + bypass analysis over S (removes old broad paths); revocation plan always ready; risk report states residual capability within the grant |
| **Compromised relayer** | Can fee-bump, censor, spend fees | Cannot forge `__check_auth` signatures (EC-L06); risk limited to fees + censorship, stated in the report; user signs the auth entries, not the relayer |
| **Supply-chain via generated code** | Malicious build.rs / proc-macro at compile time | No build.rs, dep allowlist, vendored offline registry, network-jailed sandbox (EC-B02/B04) |
| **Key exfiltration** | Any flow that captures secret keys | No schema accepts secrets; CI grep-guard; F1 takes signed XDR only; signing in the wallet (EC-T04) |
| **Artifact tampering / stale state** | Files edited between phases; account changed before submit | Full hash-chain re-verification from disk + live pre-flight at F1 (EC-T07/L03/M01) |
| **Path traversal / workspace escape** | Generated names as paths | Workspace jail + slug allowlist (EC-B03) |

**What the MCP is trusted to do:** read chain state, decode/extract deterministically, synthesize/verify, construct unsigned plans, explain. **What the AI is trusted to do:** converse, draft intent (validated by B3), orchestrate tools, patch fenced template code (re-verified). **What must be deterministic:** everything from decode through plan construction (Vol 01 §2.6). **What requires explicit approval:** any user-account mutation, any mainnet write, any relayer submission (F1 gates). **Key handling:** none held, ever. **Revocation:** always pre-built and one-command.

## 6. Self-checklist

- [x] E1 gates on fresh, hash-matched, green verification + handled bypass; refuses otherwise (anti-skip).
- [x] Ordering laws (threshold drift, remove-after-install, multi-context split) specified with tests.
- [x] Approval token never in model-visible schema; F1 constant-time compares a disk token (EC-L01).
- [x] F1 gates evaluated before side effects; live pre-flight + resumable idempotent steps (EC-L03/L04/L05).
- [x] Explain renderer is deterministic and cannot omit/invent risks (INV-Risk-1); fences hostile strings; full addresses.
- [x] Consolidated threat model maps every T-layer EC to a mitigation.
- [x] All FN/EC/T refs consistent with Vols 02–08, 10.
