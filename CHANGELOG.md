# pingora

## 0.2.0

### Minor Changes

- [#15](https://github.com/unrs/pingora/pull/15) [`92fe6e9`](https://github.com/unrs/pingora/commit/92fe6e900fcdd24dfe90d718cf262fcddae4a882) Thanks [@JounQin](https://github.com/JounQin)! - Add request header, body, route, and listener limits.

- [#7](https://github.com/unrs/pingora/pull/7) [`c30c9c3`](https://github.com/unrs/pingora/commit/c30c9c3adb820336552f0d261da1fde61f7a6caf) Thanks [@JounQin](https://github.com/JounQin)! - Add the optional async JavaScript request handler with request views,
  synthetic responses, upstream overrides, header mutations, handler timeouts,
  and 500 mapping for handler errors.

- [#14](https://github.com/unrs/pingora/pull/14) [`73a0b8c`](https://github.com/unrs/pingora/commit/73a0b8c346dbdb39192cdd510860128ede234954) Thanks [@JounQin](https://github.com/JounQin)! - Add per-route metrics and Prometheus text output.

- [#9](https://github.com/unrs/pingora/pull/9) [`c1d6f12`](https://github.com/unrs/pingora/commit/c1d6f12dd7640dbf3b6e5b13e68fdcc78349b383) Thanks [@JounQin](https://github.com/JounQin)! - Add TLS listeners with per-listener certificate/key configuration and HTTP/2
  over TLS via ALPN, with HTTP/1.1 fallback.

- [#13](https://github.com/unrs/pingora/pull/13) [`6ec20ec`](https://github.com/unrs/pingora/commit/6ec20ec79d64d58ee48877142fe4dfdafeb94de1) Thanks [@JounQin](https://github.com/JounQin)! - Add Unix domain socket listeners and upstreams via `unix:/path` addresses.

- [#12](https://github.com/unrs/pingora/pull/12) [`b9dcfc5`](https://github.com/unrs/pingora/commit/b9dcfc57212e6cc9bc25d632f6c399329560b026) Thanks [@JounQin](https://github.com/JounQin)! - Add per-upstream custom CA bundle support for TLS verification, alongside SNI
  and the existing verification opt-out.

## 0.1.0

### Minor Changes

- [#3](https://github.com/unrs/pingora/pull/3) [`75affd6`](https://github.com/unrs/pingora/commit/75affd6375d2e939df66144b4fe67f7a59b231fc) Thanks [@JounQin](https://github.com/JounQin)! - Implement the core reverse proxy: server lifecycle, host/path/method/header
  routing, hot route updates, IP upstreams, round-robin/random/first balancing,
  header mutation, per-route timeouts, metrics, and graceful shutdown.
