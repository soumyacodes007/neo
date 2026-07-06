#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! cargo llvm-cov --version >/dev/null 2>&1; then
  echo "cargo-llvm-cov is not installed. Install with: cargo install cargo-llvm-cov --locked" >&2
  exit 127
fi

cd "$ROOT_DIR"
cargo llvm-cov \
  --manifest-path rust/Cargo.toml \
  --workspace \
  --fail-under-lines "${RUST_COVERAGE_MIN_LINES:-90}"
