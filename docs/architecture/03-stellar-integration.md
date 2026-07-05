# Volume 03 — Stellar Integration Layer

The `packages/stellar` package. Everything that touches the network or raw XDR lives here and nowhere else (Vol 01 §1). The tool layer (Vols 04–09) consumes these functions; it never calls `@stellar/stellar-sdk` directly. Every function here is either pure (XDR transforms) or effectful-but-injected (RPC via a `Deps.rpc` client), so tools stay testable with cassettes/fakes.

Package public surface groups: **RpcClient** (§1), **HistoryProvider** (§2), **XDR pipeline** (§3), **Ledger-key construction** (§4), **Digest & payload builder** (§5), **ScVal bridge** (§6), **Snapshot builder for forks** (§7).

FN IDs in this volume use `FN-ST.*`. Every FN lists a tests-first table; test IDs land in Vol 11's sequencing.

---

## 1. RpcClient (`src/rpc.ts`)

A thin, typed, retry-aware wrapper over Soroban RPC. One instance per network, injected as `Deps.rpc`.

### FN-ST.1 `RpcClient.create(network, endpoints, opts)`
- **Signature:** `(network: Network, endpoints: string[], opts?: {budget?: number; timeoutMs?: number}) => RpcClient`
- **Purpose:** Construct a client with an ordered failover list of RPC endpoints and a per-session request budget (EC-R03).
- **Algorithm:** validate endpoints are https; capture `budget` (default 2 000 requests/session); no network call at construction.
- **Errors:** `E_INPUT_SCHEMA` (bad endpoint URL).
- **Edge cases:** EC-R03 (budget), EC-R06 (network pinning — the client refuses calls whose artifacts declare a different network).
- **Tests:** `T-ST.1-1` unit: budget enforced (2001st call → `E_NET_BUDGET`); `T-ST.1-2` unit: non-https rejected.

### FN-ST.2 `RpcClient.getLatestLedger()`
- **Signature:** `() => Promise<{ sequence: LedgerSeq; protocolVersion: number; id: string }>`
- **Purpose:** Freshness anchor for snapshots, plan expiry, staleness checks.
- **Edge cases:** EC-M04 (protocolVersion surfaced so callers can detect skew).
- **Tests:** `T-ST.2-1` cassette: parses sequence/protocol.

### FN-ST.3 `RpcClient.getLedgerEntries(keys)`
- **Signature:** `(keys: xdr.LedgerKey[]) => Promise<{ latestLedger: LedgerSeq; entries: LedgerEntryResult[] }>` where `LedgerEntryResult = { key; xdr; liveUntilLedger?: LedgerSeq; state: "live"|"archived"|"absent" }`
- **Purpose:** The primary state-read primitive: account rules, contract code, contract instance, policy state, token metadata.
- **Algorithm:** (1) chunk `keys` into batches of ≤200 (RPC hard limit [web]); (2) issue batches; (3) **assert every batch response reports the same `latestLedger`** — if not, the reads straddle a ledger close and are torn (EC-R07): retry the whole set up to `MAX_TORN_RETRIES` (3), then `E_DATA_INCONSISTENT_SNAPSHOT`; (4) classify each requested key as `live` (returned + not expired), `archived` (returned with `liveUntilLedger < latestLedger` or RPC archived flag), or `absent` (not returned). [inference on archived flag exact shape — resolved by `T-ST.3-3` against a real archived entry]
- **Errors:** `E_NET_RPC_UNAVAILABLE`, `E_NET_RATE_LIMITED`, `E_DATA_INCONSISTENT_SNAPSHOT`.
- **Edge cases:** EC-A01 (batching), EC-A02/EC-R07 (torn reads), EC-A08/EC-X10 (archived classification), EC-B05 (never unbounded key lists — caller caps).
- **Tests:** `T-ST.3-1` unit: >200 keys chunked; `T-ST.3-2` unit: divergent `latestLedger` triggers retry then error; `T-ST.3-3` cassette: archived entry → `state:"archived"`; `T-ST.3-4` unit: absent key → `state:"absent"`.

### FN-ST.4 `RpcClient.getTransaction(hash)`
- **Signature:** `(hash: TxHash) => Promise<GetTxResult>` with `status: "SUCCESS"|"FAILED"|"NOT_FOUND"`
- **Purpose:** Single-tx fetch for `trace_transaction`.
- **Algorithm:** call RPC; map the three statuses to distinct outcomes (EC-R05): `NOT_FOUND` → `E_DATA_TX_NOT_FOUND` with a retention hint and (if enabled) a cross-network existence probe suggestion (EC-R06); `FAILED`/`SUCCESS` → return envelope+result+meta XDR with a `successful` flag.
- **Edge cases:** EC-R05, EC-R06, EC-X10 (meta may reference archived entries).
- **Tests:** `T-ST.4-1..3` cassettes for each status.

### FN-ST.5 `RpcClient.getTransactions(range, opts)`
- **Signature:** `(range: {startLedger: LedgerSeq}, opts?: {limit?: number; cursor?: string}) => AsyncIterable<TxRecord>`
- **Purpose:** Ledger-range scan (RPC-window HistoryProvider adapter).
- **Algorithm:** paginate with `limit ≤ 200` [web]; pin the scan to `[startLedger, endLedger]` captured before the first page; dedup by tx hash across pages; on cursor-invalid errors retry the page with the same bounds (EC-R02). Emits `E_HISTORY_WINDOW_EXCEEDED` if `startLedger` precedes the provider's `oldestLedger` (EC-R01).
- **Edge cases:** EC-R01, EC-R02.
- **Tests:** `T-ST.5-1` cassette: dedup across overlapping pages; `T-ST.5-2` unit: pre-oldest start → window error.

### FN-ST.6 `RpcClient.simulateTransaction(tx)`
- **Signature:** `(tx: Transaction) => Promise<SimResult>` (`{minResourceFee; sorobanData; results; auth: xdr.SorobanAuthorizationEntry[]; restorePreamble?; error?}`)
- **Purpose:** Fee/footprint discovery, auth-entry shape discovery for replay and plans, dry-run of install steps.
- **Algorithm:** call RPC `simulateTransaction`; surface `restorePreamble` (archived-entry restore needed) as a structured field, not a failure (EC-X10); parse `error` into `E_BUILD_SIMULATION_FAILED` with the diagnostic (used by D3, E1).
- **Edge cases:** EC-M03 (resources may drift; callers re-sim at submit), EC-G02 (auth order comes from here, never assumed).
- **Tests:** `T-ST.6-1` cassette: parses auth entries + fee; `T-ST.6-2` cassette: restorePreamble surfaced.

### FN-ST.7 `RpcClient.sendTransaction(signedXdr)` / `getTransactionStatus`
- **Purpose:** Submission (used only by F1 under its gates). Tracks by hash; supports fee-bump wrapper id (EC-L06).
- **Edge cases:** EC-M06 (sim success ≠ submit success), EC-L06.
- **Tests:** `T-ST.7-1` cassette: pending→success poll; `T-ST.7-2` cassette: failed with result parsed.

---

## 2. HistoryProvider (`src/history/`)

Interface + adapters for transaction lookback. Chosen because RPC retains only ~24 h of txs / ≤7 d of events (EC-R01), but Tier-2 needs 30 days.

### 2.1 Interface

```ts
interface HistoryProvider {
  readonly kind: "rpc" | "hubble" | "stellar_expert";
  coverage(): Promise<{ oldestLedger: LedgerSeq; newestLedger: LedgerSeq; asOf: string }>;
  txByHash(hash: TxHash): Promise<RawTx | null>;
  txsBySigner(params: { account: ContractId; signer?: SignerModel; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx>;
  txsByContract(params: { contract: ContractId; from: LedgerSeq; to: LedgerSeq }): AsyncIterable<RawTx>;
}
```

Every yielded `RawTx` carries `provider` and `asOfLedger` (EC-R04). A `MergingHistoryProvider` composes the available adapters: it prefers RPC for the freshest window and the deep-history adapter for the rest, labels each tx's provider, and returns a combined `coverage()` (EC-R04).

### FN-ST.8 `MergingHistoryProvider.txsBySigner(...)`
- **Algorithm:** compute the requested window; ask each adapter for its coverage; if the union does not cover the request → `E_HISTORY_WINDOW_EXCEEDED` unless `allow_partial` set, in which case return covered subset and stamp the actual window (EC-R01); scan freshest→oldest, dedup by hash across providers (RPC wins ties), yield sorted by ledger.
- **Edge cases:** EC-R01, EC-R04.
- **Tests:** `T-ST.8-1` unit: gap in union → window error; `T-ST.8-2` unit: partial flag stamps real window; `T-ST.8-3` unit: cross-provider dedup.

### 2.2 Adapters

- **RpcHistoryProvider** — wraps FN-ST.5; coverage = `[oldestLedger, latest]` from RPC health.
- **HubbleHistoryProvider** — BigQuery over SDF's public `crypto-stellar` dataset; ~30-min freshness [web]. Queries `history_transactions` + `history_contract_events` joined to reconstruct Soroban detail. Requires a Google credential in server config; absent → adapter reports zero coverage (not an error). Signer filtering: match `transaction.account`, and for Soroban auth, match decoded auth-entry address against the signer (post-fetch filter, since BQ doesn't index auth trees).
- **StellarExpertHistoryProvider** — REST fallback for contract-scoped history; rate-limited; coverage from its API. Used mainly for `txsByContract` deep history.

Edge cases across adapters: EC-R04 (freshness labels), EC-T08 (any address/symbol from these providers is untrusted → sanitized downstream). Tests: one cassette suite per adapter (`T-ST.hub-*`, `T-ST.exp-*`) plus a live `@network` smoke test excluded from default CI.

---

## 3. XDR decode pipeline (`src/xdr/`)

Pure functions. Input: base64 XDR strings. Output: SCH-typed JSON that is **lossless** (every leaf keeps its `xdr_b64`, INV-Trace-1).

### FN-ST.9 `decodeTransactionEnvelope(envelopeXdr)`
- **Signature:** `(envelopeXdr: XdrBase64) => DecodedEnvelope`
- **Purpose:** Top-level entry for `trace_transaction`; unwraps fee-bump, extracts ops, isolates the (single) InvokeHostFunction op.
- **Algorithm:** (1) size guard ≤ `MAX_XDR_BYTES` (1 MiB) else `E_DATA_MALFORMED_XDR` (EC-X04); (2) base64 hygiene normalize (EC-X11); (3) switch on envelope type — `TxFeeBump` → unwrap once, record `feeSource`, recurse one level only, reject nested fee-bump (EC-X01); (4) collect all operations into `operations[]` (EC-X06); (5) locate ≤1 `InvokeHostFunctionOp`; extract `hostFunction` + `auth: SorobanAuthorizationEntry[]`.
- **Errors:** `E_DATA_MALFORMED_XDR`.
- **Edge cases:** EC-X01, EC-X04, EC-X06, EC-X11.
- **Tests:** `T-ST.9-1` golden: fee-bump unwrap; `T-ST.9-2` golden: multi-op classic+soroban; `T-ST.9-3` unit: nested fee-bump rejected; `T-ST.9-4` unit: oversize rejected; `T-ST.9-5` property: base64 variants normalize to same result.

### FN-ST.10 `decodeInvocationTree(hostFunction)`
- **Signature:** `(hf: xdr.HostFunction) => InvocationNode`
- **Purpose:** Build the recursive `(contract, fn_name, args, sub_invocations)` tree (SCH-TransactionTrace §4).
- **Algorithm:** for `InvokeContract` → `{contract, fn_name, args: args.map(toScValJson)}`; for `CreateContract*` → synthesize a node tagged with executable/salt (EC-X09). Sub-invocations come from the auth tree (FN-ST.11), not the host function itself (the host function is only the root call); the "tree" of *observed* calls is reconstructed by walking the auth `rootInvocation` + `subInvocations`.
- **Edge cases:** EC-X09 (create-contract), EC-X02 (opaque ScVals via FN-ST.14).
- **Tests:** `T-ST.10-1` golden: nested invocation tree; `T-ST.10-2` golden: create-contract node.

### FN-ST.11 `decodeAuthEntries(authArray)`
- **Signature:** `(auth: xdr.SorobanAuthorizationEntry[]) => AuthEntryTrace[]`
- **Purpose:** Decode credentials (source-account vs address+nonce+expiration) and the `rootInvocation`/`subInvocations` tree per entry (SCH §4).
- **Edge cases:** EC-G07 (sub-invocation contexts must be captured — this is the source of them), EC-X05 (address kind in credentials).
- **Tests:** `T-ST.11-1` golden: address credentials with sub-invocations; `T-ST.11-2` golden: source-account credentials.

### FN-ST.12 `decodeMeta(resultMetaXdr, resultXdr)`
- **Signature:** `(meta?: XdrBase64, result?: XdrBase64) => { events: DecodedEvent[]; stateChanges: EntryDiff[]; success: boolean }`
- **Purpose:** Extract Soroban events and ledger-entry diffs for token-delta derivation.
- **Algorithm:** version-switch on `TransactionMeta` (V3/V4…) — unsupported version → `E_DATA_META_VERSION` with Hubble suggestion (EC-X03); extract `sorobanMeta.events`; extract `txChanges`/`operationChanges` for entry diffs; success from result code.
- **Edge cases:** EC-X03 (version drift), EC-X10 (diffs may reference archived entries — decode from meta bytes, don't re-read).
- **Tests:** `T-ST.12-1` golden meta V3; `T-ST.12-2` golden meta V4; `T-ST.12-3` unit: unknown version → error.

### FN-ST.13 `deriveTokenDeltas(events, stateChanges, enrich)`
- **Signature:** `(events, stateChanges, enrich: (token) => TokenMeta|undefined) => TokenDelta[]`
- **Purpose:** Turn transfer/mint/burn events (and, as fallback, balance-entry diffs) into `TokenDelta[]`.
- **Algorithm:** parse SAC-shaped events first (known layout, `to` may be muxed, data bare `i128`), then generic SEP-41, then raw (EC-X08); fall back to balance diffs when events absent, tagging `source:"meta"`; dedup by `(token, from, to, amount)` with event priority (INV-Trace-4). `enrich` looks up symbol/decimals but its failure only drops metadata, never the delta (EC-X10).
- **Edge cases:** EC-X05, EC-X08, EC-X07 (i128 via BigInt), EC-X10.
- **Tests:** `T-ST.13-1` golden SAC transfer; `T-ST.13-2` golden custom-token; `T-ST.13-3` unit: event/meta dedup; `T-ST.13-4` property: i128 bounds.

---

## 4. Ledger-key construction (`src/keys.ts`)

Constructs the exact `xdr.LedgerKey`s for reading OZ smart-account storage, so A1/A2 can enumerate rules without an indexer. Grounded in the verified storage layout [code storage.rs:26-54].

### FN-ST.14 (see §6) — ScVal bridge is a dependency here.

### FN-ST.15 `accountInstanceKey(account)` and `contractCodeKey(wasmHash)`
- **Purpose:** Read the account's instance storage (holds `NextId`, `Count`, `NextSignerId`, `NextPolicyId` as `SmartAccountStorageKey` variants) and the account's WASM code.
- **Algorithm:** `LedgerKey::ContractData{contract: account, key: ScVal::Vec[Symbol("...")], durability: Persistent/Instance}` — the smart-account keys are a `#[contracttype] enum`, which encodes as an ScVal vec `[Symbol(variant), ...args]`. `NextId`/`Count`/etc. are unit variants → `ScVal::Vec[Symbol("NextId")]` in **instance** storage [code storage.rs:642 uses `instance()`]. `ContractRuleData(id)` is a 1-arg variant → `ScVal::Vec[Symbol("ContextRuleData"), U32(id)]` in **persistent** storage [code storage.rs:668]. [inference on exact ScVal encoding of the enum — pinned by golden test `T-ST.15-3` decoding a real fixture account created from `examples/multisig-smart-account`]
- **Edge cases:** EC-A03 (if these keys are absent/garbage, the account isn't an OZ account — fingerprint fails).
- **Tests:** `T-ST.15-1` unit: instance key bytes match SDK encoding; `T-ST.15-2` unit: persistent `ContextRuleData(id)` key; `T-ST.15-3` golden against a deployed fixture (round-trips to the on-chain value).

### FN-ST.16 `contextRuleDataKeys(account, ids)` / `signerDataKey` / `policyDataKey`
- **Purpose:** Batch keys for `ContextRuleData(0..NextId)`, `SignerData(id)`, `PolicyData(id)` [code storage.rs:31-53].
- **Edge cases:** EC-A01 (batch ≤200), EC-A02 (gaps = removed rules).
- **Tests:** `T-ST.16-1` unit: 0..N key set; `T-ST.16-2` golden decode of a `ContextRuleEntry`.

### FN-ST.17 `decodeContextRuleEntry(scval)` / `decodeSignerEntry` / `decodePolicyEntry`
- **Purpose:** Decode the stored `#[contracttype]` structs [code storage.rs:60,74,84] back into SCH types.
- **Algorithm:** map ScVal struct fields to `ContextRuleEntry{name, context_type, valid_until, signer_ids, policy_ids}`; `context_type` is the `ContextRuleType` enum → discriminated union (§SCH-ContextRuleModel). Resolve `signer_ids`/`policy_ids` to full members via SignerData/PolicyData reads (A1 orchestrates).
- **Edge cases:** EC-X02 (unknown fields → fail closed, not silently dropped).
- **Tests:** `T-ST.17-1..3` goldens for each struct; `T-ST.17-4` unit: unexpected shape → `E_DATA_MALFORMED_XDR`.

---

## 5. Digest & AuthPayload builder (`src/auth.ts`)

The single implementation of the OZ auth-signing contract. Used by replay (D3), plan digest notes (E1), and any wallet integration. Getting this wrong is EC-G01.

### FN-ST.18 `computeAuthDigest(signaturePayload, contextRuleIds)`
- **Signature:** `(signaturePayload: Buffer /*32*/, contextRuleIds: number[]) => Buffer /*32*/`
- **Purpose:** Compute exactly `sha256(signature_payload ‖ context_rule_ids.to_xdr())` [code storage.rs:492-495].
- **Algorithm:** serialize `contextRuleIds` as the XDR of `Vec<u32>` (soroban `ScVal::Vec` of `U32`? — **no**: it is the host `Vec<u32>` value's `to_xdr`, matching `signatures.context_rule_ids.clone().to_xdr(e)`; encode as the SDK's `Vec<u32>` XDR); concat payload‖that; SHA-256. [inference on exact `Vec<u32>.to_xdr` framing — pinned by a fork round-trip test that signs with this digest and passes `__check_auth`, `T-ST.18-2`]
- **Edge cases:** EC-G01 (the whole point), EC-G02 (ids order).
- **Tests:** `T-ST.18-1` golden: known payload+ids → known digest (cross-checked against a Rust helper compiled from the same formula); `T-ST.18-2` fork: signature over this digest authenticates on a real fixture account; `T-ST.18-3` fork: signature over the raw payload (wrong) fails, with the mismatch diagnostic (EC-G01).

### FN-ST.19 `buildAuthPayload(signersToSig, contextRuleIds)`
- **Signature:** `(signers: Map<SignerModel, Buffer>, contextRuleIds: number[]) => xdr AuthPayload`
- **Purpose:** Construct the `AuthPayload{signers, context_rule_ids}` value (SCH §glossary) for `__check_auth`.
- **Algorithm:** validate `signers.length == contextRuleIds` alignment is **not** required (signers is a map; ids align with contexts); filter signatures to signers present in the selected rules (EC-G06 — drop extras with a warning); encode.
- **Edge cases:** EC-G06 (extra signers rejected on-chain 3016), EC-G10 (single digest covers all contexts).
- **Tests:** `T-ST.19-1` unit: extras filtered; `T-ST.19-2` fork: built payload authenticates a 2-context tx.

### FN-ST.20 `mapContextsToRuleIds(simulatedContexts, ruleset)`
- **Signature:** `(contexts: Context[], selection: (ctx) => number) => number[]`
- **Purpose:** Produce the `context_rule_ids` vector aligned by index with the **simulated** context order (never assumed) [code storage.rs:468].
- **Edge cases:** EC-G02 (alignment), EC-G07 (must include sub-invocation contexts).
- **Tests:** `T-ST.20-1` unit: order taken from sim; `T-ST.20-2` fork: shuffled selection → length-mismatch/UnvalidatedContext.

### FN-ST.21 `buildDelegatedAuthEntry(account, digest, signerAddress)`
- **Purpose:** For `Delegated(Address)` signers, construct the nested `SorobanAuthorizationEntry` that `require_auth_for_args((digest,))` expects [code storage.rs:353-356], which simulation can't auto-produce for custom accounts (EC-G08, CAP-71 [docs]).
- **Edge cases:** EC-G08.
- **Tests:** `T-ST.21-1` fork: delegated signer authenticates via the built entry.

---

## 6. ScVal bridge (`src/scval.ts`)

The **only** module permitted the unsound-looking narrowing of `xdr.ScVal` (Vol 01 §2.2); 100% branch coverage mandated.

### FN-ST.14 `toScValJson(scval)` / `fromScValJson(json)`
- **Purpose:** Lossless, total conversion between `xdr.ScVal` and `ScValJson` (`{type, value, xdr_b64}`).
- **Algorithm:** exhaustive switch over ScVal variants (bool/void/u32/i32/u64/i64/u128/i128/u256/i256/bytes/string/symbol/vec/map/address/nonce/…); i128/u256 etc. rendered as decimal strings via BigInt (EC-X07); **unknown/future variants → `{type:"opaque", value:null, xdr_b64}`** with a default arm, never a throw (EC-X02). `fromScValJson` reconstructs from typed value, or re-decodes from `xdr_b64` for `opaque` (exact bytes preserved).
- **Edge cases:** EC-X02, EC-X07, EC-X05 (address variant preserves strkey kind).
- **Tests:** `T-ST.14-1` property: `fromScValJson(toScValJson(x)) === x` for all generated ScVals including nested maps; `T-ST.14-2` unit: opaque variant round-trips bytes; `T-ST.14-3` unit: i128 extremes; `T-ST.14-4` coverage gate: every variant arm hit.

### FN-ST.22 `resolvePath(scval, path)`
- **Signature:** `(root: ScValJson, path: JsonPathLite) => ScValJson[]` (∀ semantics for `[*]`)
- **Purpose:** Resolve `$.requests[*].amount`-style paths into ScVal leaves for arg predicates / call caps (Blend request vectors, EC-S16). Mirrors the on-chain path logic pb policies will implement (Vol 07) so TS pre-validation and Rust enforcement agree.
- **Algorithm:** parse path (already regex-constrained, SCH-PolicyIntent); walk vec/map/struct nodes; `[*]` yields all elements; missing key/index → empty result (caller decides: pre-validation failure vs deny). Bounded depth.
- **Edge cases:** EC-P08 (unresolved path → caller denies), EC-S16 (∀ over vectors).
- **Tests:** `T-ST.22-1` unit: `[*]` fans out; `T-ST.22-2` unit: missing path → empty; `T-ST.22-3` unit: parity with a Rust reference vector (shared fixture with Vol 07).

---

## 7. Fork-snapshot builder (`src/snapshot.ts`)

Bridges to the Rust fork harness (Vol 08). TS side computes *which* addresses must be in the snapshot; the actual `stellar snapshot create` runs in the sandbox (no network in the container, so the snapshot is fetched here first — EC-B02).

### FN-ST.23 `deriveSnapshotAddressSet(evidence, ruleset, accountSnapshot)`
- **Purpose:** Compute the complete address set a fork test must include: the account, every target contract, every token, every policy contract (existing + to-be-deployed placeholders), and every verifier referenced by signers (EC-M02).
- **Algorithm:** union addresses from trace invocations, token deltas, candidate-rule targets/tokens/policies, and signer verifiers; dedup; return sorted list.
- **Edge cases:** EC-M02 (incomplete footprint → fork test error not fail).
- **Tests:** `T-ST.23-1` unit: derives token+pool+verifier from a Blend trace.

### FN-ST.24 `createSnapshot(addresses, atLedger)`
- **Purpose:** Run `stellar snapshot create --address ... --ledger ... --output json` (outside the network-jailed build container, on the host with network), producing `snapshot.json` for `Env::from_ledger_snapshot_file` [web].
- **Algorithm:** invoke CLI via `sandbox`'s host-side runner; record the ledger; write into the session workspace (jailed, EC-B03); stamp `snapshot_hash` inputs.
- **Edge cases:** EC-M01 (staleness — ledger recorded), EC-M05 (testnet reset — missing address → clear error), EC-B07 (workspace on Linux FS not `/mnt/c`).
- **Tests:** `T-ST.24-1` integration (@network): snapshot of the fixture account loads in a Rust test; `T-ST.24-2` unit: address set passed through faithfully (CLI mocked).

---

## 8. Cross-cutting concerns

- **Retry/backoff** (FN wrapper `withRpcRetry`): bounded exponential backoff + jitter from injected entropy (deterministic in tests), respects the session budget, distinguishes retryable (`E_NET_*`) from terminal. EC-R03. Test `T-ST.retry-1`.
- **Address kind guards** (`assertContractId`/`assertAccountId`/`normalizeMuxed`): every public FN validates strkey kinds it requires; conversions explicit. EC-X05, EC-A04, EC-T06. Tests `T-ST.addr-*`.
- **Sanitization boundary**: any human-facing string that originated on-chain (rule names via A1, symbols via enrich, spec text via B2) passes through `sanitizeChainString` **at the consuming volume**, not here — but this package never interpolates such strings into anything executable. EC-T01, EC-T05.

## 9. Self-checklist

- [x] Every FN has signature, algorithm, error codes, EC refs, tests-first table.
- [x] The digest formula has a single implementation (FN-ST.18) cited by E1/D3; wrong-preimage failure is a first-class test (EC-G01).
- [x] Ledger-key construction grounded in verified storage layout [code], with golden tests against a real fixture pinning the `[inference]` ScVal encodings.
- [x] Torn-read, archived-entry, fee-bump, meta-version, i128, muxed, opaque-ScVal edge cases all owned by a test here.
- [x] No function in this package emits model-facing prose or executes generated code (separation from sandbox/explain).
