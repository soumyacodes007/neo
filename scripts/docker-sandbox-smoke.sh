#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-ozpb-sandbox:local}"

docker build -t "$IMAGE" -f "$ROOT_DIR/docker/sandbox.Dockerfile" "$ROOT_DIR"
docker run --rm \
  --network none \
  --cpus "${DOCKER_CPUS:-2}" \
  --memory "${DOCKER_MEMORY:-4g}" \
  -v "$HOME/.cargo/registry:/usr/local/cargo/registry:ro" \
  -v "$HOME/.cargo/git:/usr/local/cargo/git:ro" \
  -v "$ROOT_DIR/stellar-contracts:/work:rw" \
  -w /work \
  "$IMAGE" \
  cargo build --locked --offline \
    -p multisig-ed25519-verifier-example \
    --target wasm32v1-none \
    --release
