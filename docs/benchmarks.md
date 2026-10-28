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
below the configured ratio. CI runs the debug build with a conservative 0.1
threshold; it is a catastrophic-regression guard, not a precise benchmark.
