# @pingora/http-server

## 0.2.0

### Minor Changes

- [#57](https://github.com/unrs/pingora/pull/57) [`96a066c`](https://github.com/unrs/pingora/commit/96a066cef38c170418691f5b77f0585e805241a3) Thanks [@JounQin](https://github.com/JounQin)! - Add native static response routes and a `handlerOnlyOnUnmatched` mode. Matching routes are served entirely in Rust and skip the JS handler; `@pingora/http-server` now accepts `routes` and an optional fallback `handler`.

### Patch Changes

- [#60](https://github.com/unrs/pingora/pull/60) [`6490177`](https://github.com/unrs/pingora/commit/6490177ec25bc4ce034832b62a2eae6bb32406db) Thanks [@JounQin](https://github.com/JounQin)! - Skip request-body reads for bodyless requests when `readHandlerBody` is enabled, using Pingora's downstream body state so HTTP/1.1 and HTTP/2 framing are handled correctly.
- Updated dependencies [[`6490177`](https://github.com/unrs/pingora/commit/6490177ec25bc4ce034832b62a2eae6bb32406db), [`96a066c`](https://github.com/unrs/pingora/commit/96a066cef38c170418691f5b77f0585e805241a3)]:
  - pingora@0.5.0

## 0.1.0

### Minor Changes

- [#52](https://github.com/unrs/pingora/pull/52) [`308a360`](https://github.com/unrs/pingora/commit/308a3607b0bd5da0bdfafc9550a400e8bd1bee71) Thanks [@JounQin](https://github.com/JounQin)! - Add the direct HTTP server facade package.

### Patch Changes

- Updated dependencies [[`62edb53`](https://github.com/unrs/pingora/commit/62edb53de074170493d4282f6f5ab13dd63789f2), [`e1e23ed`](https://github.com/unrs/pingora/commit/e1e23ed585be434d9d02c3acf66373eb9115eb2d)]:
  - pingora@0.4.0
