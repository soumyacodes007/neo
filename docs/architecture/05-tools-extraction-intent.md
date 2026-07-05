# Volume 05 — Extraction & Intent Tools (B1–B3)

Group B turns raw traces into structured evidence and turns AI-drafted intent into a validated, normalized `PolicyIntent`. B1/B2 are pure/read-only; B3 is the anti-hallucination gate between the model's language and the deterministic synthesizer.

---

## B1 — `extract-auth-contexts`

**MCP contract.**
- Name: `extract-auth-contexts`. Safety: read-only / pure (given traces).
- Description: "From one or more transaction traces, produce the exact set of authorization contexts (contract, function, arguments) that the account's `__check_auth` would have seen — including sub-invocation contexts — with per-argument observed values and token metadata. This is deterministic evidence for synthesis; it never guesses argument meaning."
- Input: `{ account: ContractId, filter_signer?: SignerModel, traces: SCH-TransactionTrace[], polarity: "positive" | "negative", interface_hints?: SCH-InterfaceSpec[] }`.
- Output: `SCH-AuthContextSet`.
- Errors: `E_INPUT_SCHEMA`, `E_DOMAIN_NO_EVIDENCE`, `E_S03_FAILED_TX_AS_POSITIVE`.

### FN-B1.1 `extractAuthContexts(input, deps)`
- **Algorithm:**
  1. **Polarity guard:** if `polarity="positive"`, reject any trace with `successful:false` → `E_S03_FAILED_TX_AS_POSITIVE` naming the tx (EC-S03, INV-Trace-2). Negative sets may include failed txs.
  2. For each trace, walk **all** auth entries whose credential address == `account` (or, for source-account creds, the tx source == account), and within each, the full `rootInvocation` + `subInvocations` tree (EC-G07). Each node becomes a candidate context tagged `depth: "root"|"sub"`.
  3. Optional `filter_signer`: keep only contexts from traces where that signer actually authenticated (matched by decoding the auth entry's signer). Absent filter → all contexts for the account.
  4. Map each node to `ContextType`: contract call → `call_contract(contract)`; create-contract → `create_contract(wasm_hash)` (EC-X09).
  5. **Merge** contexts by `(contract, fn_name, arity)` (INV-Ctx-1). Differing arity stays separate (interface drift, EC-S07).
  6. Per merged context, build `arg_summary[]`: for each arg index, collect distinct observed ScVal values (clamped to 64, EC-X02 opaque args allowed but flagged), compute `numeric_range` for i128/u-int args (BigInt, non-negative filter — negatives preserved raw but excluded from range, EC-S11), and attach the declared `name`/`sc_type` **only if** `interface_hints` supplied one (else absent — never guessed, INV-Ctx-2).
  7. Attach `token_meta` when a context is a known token `transfer`/`approve` (symbol/decimals from enrichment — advisory only, keyed by contract id, EC-S06).
  8. Record `occurrences` (provenance per observation), `window`, and `evidence_hash`.
  9. If zero contexts → `E_DOMAIN_NO_EVIDENCE` (Tier-2 empty window, EC-S09).
- **Edge cases:** EC-G07, S03, S07, S09, S11, X02, X05, X09, S06.
- **Tests:** `T-B1.1-1` golden: Blend submit trace → root submit context + sub USDC transfer context; `T-B1.1-2` unit: failed tx as positive → error; `T-B1.1-3` unit: differing arity kept separate; `T-B1.1-4` unit: no interface hint → arg names absent; `T-B1.1-5` unit: negative amount excluded from range; `T-B1.1-6` unit: empty → `E_DOMAIN_NO_EVIDENCE`; `T-B1.1-7` golden: signer filter narrows contexts.

### FN-B1.2 `summarizeArg(index, observedScVals, hint?)`
- **Purpose:** Deterministic per-arg summary feeding synthesis generalization.
- **Algorithm:** dedup observed values by canonical ScVal bytes; classify sc_type; numeric range for integer types; distinct-set for enums/addresses/bytes; opaque args → `{sc_type:"opaque"}`, `eq`-only downstream (EC-X02).
- **Tests:** `T-B1.2-1` unit: enum distinct set; `T-B1.2-2` unit: address set with muxed normalization (EC-X05); `T-B1.2-3` unit: opaque flagged.

---

## B2 — `interface-lookup`

**MCP contract.**
- Name: `interface-lookup`. Safety: read-only.
- Description: "Fetch a contract's interface (function names, argument names and types) from its on-chain WASM contractspec, or the fixed SEP-41 interface for Stellar Asset Contracts. Use to enumerate what functions exist on a target and to label arguments correctly. Interface labels are advisory and untrusted."
- Input: `{ network, contract: ContractId }`.
- Output: `SCH-InterfaceSpec = { contract, kind: "wasm"|"sac", functions: { name, args: {name, sc_type}[], is_read_only_hint?: boolean }[], wasm_hash?, trusted: boolean }`.
- Errors: `E_DATA_CONTRACT_NOT_FOUND`, `E_DATA_NO_SPEC`.

### FN-B2.1 `interfaceLookup(input, deps)`
- **Algorithm:**
  1. Detect SAC vs WASM: if the contract is a Stellar Asset Contract (native/classic-asset SAC — no user WASM, as Tyler's demo hit with native XLM), return the **fixed SEP-41 interface** (`transfer`, `approve`, `mint`, `burn`, `balance`, `decimals`, …) with `kind:"sac", trusted:true` (EC handled: demo's "no WASM for SAC").
  2. Else read `ContractCode` (FN-ST.15) → parse the embedded contractspec entries (function + UDT metadata). Missing spec → `E_DATA_NO_SPEC` (some contracts strip it) with guidance to rely on evidence-derived positions.
  3. **Sanitize + slug-validate:** function/arg names are fenced for display (EC-T02) and, where they will feed code/paths, validated against the identifier charset (EC-B03); mark `trusted:false` for WASM specs (labels are attacker-controllable, EC-T05).
- **Edge cases:** EC-T02, T05, B03, plus SAC special-case.
- **Tests:** `T-B2.1-1` fork: SAC → SEP-41 fixed interface; `T-B2.1-2` fork: WASM contract spec parsed; `T-B2.1-3` unit: missing spec → `E_DATA_NO_SPEC`; `T-B2.1-4` unit: hostile arg name fenced + charset-flagged.

---

## B3 — `parse-intent`

The gate. The AI drafts a `PolicyIntent`; B3 normalizes and validates it. It fills **nothing** silently; anything missing or contradictory comes back as structured clarifications or errors. This is where "the AI's free text never reaches the synthesizer" is enforced.

**MCP contract.**
- Name: `parse-intent`. Safety: read-only (does light on-chain existence/decimals probes).
- Description: "Validate and normalize a drafted policy intent: resolve token symbols to addresses (with confirmation), convert time units to ledgers, verify referenced contracts exist, and check for missing provenance or contradictions. Returns a canonical PolicyIntent or a list of clarifications the user must answer. It never invents values."
- Input: `{ draft: PolicyIntent (loose), network }`.
- Output: `{ intent: SCH-PolicyIntent, intent_hash } | { clarifications_needed: Clarification[] }`.
- Errors: `E_INPUT_PROVENANCE_MISSING`, `E_INPUT_CONTRADICTION`, `E_DATA_CONTRACT_NOT_FOUND`, `E_INPUT_SCHEMA_VERSION`, `E_INPUT_ADDRESS_KIND`.

### FN-B3.1 `parseIntent(input, deps)`
- **Algorithm:**
  1. Schema-parse the draft (zod); version-migrate if N−1 (Vol 02 §12).
  2. **Provenance check:** every constraint leaf must carry `provenance`; any missing → `E_INPUT_PROVENANCE_MISSING` listing the JSON paths (INV-Intent-3, EC-U01). No defaulting.
  3. **Existence check:** each `targets[].contract` and each `budgets[].token` must exist on-chain (footprint probe, FN-ST.3); missing → `E_DATA_CONTRACT_NOT_FOUND` with cross-network hint (EC-U02/R06).
  4. **Symbol resolution** (FN-B3.2): any token given by symbol resolves through the curated registry + **mandatory echo** of the resolved address into `clarifications` for confirmation (EC-S06/T08); unknown symbol → require an address.
  5. **Decimals resolution** (FN-B3.3): read `decimals()` from each token; reconcile with the user's stated units; store `cap_i128` (raw) alongside human `cap` (EC-S10).
  6. **Unit normalization:** `expiry` and every `window` → ledgers via 17280/day with "~approx" provenance note (EC-U05); reject locale-ambiguous amounts (EC-U08).
  7. **Expiry required** (INV-Intent-1): absent expiry → clarification; "forever" triggers the override flow → rewrite to `MAX_GRANT_LEDGERS` (1y) with the verbatim user quote recorded (EC-U03).
  8. **Default-scope guard** (INV-Intent-2/EC-S01): `allow_default_context` may become true only through the double-confirm override; otherwise stays false.
  9. **Contradiction check** (FN-B3.4): conflicting budgets/targets/expiry across the session → `E_INPUT_CONTRADICTION` naming both quotes; resolution requires an explicit `clarifications_resolved` entry (later instruction wins only after confirmation, EC-U07).
  10. **Cross-field refinements:** `scope="per_call_arg"` ⇒ `arg_source` present (INV-Intent-2); `preserve` ids must exist in a supplied/last snapshot if referenced.
  11. If any clarifications accumulated → return `{clarifications_needed}` (the skill asks the user; nothing proceeds). Else compute `intent_hash` and return the canonical intent.
- **Edge cases:** EC-U01, U02, U03, U05, U07, U08, S01, S06, S10, T08.
- **Tests:** `T-B3.1-1` unit: missing provenance → error with paths; `T-B3.1-2` unit: nonexistent contract → error + hint; `T-B3.1-3` unit: symbol resolved → confirmation clarification with address echoed; `T-B3.1-4` fork: decimals reconciled, `cap_i128` correct; `T-B3.1-5` unit: no expiry → clarification; `T-B3.1-6` unit: "forever" override → 1y + quote; `T-B3.1-7` unit: contradiction → error naming both; `T-B3.1-8` unit: default-scope stays false without override; `T-B3.1-9` unit: EU-format amount rejected; `T-B3.1-10` golden: full Tier-1 intent normalizes deterministically (stable `intent_hash`).

### FN-B3.2 `resolveSymbol(symbol, network, deps)`
- **Algorithm:** curated per-network asset registry (address, issuer, source, verified-date; mainnet entries cross-checked against SEP-1 TOML at registry build time, EC-T08); hit → propose address as a **confirmation** clarification (never auto-accept, EC-S06); miss → require the user to supply an address.
- **Tests:** `T-B3.2-1` unit: known symbol → confirm clarification; `T-B3.2-2` unit: unknown → require address; `T-B3.2-3` unit: registry entry carries provenance.

### FN-B3.3 `resolveDecimals(token, deps)` / FN-B3.4 `detectContradictions(draft)`
- FN-B3.3: read `decimals()` via sim; compute `cap_i128 = cap × 10^decimals` with overflow headroom check (cap ≤ i128::MAX/2, EC-S13); expose both forms (EC-S10). Tests: `T-B3.3-1` fork read; `T-B3.3-2` unit overflow headroom.
- FN-B3.4: pairwise conflict scan over budgets (same token different caps/windows), targets (same contract different function sets without a superset relation), expiry (multiple values); emit `E_INPUT_CONTRADICTION` unless resolved (EC-U07). Tests: `T-B3.4-1` conflicting caps; `T-B3.4-2` resolved-then-latest-wins.

---

## Group-B invariants & self-checklist

- **B1 is deterministic evidence**; **B3 is the validation gate**; **B2 is advisory interface data marked untrusted.** No B tool ever widens scope or fills a value on its own.
- Provenance is mandatory and structural (INV-Intent-3): the synthesizer (Vol 06) can therefore assume every constraint it receives is justified.
- Symbol→address and unit→ledger conversions always echo both forms and, for symbols, require confirmation — defeating spoofing (EC-S06/T08) and unit confusion (EC-S10/U05).

Checklist:
- [x] Each tool has MCP contract, FN specs, tests-first tables.
- [x] Failed-tx-as-positive, empty-evidence, arity-drift, opaque-arg cases owned by B1 tests.
- [x] Provenance/existence/symbol/decimals/expiry/contradiction gates owned by B3 tests.
- [x] Interface labels marked `trusted:false` for WASM (EC-T05) with a display-fencing test.
- [x] All EC/FN/T refs consistent with Vols 02, 03, 10.
