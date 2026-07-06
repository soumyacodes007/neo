# Delivery Plan — OZ Policy Builder MCP (SCF RFP submission)

Status date: 2026-07-06. Codebase state: 208 tests green (157 TS + 51 Rust), phases 0–7 + wallet-gate (F1) + all offline category-2 items done; install-param encoding ABI-verified against the real contracts; real testnet reads/decode/extract/bypass proven (Phase 5 E2E).

This plan maps the RFP's **10 expected deliverables** and **evaluation criteria** to concrete work, locks every open product decision, and sequences the remaining work into a short timeline. The organizing artifact is the **Claude Desktop demo flow** (§2) — every deliverable exists to make that flow real, provable, and shippable.

---

## 1. Decisions locked (the "which/how/where" answers)

| Decision | Choice | Why |
|---|---|---|
| **Wallet integration** | **kalepail/smart-account-kit** | Only SDK built for the OZ smart account: `kit.rules` (ContextRuleManager), `kit.policies`, ed25519 + passkey + delegated signers, relayer support. Its digest = our `computeAuthDigest` (FN-ST.18). Freighter = optional secondary owner-signing surface later; passkey-kit = ancestor, not used directly. |
| **Where the kit runs** | **In a browser "companion signing page", NOT inside the MCP** | Passkey/WebAuthn approval must happen in a browser/native surface. The MCP server serves a loopback page on `http://127.0.0.1:<port>` that hosts the smart-account-kit adapter. Full protocol: `docs/architecture/14-wallet-bridge.md`. |
| **Owner auth (demo default)** | **Passkey (Touch ID) in the companion page** — a top-level browser window popped from Claude Desktop | Top-level context ⇒ WebAuthn always works (no dependency on Claude Desktop delegating `publickey-credentials-get` to the MCP Apps iframe). Demos brilliantly. Fallback: password-encrypted ed25519 keystore rendered in the same page for machines without platform authenticators. |
| **Session key (the silent signer)** | **Scoped ed25519 grantee key**, MCP-held for the first demo unless we move it into the companion wallet earlier | The agent can then sign matching txs autonomously via our own `computeAuthDigest` + ed25519 — no browser at runtime. It is never the owner key; blast radius = exactly what the installed policy allows, until expiry, revocable in one click. |
| **Fees / deploy funding** | Testnet: friendbot. Demo "gasless" option: kit's `relayerUrl` (OZ Relayer), same as Pollywallet | Removes the "new passkey user has 0 XLM" onboarding wall. |
| **In-chat clarifications** ("exact 400 or up to 400/day?") | **Conversational multiple-choice from the Claude skill** (Claude Desktop renders options natively) | Zero new UI risk; the skill owns the question grammar. MCP Apps reserved for the one place it's irreplaceable: |
| **Review & approve surface** | **One MCP Apps card**: plain-English grant, proof table (✅400/❌401/❌Bob/❌day-8), policy diff, risks, expiry, revoke one-liner, and an **"Approve & Sign" button that opens the companion page** | Keeps MCP Apps scope minimal (one view) → low host-compat risk; the passkey fires in the popped window, not the sandboxed iframe. |
| **Demo network** | Testnet end-to-end (mainnet stays behind flags) | RFP demo scope; mainnet gating is an M5 hardening item. |
| **Demo scenarios** | The RFP's exact three: Blend yield, SEP-41 subscription, bounded Soroswap delegation | Already spec'd in `docs/architecture/12-walkthroughs.md`; they exercise cap-policy, composition, and example-driven synthesis respectively. |

---

## 2. The demo flow (Claude Desktop, end to end)

**Step 0 — once ever:** user says "set up my smart account" → skill opens the companion page → passkey created (Touch ID; key never leaves the enclave) → smart-account-kit deploys the OZ smart account (friendbot/relayer funds it) → account address returned to the chat.

**The loop:**
1. User types intent: *"send 400 XLM to James"* / *"go claim my Blend yield"*.
2. Skill calls `inspect-account` + matches the intended context against installed rules.
   - **Covered** → MCP signs with the session key (`computeAuthDigest` + ed25519), submits. **No prompt. Done.** ("use")
   - **Not covered (UNIQUE)** → skill: *"This is new. Want me to set up a policy so future ones are automatic?"*
3. User says yes → skill asks the **scoping questions** as options (this is where "exactly 400 / up to 400 per day / up to N per week" happens; plus expiry, recipient-lock). Answers land in `PolicyIntent` with `user_intent` provenance — the AI never invents a bound. ("record/intent")
4. Pipeline runs silently: `parse-intent → synthesize-ruleset → match-policies (ABI-verified params) → generate-tests (mutation battery) → run-simulation (fork harness: 400 ✅, 401 ❌, Bob ❌, day-8 ❌) → detect-bypass → prepare-install-plan + revocation + explain`. ("generate → simulate")
5. **MCP Apps review card** renders the grant + proof + risks. User clicks **Approve & Sign** → companion page pops → **Touch ID** → signed XDR returns over loopback → `submit-plan` (F1) verifies hash-chain + token and installs the rule (+ session pubkey + policies). ("install")
6. User repeats the action tomorrow → step 2 hits "covered" → silent. Anything *different* → session key can't sign → back to step 2's "new pattern" branch. Revoke = one click (pre-built revocation plan).

---

## 3. Deliverable-by-deliverable plan

| # | RFP deliverable | Have today | Remaining work | Size |
|---|---|---|---|---|
| D1 | **MCP server (open source)** | All 16 tools implemented + tested as libraries (`packages/core`, `stellar`, `plans`) | `packages/mcp-server`: thin `@modelcontextprotocol/sdk` bootstrap — zod→JSON-Schema registration, `withToolBoundary` (error envelope, audit log), stdio transport, `--enable-submit` flag; serves the companion page + loopback callback | **S–M** |
| D2 | **Claude skill** | Tool grammar spec'd (Vol 00 §3.3) | `skills/policy-builder/SKILL.md`: flow grammar (check-coverage → offer → scope-questions → run pipeline → show card → never submit without token), the scoping-question templates ("exact / up-to per day / per week"), hard rules (never skip verification, always show explain output first) | **S** |
| D3 | **Policy synthesizer library (Rust)** | 4 pb crates (47 tests, clippy-clean, wasm builds, hashes registered) + C3 codegen with fenced templates + manifest, output verified compiling | Deploy pb contracts to testnet (once), record deployed hashes; `cargo llvm-cov --fail-under-lines 90` gate in CI; crate READMEs | **S** |
| D4 | **Simulation / dry-run harness** | D2 permit+deny generation (mutation battery, INV-Test-1 both-polarity coverage gate) + D3 orchestration + `NativeCargoSandbox` | **The fork harness** (critical path): Rust `harness` crate loading `stellar snapshot create` output via `Env::from_ledger_snapshot_file`, registering the account + policies, driving `__check_auth`/`enforce` per TestCase, emitting per-case JSON verdicts; TS `ForkEngine` implementing `SimulationEngine` around it; flagship tests `T-P.compose-blend-submit` + `T-ST.18-2` (digest authenticates a real account) | **L — start first** |
| D5 | **Reference wallet integration** | F1 gates fully tested; E1 emits unsigned `add_context_rule` XDR; encoders ABI-verified | Companion signing page (static HTML+JS bundling smart-account-kit): create/connect wallet, sign install plan (passkey), post signed XDR to loopback; session-key runtime signer in the MCP (`computeAuthDigest` + ed25519); **testnet install rehearsal** pinning the `add_context_rule` byte-match end-to-end | **M** |
| D6 | **Three walkthroughs** | Fully spec'd (Vol 12) with assertion tables | Execute each on testnet through the real stack; capture transcripts + txn hashes + recordings; make each runnable from clean checkout (`pnpm install` + `docker pull`/native) | **M** |
| D7 | **Developer documentation** | 13-volume architecture spec (the spine) | Three short guides layered on top: *Using the toolkit* (tool grammar + skill), *How the synthesizer scopes* (lattice, minimal closure, never-Default, provenance — Vol 06 §1 distilled), *Adding a policy primitive* (pb crate template walkthrough + `registerPbPolicies`) | **S–M** |
| D8 | **Test suite across tx shapes** | 208 tests; real-testnet fixtures (Phase 5); Tier-1 goldens | Golden corpus of tx *shapes* for the synthesizer: fee-bump/relayer, multi-op, sub-invocation (Blend submit), SAC vs WASM token, muxed source, failed-tx-as-negative, create-contract — each shape → pinned `CandidateRuleset` golden + determinism (3× byte-identical) CI job | **M** |
| D9 | **Security audit + remediation** | Structural invariants already encoded (INV-CR-3 in schema, hash chain, fenced codegen, F1 gates); threat model written (Vol 09 §5) | Scope + engage auditor early (synthesizer C1/C2, pb crates, codegen templates + diff-guard, F1 approval machinery); the deny-case story for auditors = mutation battery + INV-Test-1 coverage gate + fork sim; remediate + publish | **External + M internal** |
| D10 | **Production release** | Apache-2.0-ready monorepo, versioned schemas | Versioned server endpoint (semver + `schema_version` policy), `.mcpb` desktop-extension bundle for one-click Claude Desktop install, npm publish of packages, pinned sandbox image publish, release checklist (mainnet off by default) | **S–M** |

---

## 4. Sequencing (≈10 weeks, fork harness first)

**M-A (wk 1–2): make the proof real.** Fork harness (D4) + `T-ST.18-2` digest test + `T-P.compose-blend-submit`. Everything else demos better once the "✅400/❌401" line is a real fork verdict. *Parallel:* deploy pb contracts to testnet, record hashes (D3).

**M-B (wk 2–4): make it usable.** `packages/mcp-server` (D1) + skill (D2) + companion page + session-key runtime signer (D5). Exit: the §2 demo loop works end-to-end on testnet — first tx → question → card → Touch ID → install → silent repeat → different-tx fallback.

**M-C (wk 4–6): make it credible.** Three walkthroughs executed + recorded (D6); tx-shape golden corpus + determinism CI (D8); the three doc guides (D7). *Start audit engagement now* (D9) — auditors need lead time.

**M-D (wk 6–8): OZ + audit loop.** OZ technical review of pb crates/codegen templates (see §5); audit runs; remediation.

**M-E (wk 8–10): ship.** D10 packaging, `.mcpb`, versioned endpoint, SCF submission package with recorded demos.

Critical path: **fork harness → testnet install rehearsal → walkthroughs → audit**. The MCP server/skill/page are parallelizable and low-risk.

---

## 5. Evaluation-criteria answers (baked into the plan)

- **Verifying generated policies / deny-cases (Security story):** deny-cases are *machine-generated* by the mutation battery (wrong fn/contract/token, amount+ε, cumulative overflow, expired window, wrong signer, arg tamper, zero/negative amount) and INV-Test-1 **refuses to plan** unless every constraint is exercised in both polarities; verdicts come from the fork harness against real chain state; E1/F1 mechanically refuse without fresh, hash-matched, all-green artifacts. The audit covers the synthesizer itself (C1/C2 + codegen templates + fenced-region diff-guard), not just outputs.
- **OZ as technical reviewer:** share Vol 07 + the four pb crates for design review (they're written to OZ's own `code-quality.md`, error ranges 3300–3379 non-colliding, threshold-free by design); propose upstreaming `pb_function_allowlist`/`pb_arg_guard`/`pb_call_cap`/`pb_rate_limit` into `stellar-contracts/packages/accounts/policies`; review checkpoints at M-A exit (harness semantics), M-C exit (generated-code quality), pre-release (hash registry + audit findings).
- **Building on kalepail/pollywallet:** **adopt** — OZ Relayer gasless pattern, session-key concept, schema-first determinism, Apache-2.0; **extend** — smart-account-kit as the wallet layer (companion page + `kit.rules`/`kit.policies`); **replace (justified)** — Cloudflare-hosted freeform LLM codegen → local pinned sandbox + audited parameterized pb policies + fenced-template codegen with mutation-battery verification (fixes the demo's under-constrained-policy weakness); web-UI-first → Claude Desktop/MCP-first with the wallet reduced to a signing surface.
- **Ecosystem alignment:** smart-account-kit integration (D5) + coordinate with the C-Address Tooling cohort on shared testnet fixtures, the WASM-hash classification registry, and companion-page/signing conventions.
- **Coherent integration:** the toolkit is the *policy engine* any agent host can call (MCP standard), the skill is one wrapper; the same tools serve other wallets/agents because signing is externalized (F1 takes signed XDR).

---

## 6. Top risks & mitigations

| Risk | Mitigation |
|---|---|
| Fork harness snapshot/format drift (protocol 26) | Build against current `stellar-cli` 26 snapshot format; pin CLI version; golden snapshot committed |
| `add_context_rule` ABI byte-mismatch at install | Already de-risked for install *params* (Rust parity tests); the rehearsal in M-B pins the full call; fixture account on testnet exists |
| Claude Desktop MCP Apps rendering quirks | Card is optional enhancement — flow degrades to plain-text review + companion-page link; test on Desktop early in M-B |
| smart-account-kit API churn | Pin version; our own encoders are the source of truth for install params (kit used for account create + owner signing only) |
| Audit turnaround | Engage at M-C start, not after; scope doc derived from Vol 09 §5 threat model |
