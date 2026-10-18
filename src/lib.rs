mod handler;
mod options;
mod proxy;
mod router;
mod server;
mod state;

use napi_derive::napi;

/// Version of the Node.js binding.
#[napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
