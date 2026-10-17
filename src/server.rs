use std::net::ToSocketAddrs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use async_trait::async_trait;
use env_logger::Env;
use napi::bindgen_prelude::AsyncTask;
use napi::{Error as NapiError, Status, Task};
use napi_derive::napi;
use pingora::server::configuration::{Opt, ServerConf};
use pingora::server::{RunArgs, Server as PingoraServer, ShutdownSignal, ShutdownSignalWatch};
use tokio::sync::watch;

use crate::options::{RouteOptions, ServerOptions};
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

struct ServerState {
    shared: Arc<SharedState>,
    listeners: Vec<String>,
    threads: usize,
    grace_period: Duration,
    shutdown_timeout: Duration,
    upstream_keepalive_pool_size: usize,
    log_level: String,
    init_error: Option<String>,
    shutdown_tx: watch::Sender<bool>,
    status: AtomicU8,
    last_error: Mutex<Option<String>>,
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
        });

        let listeners = options
            .listeners
            .filter(|listeners| !listeners.is_empty())
            .unwrap_or_else(|| vec!["127.0.0.1:8080".to_string()]);

        let mut init_error = None;
        for listener in &listeners {
            if let Err(error) = validate_listener(listener) {
                init_error = Some(error);
            }
        }

        let shared = match SharedState::new(options.routes.unwrap_or_default()) {
            Ok(shared) => Arc::new(shared),
            Err(error) => {
                init_error.get_or_insert(error);
                Arc::new(SharedState::new(Vec::new()).expect("empty route table"))
            }
        };
        let (shutdown_tx, _) = watch::channel(false);

        Self {
            state: Arc::new(ServerState {
                shared,
                listeners,
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
                init_error,
                shutdown_tx,
                status: AtomicU8::new(IDLE),
                last_error: Mutex::new(None),
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

        if let Err(error) = preflight_listeners(&self.state.listeners) {
            ACTIVE_SERVER.store(false, Ordering::Release);
            self.started.store(false, Ordering::Release);
            self.state.set_status(FAILED);
            self.state.set_error(&error);
            return Err(invalid_arg(error));
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
            listeners: self.state.listeners.clone(),
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
    pub fn add_route(&self, route: RouteOptions) -> napi::Result<String> {
        self.state.shared.add_route(route).map_err(invalid_arg)
    }

    #[napi]
    pub fn remove_route(&self, id: String) -> bool {
        self.state.shared.remove_route(&id)
    }
}

pub struct StopTask {
    join: Option<JoinHandle<()>>,
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
    init_logger(&state.log_level);

    let mut conf = ServerConf {
        version: 1,
        threads: state.threads,
        work_stealing: true,
        upstream_keepalive_pool_size: state.upstream_keepalive_pool_size,
        grace_period_seconds: Some(state.grace_period.as_secs()),
        graceful_shutdown_timeout_seconds: Some(state.shutdown_timeout.as_secs()),
        ..Default::default()
    };
    conf.work_stealing = true;

    let mut server = PingoraServer::new_with_opt_and_conf(Some(Opt::default()), conf);
    server.bootstrap();

    let mut service = pingora::proxy::http_proxy_service(
        &server.configuration,
        JsProxy::new(state.shared.clone()),
    );
    for listener in &state.listeners {
        service.add_tcp(listener);
    }
    server.add_service(service);

    server.run(RunArgs {
        shutdown_signal: Box::new(WatchSignal {
            rx: state.shutdown_tx.subscribe(),
        }),
    });

    Ok(())
}

fn init_logger(level: &str) {
    INIT_LOGGER.call_once(|| {
        let _ = env_logger::Builder::from_env(Env::default().default_filter_or(level)).try_init();
    });
}

fn validate_listener(listener: &str) -> Result<(), String> {
    let mut addrs = listener
        .to_socket_addrs()
        .map_err(|error| format!("invalid listener address `{listener}`: {error}"))?;
    let addr = addrs
        .next()
        .ok_or_else(|| format!("listener `{listener}` did not resolve to an address"))?;
    if addr.port() == 0 {
        return Err("listener port must not be 0".to_string());
    }
    Ok(())
}

fn preflight_listeners(listeners: &[String]) -> Result<(), String> {
    for listener in listeners {
        std::net::TcpListener::bind(listener)
            .map_err(|error| format!("failed to bind listener `{listener}`: {error}"))?;
    }
    Ok(())
}

fn invalid_arg(message: impl Into<String>) -> NapiError {
    NapiError::new(Status::InvalidArg, message.into())
}
