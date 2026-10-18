use std::collections::HashMap;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use http::uri::Authority;
use http::{HeaderName, HeaderValue, Method};
use napi::bindgen_prelude::Either;
use pingora::http::RequestHeader;
use pingora::upstreams::peer::HttpPeer;

use crate::options::{RouteOptions, UpstreamOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    RoundRobin,
    Random,
    First,
}

#[derive(Debug, Clone)]
pub enum HostPattern {
    Any,
    Exact(String),
    Wildcard(String),
}

#[derive(Debug, Clone)]
pub struct Upstream {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    pub sni: String,
    pub verify: bool,
}

#[derive(Debug)]
pub struct Route {
    pub id: String,
    pub hosts: Vec<HostPattern>,
    pub path: Option<String>,
    pub path_prefix: Option<String>,
    pub methods: Vec<String>,
    pub match_headers: Vec<(HeaderName, String)>,
    pub upstreams: Vec<Upstream>,
    pub strategy: Strategy,
    pub request_headers: Vec<(String, String)>,
    pub remove_request_headers: Vec<String>,
    pub response_headers: Vec<(String, String)>,
    pub remove_response_headers: Vec<String>,
    pub timeout: Option<Duration>,
    counter: AtomicUsize,
}

impl Route {
    pub fn matches(&self, req: &RequestHeader, host: &str, path: &str) -> bool {
        if !self.hosts.is_empty() && !self.hosts.iter().any(|pattern| pattern.matches(host)) {
            return false;
        }

        if let Some(expected) = &self.path {
            if path != expected {
                return false;
            }
        }

        if let Some(prefix) = &self.path_prefix {
            if !path.starts_with(prefix) {
                return false;
            }
        }

        if !self.methods.is_empty()
            && !self
                .methods
                .iter()
                .any(|method| method == req.method.as_str())
        {
            return false;
        }

        for (name, expected) in &self.match_headers {
            let Some(actual) = req.headers.get(name) else {
                return false;
            };
            if actual.to_str().ok() != Some(expected.as_str()) {
                return false;
            }
        }

        true
    }

    pub fn pick(&self) -> Option<&Upstream> {
        let len = self.upstreams.len();
        if len == 0 {
            return None;
        }
        let index = match self.strategy {
            Strategy::First => 0,
            Strategy::RoundRobin => self.counter.fetch_add(1, Ordering::Relaxed) % len,
            Strategy::Random => random_index(len),
        };
        self.upstreams.get(index)
    }
}

impl HostPattern {
    fn matches(&self, host: &str) -> bool {
        match self {
            Self::Any => true,
            Self::Exact(expected) => host == expected,
            Self::Wildcard(suffix) => host.len() > suffix.len() && host.ends_with(suffix),
        }
    }
}

#[derive(Debug)]
pub enum ResolveError {
    TimedOut,
    Failed(String),
}

impl Upstream {
    pub async fn to_peer(&self, timeout: Option<Duration>) -> Result<HttpPeer, ResolveError> {
        let addr = match self.host.parse::<std::net::IpAddr>() {
            Ok(ip) => std::net::SocketAddr::new(ip, self.port),
            Err(_) => {
                let host = self.host.clone();
                let port = self.port;
                let lookup = async move {
                    tokio::net::lookup_host((host.as_str(), port))
                        .await
                        .map_err(|error| {
                            ResolveError::Failed(format!(
                                "failed to resolve upstream `{host}:{port}`: {error}"
                            ))
                        })?
                        .next()
                        .ok_or_else(|| {
                            ResolveError::Failed(format!(
                                "upstream `{host}:{port}` did not resolve to an address"
                            ))
                        })
                };

                match timeout {
                    Some(timeout) => tokio::time::timeout(timeout, lookup)
                        .await
                        .map_err(|_| ResolveError::TimedOut)??,
                    None => lookup.await?,
                }
            }
        };

        let mut peer = HttpPeer::new(addr, self.tls, self.sni.clone());
        peer.options.verify_cert = self.verify;
        peer.options.verify_hostname = self.verify;
        Ok(peer)
    }
}

pub fn parse_route(options: RouteOptions, generated_id: String) -> Result<Route, String> {
    let id = options
        .id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or(generated_id);

    let hosts = parse_hosts(options.host)?;
    let methods = parse_methods(options.methods)?;
    let match_headers = parse_match_headers(options.match_headers)?;
    let request_headers = parse_headers(options.request_headers, "requestHeaders")?;
    let response_headers = parse_headers(options.response_headers, "responseHeaders")?;
    let remove_request_headers =
        parse_header_names(options.remove_request_headers, "removeRequestHeaders")?;
    let remove_response_headers =
        parse_header_names(options.remove_response_headers, "removeResponseHeaders")?;

    if options.upstreams.is_empty() {
        return Err(format!("route `{id}` must have at least one upstream"));
    }

    let upstreams = options
        .upstreams
        .into_iter()
        .map(parse_upstream)
        .collect::<Result<Vec<_>, _>>()?;

    let strategy = match options.strategy.as_deref().unwrap_or("round_robin") {
        "round_robin" => Strategy::RoundRobin,
        "random" => Strategy::Random,
        "first" => Strategy::First,
        other => {
            return Err(format!(
            "route `{id}` has invalid strategy `{other}` (expected round_robin, random, or first)"
        ))
        }
    };

    let timeout = match options.timeout_ms {
        Some(0) => return Err(format!("route `{id}` timeoutMs must be greater than 0")),
        Some(ms) => Some(Duration::from_millis(ms.into())),
        None => None,
    };

    Ok(Route {
        id,
        hosts,
        path: options.path,
        path_prefix: options.path_prefix,
        methods,
        match_headers,
        upstreams,
        strategy,
        request_headers,
        remove_request_headers,
        response_headers,
        remove_response_headers,
        timeout,
        counter: AtomicUsize::new(0),
    })
}

fn parse_hosts(value: Option<Either<String, Vec<String>>>) -> Result<Vec<HostPattern>, String> {
    let hosts = match value {
        None => return Ok(Vec::new()),
        Some(Either::A(host)) => vec![host],
        Some(Either::B(hosts)) => hosts,
    };

    hosts
        .into_iter()
        .map(|host| {
            let host = host.trim();
            if host.is_empty() {
                return Err("host matcher cannot be empty".to_string());
            }
            if host == "*" {
                return Ok(HostPattern::Any);
            }
            if let Some(suffix) = host.strip_prefix("*.") {
                if suffix.is_empty() || suffix.contains('*') {
                    return Err(format!("invalid host wildcard `{host}`"));
                }
                return Ok(HostPattern::Wildcard(format!(
                    ".{}",
                    normalize_host(suffix)
                )));
            }
            if host.contains('*') {
                return Err(format!("invalid host wildcard `{host}`"));
            }
            Ok(HostPattern::Exact(normalize_host(host)))
        })
        .collect()
}

fn parse_methods(methods: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let Some(methods) = methods else {
        return Ok(Vec::new());
    };

    methods
        .into_iter()
        .map(|method| {
            Method::from_bytes(method.as_bytes())
                .map(|method| method.as_str().to_ascii_uppercase())
                .map_err(|_| format!("invalid HTTP method `{method}`"))
        })
        .collect()
}

fn parse_match_headers(
    headers: Option<HashMap<String, String>>,
) -> Result<Vec<(HeaderName, String)>, String> {
    let Some(headers) = headers else {
        return Ok(Vec::new());
    };

    headers
        .into_iter()
        .map(|(name, value)| {
            let header_name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| format!("invalid header name `{name}`"))?;
            HeaderValue::from_str(&value)
                .map_err(|_| format!("invalid value for header `{name}`"))?;
            Ok((header_name, value))
        })
        .collect()
}

fn parse_headers(
    headers: Option<HashMap<String, String>>,
    field: &str,
) -> Result<Vec<(String, String)>, String> {
    let Some(headers) = headers else {
        return Ok(Vec::new());
    };

    headers
        .into_iter()
        .map(|(name, value)| {
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| format!("{field} contains invalid header name `{name}`"))?;
            HeaderValue::from_str(&value)
                .map_err(|_| format!("{field} contains invalid value for `{name}`"))?;
            Ok((name.to_ascii_lowercase(), value))
        })
        .collect()
}

fn parse_header_names(names: Option<Vec<String>>, field: &str) -> Result<Vec<String>, String> {
    let Some(names) = names else {
        return Ok(Vec::new());
    };

    names
        .into_iter()
        .map(|name| {
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| format!("{field} contains invalid header name `{name}`"))?;
            Ok(name.to_ascii_lowercase())
        })
        .collect()
}

fn parse_upstream(value: Either<String, UpstreamOptions>) -> Result<Upstream, String> {
    let (address, tls_override, sni_override, verify) = match value {
        Either::A(address) => (address, None, None, true),
        Either::B(options) => (
            options.address,
            options.tls,
            options.sni,
            options.verify.unwrap_or(true),
        ),
    };

    if address.starts_with("unix:") {
        return Err("unix upstreams are not supported yet".to_string());
    }

    let (scheme_tls, rest) = if let Some(rest) = address.strip_prefix("https://") {
        (true, rest)
    } else if let Some(rest) = address.strip_prefix("http://") {
        (false, rest)
    } else {
        (false, address.as_str())
    };

    let authority =
        Authority::from_str(rest).map_err(|_| format!("invalid upstream address `{address}`"))?;
    let host = authority
        .host()
        .trim_start_matches('[')
        .trim_end_matches(']');
    if host.is_empty() {
        return Err(format!("upstream `{address}` has no host"));
    }

    let tls = tls_override.unwrap_or(scheme_tls);
    let port = authority.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let sni = sni_override.unwrap_or_else(|| host.to_string());

    Ok(Upstream {
        host: host.to_string(),
        port,
        tls,
        sni,
        verify,
    })
}

pub fn normalize_host(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('.');
    Authority::from_str(trimmed)
        .map(|authority| authority.host().trim_end_matches('.').to_ascii_lowercase())
        .unwrap_or_else(|_| trimmed.to_ascii_lowercase())
}

fn random_index(len: usize) -> usize {
    static RNG: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);
    let mut value = RNG.fetch_add(0x9E37_79B9_7F4A_7C15, Ordering::Relaxed);
    value ^= value >> 12;
    value ^= value << 25;
    value ^= value >> 27;
    ((value.wrapping_mul(0x2545_F491_4F6C_DD1D)) % len as u64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> Route {
        route_with_upstreams(vec!["127.0.0.1:9000".to_string()])
    }

    fn route_with_upstreams(upstreams: Vec<String>) -> Route {
        parse_route(
            RouteOptions {
                id: Some("test".to_string()),
                host: Some(Either::A("example.com".to_string())),
                path: None,
                path_prefix: Some("/api".to_string()),
                methods: Some(vec!["get".to_string()]),
                match_headers: None,
                upstreams: upstreams.into_iter().map(Either::A).collect(),
                strategy: None,
                request_headers: None,
                remove_request_headers: None,
                response_headers: None,
                remove_response_headers: None,
                timeout_ms: None,
            },
            "generated".to_string(),
        )
        .unwrap()
    }

    #[test]
    fn host_matching_is_case_insensitive_and_ignores_port() {
        assert!(HostPattern::Exact(normalize_host("example.com"))
            .matches(&normalize_host("EXAMPLE.com:8080")));
        assert!(HostPattern::Wildcard(".example.com".to_string()).matches("api.example.com"));
        assert!(!HostPattern::Wildcard(".example.com".to_string()).matches("example.com"));
    }

    #[test]
    fn relative_upstream_parses_tls_and_port_defaults() {
        let upstream = parse_upstream(Either::A("https://127.0.0.1".to_string())).unwrap();
        assert!(upstream.tls);
        assert_eq!(upstream.port, 443);
        assert_eq!(upstream.host, "127.0.0.1");
        assert_eq!(upstream.sni, "127.0.0.1");
    }

    #[test]
    fn matches_path_and_method() {
        let route = route();
        let get = RequestHeader::build("GET", b"/api/users", None).unwrap();
        assert!(route.matches(&get, "example.com", "/api/users"));
        assert!(!route.matches(&get, "other.com", "/api/users"));
        assert!(!route.matches(&get, "example.com", "/other"));

        let post = RequestHeader::build("POST", b"/api/users", None).unwrap();
        assert!(!route.matches(&post, "example.com", "/api/users"));
    }

    #[test]
    fn parses_ipv6_literal_without_brackets() {
        let upstream = parse_upstream(Either::A("[::1]:9000".to_string())).unwrap();
        assert_eq!(upstream.host, "::1");
        assert_eq!(upstream.port, 9000);
        assert_eq!(upstream.sni, "::1");
    }

    #[test]
    fn strategy_round_robins() {
        let route = route_with_upstreams(vec![
            "127.0.0.1:9000".to_string(),
            "127.0.0.1:9001".to_string(),
        ]);
        let first = route.pick().unwrap().port;
        let second = route.pick().unwrap().port;
        let third = route.pick().unwrap().port;
        assert_ne!(first, second);
        assert_eq!(first, third);
    }
}
