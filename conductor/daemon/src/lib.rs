//! Conductor daemon library - exports proto types and client for use by UI

pub mod proto {
    tonic::include_proto!("conductor");
}

pub use proto::conductor_client::ConductorClient;
pub use proto::*;

/// Socket path for the daemon
pub const SOCKET_PATH: &str = "/tmp/conductor-daemon.sock";
