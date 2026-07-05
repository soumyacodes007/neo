# Volume 07 — The `pb_*` Policy Library (Rust / Soroban)

Four parameterized policy contracts that fill the gap between OZ's three primitives and per-flow custom codegen. They are written as if they were PRs to `OpenZeppelin/stellar-contracts` (Vol 01 §3.1) — the OZ `code-quality.md` checklist applies verbatim — and are intended for upstream contribution (the RFP's "primitives to upstream" ask).

Design north star: **one deployed contract, many accounts/rules, configured per install.** Storage is always keyed `(smart_account, context_rule_id)` (OZ convention [code spending_limit.rs:145]) so a single deployment serves the whole ecosystem with tenant isolation (EC-P04).

Each policy follows the OZ module shape: library crate `stellar-pb-<name>` with `mod.rs` (trait/errors/constants/events) + `storage.rs` (keys + logic) + `test.rs`; plus a thin example-style contract crate exposing the `Policy` impl + getters (mirroring `examples/multisig-smart-account/threshold-policy/src/contract.rs` [code]).

Error ranges (Vol 01 §3.1): allowlist **3300–3319**, arg_guard **3320–3339**, call_cap **3340–3359**, rate_limit **3360–3379**.

Shared conventions (all four): `install/enforce/uninstall/set_*` call `smart_account.require_auth()`; TTL trio `const DAY_IN_LEDGERS=17280; *_EXTEND_AMOUNT=30*DAY; *_TTL_THRESHOLD=EXTEND-DAY`; extend-on-read; `#[contractevent]`+`emit_*`; `panic_with_error!` only; deny-by-default on any ambiguity (EC-P08); `#[should_panic(expected="Error(Contract, #<code>)")]` tests; ≥90% coverage.

---

## 1. `pb_function_allowlist` (3300–3319)

**Purpose.** Permit only an explicit set of function names on the rule's target contract; deny all others. Fills the gap that context rules scope per-contract but not per-function (the central finding, Vol 02 §2.3.2).

### 1.1 Types
```rust
#[contracttype] pub struct FunctionAllowlistParams { pub allowed: Vec<Symbol> }      // install param
#[contracttype] pub enum PbAllowlistStorageKey { AccountContext(Address, u32) }      // -> Vec<Symbol>
#[contracterror] #[repr(u32)] pub enum PbAllowlistError {
  SmartAccountNotInstalled = 3300, AlreadyInstalled = 3301,
  EmptyAllowlist = 3302, FunctionNotAllowed = 3303, OnlyCallContractAllowed = 3304, TooManyFunctions = 3305,
}
```
Events: `PbAllowlistInstalled{smart_account, context_rule_id, allowed_len}`, `PbAllowlistEnforced{...}`, `PbAllowlistChanged{...}`, `PbAllowlistUninstalled{...}` — each with `emit_*`.

### 1.2 Semantics
- **install:** require_auth; require `context_type` is `CallContract` (pin to one contract — mirrors spending_limit's `OnlyCallContractAllowed` [code]); reject empty allowlist (`EmptyAllowlist`) and >`MAX_ALLOWED (32)`; reject double-install; store `allowed`.
- **enforce:** require_auth; read `allowed` (extend TTL); match `context` — must be `Context::Contract{fn_name,..}`; if `fn_name ∉ allowed` → panic `FunctionNotAllowed`; else pass (no state change). Non-contract context (create) → `FunctionNotAllowed` (deny-by-default).
- **uninstall:** require_auth; idempotent — missing state does **not** panic (EC-P07); remove and emit.
- **set_allowed:** require_auth; replace set with validation; emits changed.

### 1.3 Edge cases → owned tests
- EC-P04 tenant isolation → `T-P.allow-tenant-accounts`, `T-P.allow-tenant-rules` (two accounts / two rules, disjoint sets don't bleed).
- EC-P05 install validation → `T-P.allow-install-empty` (`#3302`), `T-P.allow-install-noncallcontract` (`#3304`), `T-P.allow-install-toomany` (`#3305`), `T-P.allow-double-install` (`#3301`).
- EC-P06 install requires auth → `T-P.allow-install-auth` (no-auth panics via full auth path, EC-G09).
- EC-P07 uninstall idempotent → `T-P.allow-uninstall-missing-ok`.
- Core: `T-P.allow-enforce-allowed-passes`, `T-P.allow-enforce-denied-panics` (`#3303`), `T-P.allow-enforce-create-context-denies`.
- TTL: `T-P.allow-ttl-extend-on-read`.

---

## 2. `pb_arg_guard` (3320–3339)

**Purpose.** Enforce per-function argument predicates: `eq/in/range/addr_eq/addr_in`, with JSONPath-lite `path` extraction and ∀ semantics over vectors (Blend `requests[*]`, EC-S16). One installed instance guards *all* arg predicates for a rule (packing, EC-S08).

### 2.1 Types
```rust
#[contracttype] pub enum Predicate {                       // stored, one per (fn, arg, path)
  Eq(Val), In(Vec<Val>), Range(i128, i128), AddrEq(Address), AddrIn(Vec<Address>),
}
#[contracttype] pub struct ArgRule { pub fn_name: Symbol, pub arg_index: u32,
  pub path: Vec<PathSeg>, pub pred: Predicate, pub forall: bool }   // forall => path yields a vector; every element must satisfy
#[contracttype] pub enum PathSeg { Field(Symbol), Index(u32), Wildcard }
#[contracttype] pub struct ArgGuardParams { pub rules: Vec<ArgRule> }
#[contracttype] pub enum PbArgGuardStorageKey { AccountContext(Address, u32) }       // -> Vec<ArgRule>
#[contracterror] #[repr(u32)] pub enum PbArgGuardError {
  SmartAccountNotInstalled = 3320, AlreadyInstalled = 3321, EmptyRules = 3322,
  ArgIndexOutOfRange = 3323, ArgPathUnresolved = 3324, PredicateFailed = 3325,
  TypeMismatch = 3326, TooManyRules = 3327, OnlyCallContractAllowed = 3328,
}
```

### 2.2 Semantics
- **install:** require_auth; `CallContract` only; non-empty, ≤`MAX_RULES(32)`; validate each `ArgRule` shape (path well-formed); store.
- **enforce:** require_auth; for the incoming `Context::Contract{fn_name,args}`, select the `ArgRule`s whose `fn_name` matches. For each: resolve `args[arg_index]` then walk `path` (mirrors FN-ST.22). **Resolution failure → panic `ArgPathUnresolved`** (deny-by-default, EC-P08). Type mismatch between predicate and resolved value → `TypeMismatch`. Apply predicate: for `forall`, every resolved element (Wildcard fan-out) must satisfy — an empty fan-out **denies** (`ArgPathUnresolved`) unless the rule explicitly allows empties (config flag, default false, fail-closed EC-S16). Any failure → `PredicateFailed`. All rules pass → return.
- **uninstall:** idempotent.
- Functions not covered by any `ArgRule` are **out of scope** for arg_guard — they're gated by the accompanying `pb_function_allowlist` on the same rule (composition; arg_guard alone does not restrict which functions run).

### 2.3 Edge cases → tests
- EC-S16 ∀ vectors → `T-P.arg-forall-all-pass`, `T-P.arg-forall-one-fails` (`#3325`), `T-P.arg-forall-empty-denies` (`#3324`), `T-P.arg-mixed-token-element-denies`.
- EC-P08 path unresolved → `T-P.arg-missing-index-denies` (`#3323/#3324`), `T-P.arg-wrong-type-denies` (`#3326`).
- Predicates → `T-P.arg-eq`, `T-P.arg-in`, `T-P.arg-range-boundary` (min/max inclusive; min-1/max+1 fail), `T-P.arg-addr-eq`, `T-P.arg-addr-in`, `T-P.arg-addr-muxed-normalized` (EC-X05).
- EC-P04/P05/P06/P07 batteries (as §1.3).
- Parity: `T-P.arg-path-parity` shares fixtures with FN-ST.22 (TS/Rust path resolution agree) — critical so C2 pre-validation matches on-chain behavior.

---

## 3. `pb_call_cap` (3340–3359)

**Purpose.** Rolling-window cumulative cap on an amount read from a **configurable** `(fn, arg path)` — the generic DeFi spend policy `spending_limit` is not (Blend `submit.requests[*].amount`, Soroswap swap amounts). Optional token filter so only the intended asset counts (EC-S16).

### 3.1 Types
```rust
#[contracttype] pub struct CallCapParams {
  pub cap: i128, pub period_ledgers: u32,
  pub fn_name: Symbol, pub amount_path: Vec<PathSeg>,          // where the amount lives
  pub token_filter: Option<(Vec<PathSeg>, Address)>,          // count element only if token at path == Address
}
#[contracttype] pub struct CallCapData { pub params: CallCapParams,
  pub history: Vec<SpendEntry>, pub cached_total: i128 }       // mirrors spending_limit structure [code]
#[contracttype] pub struct SpendEntry { pub amount: i128, pub ledger: u32 }
#[contracttype] pub enum PbCallCapStorageKey { AccountContext(Address, u32) }
#[contracterror] #[repr(u32)] pub enum PbCallCapError {
  SmartAccountNotInstalled=3340, AlreadyInstalled=3341, InvalidLimitOrPeriod=3342, NotAllowed=3343,
  CapExceeded=3344, HistoryCapacityExceeded=3345, LessThanZero=3346, ArgPathUnresolved=3347,
  MathOverflow=3348, OnlyCallContractAllowed=3349,
}
pub const MAX_HISTORY_ENTRIES: u32 = 1000;                     // same DoS cap as OZ [code]
```

### 3.2 Semantics (deliberately mirrors OZ `spending_limit` where possible, generalized on the amount source)
- **install:** require_auth; `CallContract` only; `cap>0 ∧ period_ledgers>0` else `InvalidLimitOrPeriod`; reject double-install; init empty history/total.
- **enforce:** require_auth; require ≥1 authenticated signer (`NotAllowed`, matches OZ [code]); match `fn_name`; resolve amount via `amount_path` (unresolved → `ArgPathUnresolved`, deny). For ∀ vectors, **sum** the amounts of elements passing `token_filter` (elements failing the filter are ignored for the cap — but note pb_arg_guard, not this policy, decides whether non-USDC elements are *allowed*; separation of concerns). `amount<0` → `LessThanZero`; `amount==0` → pass without recording (documented, EC-S12 parity). Evict entries with `ledger <= current - period` (exact OZ cutoff semantics, EC-P10); `cached_total - evicted + amount > cap` → `CapExceeded`; history at `MAX_HISTORY_ENTRIES` → `HistoryCapacityExceeded` (EC-P02); checked arithmetic → `MathOverflow` (EC-S13). Record entry, update total, emit.
- **set_cap:** require_auth; `cap>0`; update.
- **uninstall:** idempotent.

### 3.3 Edge cases → tests
- EC-P10 window boundary → `T-P.callcap-evict-at-cutoff`, `T-P.callcap-keep-cutoff-plus1` (copies OZ eviction test shape).
- EC-P02 history cap → `T-P.callcap-history-full` (`#3345`).
- EC-P09 double-context accumulation → `T-P.callcap-two-contexts-accumulate` (one tx, two enforce calls, budget counts twice).
- EC-S13 overflow → `T-P.callcap-overflow` (`#3348`).
- EC-S12 zero → `T-P.callcap-zero-passes-no-record`.
- EC-S16 token filter → `T-P.callcap-filters-token` (USDC element counts, other ignored), `T-P.callcap-forall-sum`.
- Core: `T-P.callcap-under`, `T-P.callcap-exact` (== cap passes), `T-P.callcap-over` (`#3344`), `T-P.callcap-negative` (`#3346`), `T-P.callcap-unresolved-path` (`#3347`).
- EC-P03 TTL/archival → `T-P.callcap-ttl-extend`, and a fork test manipulating TTL to show archived state → `SmartAccountNotInstalled` on next enforce (documents the brick-and-restore path).
- Batteries P04/P05/P06/P07.

---

## 4. `pb_rate_limit` (3360–3379)

**Purpose.** Cap the number of authorized calls (optionally per function) in a rolling window — throttles agents independent of amount; pairs with call_cap to bound the spending_limit 1000-entry DoS (EC-P02).

### 4.1 Types
```rust
#[contracttype] pub struct RateLimitParams { pub max_calls: u32, pub period_ledgers: u32, pub fn_scope: Option<Symbol> }
#[contracttype] pub struct RateLimitData { pub params: RateLimitParams, pub calls: Vec<u32> }   // ledger seqs
#[contracttype] pub enum PbRateLimitStorageKey { AccountContext(Address, u32) }
#[contracterror] #[repr(u32)] pub enum PbRateLimitError {
  SmartAccountNotInstalled=3360, AlreadyInstalled=3361, InvalidParams=3362,
  RateLimitExceeded=3363, HistoryCapacityExceeded=3364, NotAllowed=3365, OnlyCallContractAllowed=3366,
}
pub const MAX_CALL_ENTRIES: u32 = 1000;
```

### 4.2 Semantics
- **install:** require_auth; `CallContract` only; `max_calls>0 ∧ period>0`; no double-install.
- **enforce:** require_auth; if `fn_scope` set and `fn_name != fn_scope` → pass (out of scope); evict `calls` with `ledger <= current - period`; if `remaining_count >= max_calls` → `RateLimitExceeded`; if entries at cap → `HistoryCapacityExceeded`; push current ledger; emit.
- **uninstall:** idempotent.

### 4.3 Edge cases → tests
- `T-P.rate-under`, `T-P.rate-at-limit` (Nth passes, N+1th `#3363`), `T-P.rate-window-slides` (old calls evicted allow more), `T-P.rate-fn-scope` (out-of-scope fn unaffected), `T-P.rate-history-cap` (`#3364`). Batteries P04–P07; TTL extend-on-read.

---

## 5. Composition semantics (how the four combine on one rule)

A rule enforces **all** attached policies (all-or-nothing [code]). Typical Blend-agent rule on the pool:
1. `pb_function_allowlist` — only `submit`, `claim`.
2. `pb_arg_guard` — `submit.requests[*].request_type ∈ {supply, withdraw}` (∀), and any non-USDC element denied.
3. `pb_call_cap` — cumulative USDC amount across `submit.requests[*].amount` filtered to USDC ≤ 500/day.
Plus the rule's own `valid_until` (expiry) and the grantee signer. That's 3 policies ≤ `MAX_POLICIES=5`. The paired USDC-token rule additionally uses `oz:spending_limit` for direct transfers. **Two budgets**, clearly separated, both stated in the risk report (Vol 09) — the honest answer to "does spending_limit cover Blend?" (no).

Ordering/independence: policies are order-independent within a rule (each panics or passes); no policy relies on another's side effects. Multi-tenant isolation is per-policy (§P04). Adding/removing signers does **not** notify pb policies — but only `pb_arg_guard`/`allowlist` are signer-agnostic; none of the four is threshold-based, so the drift hazard (EC-P01) does **not** apply to the pb library (a deliberate advantage over OZ threshold policies). If a rule also carries a threshold policy, the drift caveat is on that policy, and E1 sequences signer changes accordingly.

---

## 6. Example contract crates & getters

Each library crate has a sibling `*-contract` crate: `#[contract]` struct, `#[contractimpl] impl Policy for X` delegating to the library functions (exactly like `ThresholdPolicyContract` [code]), plus getters (`get_allowlist`, `get_arg_rules`, `get_call_cap_data`, `get_rate_limit_data`) that A1/A2 read via simulation (Vol 04 FN-A1.5). Getters are read-only, extend TTL on read.

WASM hashes of the audited builds are registered in the classification registry (Vol 04 FN-A1.4) so inspection can identify pb policies on-chain; an upgraded/forked deployment with a different hash is `unknown` (fail-closed, EC-A05).

---

## 7. Test matrix summary & self-checklist

Per policy: install-validation battery, enforce allow/deny battery with exact `#code` panics, TTL-extend-on-read, tenant isolation (accounts × rules), uninstall idempotence, require_auth full-path test (EC-G09), coverage ≥90%. Cross-policy: composition test on a fixture rule with allowlist+arg_guard+call_cap all installed, driving a real Blend-shaped `submit` through `enforce` on a fork (`T-P.compose-blend-submit`). Parity: `pb_arg_guard`/`pb_call_cap` path resolution shares fixtures with the TS `resolvePath` (FN-ST.22) so C2 pre-validation cannot disagree with on-chain enforcement.

Checklist:
- [x] Four policies fully specified: types, error ranges (no overlap with OZ [code]), semantics, events, TTL.
- [x] Deny-by-default on unresolved paths / empty ∀ (EC-P08/S16) is explicit in enforce semantics.
- [x] Multi-tenant `(account, rule_id)` keying everywhere (EC-P04).
- [x] `pb_call_cap` mirrors OZ `spending_limit` window/history/zero/overflow semantics (EC-P02/P10/S12/S13) but generalizes the amount source — the whole reason it exists.
- [x] pb library is threshold-free, so the drift hazard (EC-P01) is avoided by construction.
- [x] Composition example (Blend) shows ≤5 policies and the dual-budget story.
- [x] All tests named; all EC refs registered in Vol 10; getters wired for A1/A2 classification.
