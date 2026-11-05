---
"pingora": minor
"@pingora/http-server": minor
---

Add native static response routes and a `handlerOnlyOnUnmatched` mode. Matching routes are served entirely in Rust and skip the JS handler; `@pingora/http-server` now accepts `routes` and an optional fallback `handler`.
