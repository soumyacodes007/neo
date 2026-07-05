# Volume 12 — Walkthroughs & Tier Demo Scripts

Three end-to-end walkthroughs (the RFP's required documented use cases) plus the three tier demo scripts. Each walkthrough is a concrete sequence of tool calls with expected artifacts, so it doubles as an integration-test scenario and as user documentation. Addresses are placeholders (`C_BLEND`, `C_USDC`, …) resolved per network from the fixtures config (Vol 11).

Every walkthrough ends the same way: a reviewable plan + revocation + risk report, **no install**, until the user quotes the approval token — the code-first / deploy-second contract.

---

## Walkthrough A — Blend yield claim (Tier 1, intent-first)

**User goal:** "Let my AI agent claim Blend yield and move it to USDC, max 500 USDC/day, only this pool, expires in 7 days, revocable anytime."

**Flow:**
1. **Interface discovery.** `interface-lookup { contract: C_BLEND }` → functions incl. `submit`, `claim`; `interface-lookup { contract: C_USDC }` → SEP-41 (`transfer`, …). The skill asks one consolidated clarification (EC-U04): which Blend functions (`claim`, and `submit` for the withdraw→USDC step), and confirms 500/day is a direct-USDC-transfer cap.
2. **Intent.** The AI drafts `PolicyIntent`: grantee = agent ed25519 signer; targets = `C_BLEND {claim, submit}` and `C_USDC {transfer}`; budget = 500 USDC/day on `C_USDC` transfer; expiry = 7 days; preserve = owner rule id. `parse-intent` resolves USDC symbol→address (confirmation echoed, EC-S06), decimals=7 → `cap_i128 = 5_000_000_000`, 7 days → 120 960 ledgers, and returns a stable `intent_hash`.
3. **Synthesis.** `synthesize-ruleset` → two `call_contract` rules (never Default): pool rule [func_allowlist{claim,submit} + expiry + agent signer], USDC rule [amount_cap transfer_arg2 500/day + expiry + agent signer].
4. **Matching.** `match-policies` → USDC rule binds OZ `spending_limit` (exact fit, INV-CR-3). Pool rule binds `pb_function_allowlist`. **Limitation emitted:** "the 500/day cap meters direct USDC transfers by the agent; USDC moved *inside* Blend via `submit` is not metered by spending_limit" — surfaced in the risk report (the honest dual-budget caveat).
5. **Verify.** `generate-tests` (allow: claim, submit, 500 transfer; deny battery: other contract, other token, 501 transfer, day-8 call) → `run-simulation` unit+fork → all green (501 denied `#3221`, 500 allowed, other-contract denied `#3002`, day-8 denied). `detect-bypass` on the fresh account → SAFE (owner rule not satisfiable by agent; no Default).
6. **Plan.** `prepare-install-plan` → [add pool rule, add USDC rule] unsigned XDR + auth requirements (owner rule signs each `add_context_rule`, digest note). `prepare-revocation-plan` → expire/remove both. `explain-policy` → plain-English grant, policy diff (2 rules added), risk report (dual-budget caveat, spending_limit zero-amount + 1000-entry notes), expiry ~date, revoke one-liner, and the approval token in the plan file.
7. **Stop.** User reviews. If `--enable-submit` and the user quotes the token, `submit-plan` gates + installs on testnet via smart-account-kit/relayer.

**Expected artifacts (integration-test assertions):** deterministic `ruleset_hash`; sim verdict `all_green`; bypass `SAFE`; plan with exactly 2 add-rule steps; risk report contains the dual-budget limitation. This is parent acceptance criterion #1.

---

## Walkthrough B — SEP-41 subscription billing (Tier 1/2, recurring pull)

**User goal:** "Let this billing service charge me up to 20 USDC per month from my account, only via `transfer` to their address, for 12 months."

**Flow:**
1. `interface-lookup { C_USDC }` → SEP-41. Intent: grantee = billing service delegated C-address signer; target = `C_USDC {transfer}` with `arg_predicate` on `to == C_BILLER` (addr_eq) and a monthly cap; budget = 20 USDC / 30-day window; expiry = 12 months (override-confirmed as > default, but bounded); preserve owner.
2. `parse-intent` → decimals, symbol confirm, window = 30·17280 ledgers, expiry = 12·30·17280 (within `MAX_GRANT_LEDGERS` 1y? — **no**, 12 months = 1y exactly = boundary; if the user wants >1y the override flow records the quote, EC-U03). `synthesize-ruleset` → one `call_contract(C_USDC)` rule.
3. `match-policies`: the recipient restriction (`to == C_BILLER`) is an `arg_predicate` → `pb_arg_guard` (`transfer` arg index 1 `addr_eq C_BILLER`); the monthly cap → `oz:spending_limit` (transfer_arg2 on the token rule) — **two policies on one rule** (≤5). Note: spending_limit doesn't restrict the recipient (it caps any transfer), which is exactly why `pb_arg_guard` is paired — the matcher explains this composition.
4. Verify: allow (20 to biller), deny (25 to biller `#3221`; 20 to a **different** address `#3325` from arg_guard; 13th month past expiry). `detect-bypass` SAFE.
5. Plan/explain/stop as in A. Risk report notes: the biller can pull up to 20/month unattended until expiry; revoke instantly via the revocation plan.

**Why it's a good demo:** shows policy *composition* (arg_guard + spending_limit on one rule) and the delegated-signer path (EC-G08 nested auth entry in the plan).

---

## Walkthrough C — Soroswap bounded delegation (Tier 2/3, from examples)

**User goal:** "Here are 12 good swaps my agent did and 8 malicious ones (wrong token, no slippage bound, drained to an external address). Build the minimal policy that permits the good ones and rejects the bad ones."

**Flow:**
1. `lookup-transactions` / provided hashes → `trace-transaction` ×20 → `extract-auth-contexts` with `polarity` per set (failed/malicious as negative; EC-S03 guards positives).
2. `synthesize-ruleset` in **example-driven mode** (FN-C1.3): allow-closure over the 12 (func_allowlist{swap}, `path` predicates: `token_in ∈ {allowed}`, `to == account` (addr_eq — the drain attempts sent elsewhere), and an `amount_out_min` **range/floor** discriminating the no-slippage-bound negatives). If a malicious tx is byte-identical to a good one → `E_UNSATISFIABLE_BY_CONTEXT` naming the pair (honest stop).
3. `match-policies`: `swap` allowlist → `pb_function_allowlist`; the arg predicates (token_in set, `to == account`, slippage floor) → `pb_arg_guard`; per-swap amount cap → `pb_call_cap` on `amount_in`. If a constraint needs cross-arg invariants Soroswap-specific (e.g. `amount_out_min ≥ f(amount_in, oracle)`) that the IR can't express → `generate-policy-code` (C3) for that residual, compiled + tested.
4. `generate-tests` embeds all 20 examples + mutation battery → `run-simulation` (12 pass, 8 panic with the expected codes) → `detect-bypass` proving no older rule lets the agent drain elsewhere.
5. Plan/explain/stop. Risk report flags any custom-codegen policy as "unaudited — review required" (high severity) and shows the slippage-floor semantics in plain English.

**Why it's a good demo:** exercises Tier-3 synthesis, honest unsatisfiability, pb + codegen combination, and bypass proof — the full "reject all malicious" promise.

---

## Tier demo scripts (for the SCF/OZ presentation)

### Demo 1 — start from intent (Tier 1)
Single prompt (Walkthrough A prompt) → show the assistant call the tool chain live → display the `explain-policy` output (grant in English, policy diff, risk report with the dual-budget caveat) → show the fork-sim proving 500 allowed / 501 denied → **do not install**; show the plan file + approval token → optionally install on testnet with a passkey/session key. Emphasize: nothing was hallucinated; the cap is enforced by an audited OZ policy; the Blend caveat is stated, not hidden.

### Demo 2 — start from history (Tier 2)
Seeded account with 30 days of agent activity + a planted permissive Default session rule. Prompt = the Tier-2 RFP prompt. Show: `inspect-account` (rules incl. the planted one, admin/recovery classified), 30-day evidence reconstruction (golden), minimal-closure synthesis, and `detect-bypass` flagging the planted rule as **critical BYPASS** with the exact path → the plan expires it while leaving the owner rule untouched. Emphasize: the tool finds the old permissive rule the user forgot about — the security value beyond codegen.

### Demo 3 — start from examples (Tier 3)
The 12/8 corpus (Walkthrough C). Show example-driven synthesis, an intentionally colliding pair triggering `E_UNSATISFIABLE_BY_CONTEXT` (honesty), then a corpus that succeeds → generated custom policy compiling in the sandbox with its constraint-mapped manifest → 12 pass / 8 deny in fork sim → bypass proof. Emphasize: positive/negative synthesis with verified semantics and an honest "I can't separate these" failure mode.

---

## Cross-walkthrough assertions (integration suite)

| Assertion | A | B | C |
|---|---|---|---|
| No `Default` rule ever synthesized | ✓ | ✓ | ✓ |
| Deterministic `ruleset_hash` (3× rerun) | ✓ | ✓ | ✓ |
| spending_limit used only for transfer_arg2 | ✓ | ✓ | n/a |
| pb policy composition on one rule | — | ✓ | ✓ |
| Honest unsatisfiability reachable | — | — | ✓ |
| Custom codegen path exercised | — | — | ✓ |
| Bypass detection finds a planted rule | (Demo 2) | — | ✓ |
| Plan produced, install withheld pending token | ✓ | ✓ | ✓ |
| Revocation plan generated | ✓ | ✓ | ✓ |
| Risk report states every limitation | ✓ | ✓ | ✓ |

## Self-checklist

- [x] Three walkthroughs (Blend, SEP-41 subscription, Soroswap) cover Tiers 1–3 and map to RFP-required use cases.
- [x] Each walkthrough is a concrete tool-call sequence with expected artifacts (doubles as an integration scenario).
- [x] Demos emphasize the differentiators: no hallucination, honest failure, bypass detection, verified semantics, code-first/deploy-second.
- [x] Cross-walkthrough assertion table ties back to acceptance criteria and key invariants.
- [x] All references (tools, ECs, policies) resolve to prior volumes.
