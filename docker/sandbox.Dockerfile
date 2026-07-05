FROM rust:1.94-slim

RUN rustup target add wasm32v1-none

WORKDIR /work

ENV RUSTUP_TOOLCHAIN=1.94.1-x86_64-unknown-linux-gnu
ENV RUSTUP_SKIP_SELF_UPDATE=1
ENV SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1
ENV CARGO_BUILD_RUSTFLAGS="--remap-path-prefix=/usr/local/cargo/registry/src="

CMD ["cargo", "--version"]
