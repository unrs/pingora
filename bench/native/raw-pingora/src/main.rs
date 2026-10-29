use std::env;
use std::net::SocketAddr;
use std::net::ToSocketAddrs;

use async_trait::async_trait;
use pingora::proxy::{http_proxy_service, ProxyHttp, Session};
use pingora::server::configuration::ServerConf;
use pingora::server::configuration::Opt;
use pingora::server::Server;
use pingora::upstreams::peer::HttpPeer;

struct RawProxy {
    origin: SocketAddr,
}

#[async_trait]
impl ProxyHttp for RawProxy {
    type CTX = ();

    fn new_ctx(&self) -> Self::CTX {}

    async fn upstream_peer(
        &self,
        _session: &mut Session,
        _ctx: &mut Self::CTX,
    ) -> pingora::Result<Box<HttpPeer>> {
        Ok(Box::new(HttpPeer::new(self.origin, false, String::new())))
    }
}

fn main() {
    let origin = env::var("ORIGIN").unwrap_or_else(|_| "origin:8080".to_string());
    let origin = origin
        .to_socket_addrs()
        .unwrap_or_else(|error| panic!("invalid origin `{origin}`: {error}"))
        .next()
        .unwrap_or_else(|| panic!("origin `{origin}` resolved to no addresses"));
    let threads = env::var("THREADS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(4);

    let mut conf = ServerConf::default();
    conf.version = 1;
    conf.threads = threads;
    conf.work_stealing = true;
    conf.upstream_keepalive_pool_size = 128;
    conf.grace_period_seconds = Some(0);
    conf.graceful_shutdown_timeout_seconds = Some(1);

    let mut server = Server::new_with_opt_and_conf(Some(Opt::default()), conf);
    server.bootstrap();

    let mut service = http_proxy_service(&server.configuration, RawProxy { origin });
    service.add_tcp("0.0.0.0:8085");
    server.add_service(service);
    server.run_forever();
}
