# Native proxy benchmark

Pinned Compose services for Pingora, a bench-minimal Pingora build, nginx,
Caddy, OpenResty, and HAProxy, all proxying to the same origin. A host-side Pingora instance uses the same
origin and the same Node load generator.

```sh
pnpm bench:native
BENCH_NATIVE_DURATION_MS=10000 BENCH_NATIVE_CONCURRENCY=16 pnpm bench:native
```

Requires Docker with Compose v2. The command starts the containers, waits for
all targets, measures each, and tears the stack down. The origin is a minimal Go server that loads a 4 KiB file at startup and serves
it from memory by default, with no request logging; set
`BENCH_NATIVE_ORIGIN_MODES=cached,file` (the default) to measure both cached
and per-request file reads; access logging is
disabled for the proxies; nginx/OpenResty use four workers, HAProxy uses `nbthread 4`, and Pingora uses
`BENCH_NATIVE_THREADS` (default `min(4, availableParallelism)`).

This harness is not a replacement for a native load generator. It reports Node
client throughput and p50/p99 latency; CPU/RSS and external load-generator
numbers still need to be captured for the published report.

## Minimal binding

The `pingora-minimal` target is built with `--features bench-minimal`. That
feature skips request metrics, route metrics, limit checks, handler/access-log
lookups, and the logging hook; routing and proxying stay intact. It exists only
for benchmark attribution and is not a supported runtime mode.

## Raw Pingora

The `raw-pingora` target is a standalone Rust binary using Pingora's
`ProxyHttp` directly, without napi-rs or the binding's `Server`/`JsProxy`. It
uses the same origin and is built in its own Dockerfile.
