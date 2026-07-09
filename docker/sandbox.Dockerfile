FROM rust:1.94-slim

RUN rustup target add wasm32v1-none

WORKDIR /work
COPY rust/Cargo.toml rust/Cargo.lock ./rust/
COPY rust/harness/Cargo.toml rust/harness/Cargo.lock ./rust/harness/
COPY rust/harness/src ./rust/harness/src
COPY rust/policies ./rust/policies
COPY stellar-contracts/Cargo.toml stellar-contracts/Cargo.lock ./stellar-contracts/
COPY stellar-contracts/packages/accounts ./stellar-contracts/packages/accounts
RUN cargo fetch --manifest-path rust/harness/Cargo.toml
RUN cargo build --manifest-path rust/harness/Cargo.toml --locked

ENV RUSTUP_TOOLCHAIN=1.94.1-x86_64-unknown-linux-gnu
ENV RUSTUP_SKIP_SELF_UPDATE=1
ENV SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1
ENV CARGO_BUILD_RUSTFLAGS="--remap-path-prefix=/usr/local/cargo/registry/src="

CMD ["cargo", "--version"]
