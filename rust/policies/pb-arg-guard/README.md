# pb_arg_guard

Parameterized Soroban policy for OpenZeppelin Stellar smart accounts. It enforces per-function argument predicates with JSONPath-lite path resolution and vector wildcard fan-out.

## Install params

```rust
ArgGuardParams {
    rules: Vec<ArgRule>,
}

ArgRule {
    fn_name: Symbol,
    arg_index: u32,
    path: Vec<PathSeg>,
    pred: Predicate,
    forall: bool,
}
```

Supported predicates:
- `U32Eq`
- `U32In`
- `Range`
- `AddrEq`
- `AddrIn`

Supported path segments:
- `Field(Symbol)`
- `Index(u32)`
- `Wildcard`

Constraints:
- `rules` must be non-empty.
- Maximum `rules` length is `32`.
- The context rule must be `CallContract`.

## Enforcement

Rules apply only when `fn_name` matches the current contract context. Missing argument indexes, unresolved paths, empty wildcard fan-outs, and type mismatches deny by default. Functions without a matching `ArgRule` are out of scope for this policy and should be paired with `pb_function_allowlist`.

Storage is keyed by `(smart_account, context_rule_id)`, so one deployed policy contract can serve many accounts and rules without tenant bleed.

## Errors

Error range: `3320-3339`.

- `3320` `SmartAccountNotInstalled`
- `3321` `AlreadyInstalled`
- `3322` `EmptyRules`
- `3323` `ArgIndexOutOfRange`
- `3324` `ArgPathUnresolved`
- `3325` `PredicateFailed`
- `3326` `TypeMismatch`
- `3327` `TooManyRules`
- `3328` `OnlyCallContractAllowed`

## Build and test

```bash
cargo test --manifest-path rust/Cargo.toml -p stellar-pb-arg-guard
cargo clippy --manifest-path rust/Cargo.toml -p stellar-pb-arg-guard --all-targets -- -D warnings
stellar contract build --manifest-path rust/Cargo.toml
```

The deployed WASM hash is recorded in `rust/pb-wasm-hashes.json` under `pb:arg_guard`.
