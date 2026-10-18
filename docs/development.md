# Development

## Setup

```sh
just init       # dependencies, cargo-edit, and git hooks
just build      # release build; `just build-debug` is faster
just test       # Rust and Node.js tests
just check      # fmt, clippy, Rust tests, build, and Node tests
just --list     # all recipes
```

`just init` installs `cargo-binstall` when missing, then `cargo-edit`, which
provides `cargo set-version` for the release workflow.

## Generated files

The build produces `pingora.<platform>.node`, `index.js` (CommonJS loader), and
`index.d.ts`. All three are generated and git-ignored. Node's ESM interop makes
`import { Server } from 'pingora'` work without a separate wrapper.

## Hooks and tooling

- **pnpm** for dependency management and publishing.
- **just** for local task recipes.
- **lefthook** for Git hooks: pre-commit runs `cargo fmt` and clippy for Rust
  changes; pre-push runs `just check`.
- **Renovate** for dependency updates (`.renovaterc`).
- GitHub Actions are pinned to full commit SHAs with a version comment.
