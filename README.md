# pingora

Node.js bindings for [Cloudflare Pingora](https://github.com/cloudflare/pingora),
built with [napi-rs](https://napi.rs).

> **Status: 0.0.0 scaffold.** The native loader, platform packages, and the
> OIDC-based release pipeline are in place. The proxy API is the next milestone;
> see [ROADMAP.md](./ROADMAP.md).

## Package family

| Package                | Purpose                                                   | Status      |
| ---------------------- | --------------------------------------------------------- | ----------- |
| `pingora`              | Main entry point and reverse-proxy API                    | Scaffolding |
| `@pingora/binding-*`   | Prebuilt platform binaries for the native addon           | Scaffolding |
| `@pingora/http-server` | Programmable HTTP server framework built on the same core | Planned     |

The first release focuses on a reverse proxy. The binding is designed so that a
server-side framework can share the same Pingora integration later.

## Planned capabilities

- Route matching, load balancing, and proxying run in Rust on Pingora.
- Routes can be added, replaced, and removed at runtime.
- An optional async JavaScript handler can gate requests, rewrite headers,
  choose an upstream, or return a synthetic response.
- `start()` is non-blocking and `await server.stop()` shuts down gracefully.

## Requirements

- **Runtime:** Node.js 12.22+ (N-API 4; ESM loader)
- **Building from source:** Node.js 20.17+ for the napi-rs CLI, pnpm 12+, and
  [just](https://github.com/casey/just)
- Rust stable and a C toolchain (source builds only; prebuilt binaries are
  planned for 1.0)
- Linux (glibc; musl planned) and macOS (Intel and Apple Silicon)

## Development

```sh
pnpm install    # installs dependencies and the lefthook git hooks
just build      # release build; use `just build-debug` for a faster build
just test       # build and run the Node.js tests
just check      # format check, clippy, build, and test
just --list     # show all available recipes
```

The build produces `pingora.<platform>.node`, `index.js` (ESM loader), and
`index.d.ts`; all three are generated and git-ignored.

Git hooks are managed by [lefthook](https://github.com/evilmartians/lefthook):
pre-commit runs `cargo fmt` and clippy for Rust changes, and pre-push runs
`just check`.

## Releasing

Releases are published from GitHub Actions using npm trusted publishing (OIDC).
No long-lived `NPM_TOKEN` is required. See [docs/releasing.md](./docs/releasing.md)
for the one-time npm setup and the release procedure.

## Tooling

- **pnpm** for dependency management and publishing.
- **just** for local task recipes.
- **lefthook** for Git hooks.
- **Renovate** for dependency updates (`.renovaterc`).
- GitHub Actions are pinned to full commit SHAs with a version comment.

## License

[MIT](./LICENSE)
