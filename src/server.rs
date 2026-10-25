use std::fmt::Write as _;
use std::io::Write as _;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex, Once};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use async_trait::async_trait;
use env_logger::Env;
use napi::bindgen_prelude::{AsyncTask, Either, Function, Promise};
use napi::{Error as NapiError, Status, Task};
use napi_derive::napi;
use pingora::http::RequestHeader;
use pingora::listeners::tls::TlsSettings;
use pingora::server::configuration::{Opt, ServerConf};
use pingora::server::{RunArgs, Server as PingoraServer, ShutdownSignal, ShutdownSignalWatch};
use tokio::sync::watch;

use crate::handler::{AccessLog, AccessLogger, RequestDecision, RequestHandler, RequestView};
use crate::metrics::MetricsProxy;
use crate::options::{ListenerOptions, RouteOptions, ServerOptions, TlsOptions};
use crate::proxy::JsProxy;
use crate::state::{status_text, SharedState};

const IDLE: u8 = 0;
const STARTING: u8 = 1;
const RUNNING: u8 = 2;
const STOPPING: u8 = 3;
const STOPPED: u8 = 4;
const FAILED: u8 = 5;

static ACTIVE_SERVER: AtomicBool = AtomicBool::new(false);
static INIT_LOGGER: Once = Once::new();

#[napi(object)]
pub struct ServerStatus {
    pub state: String,
    pub error: Option<String>,
    pub listeners: Vec<String>,
    pub routes: u32,
}

#[napi(object)]
pub struct RouteMetrics {
    /// Requests that matched this route.
    pub requests: f64,
    /// Requests currently in flight for this route.
    pub active: f64,
    /// Responses that failed at the upstream.
    pub upstream_errors: f64,
    /// Responses with a 2xx status.
    pub responses_ok: f64,
    /// Responses with a 3xx status.
    pub responses_redirect: f64,
    /// Responses with a 4xx status.
    pub responses_client_error: f64,
    /// Responses with a 5xx status.
    pub responses_server_error: f64,
}

#[napi(object)]
pub struct ServerMetrics {
    pub requests: f64,
    pub active: f64,
    pub upstream_errors: f64,
    pub responses_ok: f64,
    pub responses_redirect: f64,
    pub responses_client_error: f64,
    pub responses_server_error: f64,
    pub uptime_ms: f64,
}

#[derive(Clone)]
struct TlsConfig {
    cert: String,
    key: String,
}

#[derive(Clone)]
struct ListenerConfig {
    address: String,
    tls: Option<TlsConfig>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LogFormat {
    Text,
    Json,
}

#[derive(Clone, Default)]
pub(crate) struct Limits {
    max_request_headers: Option<usize>,
    max_request_header_bytes: Option<usize>,
    pub(crate) max_request_body_bytes: Option<u64>,
}

impl Limits {
    pub(crate) fn request_limit_error(&self, req: &RequestHeader) -> Option<(u16, &'static str)> {
        if let Some(limit) = self.max_request_headers {
            if req.headers.len() > limit {
                return Some((431, "request headers too large"));
            }
        }
        if let Some(limit) = self.max_request_header_bytes {
            let bytes: usize = req
                .headers
                .iter()
                .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
                .sum();
            if bytes > limit {
                return Some((431, "request headers too large"));
            }
        }
        if let Some(limit) = self.max_request_body_bytes {
            if let Some(length) = req
                .headers
                .get(http::header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
            {
                if length > limit {
                    return Some((413, "request body too large"));
                }
            }
        }
        None
    }
}

struct ServerState {
    shared: Arc<SharedState>,
    limits: Limits,
    listeners: Vec<ListenerConfig>,
    metrics_listener: Option<String>,
    threads: usize,
    grace_period: Duration,
    shutdown_timeout: Duration,
    upstream_keepalive_pool_size: usize,
    handler_timeout: Duration,
    log_level: String,
    log_format: LogFormat,
    init_error: Option<String>,
    shutdown_tx: watch::Sender<bool>,
    status: AtomicU8,
    last_error: Mutex<Option<String>>,
    exited: Mutex<bool>,
    exit_cv: Condvar,
}

impl ServerState {
    fn set_status(&self, status: u8) {
        self.status.store(status, Ordering::Relaxed);
    }

    fn status(&self) -> u8 {
        self.status.load(Ordering::Relaxed)
    }

    fn set_error(&self, error: impl Into<String>) {
        *self.last_error.lock().unwrap() = Some(error.into());
    }
}

#[napi(js_name = "Server")]
pub struct JsServer {
    state: Arc<ServerState>,
    started: AtomicBool,
    join: Mutex<Option<JoinHandle<()>>>,
}

#[napi]
impl JsServer {
    #[napi(constructor)]
    pub fn new(options: Option<ServerOptions>) -> Self {
        let options = options.unwrap_or(ServerOptions {
            listeners: None,
            routes: None,
            threads: None,
            grace_period_ms: None,
            shutdown_timeout_ms: None,
            upstream_keepalive_pool_size: None,
            log_level: None,
            log_format: None,
            handler_timeout_ms: None,
            max_request_headers: None,
            max_request_header_bytes: None,
            max_request_body_bytes: None,
            max_routes: None,
            max_listeners: None,
            metrics_address: None,
        });

        let limits = Limits {
            max_request_headers: options.max_request_headers.map(|value| value as usize),
            max_request_header_bytes: options.max_request_header_bytes.map(|value| value as usize),
            max_request_body_bytes: options.max_request_body_bytes.map(u64::from),
        };
        let max_routes = options.max_routes.map(|value| value as usize);
        let max_listeners = options.max_listeners.map(|value| value as usize);

        let mut init_error = None;
        let log_format = match options.log_format.as_deref().unwrap_or("text") {
            "text" => LogFormat::Text,
            "json" => LogFormat::Json,
            other => {
                init_error
                    .get_or_insert(format!("logFormat must be `text` or `json`, got `{other}`"));
                LogFormat::Text
            }
        };
        let metrics_listener = match options.metrics_address {
            Some(address) if address.trim().is_empty() => {
                init_error.get_or_insert("metrics address cannot be empty".to_string());
                None
            }
            Some(address) if address.starts_with("unix:") => {
                init_error.get_or_insert(
                    "metrics address must be a TCP address, not a Unix socket".to_string(),
                );
                None
            }
            Some(address) if address.parse::<std::net::SocketAddr>().is_err() => {
                init_error.get_or_insert("metrics address must be an IP:port address".to_string());
                None
            }
            address => address,
        };

        let listeners = match parse_listeners(options.listeners) {
            Ok(listeners) => listeners,
            Err(error) => {
                init_error = Some(error);
                default_listeners()
            }
        };
        if let Some(metrics) = &metrics_listener {
            if listeners
                .iter()
                .any(|listener| listener_addresses_overlap(&listener.address, metrics))
            {
                init_error.get_or_insert(format!(
                    "metrics address `{metrics}` overlaps a proxy listener"
                ));
            }
        }
        if let Some(limit) = max_listeners {
            let count = listeners.len() + usize::from(metrics_listener.is_some());
            if count > limit {
                init_error.get_or_insert(format!(
                    "listener count {count} exceeds maxListeners {limit}"
                ));
            }
        }
        let shared = match SharedState::new(options.routes.unwrap_or_default(), max_routes) {
            Ok(shared) => Arc::new(shared),
            Err(error) => {
                init_error.get_or_insert(error);
                Arc::new(SharedState::new(Vec::new(), None).expect("empty route table"))
            }
        };
        let (shutdown_tx, _) = watch::channel(false);

        Self {
            state: Arc::new(ServerState {
                shared,
                limits,
                listeners,
                metrics_listener,
                threads: options.threads.unwrap_or(1).max(1) as usize,
                grace_period: Duration::from_millis(options.grace_period_ms.unwrap_or(0).into()),
                shutdown_timeout: Duration::from_millis(
                    options.shutdown_timeout_ms.unwrap_or(5_000).into(),
                ),
                upstream_keepalive_pool_size: options
                    .upstream_keepalive_pool_size
                    .unwrap_or(128)
                    .max(1) as usize,
                log_level: options
                    .log_level
                    .unwrap_or_else(|| "pingora=warn".to_string()),
                log_format,
                handler_timeout: Duration::from_millis(
                    options.handler_timeout_ms.unwrap_or(1_000).max(1).into(),
                ),
                init_error,
                shutdown_tx,
                status: AtomicU8::new(IDLE),
                last_error: Mutex::new(None),
                exited: Mutex::new(false),
                exit_cv: Condvar::new(),
            }),
            started: AtomicBool::new(false),
            join: Mutex::new(None),
        }
    }

    #[napi]
    pub fn start(&self) -> napi::Result<()> {
        if let Some(error) = &self.state.init_error {
            return Err(invalid_arg(error.clone()));
        }
        if self.started.swap(true, Ordering::AcqRel) {
            return Err(invalid_arg("server has already been started"));
        }
        if ACTIVE_SERVER
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.started.store(false, Ordering::Release);
            return Err(invalid_arg(
                "another pingora server is already running in this process",
            ));
        }

        // Pingora's listener service panics on invalid or busy addresses in a
        // spawned thread, so preflight here to keep start() fallible.
        if let Err(error) = preflight_listeners(&self.state.listeners) {
            ACTIVE_SERVER.store(false, Ordering::Release);
            self.started.store(false, Ordering::Release);
            self.state.set_status(FAILED);
            self.state.set_error(&error);
            return Err(invalid_arg(error));
        }
        if let Some(address) = &self.state.metrics_listener {
            if let Err(error) = std::net::TcpListener::bind(address) {
                ACTIVE_SERVER.store(false, Ordering::Release);
                self.started.store(false, Ordering::Release);
                self.state.set_status(FAILED);
                self.state.set_error(format!(
                    "failed to bind metrics listener `{address}`: {error}"
                ));
                return Err(invalid_arg(format!(
                    "failed to bind metrics listener `{address}`: {error}"
                )));
            }
        }

        self.state.set_status(STARTING);
        self.state.set_status(RUNNING);
        let state = self.state.clone();
        let thread = thread::Builder::new()
            .name("pingora-server".to_string())
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| run_server(state.clone())));
                let failed = match result {
                    Ok(Ok(())) => false,
                    Ok(Err(error)) => {
                        log::error!("pingora server failed: {error}");
                        state.set_error(error);
                        true
                    }
                    Err(_) => {
                        state.set_error("pingora server panicked");
                        true
                    }
                };
                if failed {
                    state.set_status(FAILED);
                } else if state.status() != FAILED {
                    state.set_status(STOPPED);
                }
                ACTIVE_SERVER.store(false, Ordering::Release);
                *state.exited.lock().unwrap() = true;
                state.exit_cv.notify_all();
            });

        match thread {
            Ok(join) => {
                *self.join.lock().unwrap() = Some(join);
                Ok(())
            }
            Err(error) => {
                ACTIVE_SERVER.store(false, Ordering::Release);
                self.started.store(false, Ordering::Release);
                self.state.set_status(FAILED);
                self.state
                    .set_error(format!("failed to spawn server thread: {error}"));
                Err(NapiError::from_reason(format!(
                    "failed to spawn server thread: {error}"
                )))
            }
        }
    }

    /// Signal shutdown and resolve once the server thread has exited.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn stop(&self) -> AsyncTask<StopTask> {
        if !self.started.load(Ordering::Acquire) {
            return AsyncTask::new(StopTask {
                join: None,
                started: false,
                state: self.state.clone(),
            });
        }

        if self.state.status() != STOPPED && self.state.status() != FAILED {
            self.state.set_status(STOPPING);
            self.state.shutdown_tx.send_replace(true);
        }

        let join = self.join.lock().unwrap().take();
        AsyncTask::new(StopTask {
            join,
            started: true,
            state: self.state.clone(),
        })
    }

    #[napi]
    pub fn status(&self) -> ServerStatus {
        let init_error = self.state.init_error.clone();
        let error = init_error
            .clone()
            .or_else(|| self.state.last_error.lock().unwrap().clone());
        ServerStatus {
            state: if init_error.is_some() {
                "failed".to_string()
            } else {
                status_text(self.state.status()).to_string()
            },
            error,
            listeners: {
                let mut listeners = self
                    .state
                    .listeners
                    .iter()
                    .map(|listener| listener.address.clone())
                    .collect::<Vec<_>>();
                if let Some(metrics) = &self.state.metrics_listener {
                    listeners.push(metrics.clone());
                }
                listeners
            },
            routes: self.state.shared.route_count() as u32,
        }
    }

    #[napi]
    pub fn metrics(&self) -> ServerMetrics {
        let metrics = self.state.shared.metrics();
        ServerMetrics {
            requests: metrics.requests as f64,
            active: metrics.active as f64,
            upstream_errors: metrics.upstream_errors as f64,
            responses_ok: metrics.responses_2xx as f64,
            responses_redirect: metrics.responses_3xx as f64,
            responses_client_error: metrics.responses_4xx as f64,
            responses_server_error: metrics.responses_5xx as f64,
            uptime_ms: metrics.uptime_ms as f64,
        }
    }

    #[napi]
    pub fn route_metrics(&self, id: String) -> Option<RouteMetrics> {
        self.state
            .shared
            .route_metrics(&id)
            .map(|metrics| RouteMetrics {
                requests: metrics.requests as f64,
                active: metrics.active as f64,
                upstream_errors: metrics.upstream_errors as f64,
                responses_ok: metrics.responses_2xx as f64,
                responses_redirect: metrics.responses_3xx as f64,
                responses_client_error: metrics.responses_4xx as f64,
                responses_server_error: metrics.responses_5xx as f64,
            })
    }

    #[napi]
    pub fn metrics_prometheus(&self) -> String {
        self.state.shared.metrics_prometheus()
    }

    #[napi]
    pub fn add_route(&self, route: RouteOptions) -> napi::Result<String> {
        self.state.shared.add_route(route).map_err(invalid_arg)
    }

    #[napi]
    pub fn remove_route(&self, id: String) -> bool {
        self.state.shared.remove_route(&id)
    }

    #[napi]
    pub fn set_request_handler(
        &self,
        handler: Function<RequestView, Either<Promise<RequestDecision>, RequestDecision>>,
    ) -> napi::Result<()> {
        let tsfn = handler
            .build_threadsafe_function::<RequestView>()
            .weak::<true>()
            .build()?;
        self.state
            .shared
            .set_handler(Some(Arc::new(RequestHandler::new(
                tsfn,
                self.state.handler_timeout,
            ))));
        Ok(())
    }

    #[napi]
    pub fn set_access_log_handler(&self, handler: Function<AccessLog, ()>) -> napi::Result<()> {
        let tsfn = handler
            .build_threadsafe_function::<AccessLog>()
            .weak::<true>()
            .max_queue_size::<1024>()
            .build()?;
        self.state
            .shared
            .set_access_logger(Some(Arc::new(AccessLogger::new(tsfn))));
        Ok(())
    }

    #[napi]
    pub fn clear_access_log_handler(&self) {
        self.state.shared.set_access_logger(None);
    }

    #[napi]
    pub fn clear_request_handler(&self) {
        self.state.shared.set_handler(None);
    }
}

pub struct StopTask {
    join: Option<JoinHandle<()>>,
    started: bool,
    state: Arc<ServerState>,
}

impl Task for StopTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<()> {
        if let Some(join) = self.join.take() {
            if join.join().is_err() {
                self.state.set_error("pingora server thread panicked");
                self.state.set_status(FAILED);
                return Ok(());
            }
        } else if self.started {
            let mut exited = self.state.exited.lock().unwrap();
            while !*exited {
                exited = self.state.exit_cv.wait(exited).unwrap();
            }
        }
        if matches!(self.state.status(), STARTING | RUNNING | STOPPING) {
            self.state.set_status(STOPPED);
        }
        Ok(())
    }

    fn resolve(&mut self, _env: napi::Env, _output: ()) -> napi::Result<()> {
        Ok(())
    }
}

struct WatchSignal {
    rx: watch::Receiver<bool>,
}

#[async_trait]
impl ShutdownSignalWatch for WatchSignal {
    async fn recv(&self) -> ShutdownSignal {
        let mut rx = self.rx.clone();
        if *rx.borrow() {
            return ShutdownSignal::GracefulTerminate;
        }
        let _ = rx.changed().await;
        ShutdownSignal::GracefulTerminate
    }
}

fn run_server(state: Arc<ServerState>) -> Result<(), String> {
    init_logger(&state.log_level, state.log_format);

    let mut conf = ServerConf {
        version: 1,
        threads: state.threads,
        work_stealing: true,
        upstream_keepalive_pool_size: state.upstream_keepalive_pool_size,
        grace_period_seconds: Some(ceil_secs(state.grace_period)),
        graceful_shutdown_timeout_seconds: Some(ceil_secs(state.shutdown_timeout)),
        ..Default::default()
    };
    conf.work_stealing = true;

    let mut server = PingoraServer::new_with_opt_and_conf(Some(Opt::default()), conf);
    server.bootstrap();

    let mut service = pingora::proxy::http_proxy_service(
        &server.configuration,
        JsProxy::new(state.shared.clone(), state.limits.clone()),
    );
    for listener in &state.listeners {
        if let Some(path) = unix_path(&listener.address) {
            #[cfg(unix)]
            service.add_uds(path, Some(std::fs::Permissions::from_mode(0o660)));
            #[cfg(not(unix))]
            return Err(format!(
                "Unix listener `{path}` is not supported on this platform"
            ));
        } else if let Some(tls) = &listener.tls {
            let mut settings = TlsSettings::intermediate(&tls.cert, &tls.key)
                .map_err(|error| format!("failed to load TLS settings: {error}"))?;
            settings.enable_h2();
            service.add_tls_with_settings(&listener.address, None, settings);
        } else {
            service.add_tcp(&listener.address);
        }
    }
    server.add_service(service);

    if let Some(address) = &state.metrics_listener {
        let mut metrics = pingora::proxy::http_proxy_service(
            &server.configuration,
            MetricsProxy::new(state.shared.clone()),
        );
        metrics.add_tcp(address);
        server.add_service(metrics);
    }

    server.run(RunArgs {
        shutdown_signal: Box::new(WatchSignal {
            rx: state.shutdown_tx.subscribe(),
        }),
    });

    Ok(())
}

fn ceil_secs(duration: Duration) -> u64 {
    duration.as_millis().div_ceil(1000) as u64
}

fn init_logger(level: &str, format: LogFormat) {
    INIT_LOGGER.call_once(|| {
        let mut builder = env_logger::Builder::from_env(Env::default().default_filter_or(level));
        if format == LogFormat::Json {
            builder.format(|buf, record| {
                writeln!(
                    buf,
                    "{{\"timestamp\":\"{}\",\"level\":\"{}\",\"target\":\"{}\",\"message\":\"{}\"}}",
                    escape_json(&buf.timestamp().to_string()),
                    record.level(),
                    escape_json(record.target()),
                    escape_json(&record.args().to_string())
                )
            });
        }
        let _ = builder.try_init();
    });
}

fn escape_json(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character < ' ' => {
                write!(&mut output, "\\u{:04x}", character as u32).unwrap();
            }
            character => output.push(character),
        }
    }
    output
}

fn unix_path(address: &str) -> Option<&str> {
    address.strip_prefix("unix:")
}

fn listener_addresses_overlap(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let (Ok(left), Ok(right)) = (
        left.parse::<std::net::SocketAddr>(),
        right.parse::<std::net::SocketAddr>(),
    ) else {
        return false;
    };
    left.port() == right.port()
        && (left.ip() == right.ip() || left.ip().is_unspecified() || right.ip().is_unspecified())
}

fn default_listeners() -> Vec<ListenerConfig> {
    vec![ListenerConfig {
        address: "127.0.0.1:8080".to_string(),
        tls: None,
    }]
}

fn parse_listeners(
    listeners: Option<Vec<Either<String, ListenerOptions>>>,
) -> Result<Vec<ListenerConfig>, String> {
    let Some(listeners) = listeners else {
        return Ok(default_listeners());
    };
    if listeners.is_empty() {
        return Ok(default_listeners());
    }

    listeners
        .into_iter()
        .map(|listener| match listener {
            Either::A(address) => {
                if address.trim().is_empty() {
                    return Err("listener address cannot be empty".to_string());
                }
                Ok(ListenerConfig { address, tls: None })
            }
            Either::B(options) => {
                if options.address.trim().is_empty() {
                    return Err("listener address cannot be empty".to_string());
                }
                if unix_path(&options.address).is_some_and(str::is_empty) {
                    return Err("Unix listener path cannot be empty".to_string());
                }
                if unix_path(&options.address).is_some() && options.tls.is_some() {
                    return Err(format!(
                        "Unix listener `{}` does not support TLS",
                        options.address
                    ));
                }
                let tls = match options.tls {
                    None => None,
                    Some(TlsOptions { cert, key }) => {
                        if cert.trim().is_empty() || key.trim().is_empty() {
                            return Err(format!(
                                "TLS listener `{}` requires both cert and key",
                                options.address
                            ));
                        }
                        Some(TlsConfig { cert, key })
                    }
                };
                Ok(ListenerConfig {
                    address: options.address,
                    tls,
                })
            }
        })
        .collect()
}

fn preflight_listeners(listeners: &[ListenerConfig]) -> Result<(), String> {
    for listener in listeners {
        if let Some(path) = unix_path(&listener.address) {
            #[cfg(unix)]
            {
                preflight_unix_listener(path)?;
                continue;
            }
            #[cfg(not(unix))]
            return Err(format!(
                "Unix listener `{path}` is not supported on this platform"
            ));
        }
        std::net::TcpListener::bind(&listener.address)
            .map_err(|error| format!("failed to bind listener `{}`: {error}", listener.address))?;
        if let Some(tls) = &listener.tls {
            preflight_tls(listener, tls)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn preflight_unix_listener(path: &str) -> Result<(), String> {
    use std::io::ErrorKind;
    use std::os::unix::net::{UnixListener, UnixStream};

    match UnixListener::bind(path) {
        Ok(socket) => {
            drop(socket);
            std::fs::remove_file(path)
                .map_err(|error| format!("failed to clean up Unix listener `{path}`: {error}"))?;
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::AddrInUse => {
            let before = std::fs::symlink_metadata(path).map_err(|metadata_error| {
                format!("failed to inspect Unix listener `{path}`: {metadata_error}")
            })?;
            if !before.file_type().is_socket() {
                return Err(format!("Unix listener `{path}` exists and is not a socket"));
            }
            match UnixStream::connect(path) {
                Ok(_) => Err(format!("Unix listener `{path}` is already in use")),
                Err(connect_error) if connect_error.kind() == ErrorKind::ConnectionRefused => {
                    let current = std::fs::symlink_metadata(path).map_err(|metadata_error| {
                        format!("failed to inspect Unix listener `{path}`: {metadata_error}")
                    })?;
                    if !current.file_type().is_socket()
                        || current.dev() != before.dev()
                        || current.ino() != before.ino()
                    {
                        return Err(format!("Unix listener `{path}` changed during preflight"));
                    }
                    std::fs::remove_file(path).map_err(|remove_error| {
                        format!("failed to remove stale Unix listener `{path}`: {remove_error}")
                    })?;
                    preflight_unix_listener(path)
                }
                Err(connect_error) => Err(format!(
                    "failed to probe Unix listener `{path}`: {connect_error}"
                )),
            }
        }
        Err(error) => Err(format!("failed to bind Unix listener `{path}`: {error}")),
    }
}

fn preflight_tls(listener: &ListenerConfig, tls: &TlsConfig) -> Result<(), String> {
    match pingora::tls::load_certs_and_key_files(&tls.cert, &tls.key) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Err(format!(
                "TLS listener `{}` has no certificate or private key",
                listener.address
            ))
        }
        Err(error) => {
            return Err(format!(
                "failed to read TLS certificate `{}` or key `{}` for `{}`: {error}",
                tls.cert, tls.key, listener.address
            ))
        }
    }
    let mut settings = TlsSettings::intermediate(&tls.cert, &tls.key)
        .map_err(|error| format!("invalid TLS settings for `{}`: {error}", listener.address))?;
    settings.enable_h2();
    catch_unwind(AssertUnwindSafe(|| settings.build())).map_err(|_| {
        format!(
            "failed to load TLS certificate `{}` or key `{}` for `{}`",
            tls.cert, tls.key, listener.address
        )
    })?;
    Ok(())
}

fn invalid_arg(message: impl Into<String>) -> NapiError {
    NapiError::new(Status::InvalidArg, message.into())
}

#[cfg(test)]
mod tests {
    use super::{ceil_secs, escape_json};
    use std::time::Duration;

    #[test]
    fn rounds_durations_up_to_pingora_seconds() {
        assert_eq!(ceil_secs(Duration::ZERO), 0);
        assert_eq!(ceil_secs(Duration::from_millis(1)), 1);
        assert_eq!(ceil_secs(Duration::from_millis(1_500)), 2);
    }

    #[test]
    fn escapes_json_log_fields() {
        assert_eq!(
            escape_json("a\"b\\c\nd\te\u{1}"),
            "a\\\"b\\\\c\\nd\\te\\u0001"
        );
    }
}
