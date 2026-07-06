#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/fixtures/testnet"
OUT_FILE="$OUT_DIR/pb-policy-deployments.json"
STELLAR_BIN="${STELLAR_BIN:-stellar}"
SOURCE_ACCOUNT="${SOURCE_ACCOUNT:-ozpb-feepayer}"
NETWORK="${NETWORK:-testnet}"

if ! command -v "$STELLAR_BIN" >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/stellar" ]; then
    STELLAR_BIN="$HOME/.local/bin/stellar"
  else
    echo "stellar CLI not found on PATH" >&2
    exit 1
  fi
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required" >&2
  exit 1
fi

cd "$ROOT_DIR"
"$STELLAR_BIN" contract build --manifest-path rust/Cargo.toml >/dev/null

if ! "$STELLAR_BIN" keys public-key "$SOURCE_ACCOUNT" >/dev/null 2>&1; then
  "$STELLAR_BIN" keys generate "$SOURCE_ACCOUNT" --network "$NETWORK" >/dev/null
fi
"$STELLAR_BIN" keys fund "$SOURCE_ACCOUNT" --network "$NETWORK" >/dev/null
FEEPAYER="$("$STELLAR_BIN" keys public-key "$SOURCE_ACCOUNT")"

STAMP="$(date -u +%Y%m%d%H%M%S)"

deploy_one() {
  local classification="$1"
  local wasm="$2"
  local alias="ozpb-${classification//:/-}-$STAMP"
  local address
  address="$("$STELLAR_BIN" contract deploy \
    --network "$NETWORK" \
    --source-account "$SOURCE_ACCOUNT" \
    --alias "$alias" \
    --wasm "$wasm" | tail -n1)"
  local hash
  hash="$(sha256sum "$wasm" | awk '{print $1}')"
  printf '{"classification":"%s","alias":"%s","address":"%s","wasm_path":"%s","wasm_hash":"%s"}' \
    "$classification" "$alias" "$address" "$wasm" "$hash"
}

mkdir -p "$OUT_DIR"
ALLOW="$(deploy_one "pb:function_allowlist" "rust/target/wasm32v1-none/release/stellar_pb_function_allowlist.wasm")"
ARG="$(deploy_one "pb:arg_guard" "rust/target/wasm32v1-none/release/stellar_pb_arg_guard.wasm")"
CAP="$(deploy_one "pb:call_cap" "rust/target/wasm32v1-none/release/stellar_pb_call_cap.wasm")"
RATE="$(deploy_one "pb:rate_limit" "rust/target/wasm32v1-none/release/stellar_pb_rate_limit.wasm")"

cat > "$OUT_FILE" <<JSON
{
  "schema_version": "1",
  "network": "$NETWORK",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_account": "$FEEPAYER",
  "source_account_alias": "$SOURCE_ACCOUNT",
  "deployments": [
    $ALLOW,
    $ARG,
    $CAP,
    $RATE
  ]
}
JSON

cat "$OUT_FILE"
