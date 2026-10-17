use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use pingora::http::RequestHeader;

use crate::options::RouteOptions;
use crate::router::{normalize_host, parse_route, Route};

#[derive(Debug, Default)]
pub struct Metrics {
    requests: AtomicU64,
    active: AtomicU64,
    upstream_errors: AtomicU64,
    responses_2xx: AtomicU64,
    responses_3xx: AtomicU64,
    responses_4xx: AtomicU64,
    responses_5xx: AtomicU64,
}

#[derive(Debug)]
pub struct MetricSnapshot {
    pub requests: u64,
    pub active: u64,
    pub upstream_errors: u64,
    pub responses_2xx: u64,
    pub responses_3xx: u64,
    pub responses_4xx: u64,
    pub responses_5xx: u64,
    pub uptime_ms: u64,
}

impl Metrics {
    pub fn request_started(&self) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        self.active.fetch_add(1, Ordering::Relaxed);
    }

    pub fn request_finished(&self, status: Option<u16>, upstream_error: bool) {
        self.active.fetch_sub(1, Ordering::Relaxed);
        if upstream_error {
            self.upstream_errors.fetch_add(1, Ordering::Relaxed);
        }
        if let Some(status) = status {
            let counter = match status {
                200..=299 => &self.responses_2xx,
                300..=399 => &self.responses_3xx,
                400..=499 => &self.responses_4xx,
                _ => &self.responses_5xx,
            };
            counter.fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub struct SharedState {
    routes: RwLock<Vec<Arc<Route>>>,
    next_route_id: AtomicU64,
    metrics: Metrics,
    started_at: Instant,
}

impl SharedState {
    pub fn new(routes: Vec<RouteOptions>) -> Result<Self, String> {
        let state = Self {
            routes: RwLock::new(Vec::new()),
            next_route_id: AtomicU64::new(1),
            metrics: Metrics::default(),
            started_at: Instant::now(),
        };

        for route in routes {
            state.add_route(route)?;
        }

        Ok(state)
    }

    pub fn add_route(&self, options: RouteOptions) -> Result<String, String> {
        let generated_id = format!(
            "route-{}",
            self.next_route_id.fetch_add(1, Ordering::Relaxed)
        );
        let route = Arc::new(parse_route(options, generated_id)?);
        let id = route.id.clone();
        let mut routes = self.routes.write().unwrap();

        if let Some(existing) = routes.iter_mut().find(|existing| existing.id == id) {
            *existing = route;
        } else {
            routes.push(route);
        }

        Ok(id)
    }

    pub fn remove_route(&self, id: &str) -> bool {
        let mut routes = self.routes.write().unwrap();
        let before = routes.len();
        routes.retain(|route| route.id != id);
        routes.len() != before
    }

    pub fn route_count(&self) -> usize {
        self.routes.read().unwrap().len()
    }

    pub fn match_route(&self, req: &RequestHeader, host: &str, path: &str) -> Option<Arc<Route>> {
        let host = normalize_host(host);
        self.routes
            .read()
            .unwrap()
            .iter()
            .find(|route| route.matches(req, &host, path))
            .cloned()
    }

    pub fn metrics(&self) -> MetricSnapshot {
        MetricSnapshot {
            requests: self.metrics.requests.load(Ordering::Relaxed),
            active: self.metrics.active.load(Ordering::Relaxed),
            upstream_errors: self.metrics.upstream_errors.load(Ordering::Relaxed),
            responses_2xx: self.metrics.responses_2xx.load(Ordering::Relaxed),
            responses_3xx: self.metrics.responses_3xx.load(Ordering::Relaxed),
            responses_4xx: self.metrics.responses_4xx.load(Ordering::Relaxed),
            responses_5xx: self.metrics.responses_5xx.load(Ordering::Relaxed),
            uptime_ms: self.started_at.elapsed().as_millis() as u64,
        }
    }

    pub fn request_started(&self) {
        self.metrics.request_started();
    }

    pub fn request_finished(&self, status: Option<u16>, upstream_error: bool) {
        self.metrics.request_finished(status, upstream_error);
    }
}

pub fn request_host(req: &RequestHeader) -> String {
    req.headers
        .get(http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .or_else(|| req.uri.host())
        .unwrap_or_default()
        .to_string()
}

pub fn status_text(status: u8) -> &'static str {
    match status {
        0 => "idle",
        1 => "starting",
        2 => "running",
        3 => "stopping",
        4 => "stopped",
        _ => "failed",
    }
}
