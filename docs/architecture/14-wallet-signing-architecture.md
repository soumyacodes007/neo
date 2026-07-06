# Volume 14 — Wallet & Signing Architecture (browser ↔ MCP)

How the browser-based signing surface talks to the headless MCP server, what runs where, the tech stack, and the connection protocol. This is the load-bearing integration doc for deliverable **D5 (reference wallet integration)** and the Claude Desktop demo (Vol delivery-plan §2).

Grounded in verified facts (2026-07-06):
- **MCP Apps** (official ext, `2026-01-26` spec): server declares a UI resource with URI `ui://…`, MIME `text/html;profile=mcp-app`; the host renders it in a **sandboxed iframe** that **cannot** touch the parent DOM, cookies, or `localStorage`; the view talks JSON-RPC-over-`postMessage` with the host acting as an MCP server; the host feeds tool data via `ui/notifications/tool-input` + `ui/notifications/tool-result`; the view can call **`ui/open-link { url }`** → host opens the URL **in the user's default browser** (a real top-level context), and **`ui/message { role, content }`** to inject text back into the conversation. [modelcontextprotocol/ext-apps]
- **smart-account-kit**: single ES-module build, hard dep on **`@simplewebauthn/browser`** and `@stellar/stellar-sdk >=15`; credential storage is IndexedDB/localStorage; passkey (WebAuthn) is **browser-only**. ⇒ the kit runs in the **browser companion page**, not in Node.
- **Our MCP already owns** the deterministic parts: unsigned `add_context_rule` XDR (E1), ABI-verified install params (`install-params.ts`), the auth digest (`computeAuthDigest`, FN-ST.18), and the F1 submit gate that takes **signed XDR only and never holds keys**.

---

## 1. The core problem

WebAuthn (Touch ID / passkey) requires a **top-level browser context with user presence**. A headless MCP server (Node, stdio) cannot invoke it, and the MCP Apps iframe is sandboxed (no parent access, uncertain WebAuthn delegation). So signing must happen in a surface that (a) is a real browser top-level context and (b) can hold/reach the passkey — while the MCP stays keyless and only ever emits unsigned XDR and consumes signed XDR (the F1 boundary we already built).

**Solution shape — three cooperating surfaces:**

```
┌──────────────────────────── Claude Desktop (MCP host) ────────────────────────────┐
│                                                                                    │
│  Chat  ──tools──►  ┌─────────────────────┐        ┌──────────────────────────────┐ │
│                    │  MCP Apps REVIEW     │        │  (conversation / skill)       │ │
│                    │  CARD  (sandboxed    │        └──────────────────────────────┘ │
│                    │  iframe, ui://…)     │                                          │
│                    │  [Approve & Sign] ───┼── ui/open-link ──►  opens default browser│
│                    └─────────────────────┘                              │           │
└─────────────────────────────────────────────────────────────────────────┼──────────┘
                                                                           │
        (2) stdio MCP  ▲                                                   ▼
┌───────────────────────┴────────────────────┐        ┌────────────────────────────────┐
│  MCP SERVER  (Node, @modelcontextprotocol)  │        │  COMPANION SIGNING PAGE          │
│  • 16 tools (core/stellar/plans)            │        │  (default browser, TOP-LEVEL)    │
│  • E1 builds UNSIGNED plan XDR              │◄──http──│  • smart-account-kit (browser)   │
│  • F1 submit-plan (signed XDR IN, no keys)  │  fetch  │  • createWallet/connectWallet    │
│  • ed25519 SESSION KEY (workspace, 0600)    │  +      │  • passkey sign of plan steps    │
│  • local HTTP on 127.0.0.1:<port>:          │  POST   │  • WebAuthn ✅ (top-level)        │
│      GET  /plan/<hash>   (unsigned plan)    │  back   │                                  │
│      POST /callback/<hash> (signed XDR)     │◄────────│  posts signed XDR + token here   │
└─────────────────────────────────────────────┘        └────────────────────────────────┘
```

Two distinct signing paths, deliberately different:
- **Owner install/approve** → the **browser companion page** (passkey). Rare, human-in-the-loop.
- **Session-key recurring** → the **MCP itself** signs matching txs with a held ed25519 key (`computeAuthDigest` + ed25519). No browser, no popup. This is what makes "do it again → silent" actually silent.

---

## 2. Components & tech stack

| Component | Runtime | Stack | Responsibility |
|---|---|---|---|
| **MCP server** | Node ≥20 (stdio) | `@modelcontextprotocol/sdk`, our `@ozpb/*` packages, `pino` logs to stderr | Register 16 tools; own E1/F1; hold+use session key; serve the review card resource + the local HTTP signing endpoints |
| **Review card** | Sandboxed iframe in Claude Desktop | plain HTML+JS (no build needed), `@modelcontextprotocol` view client over postMessage | Render the plan (grant, proof table, diff, risks, expiry); `[Approve & Sign]` → `ui/open-link`; show status via `ui/message` |
| **Companion signing page** | User's default browser, top-level | static HTML + a small bundled JS: **smart-account-kit** + `@stellar/stellar-sdk`, `@simplewebauthn/browser` (its dep) | create/connect the OZ smart account (passkey), fetch the unsigned plan, sign each step, POST signed XDR + approval token back |
| **Local HTTP bridge** | inside the MCP server (Node `http`) | `127.0.0.1` loopback only, random port, per-plan random path nonce, `Origin`/`Host` checks | Hand the unsigned plan to the page; receive signed XDR at the callback; hand it to F1 |
| **Session-key signer** | inside the MCP server | our `computeAuthDigest` (FN-ST.18) + `@stellar/stellar-sdk` ed25519 | Sign matching-context transactions autonomously (no browser) |

**Why the card is one tiny view, not the whole UI:** MCP Apps is new and host support varies; keeping the card to a single read-only-ish review + one `open-link` button minimizes host-compat risk. All *interaction* (scoping questions) stays in the **Claude skill** as conversational multiple-choice; all *signing* stays in the top-level companion page. The card is an enhancement — if a host can't render it, the skill degrades to a plain-text review + a printed `http://127.0.0.1:<port>/sign/<hash>` link.

---

## 3. The connection protocol (owner install path)

Precise sequence for "install a policy" — the moment a passkey is needed.

```
skill        MCP server                 review card (iframe)        companion page (browser)      testnet
 │  prepare-install-plan ─►│                                                                        
 │           │  E1 builds unsigned plan; writes it to workspace;                                    
 │           │  starts local HTTP: GET /plan/<hash>, POST /callback/<hash>;                         
 │           │  approval token written to plan file (never returned to model)                       
 │◄── plan + card resource ─│                                                                       
 │  (skill shows the card, bound to tool-result via ui/notifications/tool-result) ─►│               
 │                          │      user clicks [Approve & Sign]                     │               
 │                          │◄─── ui/open-link { url: http://127.0.0.1:<port>/sign/<hash>?n=<nonce> }│
 │      (host opens the URL in the DEFAULT BROWSER — top-level) ─────────────────────────────►│      
 │                          │       GET /plan/<hash>  (fetch, loopback) ─────────────────────►│      
 │                          │◄────── unsigned steps + auth requirements + intended context ───│      
 │                          │                        connectWallet() → PASSKEY (Touch ID) 👆  │      
 │                          │                        sign each step's AuthPayload             │      
 │                          │◄─ POST /callback/<hash> { approval_token, signed_steps[], confirm? }   
 │           │  F1 submit-plan: reload plan from disk, recompute hash chain,                         
 │           │  constant-time token compare, live pre-flight, per-step submit ───────────────►│  ✅  
 │◄── results (tx hashes) ──│                                                                        
 │  ui/message "Installed ✅ — rule N live until ledger M" ─► (card / chat)                          
```

### Endpoints (loopback, hardened)
- `GET http://127.0.0.1:<port>/plan/<plan_hash>?n=<nonce>` → JSON `{ steps:[{order, tx_xdr_unsigned, invoke, auth_requirements}], account, network, session_pubkey }`. **Never** includes keys or the approval token.
- `POST http://127.0.0.1:<port>/callback/<plan_hash>` body `{ approval_token, signed_steps:[{order, signed_xdr}], confirmation_phrase? }` → the server hands this straight to `submitPlan()` (F1) and returns `{ results }`.

### Why this is safe
- **Loopback only** (`127.0.0.1`), random ephemeral **port**, random per-plan **path nonce**, and `Origin`/`Host` allow-list → not reachable off-box, not guessable, not CSRF-able from a random page.
- The **approval token** lives in the plan file on disk and is quoted by the human via the page — the *model* never sees it (INV-Plan-3). F1 constant-time-compares it.
- F1 re-verifies the **entire hash chain from disk** (snapshot→ruleset→sim→bypass→risk→plan) and does a live pre-flight before any submit (already built + tested). A tampered page can't get a bad plan through.
- The MCP **never receives a private key** — only signed XDR. Same guarantee as the existing F1 tests.

### Where the passkey actually fires
Inside the **companion page**, which is a **top-level browsing context** (default browser tab) served from the stable loopback origin. Top-level ⇒ WebAuthn works unconditionally — we do **not** depend on Claude Desktop delegating `publickey-credentials-get` to the sandboxed card iframe. `ui/open-link` is the only host capability we rely on, and it's a first-class spec method.

---

## 4. The session-key (recurring) path — no browser

Once a rule is installed, the MCP holds the **ed25519 session key** whose public key is in that rule. For a *matching* context:

```
skill: "send 400 to James"
  MCP: inspect-account → context matches rule N
  MCP: build tx → simulate → compute auth_digest = sha256(payload ‖ rule_ids.to_xdr())   (FN-ST.18)
  MCP: sign digest with the session ed25519 key → assemble AuthPayload → submit
  → done, no card, no browser, no Touch ID
```

This is a pure Node path using code we already have (`computeAuthDigest`, `buildAuthPayload`, `@stellar/stellar-sdk` ed25519). A *non-matching* context can't be signed by the session key → the skill falls back to the owner install path (§3).

---

## 5. Decisions (answers to the 10 questions)

**1. Wallet surface — commit to the browser companion page for the first demo?**
**Yes — companion page is the committed v1 surface.** It's the only place passkey works reliably and it hosts smart-account-kit natively. We **also ship a password-encrypted ed25519 keystore option inside the same page** (a password field + KDF + ed25519 sign in JS — no WebAuthn) as a fallback for machines without a platform authenticator. A headless **CLI signing path** (`stellar-cli` / a keyfile) is a *test/CI convenience*, not a first-release user surface. So: **one page, two owner options (passkey default, password-keystore fallback); CLI for tests only.**

**2. Session-key custody — MCP or companion?**
**MCP holds the session private key** (v1), generated per grant, written `0600` in the session workspace, scoped by the policy + `valid_until` + revocation. Rationale: the product value *is* silent recurring signing — routing every matching tx back through the companion page would add a browser round-trip and require the page to stay open, defeating "no popup." Blast radius is bounded (session key ≠ owner; policy-limited; expiring; revocable), matching the accepted session-key model (Pollywallet stored it in localStorage). **Hardened variant (config flag):** move the session key to an OS-keychain-backed local signer, or to the companion with a `sign-matching-tx` callback, for deployments that want key custody outside the agent process. Default demo = MCP-held.

**3. smart-account-kit runtime — Node vs browser?**
**Confirmed browser-only for our purposes.** It hard-imports `@simplewebauthn/browser` and uses IndexedDB/localStorage; passkey `createWallet`/`connectWallet`/`signAndSubmit` need `window`/`navigator`. ⇒ we run the kit **only in the companion page**. We do **not** call `ContextRuleManager`/`signAndSubmit` from Node. Instead: **our MCP builds the unsigned `add_context_rule` XDR itself** (E1 + our ABI-verified `install-params.ts` encoders — already parity-tested against the Rust structs), the kit is used in the browser purely for **account create/connect + owner signing**, and the kit's relayer client is available in the browser for gasless submit. This keeps our encoders as the source of truth and sidesteps kit-in-Node fragility.

**4. First real wallet E2E target.**
**Exactly this, on testnet:** install a rule `transfer(to == James) AND amount ≤ 400 XLM, valid_until = ledger N` on a fresh OZ smart account, then prove on-chain: **`transfer 400 to James` succeeds**, **`transfer 401 to James` fails** (policy panic), **`transfer 400 to Bob` fails** (recipient guard), **a post-N call fails** (expiry). Signed by the session key after install. This is the acceptance test for D5 and doubles as the `T-P.compose`-style proof end-to-end (not just on a fork). Concretely: XLM via its SAC → `pb_arg_guard(to == James)` + `oz:spending_limit`/`pb_call_cap(≤400)` + expiry.

**5. Account creation path — fresh or pre-deployed?**
**Both, sequenced.** The recorded demo **creates a fresh OZ smart account live** (Step 0: passkey → kit `createWallet` → deploy, friendbot/relayer funded) so the whole record→install→use arc is shown from zero. For **CI / automated E2E**, we **connect to a pre-deployed fixture account** (the `deploy-oz-testnet-fixture.sh` account) for determinism and speed. So: fresh-create in the human demo, pre-deployed in the test harness.

**6. Policy deployment strategy.**
**Deploy each pb contract once per network; reuse by address.** The pb library is designed for it (storage keyed `(smart_account, context_rule_id)` → one deployment serves everyone). We deploy `pb_function_allowlist/arg_guard/call_cap/rate_limit` once to testnet, record the WASM hashes in `rust/pb-wasm-hashes.json`, register them via `registerPbPolicies` so A1 classifies them, and E1 **reuses those addresses** (no per-demo deploy). Codegen'd custom policies (C3) are the only per-need deploys.

**7. Fork harness source of truth.**
**Both, with distinct roles; the fork snapshot is the acceptance gate.**
- **`stellar snapshot create` + `Env::from_ledger_snapshot_file`** (Rust harness) = the **authoritative deny/allow gate**: it actually runs `__check_auth`/`enforce` on real forked state, so "401 panics with `#3221`" is a genuine contract execution, not an approximation. `run-simulation`'s `all_green` (which E1/F1 require) is this.
- **RPC `simulateTransaction`** = the **fast pre-check + replay + fee/footprint discovery** used inside E1 and for the live testnet rehearsal. It confirms the real network agrees but isn't the correctness oracle for policy logic.
So: **fork snapshot decides pass/fail (the gate); RPC simulation discovers fees/footprints and provides the on-network sanity replay.**

**8. OZ primitive reuse (Tier 1).**
**Prefer the real OZ primitive whenever it fits exactly; use pb only for what OZ can't express.** The decision ladder (Vol 06 §6, enforced structurally by INV-CR-3) already does this: a pure "≤ N of `transfer` arg[2] on one token" cap binds **`oz:spending_limit`** directly; the **recipient lock** (`to == James`) has no OZ primitive → **`pb_arg_guard`**. So the James demo uses **`oz:spending_limit` (real OZ) + `pb_arg_guard` (ours)** composed on one rule. This is the honest, RFP-aligned answer (reuse OZ, extend with pb) and it also showcases composition. We do **not** force everything through pb for "consistency."

**9. Relayer.**
**Optional, after direct testnet submission works.** v1 acceptance = **direct `sendTransaction`** on testnet (self-funded via friendbot). Then enable **OZ Relayer** (kit `relayerUrl`) as the **gasless demo polish** — it removes the "new passkey user has 0 XLM to deploy" wall and matches Pollywallet. Sequenced: direct first (must-have), relayer second (nice-to-have for the recorded demo).

**10. Audit scope.**
**Full: synthesizer + generated templates + F1 approval machinery — not just pb contracts.** The RFP explicitly wants the synthesizer audited. Scope:
- **Synthesizer** (`core/synthesis`): C1 `synthesize`/`synthesize-examples` (lattice, minimal closure, unsat honesty), C2 `match-policies` (INV-CR-3 spending_limit gate), D2 mutation battery + INV-Test-1 coverage gate.
- **Codegen** (`plans/codegen` + templates + `assertOnlyFencedRegionsChanged` diff-guard).
- **pb contracts** (the 4 Rust crates).
- **F1 approval machinery** (`plans/submit-plan` gates, hash-chain re-verification, token handling) + the **loopback bridge** (this doc §3).
The auditor's deny-case story = the mutation battery + coverage gate + fork gate. Findings tracked to remediation before release. (Threat model spine: Vol 09 §5.)

---

## 6. Build plan for this subsystem (maps to delivery-plan M-B)

1. **`packages/mcp-server`** — tool registration (zod→JSON-Schema), `withToolBoundary`, stdio; the local `http` bridge (`/plan`, `/callback`); the `ui://review-card` resource; `--enable-submit` flag.
2. **Session-key signer** — generate ed25519 per grant, 0600 workspace file; `signMatchingContext()` using `computeAuthDigest` + `buildAuthPayload`; wire into the skill's "covered" branch.
3. **Companion page** — static HTML + bundled smart-account-kit; routes `/sign/<hash>`; create/connect (passkey) + password-keystore fallback; fetch plan, sign steps, POST callback; relayer toggle.
4. **Review card** — HTML view: render `tool-result` plan, proof table, `[Approve & Sign]` → `ui/open-link`, status via `ui/message`.
5. **Testnet install rehearsal** — the §5-Q4 acceptance test, automated against the fixture account; pins the `add_context_rule` byte-match end-to-end.

## 7. Self-checklist
- [x] Passkey fires only in a **top-level** context (companion page), never the sandboxed card iframe — no dependency on host WebAuthn delegation.
- [x] MCP stays **keyless for the owner**; F1 takes signed XDR only (existing guarantee).
- [x] Session key is MCP-held, **policy-scoped + expiring + revocable**; hardened custody is a config.
- [x] Our **own encoders** are the source of truth for install params (kit-in-Node avoided).
- [x] Loopback bridge hardened (localhost, random port+nonce, Origin/Host checks, token via disk).
- [x] Fork snapshot = correctness gate; RPC sim = fees/replay.
- [x] Audit scope covers the **synthesizer + F1**, per the RFP.
