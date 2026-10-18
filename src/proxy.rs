use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use pingora::http::RequestHeader;
use pingora::proxy::{ProxyHttp, Session};
use pingora::upstreams::peer::HttpPeer;
use pingora::{Error, ErrorSource, ErrorType};

use crate::router::{normalize_host, Route};
use crate::state::{request_host, SharedState};

pub struct JsProxy {
    state: Arc<SharedState>,
}

impl JsProxy {
    pub fn new(state: Arc<SharedState>) -> Self {
        Self { state }
    }
}

#[derive(Default)]
pub struct ProxyCtx {
    route: Option<Arc<Route>>,
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

        let Some(route) = self.state.match_route(req, &host, &path) else {
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
        let route = ctx.route.as_ref().ok_or_else(|| {
            Error::explain(ErrorType::InternalError, "no route selected for upstream")
        })?;
        let upstream = route
            .pick()
            .ok_or_else(|| Error::explain(ErrorType::InternalError, "route has no upstream"))?;

        let mut peer = upstream.to_peer();
        if let Some(timeout) = route.timeout {
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
        let Some(route) = ctx.route.as_ref() else {
            return Ok(());
        };

        for name in &route.remove_request_headers {
            upstream_request.remove_header(name.as_str());
        }
        for (name, value) in &route.request_headers {
            upstream_request.insert_header(name.clone(), value.clone())?;
        }

        Ok(())
    }

    async fn response_filter(
        &self,
        _session: &mut Session,
        upstream_response: &mut pingora::http::ResponseHeader,
        ctx: &mut Self::CTX,
    ) -> pingora::Result<()>
    where
        Self::CTX: Send + Sync,
    {
        let Some(route) = ctx.route.as_ref() else {
            return Ok(());
        };

        for name in &route.remove_response_headers {
            upstream_response.remove_header(name.as_str());
        }
        for (name, value) in &route.response_headers {
            upstream_response.insert_header(name.clone(), value.clone())?;
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
