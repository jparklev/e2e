use conductor_agent::AgentParser;
use conductor_core::{self as core, ArchiveResult, Repo, SessionState, Workspace, WorkspaceChange};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[cfg(target_os = "macos")]
use cocoa::base::{id, nil};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};

// Global registry of running agent processes
static AGENT_PROCESSES: LazyLock<Mutex<HashMap<String, Child>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// Shell instance for PTY
struct ShellInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

// Global registry of running shell processes
static SHELL_PROCESSES: LazyLock<Mutex<HashMap<String, ShellInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn expand_tilde(path: &str) -> PathBuf {
    let trimmed = path.trim();
    if trimmed == "~" || trimmed.starts_with("~/") {
        if let Some(home) = env::var_os("HOME").or_else(|| env::var_os("USERPROFILE")) {
            let mut expanded = PathBuf::from(home);
            if trimmed.len() > 2 {
                expanded.push(&trimmed[2..]);
            }
            return expanded;
        }
    }
    PathBuf::from(trimmed)
}

fn resolve_home(home: Option<String>) -> Result<PathBuf, String> {
    if let Some(home) = home {
        if home.is_empty() {
            return Ok(core::default_home());
        }
        let path = expand_tilde(&home);
        if path.exists() && !path.is_dir() {
            return Err("home must be a directory".to_string());
        }
        return Ok(path);
    }
    Ok(core::default_home())
}

fn map_err(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[tauri::command]
fn list_repos(home: Option<String>) -> Result<Vec<Repo>, String> {
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::repo_list(&conn).map_err(map_err)
}

#[tauri::command]
fn add_repo(
    home: Option<String>,
    path: String,
    name: Option<String>,
    default_branch: Option<String>,
) -> Result<Repo, String> {
    if path.starts_with('-') {
        return Err("path must not start with '-'".to_string());
    }
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    let path = PathBuf::from(path);
    core::repo_add(&conn, &path, name.as_deref(), default_branch.as_deref()).map_err(map_err)
}

#[tauri::command]
fn add_repo_url(
    home: Option<String>,
    url: String,
    name: Option<String>,
    default_branch: Option<String>,
) -> Result<Repo, String> {
    if url.starts_with('-') {
        return Err("repo url must not start with '-'".to_string());
    }
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::repo_add_url(
        &conn,
        &home,
        &url,
        name.as_deref(),
        default_branch.as_deref(),
    )
    .map_err(map_err)
}

#[tauri::command]
fn list_workspaces(home: Option<String>, repo: Option<String>) -> Result<Vec<Workspace>, String> {
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_list(&conn, repo.as_deref()).map_err(map_err)
}

#[tauri::command]
fn create_workspace(
    home: Option<String>,
    repo: String,
    name: Option<String>,
    base: Option<String>,
    branch: Option<String>,
) -> Result<Workspace, String> {
    if repo.starts_with('-') {
        return Err("repo must not start with '-'".to_string());
    }
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_create(
        &conn,
        &home,
        &repo,
        name.as_deref(),
        base.as_deref(),
        branch.as_deref(),
    )
    .map_err(map_err)
}

#[tauri::command]
fn archive_workspace(home: Option<String>, workspace: String, force: Option<bool>) -> Result<ArchiveResult, String> {
    if workspace.starts_with('-') {
        return Err("workspace must not start with '-'".to_string());
    }
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_archive(&conn, &home, &workspace, force.unwrap_or(false)).map_err(map_err)
}

#[tauri::command]
fn workspace_files(home: Option<String>, workspace: String) -> Result<Vec<String>, String> {
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_files(&conn, &workspace).map_err(map_err)
}

#[tauri::command]
fn workspace_changes(home: Option<String>, workspace: String) -> Result<Vec<WorkspaceChange>, String> {
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_changes(&conn, &workspace).map_err(map_err)
}

#[tauri::command]
fn workspace_file_content(home: Option<String>, workspace: String, path: String) -> Result<String, String> {
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_file_content(&conn, &workspace, &path).map_err(map_err)
}

#[tauri::command]
fn workspace_file_diff(home: Option<String>, workspace: String, path: String) -> Result<String, String> {
    let home = resolve_home(home)?;
    let conn = core::connect(&home).map_err(map_err)?;
    core::workspace_file_diff(&conn, &workspace, &path).map_err(map_err)
}

#[tauri::command]
fn resolve_home_path(home: Option<String>) -> Result<String, String> {
    let home = resolve_home(home)?;
    Ok(home.to_string_lossy().to_string())
}

#[tauri::command]
fn parse_agent_lines(lines: Vec<String>) -> Result<Vec<Value>, String> {
    let mut parser = AgentParser::new();
    let mut out = Vec::new();
    for line in lines {
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Some(events) = parser.parse_value(&value) {
            out.extend(events);
        }
    }
    Ok(out)
}

#[tauri::command]
async fn run_agent(
    app: tauri::AppHandle,
    engine: String,
    prompt: String,
    cwd: String,
    session_id: String,
    resume_id: Option<String>,
) -> Result<(), String> {
    let (cmd, args) = match engine.as_str() {
        "claude" | "claude-code" => {
            let mut args = vec![
                "-p".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--dangerously-skip-permissions".to_string(), // YOLO mode
            ];
            // Add resume flag if we have a session to resume
            if let Some(ref resume) = resume_id {
                args.push("--resume".to_string());
                args.push(resume.clone());
            }
            args.push("--".to_string());
            args.push(prompt);
            ("claude", args)
        }
        "codex" => (
            "codex",
            vec![
                "--full-auto".to_string(), // YOLO mode - no permission prompts
                prompt,
            ],
        ),
        "gemini" => (
            "gemini",
            vec![
                "-m".to_string(),
                "gemini-3-pro-preview".to_string(),
                "--yolo".to_string(), // YOLO mode for Gemini CLI
                prompt,
            ],
        ),
        _ => return Err(format!("Unknown engine: {engine}")),
    };

    let mut child = Command::new(cmd)
        .args(&args)
        .current_dir(&cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn {cmd}: {e}"))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let mut reader = BufReader::new(stdout).lines();
    let mut parser = AgentParser::new();

    // Register the process so it can be stopped
    {
        let mut processes = AGENT_PROCESSES.lock().await;
        processes.insert(session_id.clone(), child);
    }

    // Emit session started event
    let _ = app.emit("agent_event", serde_json::json!({
        "type": "session_started",
        "engine": engine,
        "session_id": session_id,
    }));

    // Read and parse JSON lines, emit events
    while let Ok(Some(line)) = reader.next_line().await {
        if let Ok(value) = serde_json::from_str::<Value>(&line) {
            if let Some(events) = parser.parse_value(&value) {
                for event in events {
                    // Add session_id to each event
                    if let Value::Object(mut obj) = event {
                        obj.insert("session_id".to_string(), Value::String(session_id.clone()));
                        let _ = app.emit("agent_event", Value::Object(obj));
                    }
                }
            }
        }
    }

    // Remove from registry and wait for completion
    let status = {
        let mut processes = AGENT_PROCESSES.lock().await;
        if let Some(mut child) = processes.remove(&session_id) {
            child.wait().await.ok()
        } else {
            None
        }
    };

    // Emit completion event
    let _ = app.emit("agent_event", serde_json::json!({
        "type": "session_ended",
        "engine": engine,
        "session_id": session_id,
        "exit_code": status.and_then(|s| s.code()),
    }));

    Ok(())
}

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
                                msg_send![bitmap_rep, representationUsingType:4 properties:nil]; // 4 = NSPNGFileType

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

#[tauri::command]
async fn stop_agent(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let mut processes = AGENT_PROCESSES.lock().await;
    if let Some(mut child) = processes.remove(&session_id) {
        // Kill the process
        child.kill().await.map_err(|e| format!("Failed to kill process: {e}"))?;

        // Emit stopped event
        let _ = app.emit("agent_event", serde_json::json!({
            "type": "session_stopped",
            "session_id": session_id,
        }));

        Ok(())
    } else {
        Err("No running agent with that session_id".to_string())
    }
}

// =============================================================================
// Session & Chat Persistence
// =============================================================================

#[tauri::command]
fn session_read(workspace_path: String) -> Result<Option<SessionState>, String> {
    let path = PathBuf::from(workspace_path);
    core::session_read(&path).map_err(map_err)
}

#[tauri::command]
fn session_create(workspace_path: String, agent_id: String) -> Result<SessionState, String> {
    let path = PathBuf::from(workspace_path);
    core::session_create(&path, &agent_id).map_err(map_err)
}

#[tauri::command]
fn session_set_resume_id(workspace_path: String, resume_id: String) -> Result<SessionState, String> {
    let path = PathBuf::from(workspace_path);
    core::session_set_resume_id(&path, &resume_id).map_err(map_err)
}

#[tauri::command]
fn session_upsert_resume_id(workspace_path: String, agent_id: String, resume_id: String) -> Result<SessionState, String> {
    let path = PathBuf::from(workspace_path);
    core::session_upsert_resume_id(&path, &agent_id, &resume_id).map_err(map_err)
}

#[tauri::command]
fn chat_read(workspace_path: String) -> Result<String, String> {
    let path = PathBuf::from(workspace_path);
    core::chat_read(&path).map_err(map_err)
}

#[tauri::command]
fn chat_append(workspace_path: String, role: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(workspace_path);
    core::chat_append(&path, &role, &content).map_err(map_err)
}

#[tauri::command]
fn chat_clear(workspace_path: String) -> Result<(), String> {
    let path = PathBuf::from(workspace_path);
    core::chat_clear(&path).map_err(map_err)
}

// =============================================================================
// Shell/PTY Commands
// =============================================================================

#[tauri::command]
async fn spawn_shell(app: tauri::AppHandle, cwd: String, session_id: String) -> Result<String, String> {
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

    // Determine shell
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);

    // Spawn the shell
    let _child = pair.slave.spawn_command(cmd).map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Get reader and writer
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("Failed to clone reader: {e}"))?;
    let writer = pair.master.take_writer().map_err(|e| format!("Failed to take writer: {e}"))?;

    // Store shell instance
    {
        let mut shells = SHELL_PROCESSES.lock().await;
        shells.insert(shell_id.clone(), ShellInstance {
            writer,
            master: pair.master,
        });
    }

    // Spawn reader task
    let shell_id_clone = shell_id.clone();
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("shell_output", serde_json::json!({
                        "shell_id": shell_id_clone,
                        "data": data,
                    }));
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
        shell.writer.write_all(data.as_bytes()).map_err(|e| format!("Write failed: {e}"))?;
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
        shell.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        }).map_err(|e| format!("Resize failed: {e}"))?;
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
            parse_agent_lines,
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
