# Native proxy benchmark

Pinned Compose services for Pingora, raw Pingora, pingap, nginx, Caddy,
OpenResty, and HAProxy, all proxying to the same origin. The
Compose services share the same origin and Node load generator.

```sh
pnpm bench:native
BENCH_NATIVE_DURATION_MS=10000 BENCH_NATIVE_CONCURRENCY=16 pnpm bench:native
```

## Requirements

- Node.js 24+ (the runner is TypeScript executed with native type stripping; this
  is developer tooling and is outside the package's Node 12 runtime floor)
- Linux x64 with glibc
- Docker with Compose v2

The command starts the containers, waits for all targets, measures each, and
tears the stack down. The origin is a minimal Go server that loads a 4 KiB file at startup and serves
it from memory by default, with no request logging; set
`BENCH_NATIVE_ORIGIN_MODES=cached,file` (the default) to measure both cached
and per-request file reads; access logging is
disabled for the proxies; nginx/OpenResty use four workers, HAProxy uses `nbthread 4`, and Pingora uses
`BENCH_NATIVE_THREADS` (default `min(4, availableParallelism)`).

This harness is not a replacement for a native load generator. It reports Node
client throughput and p50/p99 latency; CPU/RSS and external load-generator
numbers still need to be captured for the published report.


## pingap

The `pingap` target is the third-party Pingora-based proxy
[`vicanso/pingap`](https://github.com/vicanso/pingap), pinned to 0.15.0 and
configured with `pingap.toml`.

`bench:native` executes `run.ts` directly with Node 24 type stripping.
