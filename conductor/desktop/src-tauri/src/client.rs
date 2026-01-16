//! gRPC client for communicating with conductor-daemon

use conductor_daemon::{ConductorClient, SOCKET_PATH};
use hyper_util::rt::TokioIo;
use std::path::Path;
use std::process::Stdio;
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::time::{sleep, Duration};
use tonic::transport::{Channel, Endpoint, Uri};
use tower::service_fn;

/// Connect to the daemon, spawning it if necessary
pub async fn connect() -> Result<ConductorClient<Channel>, String> {
    // Try to connect first
    if let Ok(client) = try_connect().await {
        return Ok(client);
    }

    // Socket doesn't exist or connection failed - try spawning daemon
    spawn_daemon().await?;

    // Wait for daemon to start and retry connection
    for _ in 0..30 {
        sleep(Duration::from_millis(100)).await;
        if let Ok(client) = try_connect().await {
            return Ok(client);
        }
    }

    Err("Failed to connect to daemon after spawning".to_string())
}

/// Try to connect to the daemon without spawning
async fn try_connect() -> Result<ConductorClient<Channel>, String> {
    if !Path::new(SOCKET_PATH).exists() {
        return Err("Socket does not exist".to_string());
    }

    // Create a channel that connects via Unix socket
    let channel = Endpoint::try_from("http://[::]:50051")
        .map_err(|e| e.to_string())?
        .connect_with_connector(service_fn(|_: Uri| async {
            let stream = UnixStream::connect(SOCKET_PATH).await?;
            Ok::<_, std::io::Error>(TokioIo::new(stream))
        }))
        .await
        .map_err(|e| format!("Failed to connect: {}", e))?;

    Ok(ConductorClient::new(channel))
}

/// Spawn the daemon as a detached process
async fn spawn_daemon() -> Result<(), String> {
    // Find the daemon binary
    let daemon_path = find_daemon_binary()?;

    // Spawn detached
    Command::new(&daemon_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to spawn daemon: {}", e))?;

    Ok(())
}

/// Find the daemon binary path
fn find_daemon_binary() -> Result<String, String> {
    // In development, use cargo target directory
    let dev_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/debug/conductor-daemon");
    if Path::new(dev_path).exists() {
        return Ok(dev_path.to_string());
    }

    // In release, check alongside the app binary
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let release_path = dir.join("conductor-daemon");
            if release_path.exists() {
                return Ok(release_path.to_string_lossy().to_string());
            }
        }
    }

    // Fallback: assume it's in PATH
    Ok("conductor-daemon".to_string())
}

/// Global client instance (lazy initialized)
use std::sync::OnceLock;
use tokio::sync::Mutex;

static CLIENT: OnceLock<Mutex<Option<ConductorClient<Channel>>>> = OnceLock::new();

/// Get or create the global client
pub async fn get_client() -> Result<ConductorClient<Channel>, String> {
    let mutex = CLIENT.get_or_init(|| Mutex::new(None));
    let mut guard = mutex.lock().await;

    if guard.is_none() {
        *guard = Some(connect().await?);
    }

    // Clone the client (tonic clients are cheap to clone)
    Ok(guard.as_ref().unwrap().clone())
}

/// Reset the client (e.g., after daemon restart)
pub async fn reset_client() {
    if let Some(mutex) = CLIENT.get() {
        let mut guard = mutex.lock().await;
        *guard = None;
    }
}
