# Upstream issues

Known issues in [`cloudflare/pingora`](https://github.com/cloudflare/pingora) that
we have actually observed and are tracking instead of working around locally.

Add an entry only when there is an upstream issue link; this is not a general
list of every Pingora limitation.

## #1056 — Per-peer CA is not part of the connection-reuse key

- Status: open
- Link: https://github.com/cloudflare/pingora/issues/1056
- Affects: routes that use the same upstream address/SNI with different
  per-upstream CA bundles
- Detail: `HttpPeer.group_key` defaults to `0` and `PeerOptions.ca` is not part
  of the connection-reuse hash, so a connection established under one CA policy
  can be reused under another.
- Binding workaround: derive `group_key` from the CA bundle (and reserve a
  distinct value for the default trust store).
- Cleanup: remove the `group_key` derivation when the upstream fix lands.

## #1055 — HTTP/1 body writer does not treat 205 as bodyless

- Status: open
- Link: https://github.com/cloudflare/pingora/issues/1055
- Affects: HTTP/1 downstream responses with status `205`
- Detail: `HttpSession::init_body_writer` special-cases `204`, `304`, and `HEAD`,
  but not `205`. A `205` response can therefore carry a body or a non-zero
  `Content-Length` and leave clients waiting for bytes that never arrive.
- Binding policy: no local workaround. Synthetic `respond` decisions with
  status `205` are left to Pingora until the issue is fixed.
- Cleanup: remove this entry and the related handler caveat when the upstream
  fix lands.
