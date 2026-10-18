# pingora

Node.js bindings for [Cloudflare Pingora](https://github.com/cloudflare/pingora),
built with [napi-rs](https://napi.rs).

> **Status: core reverse proxy (M1).** Static routes, host/path/method/header
> matching, load balancing, header mutation, metrics, and graceful lifecycle are
> implemented. TLS and the programmable JS request handler are next; see
> [ROADMAP.md](./ROADMAP.md).

## Install

```sh
npm install pingora
# or: pnpm add pingora
```

## Quick start

```js
import { Server } from 'pingora'

const server = new Server({
  listeners: ['127.0.0.1:8080'],
  routes: [
    {
      id: 'app',
      pathPrefix: '/',
      upstreams: ['127.0.0.1:3000'],
      requestHeaders: { 'x-proxied-by': 'pingora' },
    },
  ],
})

server.start()
console.log(server.status()) // { state: 'running', listeners: [...], routes: 1 }

process.on('SIGTERM', async () => {
  await server.stop()
})
```

A runnable version is in [examples/basic-proxy.mjs](./examples/basic-proxy.mjs).

## API

### `new Server(options?)`

| Option                       | Type       | Description                                              |
| ---------------------------- | ---------- | -------------------------------------------------------- |
| `listeners`                  | `string[]` | `host:port` listeners. Defaults to `127.0.0.1:8080`.      |
| `routes`                     | `Route[]`  | Initial routes. More can be added at runtime.            |
| `threads`                    | `number`   | Worker threads for the proxy service. Defaults to `1`.   |
| `gracePeriodMs`              | `number`   | Grace period before runtime shutdown. Defaults to `0`.   |
| `shutdownTimeoutMs`          | `number`   | Runtime shutdown timeout. Defaults to `5000`.            |
| `upstreamKeepalivePoolSize`  | `number`   | Upstream connection pool size. Defaults to `128`.        |
| `logLevel`                   | `string`   | Default log filter, e.g. `pingora=info`.                 |

Invalid options are reported by `start()` and in `status().error`.

### Server methods

- `start(): void` — starts the proxy on a dedicated thread. Throws if the server
  was already started or another Pingora server is running in the process.
- `stop(): Promise<void>` — signals a graceful shutdown and resolves after the
  server thread exits. Safe to call more than once.
- `status(): ServerStatus` — `{ state, error?, listeners, routes }`.
- `metrics(): ServerMetrics` — request/active/error/status-class counters and
  uptime.
- `addRoute(route): string` — adds or replaces a route by id and returns the id.
- `removeRoute(id): boolean` — removes a route, returning whether it existed.

`state` is one of `idle`, `starting`, `running`, `stopping`, `stopped`, or
`failed`.

### Route

```ts
interface Route {
  id?: string
  host?: string | string[] // exact, "*.example.com", or "*"
  path?: string // exact path
  pathPrefix?: string
  methods?: string[]
  matchHeaders?: Record<string, string>
  upstreams: Array<string | Upstream>
  strategy?: 'round_robin' | 'random' | 'first'
  requestHeaders?: Record<string, string>
  removeRequestHeaders?: string[]
  responseHeaders?: Record<string, string>
  removeResponseHeaders?: string[]
  timeoutMs?: number
}

interface Upstream {
  address: string // IP:port, http://IP..., or https://IP...
  tls?: boolean
  sni?: string
  verify?: boolean // defaults to true
}
```

Routes are evaluated in registration order; the first match wins. All specified
matchers must match. A request with no matching route receives `404`; an
upstream connection failure receives `502`.

Upstream addresses must be IP literals (IPv4 or IPv6). The binding intentionally
does not implement DNS discovery; resolve hostnames before adding routes.
Upstream TLS is verified by default. Unix sockets and listener TLS are not
implemented yet.

## Benchmarks

`just bench` builds the release binding and runs Vitest HTTP benchmarks through
a local Node.js HTTP **origin**:

```text
Node.js load generator -> proxy under test -> Node.js HTTP origin
```

"Direct origin (no proxy)" skips the middle hop. The same origin is used for
[`pingora`](https://www.npmjs.com/package/pingora),
[`http-proxy`](https://github.com/http-party/node-http-proxy), and
[`http-proxy-middleware`](https://github.com/chimurai/http-proxy-middleware).

```sh
just bench
```

The suite measures single-request throughput and batches of 20 concurrent
requests with keep-alive connections. Sample results from a local Linux x64
machine (2026-10-18 Asia/Shanghai, Node 24, Pingora with 2 worker threads, no CPU
isolation):

| Implementation           | 1 request (req/s) | 20 concurrent (req/s) |
| ------------------------ | ----------------: | --------------------: |
| direct origin (no proxy) |             7,232 |                10,547 |
| `pingora`                |             3,897 |                 6,118 |
| `http-proxy`             |             3,050 |                 3,276 |
| `http-proxy-middleware`  |             2,448 |                 3,201 |

These numbers are end-to-end Node numbers: the Vitest client and the Node
origin share the same machine and event loop, so they measure the cost of adding
a proxy to a Node stack, not Pingora's maximum throughput. The direct-origin row
is a no-proxy baseline. Under a native load generator with a non-Node origin,
Pingora's Rust data path is expected to be substantially faster; that requires
the separate native benchmark matrix in the roadmap.

Relative to the JS proxies in this harness, the binding is about 28% faster
than `http-proxy` for single requests and about 87% faster at 20 concurrent
requests. Run `just bench` on the target machine before drawing conclusions.
Native comparisons against nginx, Caddy, and OpenResty are tracked in the
roadmap benchmark matrix.

## Requirements

- **Runtime:** Node.js 10.16+ (CommonJS entry; `import` interop works on Node 12.22+)
- **Building from source:** Node.js 20.17+ for the napi-rs CLI, pnpm 12+, and
  [just](https://github.com/casey/just)
- **Tests and benchmarks:** Node.js 22.12+ (Vitest 5); this is higher than the
  runtime and build floors
- Rust stable and a C toolchain (source builds only; prebuilt binaries are
  planned for 1.0)
- Linux (glibc; musl planned) and macOS (Intel and Apple Silicon)

## Development

```sh
pnpm install    # installs dependencies and the lefthook git hooks
just build      # release build; use `just build-debug` for a faster build
just test       # build and run the Rust and Node.js tests
just check      # format check, clippy, Rust tests, build, and Node tests
just --list     # show all available recipes
```

The build produces `pingora.<platform>.node`, `index.js` (CommonJS loader), and
`index.d.ts`; all three are generated and git-ignored. Node's ESM interop makes
`import { Server } from 'pingora'` work without a separate wrapper.

Git hooks are managed by [lefthook](https://github.com/evilmartians/lefthook):
pre-commit runs `cargo fmt` and clippy for Rust changes, and pre-push runs
`just check`.

## Releasing

Releases are driven by [Changesets](https://changesets.dev). Add a changeset to
each user-facing pull request:

```sh
just changeset
```

After merge, CI opens a "Version Packages" pull request; merging it builds and
publishes the native packages from GitHub Actions using npm trusted publishing
(OIDC). No long-lived `NPM_TOKEN` is required. See
[docs/releasing.md](./docs/releasing.md) for the full flow and one-time setup.

## Tooling

- **pnpm** for dependency management and publishing.
- **just** for local task recipes.
- **lefthook** for Git hooks.
- **Renovate** for dependency updates (`.renovaterc`).
- GitHub Actions are pinned to full commit SHAs with a version comment.

## License

[MIT](./LICENSE)
