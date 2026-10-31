use std::collections::HashMap;
use std::fs::File;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::BufReader;
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http::uri::Authority;
use http::{HeaderName, HeaderValue, Method};
use napi::bindgen_prelude::Either;
use pingora::http::RequestHeader;
use pingora::tls::{CertificateDer, RootCertStore};
use pingora::upstreams::peer::HttpPeer;
use pingora::utils::tls::{parse_x509, WrappedX509};
use x509_parser::prelude::FromDer;

use crate::options::{RouteOptions, UpstreamOptions};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strategy {
    RoundRobin,
    WeightedRoundRobin,
    LeastConnections,
    Random,
    First,
}

#[derive(Debug, Clone)]
pub enum HostPattern {
    Any,
    Exact(String),
    Wildcard(String),
}

type CaBundle = Arc<[WrappedX509]>;

const HEALTH_COOLDOWN: Duration = Duration::from_secs(5);

#[derive(Debug, Default)]
pub struct UpstreamHealth {
    blocked_until_ms: AtomicU64,
}

impl UpstreamHealth {
    fn is_healthy(&self) -> bool {
        self.blocked_until_ms.load(Ordering::Relaxed) <= now_ms()
    }

    pub(crate) fn mark_healthy(&self) {
        self.blocked_until_ms.store(0, Ordering::Relaxed);
    }

    pub(crate) fn mark_unhealthy(&self) {
        self.blocked_until_ms.store(
            now_ms() + HEALTH_COOLDOWN.as_millis() as u64,
            Ordering::Relaxed,
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone)]
pub enum UpstreamAddress {
    Inet(SocketAddr),
    Unix(PathBuf),
}

#[derive(Debug, Clone)]
pub struct Upstream {
    pub address: UpstreamAddress,
    pub tls: bool,
    pub sni: String,
    pub verify: bool,
    pub ca: Option<CaBundle>,
    pub group_key: u64,
    pub weight: u32,
    pub active: Arc<AtomicUsize>,
    pub health: Arc<UpstreamHealth>,
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
    pub metrics: crate::state::Metrics,
    counter: AtomicUsize,
    weighted: Mutex<Vec<i64>>,
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
        if self.upstreams.is_empty() {
            return None;
        }
        let mut candidates = self
            .upstreams
            .iter()
            .enumerate()
            .filter(|(_, upstream)| upstream.health.is_healthy())
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            candidates.extend(0..self.upstreams.len());
        }
        let index = match self.strategy {
            Strategy::First => candidates[0],
            Strategy::RoundRobin => {
                let position = self.counter.fetch_add(1, Ordering::Relaxed) % candidates.len();
                candidates[position]
            }
            Strategy::Random => candidates[random_index(candidates.len())],
            Strategy::LeastConnections => loop {
                let (index, current) = candidates
                    .iter()
                    .map(|&index| (index, self.upstreams[index].active.load(Ordering::Relaxed)))
                    .min_by_key(|(_, count)| *count)
                    .unwrap_or((candidates[0], 0));
                if self.upstreams[index]
                    .active
                    .compare_exchange(current, current + 1, Ordering::Relaxed, Ordering::Relaxed)
                    .is_ok()
                {
                    break index;
                }
            },
            Strategy::WeightedRoundRobin => {
                let mut current = self.weighted.lock().unwrap();
                if current.len() != self.upstreams.len() {
                    *current = vec![0; self.upstreams.len()];
                }
                let mut total = 0i64;
                for &index in &candidates {
                    let weight = self.upstreams[index].weight as i64;
                    current[index] += weight;
                    total += weight;
                }
                let index = candidates
                    .iter()
                    .copied()
                    .max_by_key(|index| current[*index])
                    .unwrap_or(candidates[0]);
                current[index] -= total;
                index
            }
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

impl Upstream {
    pub fn probe(&self, timeout: Duration) -> Option<bool> {
        match &self.address {
            UpstreamAddress::Inet(address) => {
                Some(TcpStream::connect_timeout(address, timeout).is_ok())
            }
            UpstreamAddress::Unix(_) => None,
        }
    }

    pub fn to_peer(&self) -> Result<HttpPeer, String> {
        let mut peer = match &self.address {
            UpstreamAddress::Inet(addr) => HttpPeer::new(*addr, self.tls, self.sni.clone()),
            UpstreamAddress::Unix(path) => {
                #[cfg(unix)]
                {
                    let path = path
                        .to_str()
                        .ok_or_else(|| "Unix upstream path is not UTF-8".to_string())?;
                    HttpPeer::new_uds(path, self.tls, self.sni.clone())
                        .map_err(|error| format!("invalid Unix upstream: {error}"))?
                }
                #[cfg(not(unix))]
                return Err("Unix upstreams are not supported on this platform".to_string());
            }
        };
        peer.options.verify_cert = self.verify;
        peer.options.verify_hostname = self.verify;
        peer.options.ca = self.ca.clone();
        peer.group_key = self.group_key;
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
        "weighted_round_robin" => Strategy::WeightedRoundRobin,
        "least_connections" => Strategy::LeastConnections,
        "random" => Strategy::Random,
        "first" => Strategy::First,
        other => {
            return Err(format!(
            "route `{id}` has invalid strategy `{other}` (expected round_robin, weighted_round_robin, least_connections, random, or first)"
        ))
        }
    };

    let upstream_count = upstreams.len();
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
        metrics: crate::state::Metrics::default(),
        counter: AtomicUsize::new(0),
        weighted: Mutex::new(vec![0; upstream_count]),
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

#[derive(Clone)]
struct CachedCa {
    ca: CaBundle,
    group_key: u64,
}

static CA_CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedCa>>> = OnceLock::new();

fn load_ca_bundle(path: &str) -> Result<(CaBundle, u64), String> {
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("failed to load CA `{path}`: {error}"))?;
    let cache = CA_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(cached) = cache.lock().unwrap().get(&canonical) {
        return Ok((cached.ca.clone(), cached.group_key));
    }

    let (ca, group_key) = read_ca_bundle(&canonical)?;
    cache.lock().unwrap().insert(
        canonical,
        CachedCa {
            ca: ca.clone(),
            group_key,
        },
    );
    Ok((ca, group_key))
}

fn read_ca_bundle(path: &Path) -> Result<(CaBundle, u64), String> {
    let file = File::open(path)
        .map_err(|error| format!("failed to load CA `{}`: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let ders = rustls_pemfile::certs(&mut reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to parse CA `{}`: {error}", path.display()))?;
    if ders.is_empty() {
        return Err(format!(
            "CA file `{}` contains no certificate",
            path.display()
        ));
    }

    let mut hasher = DefaultHasher::new();
    let mut certificates = Vec::with_capacity(ders.len());
    let mut roots = RootCertStore::empty();
    for der in ders {
        if !matches!(
            x509_parser::certificate::X509Certificate::from_der(der.as_ref()),
            Ok(([], _))
        ) {
            return Err(format!(
                "CA file `{}` contains invalid certificate DER",
                path.display()
            ));
        }
        roots
            .add(CertificateDer::from(der.as_ref()))
            .map_err(|error| {
                format!(
                    "CA file `{}` contains a certificate rustls cannot use: {error}",
                    path.display()
                )
            })?;
        der.as_ref().hash(&mut hasher);
        certificates.push(WrappedX509::new(der.to_vec(), parse_x509));
    }

    let ca: CaBundle = Arc::from(certificates);
    Ok((ca, hasher.finish() | (1 << 63)))
}

fn resolve_ca(
    tls: bool,
    ca_path: Option<String>,
    address: &str,
) -> Result<(Option<CaBundle>, u64), String> {
    match ca_path {
        None => Ok((None, 0)),
        Some(path) => {
            if !tls {
                return Err(format!("upstream `{address}` sets ca without TLS"));
            }
            let (ca, group_key) = load_ca_bundle(&path)?;
            Ok((Some(ca), group_key))
        }
    }
}

pub(crate) fn parse_upstream(value: Either<String, UpstreamOptions>) -> Result<Upstream, String> {
    let (address, tls_override, sni_override, verify, ca_path, weight) = match value {
        Either::A(address) => (address, None, None, true, None, 1.0),
        Either::B(options) => (
            options.address,
            options.tls,
            options.sni,
            options.verify.unwrap_or(true),
            options.ca,
            options.weight.unwrap_or(1.0),
        ),
    };
    if !weight.is_finite() || weight.fract() != 0.0 || weight <= 0.0 || weight > u32::MAX as f64 {
        return Err(format!(
            "upstream `{address}` weight must be a positive u32 integer"
        ));
    }
    let weight = weight as u32;

    if let Some(path) = address.strip_prefix("unix:") {
        if path.is_empty() {
            return Err("Unix upstream path cannot be empty".to_string());
        }
        let tls = tls_override.unwrap_or(false);
        let sni = sni_override.unwrap_or_default();
        #[cfg(unix)]
        HttpPeer::new_uds(path, tls, sni.clone())
            .map_err(|error| format!("invalid Unix upstream `{address}`: {error}"))?;
        #[cfg(not(unix))]
        return Err("Unix upstreams are not supported on this platform".to_string());
        let (ca, group_key) = resolve_ca(tls, ca_path, &address)?;
        return Ok(Upstream {
            address: UpstreamAddress::Unix(PathBuf::from(path)),
            tls,
            sni,
            verify,
            ca,
            group_key,
            weight,
            active: Arc::new(AtomicUsize::new(0)),
            health: Arc::new(UpstreamHealth::default()),
        });
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

    let ip: IpAddr = host.parse().map_err(|_| {
        format!(
            "upstream `{address}` uses a hostname; use an IP literal (DNS resolution is the caller's responsibility)"
        )
    })?;
    let tls = tls_override.unwrap_or(scheme_tls);
    let port = authority.port_u16().unwrap_or(if tls { 443 } else { 80 });
    let sni = sni_override.unwrap_or_else(|| host.to_string());
    let (ca, group_key) = resolve_ca(tls, ca_path, &address)?;

    Ok(Upstream {
        address: UpstreamAddress::Inet(SocketAddr::new(ip, port)),
        tls,
        sni,
        verify,
        ca,
        group_key,
        weight,
        active: Arc::new(AtomicUsize::new(0)),
        health: Arc::new(UpstreamHealth::default()),
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

    fn in_addr(upstream: &Upstream) -> SocketAddr {
        match &upstream.address {
            UpstreamAddress::Inet(addr) => *addr,
            UpstreamAddress::Unix(_) => panic!("expected an inet upstream"),
        }
    }

    fn route_with_upstreams(upstreams: Vec<String>) -> Route {
        route_with_strategy("round_robin", upstreams)
    }

    fn route_with_strategy(strategy: &str, upstreams: Vec<String>) -> Route {
        parse_route(
            RouteOptions {
                id: Some("test".to_string()),
                host: Some(Either::A("example.com".to_string())),
                path: None,
                path_prefix: Some("/api".to_string()),
                methods: Some(vec!["get".to_string()]),
                match_headers: None,
                upstreams: upstreams.into_iter().map(Either::A).collect(),
                strategy: Some(strategy.to_string()),
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
        assert_eq!(in_addr(&upstream).port(), 443);
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
        assert!(in_addr(&upstream).is_ipv6());
        assert_eq!(in_addr(&upstream).port(), 9000);
        assert_eq!(upstream.sni, "::1");
    }

    #[test]
    fn least_connections_skips_active_upstreams() {
        let route = route_with_strategy(
            "least_connections",
            vec!["127.0.0.1:9000".to_string(), "127.0.0.1:9001".to_string()],
        );
        assert_eq!(in_addr(route.pick().unwrap()).port(), 9000);
        assert_eq!(in_addr(route.pick().unwrap()).port(), 9001);
    }

    #[test]
    fn unhealthy_peers_are_filtered_for_all_strategies() {
        for strategy in [
            "round_robin",
            "random",
            "least_connections",
            "weighted_round_robin",
        ] {
            let route = route_with_strategy(
                strategy,
                vec!["127.0.0.1:9000".to_string(), "127.0.0.1:9001".to_string()],
            );
            route.upstreams[0].health.mark_unhealthy();
            for _ in 0..50 {
                assert_ne!(in_addr(route.pick().unwrap()).port(), 9000);
            }
        }
    }

    #[test]
    fn all_unhealthy_peers_fall_back() {
        let route = route_with_strategy(
            "round_robin",
            vec!["127.0.0.1:9000".to_string(), "127.0.0.1:9001".to_string()],
        );
        for upstream in &route.upstreams {
            upstream.health.mark_unhealthy();
        }
        for _ in 0..4 {
            let port = in_addr(route.pick().unwrap()).port();
            assert!(port == 9000 || port == 9001);
        }
    }

    #[test]
    fn strategy_round_robins() {
        let route = route_with_upstreams(vec![
            "127.0.0.1:9000".to_string(),
            "127.0.0.1:9001".to_string(),
        ]);
        let first = in_addr(route.pick().unwrap()).port();
        let second = in_addr(route.pick().unwrap()).port();
        let third = in_addr(route.pick().unwrap()).port();
        assert_ne!(first, second);
        assert_eq!(first, third);
    }
}
