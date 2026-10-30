# Benchmarks

`just bench` builds the release binding and runs Vitest HTTP benchmarks through
a local Node.js HTTP origin:

```text
Node.js load generator -> proxy under test -> Node.js HTTP origin
```

"Direct origin (no proxy)" skips the middle hop. The same origin is used for
[`pingora`](https://www.npmjs.com/package/pingora),
[`http-proxy`](https://github.com/http-party/node-http-proxy), and
[`http-proxy-middleware`](https://github.com/chimurai/http-proxy-middleware).

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

These numbers are end-to-end Node numbers: the Vitest client and the Node origin
share the same machine and event loop, so they measure the cost of adding a
proxy to a Node stack, not Pingora's maximum throughput. The direct-origin row
is a no-proxy baseline. Under a native load generator with a non-Node origin,
Pingora's Rust data path is expected to be substantially faster; that requires
the separate native benchmark matrix in the roadmap.

Relative to the JS proxies in this harness, the binding is about 28% faster
than `http-proxy` for single requests and about 87% faster at 20 concurrent
requests. Run `just bench` on the target machine before drawing conclusions.
Native comparisons against nginx, Caddy, and OpenResty are tracked in the
roadmap benchmark matrix.

## Performance smoke gate

`pnpm bench:gate` compares proxy throughput against a direct origin and fails
below the configured ratio. It alternates three rounds and uses the median ratio;
CI runs the debug build with a conservative 0.05 threshold. It is a
catastrophic-regression guard, not a precise benchmark.

## Native proxy matrix

`bench/native` contains pinned Docker Compose configs for Pingora, a raw
Pingora binary, pingap, nginx, Caddy, OpenResty, and HAProxy sharing one origin
and Docker network. `pnpm bench:native` runs the matrix
with the same Node load generator used by the smoke gate:

```sh
pnpm bench:native
```

It reports throughput, p50/p99 latency, average CPU%, and RSS per target in both
`cached` and `file` origin modes. CPU% is the cgroup `usage_usec` delta over the
measured interval; RSS is `memory.current`. The direct origin is measured before and after each proxy
matrix to expose run-to-run drift. The harness requires Node.js 24+, Linux x64
glibc, and Docker; it is developer tooling and is not covered by the package
runtime floor. CPU/RSS and a native load generator are still required for the
published report.

## Native benchmark workflow

The `Native benchmark` GitHub Actions workflow runs the native matrix on pull
requests and pushes to `main`. It builds the release binding, starts the pinned
Compose stack, runs the benchmark, writes a table to the job summary, and uploads
`native-benchmark.json`.

Each result records `startedAt` and, in GitHub Actions, `commit`. Local
Pingora/origin/raw images are rebuilt with `--build`; third-party images use
pinned tags rather than `latest`.

## Sample native run

One CI run (commit `aefb134`, Linux x64, Node 24, 4 threads, 16 concurrent
clients, 5 seconds per target, Docker Compose) produced:

| mode | target | req/s | p50 (ms) | p99 (ms) | CPU% | RSS (MiB) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| cached | direct origin (start) | 15,618 | 0.88 | 2.42 | 106 | 8 |
| cached | nginx 1.27.5 | 11,867 | 1.16 | 3.58 | 100 | 5 |
| cached | Caddy 2.9.1 | 10,731 | 1.31 | 4.23 | 161 | 18 |
| cached | OpenResty 1.27.1.1 | 12,389 | 1.14 | 3.29 | 106 | 5 |
| cached | HAProxy 3.0.5 | 15,461 | 0.90 | 2.59 | 79 | 13 |
| cached | Pingora binding | 13,707 | 1.06 | 3.11 | 123 | 15 |
| cached | raw Pingora | 13,806 | 1.05 | 3.04 | 116 | 5 |
| cached | pingap 0.15.0 | 13,838 | 1.05 | 2.80 | 122 | 10 |
| cached | direct origin (end) | 16,011 | 0.87 | 2.66 | 110 | 10 |
| file | direct origin (start) | 15,550 | 0.89 | 2.69 | 132 | 8 |
| file | nginx 1.27.5 | 11,624 | 1.26 | 3.57 | 98 | 5 |
| file | Caddy 2.9.1 | 9,043 | 1.58 | 4.96 | 148 | 18 |
| file | OpenResty 1.27.1.1 | 11,094 | 1.30 | 4.02 | 95 | 5 |
| file | HAProxy 3.0.5 | 12,680 | 1.09 | 3.97 | 78 | 13 |
| file | Pingora binding | 10,885 | 1.31 | 4.01 | 108 | 15 |
| file | raw Pingora | 11,360 | 1.26 | 3.75 | 107 | 5 |
| file | pingap 0.15.0 | 11,247 | 1.28 | 3.89 | 111 | 10 |
| file | direct origin (end) | 14,894 | 0.91 | 3.19 | 150 | 11 |

CPU% is the cgroup `usage_usec` delta over the measured interval and can exceed
100% on multiple cores. RSS is `memory.current`, which includes page cache. The
direct origin drifts several percent between the start and end rows, and the
Node client is the bottleneck at these rates. This is a sample, not a published
performance claim; a native load generator is still required for the final
report.
