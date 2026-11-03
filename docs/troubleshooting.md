# Troubleshooting

## `Cannot find native binding`

The package loads a platform-specific `.node` file. If npm skipped the matching
optional dependency, the loader tries `napi-postinstall/fallback` once.

1. Confirm the platform is supported:
   Linux x64/arm64 glibc or musl, or macOS x64/arm64. Windows is not supported.
2. Reinstall without a stale lockfile:
   ```sh
   rm -rf node_modules package-lock.json
   npm install
   ```
3. If the package manager blocks install scripts, allow them for `pingora` and
   reinstall. Do not set `SKIP_PINGORA_FALLBACK=1` unless you are debugging.
4. If the fallback itself cannot reach the registry, check the project `.npmrc`
   credentials/proxy; the fallback uses them.

## `GLIBC_x.yy not found`

The glibc binding is built against a glibc floor. Upgrade the host glibc or use a
newer base image. On an actual musl host (for example Alpine), the loader selects
the musl binding automatically. Do not rename a musl `.node` file to a glibc name;
the glibc loader cannot use it.

## `EADDRINUSE` / stale Unix socket

A previous process may still own the listener. Stop it, then remove a stale Unix
socket path only if no process is listening. The binding preflights Unix paths
and rejects regular files, but it cannot remove a live socket owned by another
process.

## `502` from the proxy

Check:

- the upstream host/port is reachable from the proxy process
- TLS upstreams have the right CA (`docs/tls.md`) and SNI
- the upstream did not close the connection before sending a response
- route health: a passively failed peer is skipped for five seconds; active TCP
  probes can clear the cooldown when `healthCheckIntervalMs` is set

Use `metricsPrometheus()` or the metrics endpoint to see upstream errors and
status classes.

## Request body or header rejected

`maxRequestBodyBytes`, `maxRequestHeaders`, and `maxRequestHeaderBytes` return
`413`/`431` before/while proxying. Raise the relevant limit or reject the request
in the handler.

## Handler timeouts

The handler runs after route matching. `handlerTimeoutMs` (default 1000 ms)
returns `500` when exceeded. Keep handler work synchronous or return a decision
promptly; access-log callbacks are delivered asynchronously and are best effort.

## Build from source fails

Building needs a Rust toolchain and the platform's C toolchain. End users should
install a prebuilt platform package instead. For release builds, see
`docs/releasing.md`.

## Still stuck

Include the package version, OS/architecture, Node version, proxy options
(redact secrets), and the full error plus `loadErrors` when opening an issue.
