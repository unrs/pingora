set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

# Initialize dependencies, release tooling, and git hooks.
init:
    pnpm install
    cargo binstall --help >/dev/null 2>&1 || cargo install cargo-binstall --locked
    cargo binstall --no-confirm cargo-edit
    pnpm exec lefthook install

# Build the native binding in release mode.
build:
    pnpm exec napi build --platform --release

# Build the native binding in debug mode.
build-debug:
    pnpm exec napi build --platform

# Run Rust unit tests.
test-rust:
    cargo test

# Run the Vitest integration tests (builds the debug binding first) and Rust tests.
test:
    pnpm test
    cargo test

# Build the release binding and run the Vitest HTTP benchmarks.
bench:
    pnpm bench

# Format Rust sources.
fmt:
    cargo fmt --all

# Check Rust formatting.
fmt-check:
    cargo fmt --all -- --check

# Lint Rust sources.
lint:
    cargo clippy --all-targets -- -D warnings

# Format, lint, build, and test.
check: fmt-check lint test

# Assemble release artifacts into the platform packages.
artifacts:
    pnpm exec napi create-npm-dirs
    pnpm exec napi artifacts

# Remove build outputs and copied native binaries.
clean:
    cargo clean
    rm -rf artifacts
    rm -f *.node npm/*/*.node
