# Migration notes

## 0.1 to 0.2

No breaking API change.

- Active TCP health probes are opt-in through `healthCheckIntervalMs`; `0`
  keeps passive-only behavior.
- Prebuilt Linux musl x64/arm64 packages are now published.
- The package root still exports `Server` and `version`; existing route,
  upstream, TLS, handler, and metrics options are unchanged.
- The Node runtime floor remains `^12.20.0 || ^14.18.0 || >=16.0.0`.

Windows remains unsupported (see `docs/windows.md`).

## Migrating from another Node proxy

The binding is a Pingora proxy, not an Express middleware. Move middleware logic
into the request handler or route configuration:

- rewrite/route matching: `routes` with host/path/method/header matchers
- header changes: route `requestHeaders`/`responseHeaders` or handler decisions
- auth/rate limiting: handler returns `respond` with a status/body
- upstream selection: route `upstreams` and `strategy`

The handler is synchronous from Pingora's perspective; do not block it on
long-running I/O. Long-lived application work belongs behind the upstream.
