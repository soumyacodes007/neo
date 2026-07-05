#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$ROOT_DIR/stellar-contracts"
OUT_DIR="$ROOT_DIR/fixtures/testnet"
OUT_FILE="$OUT_DIR/oz-fixture.json"
STELLAR_BIN="${STELLAR_BIN:-stellar}"
SOURCE_ACCOUNT="${SOURCE_ACCOUNT:-ozpb-feepayer}"
NETWORK="${NETWORK:-testnet}"

ED25519_KEY_HEX="${ED25519_KEY_HEX:-3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29}"
ACCOUNT_WASM="target/wasm32v1-none/release/multisig_account_example.wasm"
VERIFIER_WASM="target/wasm32v1-none/release/multisig_ed25519_verifier_example.wasm"
THRESHOLD_WASM="target/wasm32v1-none/release/multisig_threshold_policy_example.wasm"

if ! command -v "$STELLAR_BIN" >/dev/null 2>&1; then
  if [ -x "$HOME/.local/bin/stellar" ]; then
    STELLAR_BIN="$HOME/.local/bin/stellar"
  else
    echo "stellar CLI not found on PATH" >&2
    exit 1
  fi
fi

cd "$CONTRACTS_DIR"

"$STELLAR_BIN" contract build --package multisig-ed25519-verifier-example >/dev/null
"$STELLAR_BIN" contract build --package multisig-threshold-policy-example >/dev/null
"$STELLAR_BIN" contract build --package multisig-account-example >/dev/null

if ! "$STELLAR_BIN" keys public-key "$SOURCE_ACCOUNT" >/dev/null 2>&1; then
  "$STELLAR_BIN" keys generate "$SOURCE_ACCOUNT" --network "$NETWORK" >/dev/null
fi
"$STELLAR_BIN" keys fund "$SOURCE_ACCOUNT" --network "$NETWORK" >/dev/null
FEEPAYER="$("$STELLAR_BIN" keys public-key "$SOURCE_ACCOUNT")"

STAMP="$(date -u +%Y%m%d%H%M%S)"
VERIFIER_ALIAS="ozpb-ed25519-$STAMP"
THRESHOLD_ALIAS="ozpb-threshold-$STAMP"
ACCOUNT_ALIAS="ozpb-account-$STAMP"

VERIFIER="$("$STELLAR_BIN" contract deploy \
  --network "$NETWORK" \
  --source-account "$SOURCE_ACCOUNT" \
  --alias "$VERIFIER_ALIAS" \
  --wasm "./$VERIFIER_WASM" | tail -n1)"

THRESHOLD_POLICY="$("$STELLAR_BIN" contract deploy \
  --network "$NETWORK" \
  --source-account "$SOURCE_ACCOUNT" \
  --alias "$THRESHOLD_ALIAS" \
  --wasm "./$THRESHOLD_WASM" | tail -n1)"

SIGNERS="[{\"External\":[\"$VERIFIER\",\"$ED25519_KEY_HEX\"]}]"
ACCOUNT="$("$STELLAR_BIN" contract deploy \
  --network "$NETWORK" \
  --source-account "$SOURCE_ACCOUNT" \
  --alias "$ACCOUNT_ALIAS" \
  --wasm "./$ACCOUNT_WASM" \
  -- \
  --signers "$SIGNERS" \
  --policies "{}" | tail -n1)"

ACCOUNT_WASM_HASH="$(sha256sum "./$ACCOUNT_WASM" | awk '{print $1}')"
VERIFIER_WASM_HASH="$(sha256sum "./$VERIFIER_WASM" | awk '{print $1}')"
THRESHOLD_WASM_HASH="$(sha256sum "./$THRESHOLD_WASM" | awk '{print $1}')"

mkdir -p "$OUT_DIR"
cat > "$OUT_FILE" <<JSON
{
  "schema_version": "1",
  "network": "$NETWORK",
  "created_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_account": "$FEEPAYER",
  "account": "$ACCOUNT",
  "account_alias": "$ACCOUNT_ALIAS",
  "account_wasm_hash": "$ACCOUNT_WASM_HASH",
  "ed25519_verifier": "$VERIFIER",
  "ed25519_verifier_alias": "$VERIFIER_ALIAS",
  "ed25519_verifier_wasm_hash": "$VERIFIER_WASM_HASH",
  "threshold_policy": "$THRESHOLD_POLICY",
  "threshold_policy_alias": "$THRESHOLD_ALIAS",
  "threshold_policy_wasm_hash": "$THRESHOLD_WASM_HASH",
  "external_signer_key_hex": "$ED25519_KEY_HEX",
  "fixture_shape": "one external Ed25519 signer, one no-policy Default rule"
}
JSON

cat "$OUT_FILE"
