# pb_rate_limit

Parameterized Soroban policy for OpenZeppelin Stellar smart accounts. It caps the number of authorized calls in a rolling ledger window, optionally scoped to one function.

## Install params

```rust
RateLimitParams {
    max_calls: u32,
    period_ledgers: u32,
    fn_scope: Option<Symbol>,
}
```

Constraints:
- `max_calls` must be positive.
- `period_ledgers` must be positive.
- The context rule must be `CallContract`.

## Enforcement

If `fn_scope` is set and the current function is different, the policy is out of scope and passes. Otherwise it evicts calls outside the rolling window and denies when the next call would exceed `max_calls`.

Storage is keyed by `(smart_account, context_rule_id)`, so one deployed policy contract can serve many accounts and rules without tenant bleed.

## Errors

Error range: `3360-3379`.

- `3360` `SmartAccountNotInstalled`
- `3361` `AlreadyInstalled`
- `3362` `InvalidParams`
- `3363` `RateLimitExceeded`
- `3364` `HistoryCapacityExceeded`
- `3365` `NotAllowed`
- `3366` `OnlyCallContractAllowed`

## Build and test

```bash
cargo test --manifest-path rust/Cargo.toml -p stellar-pb-rate-limit
cargo clippy --manifest-path rust/Cargo.toml -p stellar-pb-rate-limit --all-targets -- -D warnings
stellar contract build --manifest-path rust/Cargo.toml
```

The deployed WASM hash is recorded in `rust/pb-wasm-hashes.json` under `pb:rate_limit`.
