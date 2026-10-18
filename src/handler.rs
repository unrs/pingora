use std::collections::HashMap;
use std::time::Duration;

use napi::bindgen_prelude::{Either, Promise};
use napi::threadsafe_function::ThreadsafeFunction;
use napi::Status;
use napi_derive::napi;
use pingora::proxy::Session;

use crate::options::UpstreamOptions;

#[napi(object)]
pub struct RequestView {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    pub host: Option<String>,
    pub headers: HashMap<String, String>,
    pub client_ip: Option<String>,
    pub scheme: String,
    pub http_version: String,
    pub route_id: Option<String>,
}

#[napi(object)]
pub struct RequestDecision {
    /// `continue`, `respond`, or `upstream`.
    pub action: Option<String>,
    /// Synthetic response status for `respond`.
    pub status: Option<u16>,
    /// Synthetic response headers for `respond`.
    pub headers: Option<HashMap<String, String>>,
    /// Synthetic response body for `respond`.
    pub body: Option<String>,
    /// Upstream peer for `upstream`.
    pub upstream: Option<Either<String, UpstreamOptions>>,
    pub request_headers: Option<HashMap<String, String>>,
    pub remove_request_headers: Option<Vec<String>>,
    pub response_headers: Option<HashMap<String, String>>,
    pub remove_response_headers: Option<Vec<String>>,
}

pub type HandlerTsfn =
    ThreadsafeFunction<RequestView, Promise<RequestDecision>, RequestView, Status, false, true>;

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
            let promise = self.tsfn.call_async_catch(view).await?;
            promise.await
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
        let headers = req
            .headers
            .iter()
            .filter_map(|(name, value)| {
                Some((name.as_str().to_string(), value.to_str().ok()?.to_string()))
            })
            .collect();

        let host = crate::state::request_host(req);
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
            scheme: req.uri.scheme_str().unwrap_or("http").to_string(),
            http_version: format!("{:?}", req.version),
            route_id: route_id.map(ToString::to_string),
        }
    }
}
