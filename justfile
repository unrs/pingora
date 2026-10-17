set shell := ["bash", "-euo", "pipefail", "-c"]

default: check

# Install JavaScript dependencies and git hooks.
install:
    pnpm install
    pnpm exec lefthook install

# Build the native binding in release mode.
build:
    pnpm exec napi build --platform --release

# Build the native binding in debug mode.
build-debug:
    pnpm exec napi build --platform

# Run the Node.js integration tests (builds the debug binding first).
test: build-debug
    pnpm exec node --test __test__/index.test.mjs

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

# Bump the version and create the release commit/tag.
# Run this on main after the release PR is merged.
version v:
    pnpm version {{v}} --no-git-tag-version
    git add package.json Cargo.toml pnpm-lock.yaml
    git commit -m "chore: release v{{v}}"
    git tag "v{{v}}"

# Publish the platform packages (skips versions that already exist).
publish-platforms:
    pnpm exec napi create-npm-dirs
    node scripts/publish-platforms.mjs
