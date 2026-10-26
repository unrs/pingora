# Security review

This is the binding's security checklist and current posture. It is not a
substitute for reviewing a specific deployment.

## Listener exposure

- Default listener is `127.0.0.1:8080`; nothing is public unless configured.
- A public listener should terminate TLS and enforce application authentication
  before proxying.
- The metrics listener (`metricsAddress`) has no authentication or TLS. Bind it
  to loopback or a private interface; it exposes route ids and traffic counts.
- Unix listeners use mode `0o660`; directory permissions control access.

## Upstream trust

- Internet upstreams must be IP literals. The binding does not resolve DNS, so a
  caller cannot use route configuration to trigger arbitrary DNS lookups.
- Upstream TLS verifies certificates and hostnames by default. `verify: false`
  is an explicit opt-out.
- Custom CA bundles are parsed, DER-validated, and checked against the rustls
  root store at route creation.
- Invalid CA files, invalid DER, or `ca` on a non-TLS upstream fail route setup.

## HTTP handling

- Links, CRLF, and header names are validated by `http`/Pingora.
- Handler-supplied response headers that fail validation produce a controlled
  error rather than being written raw.
- Request body limits are enforced for declared `Content-Length` and streamed
  bodies; upgraded/WebSocket traffic is excluded.
- Header count and byte limits are checked before routing.
- Handler timeouts are bounded by `handlerTimeoutMs`.
- HEAD/204/304 bodies are suppressed; 205 framing is left to Pingora because of
  `cloudflare/pingora#1055`.

## Resource limits

- `maxRequestHeaders`, `maxRequestHeaderBytes`, and `maxRequestBodyBytes`
- `maxRoutes` and `maxListeners`
- `threads` and upstream keepalive pool size are explicit options
- Access-log delivery is best effort: at most 1024 records in flight, excess
  records are dropped

## Known upstream risks

See [upstream-issues.md](./upstream-issues.md):

- `cloudflare/pingora#1056`: per-peer CA is not part of the reuse key; the
  binding isolates pools with `group_key`.
- `cloudflare/pingora#374`: path-based Unix bind can unlink a competing live
  socket; the binding requires exclusive socket paths.
- `napi-rs/napi-rs#3655`: TSFN queue-full allocation leak; the binding caps
  access-log in-flight records and is tracked upstream.

## Deployment checklist

- [ ] Public listeners have TLS and authentication.
- [ ] Metrics listener is loopback/private.
- [ ] Upstreams are IP literals with verification enabled unless intentionally
  disabled.
- [ ] Request/header/body limits are set for the expected traffic.
- [ ] Handler timeout and access-log sink are sized for the workload.
- [ ] Unix socket paths use restrictive directory permissions.
- [ ] The deployment does not expose an unintended open proxy.
