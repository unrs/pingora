use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::{RequestHeader, ResponseHeader};
use pingora::proxy::{ProxyHttp, Session};
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorSource, ErrorType};

use crate::handler::{HandlerError, RequestDecision, RequestView};
use crate::router::{normalize_host, parse_upstream, Route, Upstream};
use crate::state::{request_host, SharedState};

pub struct JsProxy {
    state: Arc<SharedState>,
}

impl JsProxy {
    pub fn new(state: Arc<SharedState>) -> Self {
        Self { state }
    }

    async fn apply_decision(
        &self,
        session: &mut Session,
        ctx: &mut ProxyCtx,
        route: Option<Arc<Route>>,
        decision: RequestDecision,
    ) -> Result<bool, String> {
        ctx.route = route;

        let action = decision
            .action
            .as_deref()
            .unwrap_or("continue")
            .to_ascii_lowercase();
        if action != "respond" {
            ctx.request_headers = decision
                .request_headers
                .unwrap_or_default()
                .into_iter()
                .collect();
            ctx.remove_request_headers = decision.remove_request_headers.unwrap_or_default();
            ctx.response_headers = decision
                .response_headers
                .unwrap_or_default()
                .into_iter()
                .collect();
            ctx.remove_response_headers = decision.remove_response_headers.unwrap_or_default();
        }

        match action.as_str() {
            "continue" => Ok(false),
            "upstream" => {
                let upstream = decision
                    .upstream
                    .ok_or_else(|| "upstream decision requires an upstream".to_string())?;
                ctx.upstream = Some(parse_upstream(upstream)?);
                Ok(false)
            }
            "respond" => {
                let status = decision.status.unwrap_or(200);
                let is_head = session.req_header().method == http::Method::HEAD;
                let body = decision.body.unwrap_or_default();
                let mut response = ResponseHeader::build(status, None)
                    .map_err(|error| format!("invalid response: {error}"))?;
                for (name, value) in decision.headers.unwrap_or_default() {
                    response
                        .insert_header(name, value)
                        .map_err(|error| format!("invalid response header: {error}"))?;
                }
                if status != 204 && status != 304 {
                    response
                        .set_content_length(body.len())
                        .map_err(|error| format!("invalid response body: {error}"))?;
                }
                session
                    .write_response_header(Box::new(response), false)
                    .await
                    .map_err(|error| format!("failed to write response: {error}"))?;
                // 205 framing is left to Pingora: cloudflare/pingora#1055.
                let body = if is_head || matches!(status, 204 | 304) {
                    None
                } else {
                    Some(Bytes::from(body))
                };
                session
                    .write_response_body(body, true)
                    .await
                    .map_err(|error| format!("failed to write response body: {error}"))?;
                Ok(true)
            }
            other => Err(format!(
                "invalid request decision action `{other}` (expected continue, respond, or upstream)"
            )),
        }
    }

    async fn handler_failed(session: &mut Session, reason: &str) -> pingora::Result<bool> {
        log::error!("request handler failed: {reason}");
        session
            .respond_error_with_body(500, Bytes::from_static(b"request handler failed"))
            .await?;
        Ok(true)
    }
}

#[derive(Default)]
pub struct ProxyCtx {
    route: Option<Arc<Route>>,
    upstream: Option<Upstream>,
    request_headers: Vec<(String, String)>,
    remove_request_headers: Vec<String>,
    response_headers: Vec<(String, String)>,
    remove_response_headers: Vec<String>,
    active: bool,
}

#[async_trait]
impl ProxyHttp for JsProxy {
    type CTX = ProxyCtx;

    fn new_ctx(&self) -> Self::CTX {
        ProxyCtx::default()
    }

    async fn request_filter(
        &self,
        session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> pingora::Result<bool>
    where
        Self::CTX: Send + Sync,
    {
        self.state.request_started();
        ctx.active = true;

        let req = session.req_header();
        let path = req.uri.path().to_string();
        let host = normalize_host(&request_host(req));
        let route = self.state.match_route(req, &host, &path);

        if let Some(handler) = self.state.handler() {
            let view =
                RequestView::from_session(session, route.as_ref().map(|route| route.id.as_str()));
            match handler.call(view).await {
                Ok(decision) => match self.apply_decision(session, ctx, route, decision).await {
                    Ok(true) => return Ok(true),
                    Ok(false) if ctx.route.is_none() && ctx.upstream.is_none() => {
                        session
                            .respond_error_with_body(404, Bytes::from_static(b"no route matched"))
                            .await?;
                        return Ok(true);
                    }
                    Ok(false) => return Ok(false),
                    Err(error) => return Self::handler_failed(session, &error).await,
                },
                Err(HandlerError::Timeout) => {
                    return Self::handler_failed(session, "handler timed out").await
                }
                Err(HandlerError::Call(error)) => {
                    return Self::handler_failed(session, &error.to_string()).await
                }
            }
        }

        let Some(route) = route else {
            session
                .respond_error_with_body(404, Bytes::from_static(b"no route matched"))
                .await?;
            return Ok(true);
        };

        ctx.route = Some(route);
        Ok(false)
    }

    async fn upstream_peer(
        &self,
        _session: &mut Session,
        ctx: &mut Self::CTX,
    ) -> pingora::Result<Box<HttpPeer>> {
        let mut peer = if let Some(upstream) = ctx.upstream.as_ref() {
            upstream.to_peer()
        } else {
            let route = ctx.route.as_ref().ok_or_else(|| {
                Error::explain(ErrorType::InternalError, "no route selected for upstream")
            })?;
            let upstream = route
                .pick()
                .ok_or_else(|| Error::explain(ErrorType::InternalError, "route has no upstream"))?;
            upstream.to_peer()
        }
        .map_err(|error| Error::explain(ErrorType::InternalError, error))?;

        if let Some(timeout) = ctx.route.as_ref().and_then(|route| route.timeout) {
            peer.options.connection_timeout = Some(timeout);
            peer.options.total_connection_timeout = Some(timeout);
            peer.options.read_timeout = Some(timeout);
            peer.options.write_timeout = Some(timeout);
        }

        Ok(Box::new(peer))
    }

    async fn upstream_request_filter(
        &self,
        _session: &mut Session,
        upstream_request: &mut RequestHeader,
        ctx: &mut Self::CTX,
    ) -> pingora::Result<()>
    where
        Self::CTX: Send + Sync,
    {
        if let Some(route) = ctx.route.as_ref() {
            for name in route.remove_request_headers.iter() {
                upstream_request.remove_header(name.as_str());
            }
            for (name, value) in route.request_headers.iter().cloned() {
                upstream_request.insert_header(name, value)?;
            }
        }
        for name in ctx.remove_request_headers.iter() {
            upstream_request.remove_header(name.as_str());
        }
        for (name, value) in ctx.request_headers.iter().cloned() {
            upstream_request.insert_header(name, value)?;
        }

        Ok(())
    }

    async fn response_filter(
        &self,
        _session: &mut Session,
        upstream_response: &mut ResponseHeader,
        ctx: &mut Self::CTX,
    ) -> pingora::Result<()>
    where
        Self::CTX: Send + Sync,
    {
        if let Some(route) = ctx.route.as_ref() {
            for name in route.remove_response_headers.iter() {
                upstream_response.remove_header(name.as_str());
            }
            for (name, value) in route.response_headers.iter().cloned() {
                upstream_response.insert_header(name, value)?;
            }
        }
        for name in ctx.remove_response_headers.iter() {
            upstream_response.remove_header(name.as_str());
        }
        for (name, value) in ctx.response_headers.iter().cloned() {
            upstream_response.insert_header(name, value)?;
        }

        Ok(())
    }

    async fn logging(&self, session: &mut Session, error: Option<&Error>, ctx: &mut Self::CTX)
    where
        Self::CTX: Send + Sync,
    {
        if !ctx.active {
            return;
        }
        ctx.active = false;

        let status = session
            .response_written()
            .map(|response| response.status.as_u16());
        let upstream_error =
            error.is_some_and(|error| matches!(error.esource(), ErrorSource::Upstream));
        self.state.request_finished(status, upstream_error);
    }
}
