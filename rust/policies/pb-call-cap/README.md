# pb_call_cap

Parameterized Soroban policy for OpenZeppelin Stellar smart accounts. It enforces a rolling-window cumulative cap over amounts read from configurable function arguments.

This covers DeFi calls where the amount is not the SEP-41 `transfer(from,to,amount)` `arg[2]` shape, such as Blend `submit.requests[*].amount`.

## Install params

```rust
CallCapParams {
    cap: i128,
    period_ledgers: u32,
    fn_name: Symbol,
    amount_path: Vec<PathSeg>,
    token_filter_path: Vec<PathSeg>,
    token_filter_token: Option<Address>,
}
```

Constraints:
- `cap` must be positive.
- `period_ledgers` must be positive.
- The context rule must be `CallContract`.

## Enforcement

The policy applies only to `fn_name`. It resolves `amount_path`, sums all resolved amounts, optionally counts only elements matching `token_filter_token`, evicts old spend entries by ledger window, and denies if the projected total exceeds `cap`.

Zero amount passes without recording. Negative amounts, unresolved paths, overflow, and full history deny.

Storage is keyed by `(smart_account, context_rule_id)`, so one deployed policy contract can serve many accounts and rules without tenant bleed.

## Errors

Error range: `3340-3359`.

- `3340` `SmartAccountNotInstalled`
- `3341` `AlreadyInstalled`
- `3342` `InvalidLimitOrPeriod`
- `3343` `NotAllowed`
- `3344` `CapExceeded`
- `3345` `HistoryCapacityExceeded`
- `3346` `LessThanZero`
- `3347` `ArgPathUnresolved`
- `3348` `MathOverflow`
- `3349` `OnlyCallContractAllowed`

## Build and test

```bash
cargo test --manifest-path rust/Cargo.toml -p stellar-pb-call-cap
cargo clippy --manifest-path rust/Cargo.toml -p stellar-pb-call-cap --all-targets -- -D warnings
stellar contract build --manifest-path rust/Cargo.toml
```

The deployed WASM hash is recorded in `rust/pb-wasm-hashes.json` under `pb:call_cap`.
