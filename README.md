# pingora

Node.js bindings for [Cloudflare Pingora](https://github.com/cloudflare/pingora),
built with [napi-rs](https://napi.rs).

> **Status: programmable reverse proxy (M3 complete; M4 in progress).** Static
> routes, load balancing, header mutation, metrics, graceful lifecycle, the
> JavaScript request handler, TLS/HTTP2, WebSocket passthrough, upstream
> TLS/custom CAs, and Unix sockets are implemented. Production-readiness work is
> ongoing; see [ROADMAP.md](./ROADMAP.md).

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

A runnable version is in [examples/basic-proxy.mjs](./examples/basic-proxy.mjs). The
handler example is [examples/request-handler.mjs](./examples/request-handler.mjs).

## API

### `new Server(options?)`

| Option                       | Type       | Description                                              |
| ---------------------------- | ---------- | -------------------------------------------------------- |
| `listeners`                  | `(string \| ListenerOptions)[]` | TCP, TLS, or `unix:/path` (Unix only). Defaults to `127.0.0.1:8080`. |
| `routes`                     | `Route[]`  | Initial routes. More can be added at runtime.            |
| `threads`                    | `number`   | Worker threads for the proxy service. Defaults to `1`.   |
| `gracePeriodMs`              | `number`   | Grace period before runtime shutdown. Defaults to `0`.   |
| `shutdownTimeoutMs`          | `number`   | Runtime shutdown timeout. Defaults to `5000`.            |
| `upstreamKeepalivePoolSize`  | `number`   | Upstream connection pool size. Defaults to `128`.        |
| `logLevel`                   | `string`   | Default log filter, e.g. `pingora=info`.                 |
| `handlerTimeoutMs`           | `number`   | Request handler timeout. Defaults to `1000`.             |

Invalid options are reported by `start()` and in `status().error`.

### Server methods

- `start(): void` — starts the proxy on a dedicated thread. Throws if the server
  was already started or another Pingora server is running in the process.
- `stop(): Promise<void>` — signals a graceful shutdown and resolves after the
  server thread exits. Safe to call more than once.
- `status(): ServerStatus` — `{ state, error?, listeners, routes }`.
- `metrics(): ServerMetrics` — request/active/error/status-class counters and
  uptime.
- `routeMetrics(id): RouteMetrics | null` — counters for one route.
- `metricsPrometheus(): string` — Prometheus text exposition of aggregate and
  per-route counters.
- `addRoute(route): string` — adds or replaces a route by id and returns the id.
- `removeRoute(id): boolean` — removes a route, returning whether it existed.
- `setRequestHandler(fn): void` — installs an async request handler.
- `clearRequestHandler(): void` — removes the handler; the Rust fast path resumes.

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
  address: string // IP:port, unix:/path, http://IP..., or https://IP...
  tls?: boolean
  sni?: string
  verify?: boolean // defaults to true
  ca?: string // PEM CA file for a private upstream CA
}
```

Routes are evaluated in registration order; the first match wins. All specified
matchers must match. A request with no matching route receives `404`; an
upstream connection failure receives `502`.

Internet upstream addresses must be IP literals (IPv4 or IPv6). The binding
intentionally does not implement DNS discovery; resolve hostnames before adding
routes. Upstream TLS is verified by default, including hostname/SNI
verification. `verify: false` opts out; `ca` points to a PEM CA bundle for a
private CA. Unix upstreams use `unix:/path` on Unix platforms.

### TLS listeners

A listener can terminate TLS by passing an object instead of a string:

```js
new Server({
  listeners: [
    '127.0.0.1:8080',
    {
      address: '127.0.0.1:8443',
      tls: { cert: '/etc/pingora/cert.pem', key: '/etc/pingora/key.pem' },
    },
  ],
})
```

TLS 1.2 and 1.3 are enabled with ALPN preferring HTTP/2 and falling back to
HTTP/1.1. Certificates and keys are PEM files and are validated by `start()`;
an invalid path fails startup. Certificate rotation requires a restart. See
[docs/tls.md](./docs/tls.md) for the certificate layout and operational notes.
The request handler sees `scheme: 'https'` on TLS listeners.

HTTP/1.1 `Upgrade` requests, including WebSocket handshakes, are passed through
to the upstream after the normal route and header filters.

### Unix domain sockets

Listeners and upstreams can use `unix:/absolute/or/relative/path` on Unix
platforms. Non-Unix builds reject Unix listener/upstream configuration. Each
Unix socket path must be exclusively owned by one process; concurrent binds to
the same path are not supported because Pingora's path-based bind unlinks an
existing socket.

```js
new Server({
  listeners: ['unix:/run/pingora/proxy.sock'],
  routes: [
    {
      pathPrefix: '/',
      upstreams: ['unix:/run/app/app.sock'],
    },
  ],
})
```

TLS is not supported on Unix listeners. Socket files are created with mode
`0o660`; directory permissions control access. A stale socket path is removed at
startup only when no live listener answers and the path is actually a socket;
regular files are rejected. The socket path may remain after stop and is
replaced on the next start.

### Request handler

The optional handler runs after route matching but before proxying. It receives
a request view and returns a decision or a promise resolving to one:

```js
server.setRequestHandler(async (request) => {
  if (request.path === '/health') {
    return { action: 'respond', status: 200, body: 'ok' }
  }
  if (request.headers.authorization !== 'Bearer secret') {
    return { action: 'respond', status: 401, body: 'unauthorized' }
  }
  if (request.path.startsWith('/canary')) {
    return { action: 'upstream', upstream: '127.0.0.1:3001' }
  }
  return { action: 'continue' }
})
```

```ts
interface RequestView {
  method: string
  path: string
  query?: string
  host?: string
  headers: Record<string, string>
  clientIp?: string
  scheme: string
  httpVersion: string
  routeId?: string
}

interface RequestDecision {
  action?: 'continue' | 'respond' | 'upstream'
  status?: number
  headers?: Record<string, string>
  body?: string
  upstream?: string | Upstream
  requestHeaders?: Record<string, string>
  removeRequestHeaders?: string[]
  responseHeaders?: Record<string, string>
  removeResponseHeaders?: string[]
}
```

`continue` is the default. `respond` writes a synthetic response and uses its
`headers` field. `upstream` overrides the selected peer for this request.
`requestHeaders`, `responseHeaders`, and their remove variants apply only to
proxied responses, on top of route mutations. Route response mutations are not
applied to synthetic responses; use the decision `headers` field for those.
Repeated request header values are joined with `, ` and non-UTF-8 bytes are
replaced with U+FFFD, so every forwarded value is visible to the handler.
Handler errors and timeouts return `500`; malformed header mutations are left
to Pingora's validation. A timeout is controlled by `handlerTimeoutMs`.
Handlers are optional: requests take the all-Rust path when none is installed.

## Known upstream issues

See [docs/upstream-issues.md](./docs/upstream-issues.md) for Pingora issues tracked
against this binding.

### Metrics endpoint

`metricsPrometheus()` returns Prometheus text; serve it from the request handler
if you want an HTTP endpoint. On a public listener, require authorization and
HTTPS or equivalent transport security. Otherwise, keep the endpoint private;
route ids and traffic counts are visible in the output.

```js
const metricsToken = process.env.METRICS_TOKEN

server.setRequestHandler(async (request) => {
  if (request.path === '/healthz') {
    return { action: 'respond', status: 200, body: server.status().state }
  }
  if (request.path === '/metrics') {
    if (
      !metricsToken ||
      request.headers.authorization !== `Bearer ${metricsToken}`
    ) {
      return { action: 'respond', status: 401, body: 'unauthorized' }
    }
    return {
      action: 'respond',
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4' },
      body: server.metricsPrometheus(),
    }
  }
  return { action: 'continue' }
})
```

The metrics include aggregate request/active/error/status-class counters, uptime,
and `pingora_route_*` counters labelled by route id.

```ts
interface RouteMetrics {
  requests: number
  active: number
  upstreamErrors: number
  responsesOk: number
  responsesRedirect: number
  responsesClientError: number
  responsesServerError: number
}
```

## Benchmarks

Sample throughput from a local Linux x64 machine (Node 24, Pingora with 2 worker
threads, keep-alive, 20 concurrent requests per batch):

| Implementation           | 1 request (req/s) | 20 concurrent (req/s) |
| ------------------------ | ----------------: | --------------------: |
| direct origin (no proxy) |             7,232 |                10,547 |
| `pingora`                |             3,897 |                 6,118 |
| `http-proxy`             |             3,050 |                 3,276 |
| `http-proxy-middleware`  |             2,448 |                 3,201 |

These are end-to-end Node numbers, not Pingora's raw ceiling. See
[docs/benchmarks.md](./docs/benchmarks.md) for the method and caveats.

## Requirements

- **Runtime:** Node.js 10.16+ (CommonJS entry; `import` interop works on Node 12.22+)
- Linux (glibc; musl planned) and macOS (Intel and Apple Silicon)
- Prebuilt binaries are installed through npm; source builds are documented in
  [docs/development.md](./docs/development.md).

## Contributing

See [docs/development.md](./docs/development.md) for the local workflow and
[docs/releasing.md](./docs/releasing.md) for the release process.

## License

[MIT](./LICENSE)
