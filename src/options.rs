use std::collections::HashMap;

use napi::bindgen_prelude::Either;
use napi_derive::napi;

#[napi(object)]
pub struct ServerOptions {
    /// Listener addresses or per-listener TLS settings. Strings are TCP
    /// `host:port` or `unix:/path`. Defaults to `127.0.0.1:8080`.
    pub listeners: Option<Vec<Either<String, ListenerOptions>>>,
    /// Initial routes. More can be added at runtime.
    pub routes: Option<Vec<RouteOptions>>,
    /// Worker threads for the proxy service.
    pub threads: Option<u32>,
    /// Grace period between shutdown broadcast and runtime shutdown, in ms.
    /// Pingora applies this in whole seconds, rounded up.
    pub grace_period_ms: Option<u32>,
    /// Maximum time to wait for the service runtimes to exit, in ms.
    /// Pingora applies this in whole seconds, rounded up.
    pub shutdown_timeout_ms: Option<u32>,
    /// Upstream connection pool size.
    pub upstream_keepalive_pool_size: Option<u32>,
    /// Default log filter, e.g. `pingora=info`. `RUST_LOG` takes precedence.
    pub log_level: Option<String>,
    /// Request handler timeout, in milliseconds. Defaults to 1000.
    pub handler_timeout_ms: Option<u32>,
    /// Maximum number of request headers; larger requests get 431.
    pub max_request_headers: Option<u32>,
    /// Maximum total request header name+value bytes; larger requests get 431.
    pub max_request_header_bytes: Option<u32>,
    /// Maximum request body size; larger requests get 413. Declared
    /// Content-Length is rejected before proxying; chunked bodies are limited
    /// while streaming (an early upstream response can win the status code).
    pub max_request_body_bytes: Option<u32>,
    /// Maximum number of routes.
    pub max_routes: Option<u32>,
    /// Maximum number of listeners.
    pub max_listeners: Option<u32>,
    /// Optional numeric IP:port for a read-only /metrics and /healthz service.
    pub metrics_address: Option<String>,
}

#[napi(object)]
pub struct RouteOptions {
    /// Stable route id. Defaults to a generated id; adding the same id replaces
    /// the existing route in place.
    pub id: Option<String>,
    /// Host matcher: an exact host, a `*.example.com` wildcard, or `*`.
    pub host: Option<Either<String, Vec<String>>>,
    /// Exact path matcher.
    pub path: Option<String>,
    /// Path prefix matcher.
    pub path_prefix: Option<String>,
    /// HTTP methods, case-insensitive.
    pub methods: Option<Vec<String>>,
    /// Headers that must all be present with the given values.
    pub match_headers: Option<HashMap<String, String>>,
    /// Upstreams; strings accept `IP:port`, `http://IP[:port]`, or
    /// `https://IP[:port]`. Hostnames must be resolved by the caller.
    pub upstreams: Vec<Either<String, UpstreamOptions>>,
    /// `round_robin` (default), `weighted_round_robin`, `random`, or `first`.
    pub strategy: Option<String>,
    /// Request headers applied before proxying.
    pub request_headers: Option<HashMap<String, String>>,
    /// Request headers removed before proxying.
    pub remove_request_headers: Option<Vec<String>>,
    /// Response headers applied before sending downstream.
    pub response_headers: Option<HashMap<String, String>>,
    /// Response headers removed before sending downstream.
    pub remove_response_headers: Option<Vec<String>>,
    /// Connect, read, and write timeout for this route's upstreams, in ms.
    pub timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct ListenerOptions {
    /// `host:port` or `unix:/path` to listen on.
    pub address: String,
    /// Terminate TLS on this listener.
    pub tls: Option<TlsOptions>,
}

#[napi(object)]
pub struct TlsOptions {
    /// PEM certificate chain path.
    pub cert: String,
    /// PEM private key path.
    pub key: String,
}

#[napi(object)]
pub struct UpstreamOptions {
    /// `IP:port`, `unix:/path`, `http://IP[:port]`, or `https://IP[:port]`.
    pub address: String,
    /// Relative weight for `weighted_round_robin`; defaults to 1.
    pub weight: Option<u32>,
    /// Override the scheme-derived TLS setting.
    pub tls: Option<bool>,
    /// Override the SNI hostname.
    pub sni: Option<String>,
    /// Verify the upstream certificate and hostname. Defaults to true.
    pub verify: Option<bool>,
    /// PEM CA certificate used to verify the upstream. Defaults to the system
    /// trust store.
    pub ca: Option<String>,
}
