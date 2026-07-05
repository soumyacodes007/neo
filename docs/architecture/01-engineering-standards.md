# Volume 01 — Engineering Standards

Binding standards for all code in this project. Two languages, two rulebooks, one principle: **the tool layer must be deterministic, testable, and boring.**

Sources: the OZ repo's own checklist `stellar-contracts/.claude/commands/code-quality.md` (Rust — adopted verbatim where applicable, adapted where our crates differ), stellar-contracts `CLAUDE.md`, and current TypeScript/MCP community practice ([typescript-eslint strict presets, strict tsconfig guidance](https://blog.logrocket.com/typescript-at-scale-2026/), [MCP TS SDK server guidance](https://github.com/modelcontextprotocol/typescript-sdk)).

---

## 1. Repository layout (pnpm monorepo + cargo workspace)

```
oz-policy-builder/
├── package.json                  # pnpm workspace root; no runtime deps here
├── pnpm-workspace.yaml
├── tsconfig.base.json            # shared strict compiler options
├── eslint.config.mjs             # flat config, typescript-eslint strict-type-checked
├── packages/
│   ├── mcp-server/               # thin bootstrap: transport + tool registration ONLY
│   ├── core/                     # pure domain logic (schemas, synthesis, matching, bypass math)
│   ├── stellar/                  # RPC client, XDR pipeline, HistoryProvider adapters
│   ├── sandbox/                  # Docker/native runner, compile & test execution
│   ├── plans/                    # install/revocation plan construction, hashing, approval tokens
│   └── explain/                  # deterministic renderers (policy diff, risk report, plain English)
├── rust/
│   ├── Cargo.toml                # cargo workspace
│   ├── policies/
│   │   ├── pb-function-allowlist/
│   │   ├── pb-arg-guard/
│   │   ├── pb-call-cap/
│   │   └── pb-rate-limit/
│   ├── templates/                # codegen templates (askama-style .rs.tmpl + manifest)
│   ├── harness/                  # generated-test scaffolding, fork-test helpers
│   └── fixtures/                 # fixture account/token/mock contracts for tests
├── docker/
│   └── sandbox.Dockerfile        # pinned rust + stellar-cli + wasm32v1-none image
├── skills/claude/                # the Claude skill package
└── docs/                         # this spec + user docs + walkthroughs
```

Rules:
- `mcp-server` may import from every package; nothing imports from `mcp-server`. `core` imports **nothing** network- or fs-facing (pure functions + zod only). `stellar`/`sandbox`/`plans` may import `core`. This is enforced by `eslint-plugin-import` `no-restricted-imports` rules per package.
- TS project references (`composite: true`) across packages for incremental builds.
- One version of `@stellar/stellar-sdk` pinned at the root; no per-package overrides.
- Rust crates in `rust/` are a separate cargo workspace, **not** built by pnpm; the `sandbox` package invokes them via the pinned Docker image (or native fallback) only.

---

## 2. TypeScript standards

### 2.1 Compiler (`tsconfig.base.json`)

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,     // arr[i] is T | undefined — mandatory
    "exactOptionalPropertyTypes": true,   // no `{x?: T}` assigned `{x: undefined}`
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,   // default under strict; relied upon
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "composite": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

No `tsconfig` may weaken a base option. `skipLibCheck: true` is allowed (upstream `.d.ts` noise) — nothing else.

### 2.2 Lint

- Flat config with `typescript-eslint` presets `strictTypeChecked` + `stylisticTypeChecked`.
- Hard-error rules (non-negotiable): `no-explicit-any`, `no-unsafe-*` family, `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, `prefer-nullish-coalescing`, `restrict-template-expressions`.
- `any` is banned. Escape hatch is `unknown` + a zod parse or a hand-written type guard. XDR objects from `@stellar/stellar-sdk` are typed via the SDK's types; where the SDK returns loosely-typed values (`xdr.ScVal`), conversion goes through one dedicated module (`packages/stellar/src/scval.ts`) — the only file allowed to do unsound-looking narrowing, and it is 100% branch-covered.
- `eslint-disable` comments require a trailing `-- reason` and are reviewed like `unsafe` blocks; CI counts them and fails if the count rises without a changelog note.

### 2.3 Zod as the single source of truth

- Every tool input/output, every persisted artifact, every cross-package DTO is a zod schema in `packages/core/src/schemas/` (Vol 02 specifies each). TS types are derived (`z.infer`), never written by hand.
- Every field carries `.describe()` — descriptions ship to the model as JSON Schema and double as documentation [web: MCP SDK].
- Tool registration converts zod → JSON Schema once at startup; the same schema object validates at runtime. **Parse, don't validate**: handlers receive parsed, branded types.
- Branded primitives (zod `.brand<>()`): `ContractId` (C-strkey), `AccountId` (G-strkey), `MuxedId` (M-strkey), `WasmHash` (32-byte hex), `TxHash`, `LedgerSeq` (uint32), `Amount` (decimal string matching `/^\d+(\.\d+)?$/` + separate `decimals` field — **never** JS `number` for amounts; see EC-X07), `XdrBase64`. Constructors are the only way to mint them.
- Schema evolution: additive fields optional + defaulted; breaking changes bump `schema_version` (Vol 02 §12); parsers accept N and N−1.

### 2.4 Tool handler pattern (thin server, thick core)

```ts
// packages/mcp-server/src/tools/trace-transaction.ts
server.registerTool("trace-transaction", {
  description: "...written for the model: when to use, what it returns...",
  inputSchema: TraceTransactionInput,     // zod, from core
  outputSchema: TransactionTrace,         // zod, from core
}, withToolBoundary("trace-transaction", async (input, ctx) =>
  traceTransaction(input, ctx.deps)       // pure-ish core fn, deps injected
));
```

- `withToolBoundary` is the single wrapper that: validates output against the schema before returning; maps thrown `ToolError` to the structured error envelope; maps *unexpected* exceptions to `E_INTERNAL` with a correlation id (never a stack trace to the model); records timing/audit logs.
- Handlers never construct network clients — all effects arrive via an injected `Deps` object (`rpc`, `history`, `sandbox`, `clock`, `workspace`), making every tool testable with in-memory fakes.
- Tool names are kebab-case on the wire; internal groups keep the A1–F1 spec IDs in doc comments.

### 2.5 Error taxonomy

Structured error envelope (never a bare string):

```ts
{ error: { code: "E_HISTORY_WINDOW_EXCEEDED", message: "...human sentence...",
           details?: {...},              // machine-usable, schema'd per code
           retryable: boolean,
           suggestion?: "..." } }        // what the model/user can do next
```

Reserved code families (extended per-tool in Vols 03–09; registry lives in `packages/core/src/errors.ts`):

| Family | Examples | Meaning |
|--------|----------|---------|
| `E_INPUT_*` | `E_INPUT_SCHEMA`, `E_INPUT_ADDRESS_KIND` | Caller (model) sent invalid/mismatched input |
| `E_NET_*` | `E_NET_RPC_UNAVAILABLE`, `E_NET_RATE_LIMITED` | Upstream transient; `retryable: true` |
| `E_DATA_*` | `E_DATA_TX_NOT_FOUND`, `E_HISTORY_WINDOW_EXCEEDED`, `E_DATA_ENTRY_ARCHIVED` | Requested data not available; suggestion names alternate provider |
| `E_DOMAIN_*` | `E_RULE_NOT_FOUND`, `E_UNSATISFIABLE_BY_CONTEXT`, `E_POLICY_SEMANTICS_UNPROVABLE` | Valid request, domain says no — the honest-failure channel |
| `E_BUILD_*` | `E_BUILD_COMPILE_FAILED`, `E_BUILD_TIMEOUT`, `E_BUILD_SANDBOX_UNAVAILABLE` | Sandbox/compilation outcomes with structured diagnostics |
| `E_GATE_*` | `E_GATE_SUBMIT_DISABLED`, `E_GATE_TOKEN_MISMATCH`, `E_GATE_STALE_ARTIFACTS` | Approval machinery refusals — **never retryable by the model alone** |
| `E_INTERNAL` | — | Bug; correlation id logged |

### 2.6 Determinism rules

- Banned in `core`: `Date.now`, `Math.random`, `crypto.randomUUID`, locale-dependent APIs, object-key iteration order dependence. Time comes from injected `clock` (only `plans`/`sandbox` may use it, for timestamps recorded *in* artifacts, never for logic branching); randomness only for `approval_token` generation in `plans` via injected `entropy`.
- Canonical JSON everywhere a hash is computed: RFC 8785 (JCS)-style serialization implemented once in `core/src/canonical.ts`; `ruleset_hash`/`plan_hash` = SHA-256 over canonical bytes (Vol 02 §11).
- All collections in outputs are sorted by a documented key (e.g. rules by `id`, constraints by `(kind, target)`), so byte-identical reruns are testable (acceptance criterion #4 of the parent plan).
- Network nondeterminism is quarantined: tools that read chain state stamp `ledger` + `taken_at` into the artifact; downstream tools consume the artifact, not the network, wherever possible.

### 2.7 Logging & audit

- `pino` JSON logs to stderr (stdout is the MCP stdio transport — **never** write logs to stdout). Levels: `info` per tool call (name, input hash, duration, outcome code), `debug` gated by env.
- Append-only audit file per session in the workspace dir: every tool invocation with input/output hashes; F1 additionally records the full plan hash + token check result. No secrets, no key material, no full XDR bodies at `info`.

### 2.8 Testing (vitest)

- Layout: `src/foo.ts` ↔ `src/foo.test.ts` colocated; `test/golden/` for fixture files; `test/integration/` per package.
- Kinds used in tests-first tables (Vols 03–09): **unit** (pure logic, fakes), **property** (fast-check generators, e.g. lattice laws, canonical-JSON idempotence), **golden** (decoded-XDR fixtures → expected JSON snapshots, reviewed by hand once), **integration** (against a local RPC container or recorded HTTP cassettes — cassettes are committed, refresh is a manual script), **e2e** (testnet, tagged `@network`, excluded from default CI).
- Coverage gates: `core` 95% lines/branches; other TS packages 85%; enforced by `vitest --coverage` in CI.
- Every `E_*` code has at least one test asserting it is produced by the documented condition.
- Snapshot tests are allowed only for `explain` renderer output and golden XDR decodes; logic assertions must be explicit.

---

## 3. Rust standards

### 3.1 For `pb_*` policy contracts — the OZ checklist applies verbatim

These crates are written as if they were PRs to `OpenZeppelin/stellar-contracts` (they are intended for upstream review). The full `code-quality.md` checklist is adopted; the load-bearing items restated:

- **Module shape**: `mod.rs` (docstring → `mod` decls → grouped `use` → `pub use` re-exports → `#[contracttrait]` trait → `ERRORS` → `CONSTANTS` → `EVENTS` sections with the canonical 18-hash delimiters) + `storage.rs` (`QUERY STATE` / `CHANGE STATE` / `LOW-LEVEL HELPERS`) + `test.rs` behind `#[cfg(test)] mod test;` starting with `extern crate std;`.
- **`#![no_std]`** library crates; `crate-type = ["lib", "cdylib"]`, `doctest = false`; workspace-inherited fields; `[package.metadata.stellar] cargo_inherit = true`.
- **Errors**: `#[contracterror]`, `#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]`, `#[repr(u32)]`. **Allocated ranges for this project** (existing accounts ranges are smart_account 3000–3016, simple_threshold 3200–3203, weighted_threshold 3210–3214, spending_limit 3220–3227 [code]): `pb_function_allowlist` **3300–3319**, `pb_arg_guard` **3320–3339**, `pb_call_cap` **3340–3359**, `pb_rate_limit` **3360–3379**, codegen'd custom policies **3400–3499** (template fixes the enum name `GeneratedPolicyError`).
- **Panics**: `panic_with_error!(e, Error::Variant)` only; no bare `panic!`/`unwrap()` outside tests; `expect("...")` messages state *why* the invariant holds.
- **Storage/TTL**: three tiers used intentionally; persistent policy state keyed `AccountContext(Address, u32)` (smart account, context rule id) exactly like OZ's policies [code: spending_limit.rs:145]; extend-on-read with the trio `const DAY_IN_LEDGERS / *_EXTEND_AMOUNT / *_TTL_THRESHOLD`, argument order `(&key, TTL_THRESHOLD, EXTEND_AMOUNT)`.
- **Events**: `#[contractevent]` structs, `#[topic]` fields first, paired `pub fn emit_*` helpers in `mod.rs`; storage layer never calls `.publish` directly.
- **Docs**: `# Arguments → # Errors → # Events → # Notes → # Security Warning` order; module docstring explains design; `cargo doc --no-deps` clean.
- **Auth**: `install/enforce/uninstall/set_*` all `smart_account.require_auth()` (mirrors OZ policies [code]); never `require_auth()` twice on one address per invocation.
- **No `#[allow(...)]`** — fix or escalate.
- **Tests**: `Env::default()`, `e.mock_all_auths()` except when testing auth machinery itself; event assertions via typed struct `.to_xdr(&e, &address)`; panic tests use `#[should_panic(expected = "Error(Contract, #3341)")]` numeric form; ≥90% line coverage (`cargo llvm-cov --fail-under-lines 90`).
- **Toolchain**: `cargo +nightly fmt --all -- --check` (repo rustfmt style: `imports_granularity="Crate"`, `group_imports="StdExternalCrate"`), `cargo clippy --release --locked --all-targets -- -D warnings`, `cargo build --target wasm32v1-none --release` per crate.

### 3.2 For codegen templates & generated code

- Templates are complete, compiling contracts with **delimited holes**: `// >>> GENERATED: <constraint-id>` ... `// <<< GENERATED`. Everything outside the markers is frozen template text covered by the template's own test suite; the AI repair loop (Vol 08) may only edit inside markers — enforced by a diff guard in the sandbox runner, not by trust.
- Generated crates get **zero third-party dependencies** beyond `soroban-sdk` and (optionally) `stellar-accounts` — no `build.rs`, no proc-macro deps (supply-chain surface; see EC-B04). `Cargo.toml` is emitted from a fixed template with pinned versions matching the sandbox image.
- Generated code must pass the same fmt/clippy/coverage gates as handwritten code; the mutation battery (Vol 08) is the semantic gate.
- Every generated check carries a comment `// constraint: <constraint-id> — <one-line semantics>` linking back to `codegen_manifest.json`.

### 3.3 For the test harness crate

- `std` allowed (it's host-side test code). May depend on `soroban-sdk` testutils and read `snapshot.json` fixtures. No network access at test time — snapshots are fetched by the TS `sandbox` package *before* the container runs (container has no egress; EC-B02).

---

## 4. Sandbox & CI pipeline

### 4.1 Sandbox image (`docker/sandbox.Dockerfile`)

- Base: pinned digest of `rust:<ver>-slim`. Adds: `wasm32v1-none` target, pinned `stellar-cli`, pinned `cargo-llvm-cov`, nightly rustfmt component, vendored crates.io mirror for the allowed dependency set (offline builds: `--locked --offline`).
- Runtime contract (enforced by the `sandbox` runner): no network (`--network none`), read-only image, workspace mounted at `/work` (the only writable path), CPU/memory/pids limits, wall-clock timeout per phase (check 120 s, build 300 s, test 600 s — tunable constants), non-root user.
- Native fallback (no Docker): same commands via local toolchain **iff** versions match the pinned manifest, else `E_BUILD_SANDBOX_UNAVAILABLE` with instructions — never silently build with a drifted toolchain (EC-B01).

### 4.2 CI (GitHub Actions)

Jobs: (1) TS: install → typecheck (`tsc -b`) → lint → unit+property+golden → coverage gates; (2) TS integration with cassettes; (3) Rust: fmt-check → clippy `-D warnings` → test → llvm-cov ≥90 → wasm builds per crate; (4) sandbox image build + smoke test (compile the fixture policy inside it); (5) cross-ref integrity: script greps docs for dangling `EC-`/`FN-`/`T-`/`SCH-` IDs (spec acceptance); (6) determinism check: run `synthesize_ruleset` golden corpus twice, byte-compare. `@network` e2e runs nightly against testnet, not per-PR.

---

## 5. Security-relevant coding rules (both languages)

1. **No key material, ever.** No API accepts a secret key; grep-guard in CI for `SecretKey|fromSecret|S[A-Z0-9]{55}` in non-test TS code.
2. **On-chain strings are attacker input.** Rule names, token symbols/names, event payloads are rendered only through escaping formatters and are length-clamped in explanations; they must never be interpolated into prompts/templates as instructions (EC-T01, EC-T02).
3. **Address kind discipline.** C/G/M strkeys are distinct branded types; conversion is explicit; every tool validates the kind it needs (`E_INPUT_ADDRESS_KIND`).
4. **Amounts are `i128`-ranged decimal strings + `decimals`.** JS `number` for chain amounts is a lint error (custom rule) — 2^53 < i128 max (EC-X07).
5. **Workspace jail.** All file writes go through `workspace.write(relPath)` which resolves + verifies the path stays inside the session dir (EC-B03).
6. **Fail closed.** Unknown policy WASM, unknown context variants, unknown ScVal types → explicit `UNKNOWN`/error outcomes, never best-effort guesses presented as facts.

---

## 6. Session-1 self-checklist

- [x] TS standards traceable to cited sources; Rust standards traceable to `code-quality.md` items.
- [x] Error-code families named; per-tool codes deferred to Vols 03–09 by design.
- [x] pb error ranges chosen against verified existing ranges [code].
- [x] Determinism/banned-API list matches parent-plan acceptance criterion #4.
- [x] All ECs referenced here (X07, B01–B04, T01–T02) are registered in Vol 10.
