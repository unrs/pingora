# Architecture

The binding is a thin Node facade over one Pingora HTTP proxy service.

```text
Node.js main thread
  Server (napi class)
    ├── SharedState: route table (RwLock), handler, atomic metrics
    ├── start(): preflight listeners, spawn "pingora-server" thread
    └── stop(): send watch signal, join the thread via napi AsyncTask

Pingora thread
  PingoraServer::run with a custom ShutdownSignalWatch
    └── HttpProxy<JsProxy>
          request_filter        match route, run optional handler, write decision/404
          upstream_peer         pick upstream or handler override, build HttpPeer
          upstream_request_filter
          response_filter
          logging               update metrics
```

## Modules

- `src/options.rs` — napi option objects (`ServerOptions`, `RouteOptions`, `UpstreamOptions`).
- `src/router.rs` — route validation/matching, upstream parsing, load balancing.
- `src/state.rs` — hot route table, request metrics, host helpers.
- `src/handler.rs` — napi request/decision types and the async TSFN call.
- `src/proxy.rs` — `ProxyHttp` implementation. JavaScript is called only when a
  request handler is installed.
- `src/server.rs` — napi `Server` class, singleton guard, listener preflight,
  thread lifecycle, graceful shutdown, `AsyncTask` join.

## Lifecycle

1. The constructor parses routes and upstreams into typed values. Route errors
   are stored and surfaced by `start()` and `status()`.
2. `start()` acquires the process-wide singleton, preflights TCP listeners, and
   spawns a dedicated thread. Listener preflight is the one deliberate check
   outside Pingora: Pingora's listener service panics on an invalid or busy
   address in a spawned thread instead of returning an error. Header names and
   values are passed through and validated by Pingora when inserted.
3. `stop()` sends `true` through a Tokio watch channel; the custom
   `ShutdownSignalWatch` returns `GracefulTerminate`. The returned `AsyncTask`
   joins the Pingora thread on a libuv worker, so the event loop is not blocked.
4. Stopping before starting is a no-op; stopping twice resolves twice. A server
   object cannot be restarted after it has started.

## Routing

`weighted_round_robin` uses smooth weighted round-robin with per-route current
weights protected by a mutex. `least_connections` tracks per-upstream active
requests and releases them from `logging`. All route selection is binding-level; Pingora's
`pingora-load-balancing` crate is not linked yet. It still has UDS gaps and its
health-check/discovery model has not been mapped onto the route facade.

Routes are checked in registration order. All specified matchers must match.
`addRoute` replaces the route with the same id in place. The route table is
behind an `RwLock`; requests clone an `Arc<Route>` snapshot for the duration of
the request.

Upstream addresses are required to be IP literals. Hostname resolution and
service discovery are deliberately left outside the binding: Pingora 0.9 has no
DNS discovery, and the binding stays a thin mapping onto its peer API.

`round_robin` uses a per-route atomic counter, `random` uses a process-wide
xorshift counter, and `first` always picks the first upstream.

## Request handler

TLS listeners use Pingora `TlsSettings` with ALPN `h2`/`http/1.1`; `start()`
validates the certificate/key pair before handing them to Pingora.

`setRequestHandler(fn)` builds a napi `ThreadsafeFunction` whose return value is
a decision or a JavaScript promise. The Pingora worker calls it with a
`RequestView` snapshot and awaits the promise under `handlerTimeoutMs`, if
one is returned. The handler is cloned per
request, so replacing or clearing it does not invalidate in-flight requests.
Decisions are `continue`, `respond`, or `upstream`, plus optional header
mutations. Synthetic responses use the decision `headers`; route response
mutations do not apply. Handler errors, invalid decisions, and timeouts produce a
`500`. Without a handler, requests never cross into JavaScript.

HTTP/1.1 upgrade requests, including WebSocket, follow Pingora's upgraded-body
path after the route and header filters.

## Limits

Limits are checked in `request_filter` before route selection and the handler;
streamed request bodies are counted in `request_body_filter` and rejected with
413 once they exceed `maxRequestBodyBytes`.

## Access logs

`setAccessLogHandler` sends one `AccessLog` record per request from `logging`
through a non-blocking TSFN. System logs remain on the env_logger path.

## Logging

`logFormat: 'json'` installs an env_logger formatter that emits one JSON object
per line. Logger initialization remains process-wide.

## Metrics service

When `metricsAddress` is set, a second Pingora service serves `/metrics` and
`/healthz` on its own TCP listener; it shares the proxy's metrics state.

## Metrics

Per-route counters live on each route; `metricsPrometheus` renders aggregate and
per-route counters in Prometheus text format.

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
