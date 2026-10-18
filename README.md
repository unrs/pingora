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
