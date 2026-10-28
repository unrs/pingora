# Native proxy benchmark

Pinned Compose services for nginx, Caddy, OpenResty, and HAProxy, all proxying to
the same `hashicorp/http-echo` origin. A host-side Pingora instance uses the same
origin and the same Node load generator.

```sh
pnpm bench:native
BENCH_NATIVE_DURATION_MS=10000 BENCH_NATIVE_CONCURRENCY=16 pnpm bench:native
```

Requires Docker with Compose v2. The command starts the containers, waits for
all targets, measures each, and tears the stack down. The origin is a minimal Go server that loads a 4 KiB file at startup and serves
it from memory by default, with no request logging; set
`ORIGIN_READ_PER_REQUEST=1` to open and stream the file per request; access logging is
disabled for the proxies; nginx/OpenResty use four workers, HAProxy uses `nbthread 4`, and Pingora uses
`BENCH_NATIVE_THREADS` (default `min(4, availableParallelism)`).

This harness is not a replacement for a native load generator. It reports Node
client throughput and p50/p99 latency; CPU/RSS and external load-generator
numbers still need to be captured for the published report.
