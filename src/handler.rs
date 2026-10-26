use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use napi::bindgen_prelude::{Either, Promise};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use pingora::proxy::Session;

use crate::options::UpstreamOptions;

#[napi(object)]
pub struct RequestView {
    /// Request method, e.g. `GET`.
    pub method: String,
    /// Raw, percent-encoded request path.
    pub path: String,
    /// Query string without the leading `?`.
    pub query: Option<String>,
    /// `Host` header including the port, if present.
    pub host: Option<String>,
    /// Lowercase header names. Repeated values are joined with `, `.
    pub headers: HashMap<String, String>,
    /// Downstream peer IP address.
    pub client_ip: Option<String>,
    /// `http` for the current listener implementation.
    pub scheme: String,
    /// HTTP version, e.g. `HTTP/1.1`.
    pub http_version: String,
    /// Matched route id, or `None` when no route matched.
    pub route_id: Option<String>,
}

#[napi(object)]
pub struct RequestDecision {
    /// `continue` (default), `respond`, or `upstream`.
    pub action: Option<String>,
    /// Final response status for `respond`.
    pub status: Option<u16>,
    /// Response headers for `respond`.
    pub headers: Option<HashMap<String, String>>,
    /// Response body for `respond`.
    pub body: Option<String>,
    /// Upstream peer for `upstream`.
    pub upstream: Option<Either<String, UpstreamOptions>>,
    /// Request headers added to a proxied request.
    pub request_headers: Option<HashMap<String, String>>,
    /// Request headers removed from a proxied request.
    pub remove_request_headers: Option<Vec<String>>,
    /// Response headers added to a proxied response.
    pub response_headers: Option<HashMap<String, String>>,
    /// Response headers removed from a proxied response.
    pub remove_response_headers: Option<Vec<String>>,
}

#[napi(object)]
pub struct AccessLog {
    /// Request method, e.g. `GET`.
    pub method: String,
    /// Raw, percent-encoded request path.
    pub path: String,
    /// Response status, if a response was written.
    pub status: Option<u16>,
    /// Matched route id, or `None` when no route matched.
    pub route_id: Option<String>,
    /// Whether the failure came from the upstream.
    pub upstream_error: bool,
    /// Request duration in milliseconds.
    pub duration_ms: f64,
}

pub const ACCESS_LOG_QUEUE: usize = 1024;

pub type AccessLogTsfn =
    ThreadsafeFunction<AccessLog, (), AccessLog, Status, false, true, ACCESS_LOG_QUEUE>;

pub struct AccessLogger {
    tsfn: AccessLogTsfn,
    in_flight: Arc<AtomicUsize>,
}

impl AccessLogger {
    pub fn new(tsfn: AccessLogTsfn) -> Self {
        Self {
            tsfn,
            in_flight: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn log(&self, record: AccessLog) {
        let mut in_flight = self.in_flight.load(Ordering::Relaxed);
        loop {
            if in_flight >= ACCESS_LOG_QUEUE {
                return;
            }
            match self.in_flight.compare_exchange_weak(
                in_flight,
                in_flight + 1,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(current) => in_flight = current,
            }
        }

        let in_flight = self.in_flight.clone();
        let status = self.tsfn.call_with_return_value(
            record,
            ThreadsafeFunctionCallMode::NonBlocking,
            move |_result, _env| {
                in_flight.fetch_sub(1, Ordering::Relaxed);
                Ok(())
            },
        );
        if status != Status::Ok {
            self.in_flight.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

pub type HandlerReturn = Either<Promise<RequestDecision>, RequestDecision>;

pub type HandlerTsfn =
    ThreadsafeFunction<RequestView, HandlerReturn, RequestView, Status, false, true>;

pub enum HandlerError {
    Timeout,
    Call(napi::Error),
}

pub struct RequestHandler {
    tsfn: HandlerTsfn,
    timeout: Duration,
}

impl RequestHandler {
    pub fn new(tsfn: HandlerTsfn, timeout: Duration) -> Self {
        Self { tsfn, timeout }
    }

    pub async fn call(&self, view: RequestView) -> Result<RequestDecision, HandlerError> {
        let call = async {
            match self.tsfn.call_async_catch(view).await? {
                Either::A(promise) => promise.await,
                Either::B(decision) => Ok(decision),
            }
        };

        match tokio::time::timeout(self.timeout, call).await {
            Ok(Ok(decision)) => Ok(decision),
            Ok(Err(error)) => Err(HandlerError::Call(error)),
            Err(_) => Err(HandlerError::Timeout),
        }
    }
}

impl RequestView {
    pub fn from_session(session: &Session, route_id: Option<&str>) -> Self {
        let req = session.req_header();
        let mut headers: HashMap<String, String> = HashMap::with_capacity(req.headers.len());
        for (name, value) in req.headers.iter() {
            let value = String::from_utf8_lossy(value.as_bytes());
            headers
                .entry(name.as_str().to_string())
                .and_modify(|existing| {
                    existing.push_str(", ");
                    existing.push_str(&value);
                })
                .or_insert_with(|| value.into_owned());
        }

        let host = crate::state::request_host(req);
        let scheme = if session
            .digest()
            .and_then(|digest| digest.ssl_digest.as_ref())
            .is_some()
        {
            "https"
        } else {
            "http"
        };
        Self {
            method: req.method.as_str().to_string(),
            path: req.uri.path().to_string(),
            query: req.uri.query().map(ToString::to_string),
            host: (!host.is_empty()).then_some(host),
            headers,
            client_ip: session
                .client_addr()
                .and_then(|addr| addr.as_inet())
                .map(|addr| addr.ip().to_string()),
            scheme: scheme.to_string(),
            http_version: format!("{:?}", req.version),
            route_id: route_id.map(ToString::to_string),
        }
    }
}
