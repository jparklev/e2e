mod client;

use conductor_core::{Repo, SessionState, Workspace, WorkspaceChange, ArchiveResult};
use conductor_daemon::proto;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::sync::LazyLock;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_stream::StreamExt;

#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

// Shell instance for PTY (kept local - not moved to daemon)
struct ShellInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

static SHELL_PROCESSES: LazyLock<Mutex<HashMap<String, ShellInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn map_err(err: impl std::fmt::Display) -> String {
    err.to_string()
}

// =============================================================================
// Repository Commands (via daemon)
// =============================================================================

#[tauri::command]
async fn list_repos(_home: Option<String>) -> Result<Vec<Repo>, String> {
    let mut client = client::get_client().await?;
    let response = client
        .list_repos(proto::ListReposRequest {})
        .await
        .map_err(map_err)?;

    Ok(response
        .into_inner()
        .repos
        .into_iter()
        .map(|r| Repo {
            id: r.id,
            name: r.name,
            root_path: r.root_path,
            default_branch: r.default_branch,
            remote_url: r.remote_url,
        })
        .collect())
}

#[tauri::command]
async fn add_repo(
    _home: Option<String>,
    path: String,
    _name: Option<String>,
    _default_branch: Option<String>,
) -> Result<Repo, String> {
    if path.starts_with('-') {
        return Err("path must not start with '-'".to_string());
    }

    let mut client = client::get_client().await?;
    let response = client
        .add_repo(proto::AddRepoRequest { path })
        .await
        .map_err(map_err)?;

    let r = response.into_inner();
    Ok(Repo {
        id: r.id,
        name: r.name,
        root_path: r.root_path,
        default_branch: r.default_branch,
        remote_url: r.remote_url,
    })
}

#[tauri::command]
async fn add_repo_url(
    _home: Option<String>,
    url: String,
    _name: Option<String>,
    _default_branch: Option<String>,
) -> Result<Repo, String> {
    if url.starts_with('-') {
        return Err("repo url must not start with '-'".to_string());
    }

    let mut client = client::get_client().await?;
    let response = client
        .add_repo_url(proto::AddRepoUrlRequest {
            url,
            parent_dir: None,
        })
        .await
        .map_err(map_err)?;

    let r = response.into_inner();
    Ok(Repo {
        id: r.id,
        name: r.name,
        root_path: r.root_path,
        default_branch: r.default_branch,
        remote_url: r.remote_url,
    })
}

// =============================================================================
// Workspace Commands (via daemon)
// =============================================================================

#[tauri::command]
async fn list_workspaces(_home: Option<String>, repo: Option<String>) -> Result<Vec<Workspace>, String> {
    let mut client = client::get_client().await?;
    let response = client
        .list_workspaces(proto::ListWorkspacesRequest { repo_id: repo })
        .await
        .map_err(map_err)?;

    Ok(response
        .into_inner()
        .workspaces
        .into_iter()
        .map(|w| Workspace {
            id: w.id,
            repo_id: w.repository_id,
            repo: String::new(), // Not returned by daemon
            name: w.directory_name,
            branch: w.branch,
            base_branch: w.base_branch,
            state: match w.state.as_str() {
                "ready" => conductor_core::WorkspaceState::Ready,
                "archived" => conductor_core::WorkspaceState::Archived,
                "error" => conductor_core::WorkspaceState::Error,
                _ => conductor_core::WorkspaceState::Ready,
            },
            path: w.path,
        })
        .collect())
}

#[tauri::command]
async fn create_workspace(
    _home: Option<String>,
    repo: String,
    name: Option<String>,
    _base: Option<String>,
    _branch: Option<String>,
) -> Result<Workspace, String> {
    if repo.starts_with('-') {
        return Err("repo must not start with '-'".to_string());
    }

    let mut client = client::get_client().await?;
    let response = client
        .create_workspace(proto::CreateWorkspaceRequest {
            repo_id: repo,
            name,
        })
        .await
        .map_err(map_err)?;

    let w = response.into_inner();
    Ok(Workspace {
        id: w.id,
        repo_id: w.repository_id,
        repo: String::new(),
        name: w.directory_name,
        branch: w.branch,
        base_branch: w.base_branch,
        state: match w.state.as_str() {
            "ready" => conductor_core::WorkspaceState::Ready,
            "archived" => conductor_core::WorkspaceState::Archived,
            "error" => conductor_core::WorkspaceState::Error,
            _ => conductor_core::WorkspaceState::Ready,
        },
        path: w.path,
    })
}

#[tauri::command]
async fn archive_workspace(
    _home: Option<String>,
    workspace: String,
    force: Option<bool>,
) -> Result<ArchiveResult, String> {
    if workspace.starts_with('-') {
        return Err("workspace must not start with '-'".to_string());
    }

    let mut client = client::get_client().await?;
    let workspace_id = workspace.clone();
    let response = client
        .archive_workspace(proto::ArchiveWorkspaceRequest {
            workspace_id,
            force: force.unwrap_or(false),
        })
        .await
        .map_err(map_err)?;

    let r = response.into_inner();
    if r.success {
        Ok(ArchiveResult {
            id: workspace,
            ok: true,
            removed: true,
            message: "archived".to_string(),
        })
    } else {
        Err(r.error.unwrap_or_else(|| "Archive failed".to_string()))
    }
}

#[tauri::command]
async fn workspace_files(_home: Option<String>, workspace: String) -> Result<Vec<String>, String> {
    let mut client = client::get_client().await?;
    let response = client
        .get_workspace_files(proto::GetWorkspaceFilesRequest {
            workspace_id: workspace,
        })
        .await
        .map_err(map_err)?;

    Ok(response
        .into_inner()
        .files
        .into_iter()
        .map(|f| f.path)
        .collect())
}

#[tauri::command]
async fn workspace_changes(_home: Option<String>, workspace: String) -> Result<Vec<WorkspaceChange>, String> {
    let mut client = client::get_client().await?;
    let response = client
        .get_workspace_changes(proto::GetWorkspaceChangesRequest {
            workspace_id: workspace,
        })
        .await
        .map_err(map_err)?;

    Ok(response
        .into_inner()
        .changes
        .into_iter()
        .map(|c| WorkspaceChange {
            old_path: None,
            path: c.path,
            status: c.status,
        })
        .collect())
}

#[tauri::command]
async fn workspace_file_content(
    _home: Option<String>,
    workspace: String,
    path: String,
) -> Result<String, String> {
    let mut client = client::get_client().await?;
    let response = client
        .get_file_content(proto::GetFileContentRequest {
            workspace_id: workspace,
            file_path: path,
        })
        .await
        .map_err(map_err)?;

    Ok(response.into_inner().content)
}

#[tauri::command]
async fn workspace_file_diff(
    _home: Option<String>,
    workspace: String,
    path: String,
) -> Result<String, String> {
    let mut client = client::get_client().await?;
    let response = client
        .get_file_diff(proto::GetFileDiffRequest {
            workspace_id: workspace,
            file_path: path,
        })
        .await
        .map_err(map_err)?;

    Ok(response.into_inner().diff)
}

#[tauri::command]
fn resolve_home_path(_home: Option<String>) -> Result<String, String> {
    Ok(conductor_core::default_home().to_string_lossy().to_string())
}

// =============================================================================
// Session & Chat Commands (via daemon)
// =============================================================================

#[tauri::command]
async fn session_read(workspace_path: String) -> Result<Option<SessionState>, String> {
    let mut client = client::get_client().await?;
    let response = client
        .get_session(proto::GetSessionRequest { workspace_path })
        .await
        .map_err(map_err)?;

    let s = response.into_inner();
    if s.agent_id.is_none() {
        return Ok(None);
    }

    Ok(Some(SessionState {
        agent_id: s.agent_id.unwrap_or_default(),
        resume_id: s.resume_id,
        started_at: s.started_at.unwrap_or_default(),
        updated_at: s.updated_at.unwrap_or_default(),
    }))
}

#[tauri::command]
async fn session_create(workspace_path: String, agent_id: String) -> Result<SessionState, String> {
    let mut client = client::get_client().await?;
    let response = client
        .create_session(proto::CreateSessionRequest {
            workspace_path,
            agent_id,
        })
        .await
        .map_err(map_err)?;

    let s = response.into_inner();
    Ok(SessionState {
        agent_id: s.agent_id.unwrap_or_default(),
        resume_id: s.resume_id,
        started_at: s.started_at.unwrap_or_default(),
        updated_at: s.updated_at.unwrap_or_default(),
    })
}

#[tauri::command]
async fn session_set_resume_id(workspace_path: String, resume_id: String) -> Result<SessionState, String> {
    let mut client = client::get_client().await?;
    let response = client
        .set_resume_id(proto::SetResumeIdRequest {
            workspace_path,
            resume_id,
        })
        .await
        .map_err(map_err)?;

    let s = response.into_inner();
    Ok(SessionState {
        agent_id: s.agent_id.unwrap_or_default(),
        resume_id: s.resume_id,
        started_at: s.started_at.unwrap_or_default(),
        updated_at: s.updated_at.unwrap_or_default(),
    })
}

#[tauri::command]
async fn session_upsert_resume_id(
    workspace_path: String,
    agent_id: String,
    resume_id: String,
) -> Result<SessionState, String> {
    // Try to read existing session first
    let existing = session_read(workspace_path.clone()).await?;

    if existing.is_some() {
        // Update existing
        session_set_resume_id(workspace_path, resume_id).await
    } else {
        // Create new, then set resume_id
        session_create(workspace_path.clone(), agent_id).await?;
        session_set_resume_id(workspace_path, resume_id).await
    }
}

#[tauri::command]
async fn chat_read(workspace_path: String) -> Result<String, String> {
    let mut client = client::get_client().await?;
    let response = client
        .get_chat(proto::GetChatRequest { workspace_path })
        .await
        .map_err(map_err)?;

    // Return raw content from first message
    Ok(response
        .into_inner()
        .messages
        .first()
        .map(|m| m.content.clone())
        .unwrap_or_default())
}

#[tauri::command]
async fn chat_append(workspace_path: String, role: String, content: String) -> Result<(), String> {
    let mut client = client::get_client().await?;
    client
        .append_chat(proto::AppendChatRequest {
            workspace_path,
            role,
            content,
        })
        .await
        .map_err(map_err)?;
    Ok(())
}

#[tauri::command]
async fn chat_clear(workspace_path: String) -> Result<(), String> {
    let mut client = client::get_client().await?;
    client
        .clear_chat(proto::ClearChatRequest { workspace_path })
        .await
        .map_err(map_err)?;
    Ok(())
}

// =============================================================================
// Agent Commands (via daemon streaming)
// =============================================================================

#[tauri::command]
async fn run_agent(
    app: tauri::AppHandle,
    engine: String,
    prompt: String,
    cwd: String,
    session_id: String,
    resume_id: Option<String>,
) -> Result<(), String> {
    let mut client = client::get_client().await?;

    // Start the agent stream
    let response = client
        .run_agent(proto::RunAgentRequest {
            engine: engine.clone(),
            prompt,
            cwd,
            session_id: session_id.clone(),
            resume_id,
        })
        .await
        .map_err(map_err)?;

    let mut stream = response.into_inner();
    let app_clone = app.clone();

    // Spawn task to forward events to UI
    tokio::spawn(async move {
        while let Some(result) = stream.next().await {
            match result {
                Ok(event) => {
                    // Parse payload and emit to UI
                    let payload: serde_json::Value = serde_json::from_str(&event.payload)
                        .unwrap_or(serde_json::Value::Null);

                    let mut event_obj = serde_json::json!({
                        "session_id": event.session_id,
                        "type": event.event_type,
                    });

                    // Merge payload into event
                    if let serde_json::Value::Object(map) = payload {
                        if let serde_json::Value::Object(ref mut obj) = event_obj {
                            obj.extend(map);
                        }
                    }

                    let _ = app_clone.emit("agent_event", event_obj);
                }
                Err(e) => {
                    let _ = app_clone.emit(
                        "agent_event",
                        serde_json::json!({
                            "session_id": session_id,
                            "type": "error",
                            "error": e.to_string(),
                        }),
                    );
                    break;
                }
            }
        }

        // Emit session ended
        let _ = app_clone.emit(
            "agent_event",
            serde_json::json!({
                "session_id": session_id,
                "type": "session_ended",
            }),
        );
    });

    Ok(())
}

#[tauri::command]
async fn stop_agent(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let mut client = client::get_client().await?;
    client
        .stop_agent(proto::StopAgentRequest {
            session_id: session_id.clone(),
        })
        .await
        .map_err(map_err)?;

    // Emit stopped event
    let _ = app.emit(
        "agent_event",
        serde_json::json!({
            "type": "session_stopped",
            "session_id": session_id,
        }),
    );

    Ok(())
}

// =============================================================================
// Snapshot (kept local - macOS specific)
// =============================================================================

const SNAPSHOT_PATH: &str = "/tmp/conductor-snapshot.png";

#[tauri::command]
async fn capture_snapshot(webview: tauri::Webview) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use block::ConcreteBlock;

        let (tx, rx) = tokio::sync::oneshot::channel();

        let tx_mutex = std::sync::Arc::new(std::sync::Mutex::new(Some::<
            tokio::sync::oneshot::Sender<Result<String, String>>,
        >(tx)));

        webview
            .with_webview(move |webview_ptr| {
                unsafe {
                    let webview_id = webview_ptr.inner() as id;
                    let config: id = msg_send![class!(WKSnapshotConfiguration), new];

                    let tx_clone = tx_mutex.clone();
                    let block = ConcreteBlock::new(move |image: id, _error: id| {
                        let mut tx_lock = tx_clone.lock().unwrap();
                        if let Some(tx) = tx_lock.take() {
                            if image == nil {
                                let _ = tx.send(Err("Snapshot returned nil image".to_string()));
                                return;
                            }

                            let tiff_data: id = msg_send![image, TIFFRepresentation];
                            let bitmap_rep: id =
                                msg_send![class!(NSBitmapImageRep), imageRepWithData:tiff_data];
                            let png_data: id =
                                msg_send![bitmap_rep, representationUsingType:4 properties:nil];

                            let bytes: *const u8 = msg_send![png_data, bytes];
                            let length: usize = msg_send![png_data, length];
                            let data = std::slice::from_raw_parts(bytes, length);

                            match std::fs::write(SNAPSHOT_PATH, data) {
                                Ok(_) => {
                                    let _ = tx.send(Ok(SNAPSHOT_PATH.to_string()));
                                }
                                Err(e) => {
                                    let _ = tx.send(Err(e.to_string()));
                                }
                            }
                        }
                    });

                    let block_copy = block.copy();
                    let _: () = msg_send![webview_id, takeSnapshotWithConfiguration:config completionHandler:block_copy];
                }
            })
            .map_err(|e| e.to_string())?;

        rx.await
            .map_err(|e: tokio::sync::oneshot::error::RecvError| e.to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Snapshot only supported on macOS".to_string())
    }
}

// =============================================================================
// Shell/PTY Commands (kept local - not moved to daemon)
// =============================================================================

#[tauri::command]
async fn spawn_shell(app: tauri::AppHandle, cwd: String, _session_id: String) -> Result<String, String> {
    let shell_id = uuid::Uuid::new_v4().to_string();
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {e}"))?;

    {
        let mut shells = SHELL_PROCESSES.lock().await;
        shells.insert(
            shell_id.clone(),
            ShellInstance {
                writer,
                master: pair.master,
            },
        );
    }

    let shell_id_clone = shell_id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(
                        "shell_output",
                        serde_json::json!({
                            "shell_id": shell_id_clone,
                            "data": data,
                        }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    Ok(shell_id)
}

#[tauri::command]
async fn write_shell(shell_id: String, data: String) -> Result<(), String> {
    let mut shells = SHELL_PROCESSES.lock().await;
    if let Some(shell) = shells.get_mut(&shell_id) {
        shell
            .writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Write failed: {e}"))?;
        shell.writer.flush().map_err(|e| format!("Flush failed: {e}"))?;
        Ok(())
    } else {
        Err("Shell not found".to_string())
    }
}

#[tauri::command]
async fn resize_shell(shell_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let shells = SHELL_PROCESSES.lock().await;
    if let Some(shell) = shells.get(&shell_id) {
        shell
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {e}"))?;
        Ok(())
    } else {
        Err("Shell not found".to_string())
    }
}

#[tauri::command]
async fn kill_shell(shell_id: String) -> Result<(), String> {
    let mut shells = SHELL_PROCESSES.lock().await;
    if shells.remove(&shell_id).is_some() {
        Ok(())
    } else {
        Err("Shell not found".to_string())
    }
}

// =============================================================================
// Tauri App Entry Point
// =============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            list_repos,
            add_repo,
            add_repo_url,
            list_workspaces,
            create_workspace,
            archive_workspace,
            workspace_files,
            workspace_changes,
            workspace_file_content,
            workspace_file_diff,
            resolve_home_path,
            run_agent,
            stop_agent,
            capture_snapshot,
            session_read,
            session_create,
            session_set_resume_id,
            session_upsert_resume_id,
            chat_read,
            chat_append,
            chat_clear,
            spawn_shell,
            write_shell,
            resize_shell,
            kill_shell
        ]);

    // AI testing laboratory: MCP plugin for Claude/Gemini (debug builds only)
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp::init_with_config(
            tauri_plugin_mcp::PluginConfig::new("desktop".to_string())
                .socket_path(std::path::PathBuf::from("/tmp/conductor-mcp.sock"))
                .start_socket_server(true),
        ));
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
