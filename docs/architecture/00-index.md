# Volume 00 — Master Index & Conventions

**Project:** OZ Policy Builder MCP — deterministic policy engineering for OpenZeppelin Stellar smart accounts.
**Parent document:** `../../mcp-architecture-plan.md` (approved high-level architecture; this spec refines it to function level and never contradicts it without an explicit "SUPERSEDES" note).
**Evidence base:** `stellar-contracts` @ `d2c884d` (2026-07-03); OZ accounts docs; the-rfp.md; pollywallet-demo.md; kalepail/smart-account-kit; Stellar RPC/CLI docs.

---

## 1. Volume map & status tracker

| Vol | File | Contents | Status | Session |
|-----|------|----------|--------|---------|
| 00 | `00-index.md` | This file: TOC, conventions, ID schemes, glossary | ✅ done | 1 |
| 01 | `01-engineering-standards.md` | TypeScript + Rust standards, repo layout, CI, error taxonomy | ✅ done | 1 |
| 02 | `02-data-model.md` | All schemas field-by-field: zod, invariants, hashing, versioning | ✅ done | 1 |
| 03 | `03-stellar-integration.md` | RPC wrapper, HistoryProvider, XDR pipeline, ledger-key construction, digest | ✅ done | 2 |
| 04 | `04-tools-inspection.md` | Tools A1–A4 function-level specs | ✅ done | 2 |
| 05 | `05-tools-extraction-intent.md` | Tools B1–B3 function-level specs | ✅ done | 2 |
| 06 | `06-tools-synthesis.md` | Tools C1–C3, Constraint IR, lattice algorithm, matching table, codegen | ✅ done | 2 |
| 07 | `07-policy-library-rust.md` | pb_* Soroban policy contracts, full OZ-checklist specs + test matrices | ✅ done | 2 |
| 08 | `08-verification-simulation.md` | D1–D4: sandbox, compile loop, mutation battery, fork harness, bypass | ✅ done | 2 |
| 09 | `09-planning-approval-security.md` | E1–E3, F1, threat model, approval machinery, key/relayer handling | ✅ done | 2 |
| 10 | `10-edge-case-catalog.md` | Master EC registry (grows every session) | 🌱 seeded (103 entries) | 1+ |
| 11 | `11-roadmap-testing.md` | Milestone → epic → work item → function → test-first spec | ✅ done | 2 |
| 12 | `12-walkthroughs.md` | Blend / SEP-41 subscription / Soroswap walkthrough specs + tier demos | ✅ done | 2 |

**Continuation protocol:** all 13 volumes are now written (Session 2 completed 03–09, 11, 12). Volume 10 remains the living edge-case registry — append newly discovered ECs there per layer. Remaining work is refinement, not new volumes: deepen any volume on request, and run the CI cross-reference integrity pass (grep for dangling EC-/FN-/T-/SCH- IDs) once implementation begins.

---

## 2. Cross-reference ID schemes

All IDs are globally unique across the whole spec and never reused.

| Prefix | Meaning | Format | Allocated in |
|--------|---------|--------|--------------|
| `EC-` | Edge case | `EC-<layer><nn>` e.g. `EC-X03` | Vol 10 (registry of record) |
| `FN-` | Function spec | `FN-<tool>.<n>` e.g. `FN-A4.2` | Vols 03–09 |
| `T-` | Named test (exists before code) | `T-<FN id>-<n>` e.g. `T-A4.2-3` | Vols 03–09, indexed in Vol 11 |
| `SCH-` | Schema | `SCH-<name>` e.g. `SCH-PolicyIntent` | Vol 02 |
| `E_` | Machine-readable tool error code | `E_UPPER_SNAKE` | Vol 01 §5 taxonomy; extended per-tool |
| `INV-` | Data-model invariant | `INV-<schema>-<n>` | Vol 02 |
| `WI-` | Roadmap work item | `WI-<milestone>.<n>` | Vol 11 |

Edge-case layer letters: `X` = XDR/decode, `R` = RPC/history, `A` = account inspection, `G` = auth/digest/signing, `S` = synthesis/matching, `P` = policy contracts (Rust), `B` = sandbox/build, `M` = simulation/fork, `L` = plan/approval/submit, `T` = trust/security/prompt-injection, `U` = UX/intent.

---

## 3. Conventions binding all volumes

1. **Function specs.** Every `FN-` entry contains: signature (TS or Rust), purpose (1–2 sentences), algorithm (numbered steps or pseudocode), inputs/outputs (referencing `SCH-` types — never redefining them), error codes emitted, edge-case refs (`EC-###`), and a **tests-first table** listing `T-` IDs with kind (`unit | property | golden | integration | fork | e2e`) and a one-line assertion. Tests are named before implementation exists; Vol 11 sequences them.
2. **Edge cases.** Every `EC-` entry has: scenario, impact, detection, **fix (no TBDs)**, owning test(s). Volumes 03–09 may describe an EC inline but must register it in Vol 10.
3. **Evidence tags.** Claims about OZ/Stellar behavior carry `[code]` (with `file:line` in the stellar-contracts clone), `[docs]`, `[web]`, or `[inference]` (must state how it will be verified).
4. **Schemas live in Vol 02 only.** Tools reference `SCH-` types. A tool needing a new field triggers a Vol 02 edit + schema version bump, not a local redefinition.
5. **Determinism rule.** Any function reachable from a tool handler must be deterministic given its inputs + pinned network responses. Wall-clock, randomness, and locale are banned outside the approved list in Vol 01 §6.
6. **Prose style.** Specs are written to be implementable by an engineer who has NOT read the conversation history: no unexplained shorthand; first use of a term links to the glossary.

---

## 4. System overview (orientation refresher)

The MCP server (TypeScript) exposes 16 tools in 6 groups — Inspection (A1–A4), Extraction/Intent (B1–B3), Synthesis (C1–C3), Verification (D1–D4), Planning/Explanation (E1–E3), Approval-gated submission (F1). Rust artifacts are: the `pb_*` parameterized policy contracts, codegen templates, and the generated test harness that runs inside a pinned Docker sandbox. The AI assistant orchestrates tools and drafts `PolicyIntent`; every fact, transform, verification, and artifact is produced by the deterministic tool layer. Nothing is ever submitted to the network except through F1's plan-hash + human-quoted approval token gate (off by default).

Data flows: **record** (A3/A4 → B1) → **intend** (B3) → **synthesize** (C1 → C2 → [C3]) → **verify** (D1 → D2 → D3 → D4) → **plan** (E1/E2) → **explain** (E3) → **[approve & submit]** (F1).

---

## 5. Glossary

| Term | Definition |
|------|------------|
| **Smart account** | Soroban contract (C-address) implementing `CustomAccountInterface::__check_auth` via OZ `stellar-accounts`, holding context rules. |
| **Context rule** | Stored authorization entry `{id, context_type, name, signers, policies, valid_until}`; scope is `Default` (matches anything), `CallContract(Address)`, or `CreateContract(wasm_hash)` [code]. |
| **Context** | `soroban_sdk::auth::Context` — one authorized operation (contract call or deployment) passed to `__check_auth`. |
| **Signer** | `Delegated(Address)` (authenticates via `require_auth_for_args`) or `External(verifier, key_data)` (verifier contract checks the signature) [code]. |
| **Policy** | External contract with `install/enforce/uninstall`; `enforce` panics to deny. Attached to rules; all attached policies must pass [code]. |
| **AuthPayload** | `{signers: Map<Signer, Bytes>, context_rule_ids: Vec<u32>}` — the signature object for `__check_auth` [code]. |
| **Auth digest** | `sha256(signature_payload ‖ context_rule_ids.to_xdr())` — what signers actually sign [code]. |
| **pb library** | Our parameterized policy contracts (`pb_function_allowlist`, `pb_arg_guard`, `pb_call_cap`, `pb_rate_limit`), audited once, configured per install. |
| **Constraint IR** | Abstract intermediate representation of restrictions (`func_allowlist`, `arg_predicate`, `amount_cap`, `rate_limit`, `threshold`, `expiry`) produced by synthesis, consumed by matching/codegen/test-gen. |
| **Evidence** | Decoded transaction traces and extracted auth contexts that justify constraints; every constraint carries provenance. |
| **Minimal closure** | The least-general constraint set (in the generalization lattice) covering all positive evidence and excluding all negative evidence + mutation battery. |
| **Bypass** | Any live rule other than the proposed one that lets the grantee signer set authorize a context the new ruleset intends to restrict. |
| **Install plan** | Ordered unsigned transactions (deploys + `add_context_rule`/`remove_*`/`update_*` invocations) with auth requirements, hashes, and a paired revocation plan. |
| **Approval token** | Human-quoted secret printed in the plan artifact (not returned through the model) required by F1. |
| **Fork test** | Rust test loading real network state via `Env::from_ledger_snapshot_file` from `stellar snapshot create` output [web]. |
| **HistoryProvider** | Pluggable interface for transaction lookback: RPC (~24h), Hubble/BigQuery, stellar.expert (deep history). |
| **SAC** | Stellar Asset Contract — built-in token contract for classic assets; fixed SEP-41 interface, no user WASM. |
| **Stroop** | 1e-7 of an asset unit; SAC amounts are `i128` stroops (7 decimals). |
| **Ledger sequence** | Monotonic ledger counter (~5 s/ledger, `17280`/day); unit of `valid_until` and policy windows. |
