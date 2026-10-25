use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::ResponseHeader;
use pingora::proxy::{ProxyHttp, Session};
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorType};

use crate::state::SharedState;

pub struct MetricsProxy {
    state: std::sync::Arc<SharedState>,
}

impl MetricsProxy {
    pub fn new(state: std::sync::Arc<SharedState>) -> Self {
        Self { state }
    }
}

#[async_trait]
impl ProxyHttp for MetricsProxy {
    type CTX = ();

    fn new_ctx(&self) -> Self::CTX {}

    async fn upstream_peer(
        &self,
        _session: &mut Session,
        _ctx: &mut Self::CTX,
    ) -> pingora::Result<Box<HttpPeer>> {
        Err(Error::explain(
            ErrorType::InternalError,
            "metrics service does not proxy",
        ))
    }

    async fn request_filter(
        &self,
        session: &mut Session,
        _ctx: &mut Self::CTX,
    ) -> pingora::Result<bool>
    where
        Self::CTX: Send + Sync,
    {
        let method = session.req_header().method.clone();
        let path = session.req_header().uri.path();
        let (status, content_type, body) =
            if method != http::Method::GET && method != http::Method::HEAD {
                (405, "text/plain", "method not allowed".to_string())
            } else {
                match path {
                    "/metrics" => (
                        200,
                        "text/plain; version=0.0.4",
                        self.state.metrics_prometheus(),
                    ),
                    "/healthz" => (200, "text/plain", "ok".to_string()),
                    _ => (404, "text/plain", "not found".to_string()),
                }
            };
        let mut response = ResponseHeader::build(status, None)
            .map_err(|error| Error::explain(ErrorType::InternalError, error.to_string()))?;
        response
            .insert_header("content-type", content_type)
            .map_err(|error| Error::explain(ErrorType::InternalError, error.to_string()))?;
        if status == 405 {
            response
                .insert_header("allow", "GET, HEAD")
                .map_err(|error| Error::explain(ErrorType::InternalError, error.to_string()))?;
        }
        response
            .set_content_length(body.len())
            .map_err(|error| Error::explain(ErrorType::InternalError, error.to_string()))?;
        session
            .write_response_header(Box::new(response), false)
            .await?;
        let is_head = session.req_header().method == http::Method::HEAD;
        let body = if is_head || status == 204 {
            None
        } else {
            Some(Bytes::from(body))
        };
        session.write_response_body(body, true).await?;
        Ok(true)
    }
}
