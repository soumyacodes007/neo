# pb_function_allowlist

Parameterized Soroban policy for OpenZeppelin Stellar smart accounts. It permits only an explicit set of function names on the rule target contract and denies every other function.

## Install params

```rust
FunctionAllowlistParams {
    allowed: Vec<Symbol>,
}
```

Constraints:
- `allowed` must be non-empty.
- Maximum `allowed` length is `32`.
- The context rule must be `CallContract`.

## Enforcement

For a `Context::Contract`, `fn_name` must be present in `allowed`. Create-contract and other non-contract contexts deny by default.

Storage is keyed by `(smart_account, context_rule_id)`, so one deployed policy contract can serve many accounts and rules without tenant bleed.

## Errors

Error range: `3300-3319`.

- `3300` `SmartAccountNotInstalled`
- `3301` `AlreadyInstalled`
- `3302` `EmptyAllowlist`
- `3303` `FunctionNotAllowed`
- `3304` `OnlyCallContractAllowed`
- `3305` `TooManyFunctions`

## Build and test

```bash
cargo test --manifest-path rust/Cargo.toml -p stellar-pb-function-allowlist
cargo clippy --manifest-path rust/Cargo.toml -p stellar-pb-function-allowlist --all-targets -- -D warnings
stellar contract build --manifest-path rust/Cargo.toml
```

The deployed WASM hash is recorded in `rust/pb-wasm-hashes.json` under `pb:function_allowlist`.
