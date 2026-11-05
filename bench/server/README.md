# HTTP server framework benchmark

Pinned Compose services for `@pingora/http-server`, Node's `http` module,
Express, Fastify, Koa, NestJS, Hono, and Elysia's Node adapter. Every target
serves the same three routes from one image and is measured by the Go load
generator used by the native proxy matrix.

```sh
pnpm bench:server
BENCH_SERVER_DURATION_MS=10000 BENCH_SERVER_CONCURRENCY=32 pnpm bench:server
```

## Requirements

- Node.js 24+ (the runner uses native type stripping; it is developer tooling)
- Linux x64 with glibc
- Docker with Compose v2

The command builds the release binding and `@pingora/http-server`, builds the
server image, starts every target, waits for `/plaintext`, and measures
`/plaintext`, `/json`, and `/users/42` with a Go load generator inside the
Compose network. Each container is limited to `${BENCH_SERVER_CPUS:-1}` CPU and
`${BENCH_SERVER_MEMORY:-512m}` memory. A 500 ms warmup runs before each target; set
`BENCH_SERVER_WARMUP_MS=0` to skip it. Results include requests, errors, req/s,
p50/p95/p99 latency, CPU%, cgroup memory, and RSS from the container node process;
`BENCH_SERVER_OUTPUT` writes the JSON to a file.

Express and NestJS disable `ETag` and `X-Powered-By` so the response work stays
comparable. The `hybrid (poc)` entry uses native routes for `/plaintext` and `/json`, then
reverse-proxies `/users/:id` to an internal Node UDS server, showing the cost of
the fallback hop. The `@pingora/http-server` entry uses native routes for `/plaintext` and `/json`,
so those results measure the Rust response path. `/users/:id` uses the JS
fallback and includes the Rust-to-Node bridge; that row is not a measurement of
raw Pingora throughput.
`@pingora/http-server` runs with one native thread. NestJS uses the default
Express adapter; it is compiled with `tsc` at image build because decorators are
not erasable TypeScript, while every other app runs directly with Node 24 type
stripping. Elysia runs through `@elysiajs/node`; Bun-only Elysia numbers
are deliberately not mixed into this table.
