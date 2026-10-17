# Architecture

The binding is a thin Node facade over one Pingora HTTP proxy service.

```text
Node.js main thread
  Server (napi class)
    ├── SharedState: route table (RwLock) + atomic metrics
    ├── start(): preflight listeners, spawn "pingora-server" thread
    └── stop(): send watch signal, join the thread via napi AsyncTask

Pingora thread
  PingoraServer::run with a custom ShutdownSignalWatch
    └── HttpProxy<JsProxy>
          request_filter        match route or write 404
          upstream_peer         pick upstream, build HttpPeer, apply timeout
          upstream_request_filter
          response_filter
          logging               update metrics
```

## Modules

- `src/options.rs` — napi option objects (`ServerOptions`, `RouteOptions`, `UpstreamOptions`).
- `src/router.rs` — route validation/matching, upstream parsing, load balancing.
- `src/state.rs` — hot route table, request metrics, host helpers.
- `src/proxy.rs` — `ProxyHttp` implementation. No JavaScript is called on the
  request path in M1.
- `src/server.rs` — napi `Server` class, singleton guard, listener preflight,
  thread lifecycle, graceful shutdown, `AsyncTask` join.

## Lifecycle

1. The constructor validates address syntax, routes, headers, and upstreams. A
   validation error is stored and surfaced by `start()` and `status()`.
2. `start()` acquires the process-wide singleton, preflight-binds TCP listeners,
   and spawns a dedicated thread. It returns after the thread is spawned.
3. `stop()` sends `true` through a Tokio watch channel; the custom
   `ShutdownSignalWatch` returns `GracefulTerminate`. The returned `AsyncTask`
   joins the Pingora thread on a libuv worker, so the event loop is not blocked.
4. Stopping before starting is a no-op; stopping twice resolves twice. A server
   object cannot be restarted after it has started.

## Routing

Routes are checked in registration order. All specified matchers must match.
`addRoute` replaces the route with the same id in place. The route table is
behind an `RwLock`; requests clone an `Arc<Route>` snapshot for the duration of
the request.

Upstreams are resolved when a route is added. `round_robin` uses a per-route
atomic counter, `random` uses a process-wide xorshift counter, and `first`
always picks the first upstream.

## Metrics

Metrics are updated from `request_filter` and `logging`:

- `requests` and `active` at request start;
- `active` decrement, `upstreamErrors`, and the response status class at
  logging time.

Because `logging` runs after the response is written, metric updates can be
observed slightly after the client receives the response.

## Threading constraints

Pingora assumes process-level singletons. Only one server may run per process;
a second `start()` fails with a clear error. The server runs on its own OS
thread, while napi calls stay on the Node thread.
