# Pingora for Node.js — Roadmap

> Status: **M3 TLS/protocol coverage complete.** TLS listeners, HTTP/2, WebSocket
> passthrough, upstream TLS/custom CAs, and Unix sockets are implemented.
> Production readiness (M4) is next.

## 1. Vision

Give Node.js applications **production-grade networking primitives from
Pingora** — starting with a programmable HTTP reverse proxy, and later a
server-side framework — through small, Node-native APIs built with
[napi-rs](https://napi.rs).

The binding should feel like a Node library, not a generated dump of Rust
internals:

- **Fast by default.** With no JavaScript hooks installed, requests are matched,
  proxied, and load-balanced entirely in Rust.
- **Programmable when needed.** An optional async request handler can inspect
  request metadata, rewrite headers, select an upstream, or short-circuit with a
  response.
- **Runtime-configurable.** Routes can be added, replaced, and removed while the
  server is running, without restarting the process.
- **Node-native lifecycle.** `start()` never blocks the event loop, and
  `await server.stop()` performs a graceful shutdown and resolves when the
  Pingora server thread has exited.

Target package names: `pingora` for the main entry point and
`@pingora/binding-<platform>` for the native binaries.

### Package family

The project is not limited to reverse proxying. The first release delivers the
proxy; later releases can add server-side primitives on the same native core.

| Package                | Role                                                             | Timing      |
| ---------------------- | ---------------------------------------------------------------- | ----------- |
| `pingora`              | Reverse-proxy facade and main entry point                        | 0.1.0       |
| `@pingora/binding-*`   | Prebuilt native addon for each supported platform                | 0.1.0       |
| `@pingora/http-server` | Programmable HTTP server framework built on the same integration | Post-1.0    |

`@pingora/http-server` is illustrative rather than final: it represents the
intent to expose Pingora's server-side service model (custom apps, connection
handling, protocol-level hooks) once the proxy facade is stable.

## 2. Non-goals

These are deliberately out of scope for the first stable release:

- **A one-to-one mapping of Pingora's Rust API.** No exposing `Service`,
  `ProxyHttp`, connectors, or protocol internals. We expose a curated facade.
- **A general-purpose L4 proxy.** TCP/UDP proxying is not part of 1.0; the focus
  is HTTP/1.1 and HTTP/2 reverse proxying.
- **Streaming request/response bodies into JavaScript.** The programmable layer
  works on request metadata and headers. Body hooks are a later exploration.
- **A process manager or CLI.** Supervision (systemd, containers, PM2) remains
  the deployment tool's job.
- **An Express-style web framework before the proxy is stable.** The server
  framework (`@pingora/http-server`) is a post-1.0 package, not a reason to blur
  the proxy API.
- **Windows support before 1.0.** Pingora's programmatic shutdown path is
  Unix-oriented. Windows users can use WSL; native support is revisited after
  the Unix releases are stable.
- **A caching proxy before 1.0.** Pingora has a cache framework, but exposing it
  well needs a separate design cycle.
- **A custom DNS resolver or service-discovery layer.** Pingora 0.9 has no DNS
  discovery; the binding stays thin and requires resolved IP addresses instead
  of implementing its own resolver.

## 3. Design decisions

| #   | Decision                                                                                                                       | Rationale                                                                                                                       | Status   |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1  | Expose a Node-first **reverse proxy facade** (routes + optional request handler), not raw Pingora traits.                        | Pingora's async Rust traits cannot be mapped ergonomically or safely onto JavaScript; a facade keeps the API stable.             | Proposed |
| D2  | One Pingora `Server` per process, running on a dedicated OS thread with its own Pingora-managed runtimes.                      | Pingora assumes process-level singletons (signals, bootstrap, upgrade socket); one server avoids global-state conflicts.        | Proposed |
| D3  | Route matching and static proxying happen in Rust; JavaScript is invoked only when a handler is registered.                     | Keeps the hot path free of cross-thread hops and makes the common case predictable.                                              | Proposed |
| D4  | The JS handler is async, receives request metadata, and returns a decision (`continue` or `respond`).                           | Header-level programmability covers auth gates, canary routing, redirects, and synthetic responses without body streaming.      | Proposed |
| D5  | TLS uses **rustls** for both listeners and upstream connections.                                                               | Pure-Rust build, no BoringSSL/OpenSSL toolchain, predictable cross-compilation.                                                  | Proposed |
| D6  | Programmatic graceful shutdown via a custom Pingora `ShutdownSignalWatch`; `stop()` joins the thread off the JS thread.        | Pingora's built-in watcher only listens for OS signals; a watch channel lets Node request shutdown without killing the process.  | Proposed |
| D7  | Ship the napi-rs-generated CommonJS loader; rely on Node's ESM interop for `import` consumers.                                 | One generated entry keeps the runtime floor at Node 12.20 because napi-postinstall requires it, and still supports named ESM imports on modern Node.       | Proposed |
| D8  | Tier 1 platforms: Linux x64/arm64 (glibc), macOS x64/arm64. Tier 2: Linux musl. Windows later.                                  | Matches Pingora's practical deployment target and keeps the prebuild matrix manageable.                                           | Proposed |
| D9  | Grow into a package family: `pingora` for the proxy and `@pingora/http-server` for the later server framework.                | Both packages share one native integration; keeping the proxy API stable first lets the framework build on a proven core.        | Proposed |

### Why not bind Pingora's `ProxyHttp` directly?

Pingora is designed to be embedded in Rust. Its filters are async trait methods
that receive `Session`, `HttpPeer`, and a user-defined context by reference.
JavaScript callbacks would require marshalling mutable protocol state across the
FFI boundary on every stage. Instead, the binding owns one `ProxyHttp`
implementation and translates a small, serializable view of the request into JS.

## 4. Architecture

```text
┌──────────────────────────────── Node.js main thread ────────────────────────────────┐
│  Server (napi class)                                                               │
│    ├── immutable options                                                           │
│    ├── route table        Arc<RwLock<Vec<Arc<Route>>>>   ← add/remove at runtime   │
│    ├── request handler    ThreadsafeFunction<Request, Promise<Decision>> (opt-in)   │
│    ├── counters           atomics                                                   │
│    └── stop()             AsyncTask → signal + join                                │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │ dedicated std::thread
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│  Pingora Server::run (custom ShutdownSignalWatch)                                  │
│    └── HTTP proxy service                                                          │
│          request_filter    → match route, optionally await the JS handler          │
│          upstream_peer     → choose upstream, build HttpPeer                       │
│          upstream_request  → apply request-header mutations                        │
│          response_filter   → apply response-header mutations                       │
│          logging           → update metrics                                        │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Planned crate layout:

```text
src/
  lib.rs       napi exports: Server, option structs, handler types
  server.rs    lifecycle: start, stop, status, readiness, singleton guard
  options.rs   JS-facing option structs and validated internal config
  router.rs    route matching, upstream parsing, load-balancing strategies
  proxy.rs     ProxyHttp implementation and request/response translation
  state.rs     shared state, handler handle, metrics
__test__/      node:test integration tests
examples/      runnable Node examples
docs/          guides beyond the README
```

### Lifecycle model

1. `new Server(options)` validates options and builds the route table. Listeners
   are parsed but not bound yet.
2. `start()` checks the process-wide singleton guard, spawns a dedicated thread,
   and returns immediately. The thread creates the Pingora server, adds the HTTP
   proxy service, and calls `Server::run`.
3. `stop()` signals the custom `ShutdownSignalWatch` and returns an `AsyncTask`
   that joins the Pingora thread on a libuv worker thread, so the event loop is
   never blocked.
4. Once the thread exits, the singleton guard is released and the status becomes
   `stopped` (or `failed` with the last error).

### Readiness and startup errors

Pingora binds listeners inside service runtimes, so a bind failure is not
returned by `Server::run` synchronously. The binding will:

- validate every listener address and every TLS certificate/key pair before
  spawning the thread;
- preflight-bind TCP listeners to surface common errors (`EADDRINUSE`, bad
  address) as a rejected `start()`;
- expose `status()` and an optional `startAsync()` readiness promise (Phase 2)
  that resolves once the service reports `Running`.

The exact mechanism (preflight bind vs. a startup handshake) is part of the
Phase 0 spike.

## 5. Public API sketch

The final names may shift during Phase 0, but this is the intended shape.

```ts
import { Server } from 'pingora'

const server = new Server({
  listeners: ['127.0.0.1:8080'],
  threads: 2,
  upstreamKeepalivePoolSize: 128,
})

server.addRoute({
  id: 'api',
  host: 'api.example.com',
  pathPrefix: '/v1',
  methods: ['GET', 'POST'],
  upstreams: ['127.0.0.1:9000', '127.0.0.1:9001'],
  strategy: 'round_robin',
  requestHeaders: { 'x-proxied-by': 'pingora' },
  timeoutMs: 30_000,
})

server.setRequestHandler(async (request) => {
  if (request.path === '/health') {
    return { action: 'respond', response: { status: 200, body: 'ok' } }
  }

  if (request.headers['x-canary'] === '1') {
    return { action: 'continue', upstream: '127.0.0.1:9002' }
  }

  return { action: 'continue' }
})

server.start()

// Later, on SIGTERM:
await server.stop()
```

### Core types

```ts
interface ServerOptions {
  listeners?: Array<string | ListenerOptions>
  threads?: number
  routes?: RouteOptions[]
  upstreamKeepalivePoolSize?: number
  gracePeriodMs?: number
  shutdownTimeoutMs?: number
  logLevel?: string
}

interface ListenerOptions {
  address: string // "IP:port", or "unix:/path" in Phase 3
  tls?: { cert: string; key: string }
  http2?: boolean
}

interface RouteOptions {
  id?: string
  host?: string | string[]
  path?: string
  pathPrefix?: string
  methods?: string[]
  matchHeaders?: Record<string, string>
  upstreams: Array<string | UpstreamOptions>
  strategy?: 'round_robin' | 'random' | 'first'
  requestHeaders?: Record<string, string>
  removeRequestHeaders?: string[]
  responseHeaders?: Record<string, string>
  removeResponseHeaders?: string[]
  timeoutMs?: number
}

interface UpstreamOptions {
  address: string
  tls?: boolean
  sni?: string
  verify?: boolean // default true
}

interface RequestView {
  method: string
  path: string
  query: string
  host: string
  headers: Record<string, string>
  clientIp?: string
  scheme: 'http' | 'https'
  httpVersion: string
  routeId?: string
}

interface RequestDecision {
  action?: 'continue' | 'respond'
  upstream?: string | UpstreamOptions
  requestHeaders?: Record<string, string>
  removeRequestHeaders?: string[]
  responseHeaders?: Record<string, string>
  removeResponseHeaders?: string[]
  response?: {
    status?: number
    headers?: Record<string, string>
    body?: string | Buffer
  }
}
```

Rules:

- If `listeners` is omitted, the server binds `127.0.0.1:8080`. Binding to a
  public interface must be explicit.
- Routes are evaluated in registration order; the first match wins.
- A route matches only when **all** specified matchers match (`host`, `path`,
  `pathPrefix`, `methods`, `matchHeaders`).
- `addRoute` upserts by `id`; `removeRoute` returns whether a route was removed.
- Without a matching route and without a handler-provided upstream, the proxy
  responds `404`.
- A handler returning `respond` writes the response directly; no upstream is
  contacted.
- Handler exceptions become `500` responses and are reported through the logger;
  the server keeps running.
- `verify: true` is the default for upstream TLS. Turning it off must be explicit.

### Node-visible lifecycle

```ts
type ServerState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

interface ServerStatus {
  state: ServerState
  error?: string
  listeners: string[]
  routes: number
}

interface ServerMetrics {
  requests: number
  active: number
  upstreamErrors: number
  responses: { '2xx': number; '3xx': number; '4xx': number; '5xx': number }
  uptimeMs: number
}
```

`start()` throws if the server is already running or if the process-wide
singleton guard is held. `stop()` is idempotent.

## 6. Feature matrix

| Capability                    | Phase | Status      |
| ----------------------------- | ----- | ----------- |
| TCP listeners                 | 0.1   | Implemented     |
| Host/path/method/header match | 0.1   | Implemented     |
| Route CRUD while running      | 0.1   | Implemented     |
| RR / weighted RR / random / first | 0.1 | Implemented     |
| Request/response header rules | 0.1   | Implemented     |
| Per-route connect/read timeout| 0.1   | Implemented     |
| Graceful start/stop/status    | 0.1   | Implemented     |
| Metrics counters              | 0.1   | Implemented     |
| Async request handler         | 0.2   | Implemented |
| Synthetic responses           | 0.2   | Implemented |
| Upstream override per request | 0.2   | Implemented |
| Readiness promise             | 0.2   | Planned     |
| TLS termination (rustls)      | 0.3   | Implemented |
| HTTP/2 downstream (ALPN)      | 0.3   | Implemented |
| Upstream TLS + SNI + verify   | 0.3   | Implemented |
| Unix domain sockets           | 0.3   | Implemented |
| WebSocket / Upgrade passthrough| 0.3  | Implemented |
| Health checks                 | 0.4   | Planned     |
| Per-route metrics + Prometheus text | 0.4 | Implemented |
| Request/header/route/listener limits | 0.4 | Implemented |
| Prometheus metrics endpoint   | 0.4   | Implemented |
| Config file + schema          | 0.4   | Deferred    |
| Structured JSON logs          | 0.4   | Implemented |
| JS access-log callback        | 0.4   | Implemented |
| Prebuilt platform binaries     | 1.0      | Planned     |
| Native proxy benchmarks       | 0.4      | Planned     |
| Server framework package       | post-1.0 | Exploring   |
| Request/response body hooks    | later    | Exploring   |
| Cache / L4 proxy / gRPC-Web   | later | Exploring   |
| Windows native support        | later | Exploring   |

## 7. Milestones

### M0 — Design and technical spike (proxy spike complete)

**Goal:** prove the risky parts before writing the public API around them.

- [x] Survey Pingora 0.9 server, proxy, TLS, and shutdown APIs.
- [x] Define the Node-first facade, lifecycle, and non-goals.
- [x] Scaffold the napi-rs crate, ESM loader, platform packages, and TypeScript
      declarations.
- [x] Add the OIDC release workflow with SHA-pinned GitHub Actions.
- [x] Set up pnpm, just, lefthook, and Renovate for the repository workflow.
- [x] Build a spike: napi-rs 3 + Pingora 0.9 (`proxy`, `rustls`) cdylib that
      starts and stops a server.
- [ ] Prove an async `ThreadsafeFunction` round trip from a Pingora worker
      thread: JS handler → `Promise<Decision>` → Rust. (Moved to M2.)
- [x] Prove programmatic graceful shutdown with a custom
      `ShutdownSignalWatch`, including a hard timeout.
- [x] Decide the readiness mechanism (preflight bind plus `status()`).
- [x] Record findings in `docs/architecture.md` and lock the package layout.

**Exit criteria:** one request is proxied end-to-end through the spike and
`stop()` resolves after the server thread exits. The async JS hook moved to M2.

### M1 — `0.1.0`: Core reverse proxy

**Goal:** a fast, static reverse proxy that is useful without any JavaScript
handler.

- [x] Cargo crate, `package.json`, napi build, generated CommonJS loader and `.d.ts`.
- [x] `Server` lifecycle: `start`, `stop`, `status`, singleton guard, error
      propagation, idempotent stop.
- [x] Listener parsing and preflight validation for TCP.
- [x] Route table with host, path, path prefix, method, and header matching.
- [x] Upstream parsing (`IP:port`, `http://`, `https://`), SNI defaults,
      TLS verification defaults. Hostname resolution is left to the caller.
- [x] Load balancing: round robin, random, first.
- [x] Request- and response-header mutations, validated by Pingora at insert.
- [x] Per-route timeouts applied to the upstream peer.
- [x] `404` for unmatched routes, `502` for upstream failures, `500` for
      internal errors.
- [x] Atomic metrics: requests, active, upstream errors, status classes, uptime.
- [x] TypeScript declarations and a runnable `examples/basic-proxy`.
- [x] Rust unit tests for routing/parsing; Node integration tests with a real
      upstream; CI for build, lint, and tests.
- [x] Initial README with install, build, API, and limitations.

**Exit criteria:** an app can start a proxy, route by path and host, round-robin
across two upstreams, hot-add a route, read metrics, and stop gracefully. Tests
cover success, 404, 502, route updates, and double stop.

### M2 — `0.2.0`: Programmable request layer

**Goal:** make the proxy scriptable without sacrificing the fast path.

- [x] `setRequestHandler(fn)` / `clearRequestHandler()` with async
      `Promise<RequestDecision>` support.
- [x] Request view: method, path, query, host, headers, client IP, scheme,
      HTTP version, matched route id.
- [x] Decisions: `continue`, `respond`, upstream override, request/response
      header mutations.
- [x] Stable validation and error mapping for invalid decisions.
- [x] Handler errors → `500`; handler never crashes the server.
- [x] Configurable handler timeout (protects the event loop and upstream
      latency).
- [x] Hot route updates while requests are in flight, with safe Arc snapshots.
- [x] GC/lifetime tests for handler replacement and server shutdown.
- [x] Docs: auth gate, canary routing, synthetic response, header rewriting.

**Exit criteria:** all handler behaviors are covered by integration tests,
including async delays, rejections, invalid decisions, replacement while
running, and shutdown with in-flight requests.

### M3 — `0.3.0`: TLS and protocol coverage

**Goal:** cover the common production edge cases.

- [x] TLS listeners with cert/key files; per-listener configuration.
- [x] HTTP/2 over TLS via ALPN; HTTP/1.1 remains the default fallback.
- [x] Upstream TLS with SNI, hostname verification, and an explicit opt-out.
- [x] Optional custom CA support for upstream verification.
- [x] Unix domain socket listeners and upstreams.
- [x] WebSocket / HTTP Upgrade passthrough tests.
- [x] TLS test fixtures and integration tests for h1 and h2 downstream.
- [x] Documentation for certificate rotation expectations (restart vs. future
      dynamic certs).

**Exit criteria:** HTTPS termination, HTTPS upstream, h2, Unix sockets, and
WebSocket passthrough all work in integration tests on both glibc Linux and
macOS.

### M4 — `0.4.0`: Production readiness

**Goal:** make the binding operationally credible.

- [ ] Health checks and/or Pingora load-balancer integration.
- [x] Weighted round-robin strategy (binding-level; Pingora LB integration is still open).
- [x] Least-connection strategy (binding-level).
- [x] Listener and route limits; request body size and header limits surfaced.
- [x] Per-route metrics, Prometheus text output, and a dedicated
      `metricsAddress` endpoint for `/metrics` and `/healthz`.
- [x] Structured JSON logging via `logFormat: 'json'`.
- [x] JS access-log callback via a non-blocking TSFN.
- [x] Defer a custom config-file parser for now. Users can load JSON directly
      with CommonJS (`const config = require('./pingora.config.json')`) or, on
      modern Node ESM, `import config from './pingora.config.json' with { type: 'json' }`;
      or build an options object in JS. Revisit only if a real custom format is needed.
- [x] Initial Vitest HTTP benchmark suite against a direct upstream,
      `http-proxy`, and `http-proxy-middleware`.
- [ ] Native proxy benchmark harness: nginx, Caddy, OpenResty, and optionally
      HAProxy, with pinned configs/images and the same upstream/workload.
- [ ] Publish a benchmark report with req/s, p50/p99 latency, CPU/RSS, and the
      tested native proxy versions.
- [ ] Add a CI performance regression gate.
- [x] Security review: open-proxy defaults, header injection, TLS defaults,
      SSRF considerations, denial-of-service limits.
- [x] Add a soak harness for sustained traffic, route/handler churn, and
      repeated start/stop cycles.
- [ ] Run and record a multi-hour soak before 1.0.

**Exit criteria:** no unbounded resource growth in a multi-hour soak, benchmark
numbers are documented, and a security checklist has been signed off.

### M5 — `1.0.0`: Stable release

**Goal:** freeze the API and make installation boring.

- [ ] API freeze and semver policy; deprecation process.
- [ ] Prebuilt binaries: Linux x64/arm64 glibc, Linux x64/arm64 musl,
      macOS x64/arm64.
- [ ] npm platform packages, publish-time optional dependencies, provenance,
      and a Changesets-driven release workflow.
- [ ] CI matrix for the Node.js release lines selected by the support policy on
      Linux and macOS, plus the runtime compatibility floor.
- [ ] API reference, guides, migration notes, and troubleshooting.
- [ ] Performance regression job and published benchmark report.
- [ ] Security policy and vulnerability reporting process.
- [ ] Windows investigation outcome documented (support or explicit deferral).

**Exit criteria:** a clean `npm install pingora` works on every Tier 1 target
without a Rust toolchain, the API is documented, and the release workflow has
been rehearsed.

### Post-1.0 — Server framework (`@pingora/http-server`)

**Goal:** reuse the native Pingora integration for server-side applications, not
only reverse proxying.

- [ ] Decide whether the package exposes Pingora's low-level service model
      (custom apps, connection handling, protocol hooks) or a higher-level Node
      HTTP framework.
- [ ] Extract the shared native lifecycle and configuration layer into a
      workspace crate used by both packages.
- [ ] Define the server API, request/response model, and graceful shutdown
      semantics.
- [ ] Package and publish it independently from `pingora`, with its own trusted
      publisher configuration.
- [ ] Keep the proxy package free of framework-specific dependencies.

**Exit criteria:** a separately installable `@pingora/http-server` package with
its own API docs, tests, and release pipeline, sharing no unstable internals with
the proxy facade.

## 8. Testing strategy

| Layer                | Tooling                              | What it covers                                                        |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| Rust unit            | `cargo test`                         | Route matching, upstream parsing, decision validation, metrics.       |
| Node integration     | Vitest, ephemeral ports              | Real HTTP upstream, route CRUD, handler behavior, headers, errors.     |
| TLS                  | generated self-signed fixtures       | Certificate loading, h2 ALPN, upstream verification, failure modes.   |
| Lifecycle / GC       | `--expose-gc`, repeated start/stop   | Handler replacement, no use-after-free, singleton release.            |
| Soak / load          | autocannon or wrk                    | Throughput, latency, memory growth, connection reuse.                 |
| Cross-platform       | GitHub Actions matrix                | Linux glibc/musl, macOS Intel/Apple Silicon.                          |

Every public behavior in the API sketch should have at least one integration
test. Tests must not depend on a fixed port or on network access beyond
localhost.

### Benchmark matrix

Benchmarks must answer one question: how much does the binding cost relative to
the same proxy work done by other implementations? Every entry uses the same
origin, workload, connection reuse, and warmup. The current Vitest suite is
Node-client-bound: it measures proxy overhead in a Node stack, not Pingora's
raw Rust throughput. The native matrix below is where raw Pingora capacity is
measured with wrk/oha and a non-Node origin.

| Class            | Implementations                                      | Status      |
| ---------------- | ---------------------------------------------------- | ----------- |
| Baseline         | direct origin (Node.js HTTP server, no proxy)        | Implemented |
| JS proxies       | `pingora`, `http-proxy`, `http-proxy-middleware`   | Implemented |
| Native proxies   | nginx, Caddy, OpenResty, HAProxy (optional)          | Planned     |
| Load generators  | Vitest bench for JS; wrk/oha for native proxies      | Planned     |

Planned native benchmark work:

- [ ] Commit pinned configs and Docker images under `bench/native/` for nginx,
      Caddy, and OpenResty, all proxying to the same non-Node origin
      (for example a static-file server), not the Node origin used by the Vitest
      suite.
- [ ] Use the same worker/CPU allocation, keep-alive settings, disabled access
      logs, and disabled TLS for every implementation.
- [ ] Run single-request and 20-concurrent cases; publish req/s plus p50/p99
      latency, CPU, and RSS.
- [ ] Record the native proxy versions and image digests with the results.
- [ ] Add a `just bench:native` entry point that builds and runs the whole matrix.
- [ ] Keep results machine-specific and publish the hardware/OS/runtime details
      next to them.

The matrix compares proxy overhead, not absolute production capacity. TLS,
large bodies, WebSocket upgrades, and HTTP/2 need separate scenarios.

## 9. Distribution and compatibility

- **Runtime compatibility floor:** Node.js `^12.20.0 || ^14.18.0 || >=16.0.0` via the CommonJS loader
  (N-API 4). ESM `import` interop requires Node.js 12.22+ (named exports are
  detected by Node's CJS lexer). This floor is separate from the supported
  Node.js release lines. Building from source needs Node.js 20.17+ for the
  napi-rs CLI. The supported release lines and M5 CI matrix must follow the
  support policy.
- **Package names:** `pingora` for the main entry point and
  `@pingora/binding-<platform>` for the native binaries. The scope and all
  package names are reserved before the first real release.
- **Module format:** the napi-rs-generated CommonJS loader is the only entry
  point; Node's ESM interop supports named imports on Node 12.22+. There is no
  separate wrapper to maintain.
- **Rust:** stable toolchain; MSRV recorded after the Phase 0 spike.
- **Platforms:**
  - Tier 1: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
    `x86_64-apple-darwin`, `aarch64-apple-darwin`.
  - Tier 2: `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`.
  - Deferred: Windows.
- **Publishing:** napi-rs platform packages plus a main package, built and
  published from CI with **pnpm** and npm **trusted publishing (OIDC)**. No
  long-lived `NPM_TOKEN`. Provenance is attached to every package. Third-party
  GitHub Actions are pinned to full commit SHAs with a version comment
  (`uses: owner/action@<sha> # vX.Y.Z`).
- **Node workers:** the binding enforces one server per process. A second
  `start()` from the main thread or a worker thread fails with a clear error.

## 10. Risks and mitigations

| Risk                                                                 | Impact | Mitigation                                                                                                             |
| -------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Cross-thread JS calls add latency and can stall on a busy event loop. | High   | Handler is opt-in; no-handler path stays in Rust; document the cost; add a handler timeout; benchmark both paths.       |
| Pingora startup/bind errors surface asynchronously.                   | High   | Validate and preflight-bind listeners; expose `status()` / `lastError`; add readiness in 0.2.                          |
| Graceful stop hangs on keep-alive or long requests.                  | High   | Configurable grace/shutdown timeouts; force-close fallback; integration tests with in-flight requests.                  |
| Pingora's process-level global state conflicts with multiple servers or workers. | High | Enforce a single server per process; clear error; release the guard after shutdown; document worker behavior.           |
| TSFN lifetime/GC bugs cause crashes or leaks.                        | High   | Keep the TSFN in shared state, release on replacement/shutdown, add GC and repeated-lifecycle tests.                   |
| rustls lacks a feature needed by a user (e.g. custom OpenSSL engine).| Medium | Start with rustls; document the limitation; revisit an optional OpenSSL backend only if demand is real.                |
| Pingora 0.x API churn breaks upgrades.                               | Medium | Pin the minor version, centralize Pingora usage behind internal modules, maintain an upgrade checklist.                |
| Prebuild matrix and musl builds are fragile.                         | Medium | Start with Tier 1 targets, add musl after green CI, keep a source-build fallback documented.                            |
| An open proxy or header-injection bug creates a security incident.   | High   | Bind localhost by default, require explicit routes, validate all headers, verify upstream TLS by default, security review. |

## 11. Open questions

These need answers before the public API is frozen. Recommendations are noted;
the maintainer can override any of them.

1. **Handler scope.** Is header/metadata programmability sufficient for the
   first release, with body streaming deferred? _Recommendation: yes._
2. **TLS backend.** Is rustls-only acceptable, or is a BoringSSL/OpenSSL option
   required for a specific deployment? _Recommendation: rustls only until 1.0._
3. **Configuration style.** Programmatic API first, with a file loader added in
   0.4? _Recommendation: yes._
4. **Platform priority.** Is Windows native support needed before 1.0, or is WSL
   acceptable initially? _Recommendation: defer, document WSL._
5. **Zero-downtime upgrade.** Should the binding expose Pingora's upgrade socket
   workflow, given that Node apps usually rely on process managers and rolling
   restarts? _Recommendation: defer until after 1.0._
6. **Server framework.** Should `@pingora/http-server` expose Pingora's
   low-level service model (custom apps, connection handling), or a higher-level
   Node HTTP framework? What belongs in the first version after 1.0?
   _Recommendation: design it only after the proxy API is stable._

## 12. Repository conventions

- **Package manager:** pnpm. `pnpm-lock.yaml` is committed and CI installs with
  `--frozen-lockfile`.
- **Generated platform packages:** `npm/` is produced by `napi create-npm-dirs`
  at release time and is git-ignored. Platform `optionalDependencies` are added
  to a temporary root manifest only while publishing.
- **Versioning:** Changesets. Pull requests carry a changeset; the release
  workflow owns versioning, publishing, and the `vX.Y.Z` tag.
- **Tasks:** [just](https://github.com/casey/just). `just check` is the local
  gate; CI runs the underlying pnpm/cargo commands directly.
- **Git hooks:** lefthook. Pre-commit runs `cargo fmt` and clippy for Rust
  changes; pre-push runs `just check`.
- **Dependency updates:** Renovate with the shared `github>1stG/configs`
  preset (`.renovaterc`).
- **GitHub Actions:** pinned to full commit SHAs with a version comment
  (`uses: owner/action@<sha> # vX.Y.Z`).
- Rust code formatted with `cargo fmt`; clippy clean with warnings denied in CI.
- TypeScript/JS tests use `node:test`.
- Every public API change updates `README.md` and the generated `.d.ts`.
- Performance-sensitive changes include a benchmark note.
- Commit scopes: `server`, `router`, `proxy`, `tls`, `napi`, `docs`, `ci`.
