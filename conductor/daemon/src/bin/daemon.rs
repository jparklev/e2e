use conductor_agent::AgentParser;
use conductor_core::{self as core};
use conductor_daemon::proto::conductor_server::{Conductor, ConductorServer};
use conductor_daemon::proto::*;
use conductor_daemon::SOCKET_PATH;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};
use tokio_stream::Stream;
use tonic::{Request, Response, Status};
use tracing::{info, warn};
const VERSION: &str = env!("CARGO_PKG_VERSION");

// Active agent with its event broadcast channel
struct ActiveAgentHandle {
    engine: String,
    cwd: String,
    started_at: Instant,
    sender: broadcast::Sender<AgentEvent>,
    child: Option<Child>, // Mutable for cleanup
}

impl Drop for ActiveAgentHandle {
    fn drop(&mut self) {
        // Kill child process on drop to prevent zombies
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
    }
}

struct ConductorService {
    home: PathBuf,
    agents: Arc<Mutex<HashMap<String, ActiveAgentHandle>>>,
    start_time: Instant,
}

impl ConductorService {
    fn new(home: PathBuf) -> Self {
        Self {
            home,
            agents: Arc::new(Mutex::new(HashMap::new())),
            start_time: Instant::now(),
        }
    }

    // Helper to run blocking DB operations
    async fn with_db<F, T>(&self, f: F) -> Result<T, Status>
    where
        F: FnOnce(rusqlite::Connection) -> Result<T, anyhow::Error> + Send + 'static,
        T: Send + 'static,
    {
        let home = self.home.clone();
        tokio::task::spawn_blocking(move || {
            let conn = core::connect(&home)?;
            f(conn)
        })
        .await
        .map_err(|e| Status::internal(format!("Task join error: {}", e)))?
        .map_err(|e| Status::internal(e.to_string()))
    }
}

#[tonic::async_trait]
impl Conductor for ConductorService {
    // =========================================================================
    // Repository Management
    // =========================================================================

    async fn list_repos(
        &self,
        _request: Request<ListReposRequest>,
    ) -> Result<Response<ListReposResponse>, Status> {
        let repos: Vec<core::Repo> = self
            .with_db(|conn| Ok(core::repo_list(&conn)?))
            .await?;

        Ok(Response::new(ListReposResponse {
            repos: repos
                .into_iter()
                .map(|r| Repo {
                    id: r.id,
                    name: r.name,
                    root_path: r.root_path,
                    default_branch: r.default_branch,
                    remote_url: r.remote_url,
                })
                .collect(),
        }))
    }

    async fn add_repo(&self, request: Request<AddRepoRequest>) -> Result<Response<Repo>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.path);

        let repo = self
            .with_db(move |conn| Ok(core::repo_add(&conn, &path, None, None)?))
            .await?;

        Ok(Response::new(Repo {
            id: repo.id,
            name: repo.name,
            root_path: repo.root_path,
            default_branch: repo.default_branch,
            remote_url: repo.remote_url,
        }))
    }

    async fn add_repo_url(
        &self,
        request: Request<AddRepoUrlRequest>,
    ) -> Result<Response<Repo>, Status> {
        let req = request.into_inner();
        let home = self.home.clone();
        let url = req.url;

        let repo = self
            .with_db(move |conn| Ok(core::repo_add_url(&conn, &home, &url, None, None)?))
            .await?;

        Ok(Response::new(Repo {
            id: repo.id,
            name: repo.name,
            root_path: repo.root_path,
            default_branch: repo.default_branch,
            remote_url: repo.remote_url,
        }))
    }

    // =========================================================================
    // Workspace Management
    // =========================================================================

    async fn list_workspaces(
        &self,
        request: Request<ListWorkspacesRequest>,
    ) -> Result<Response<ListWorkspacesResponse>, Status> {
        let req = request.into_inner();
        let repo_id = req.repo_id;

        let workspaces: Vec<core::Workspace> = self
            .with_db(move |conn| Ok(core::workspace_list(&conn, repo_id.as_deref())?))
            .await?;

        Ok(Response::new(ListWorkspacesResponse {
            workspaces: workspaces
                .into_iter()
                .map(|w| Workspace {
                    id: w.id,
                    repository_id: w.repo_id,
                    directory_name: w.name,
                    path: w.path,
                    branch: w.branch,
                    base_branch: w.base_branch,
                    state: w.state.to_string(),
                })
                .collect(),
        }))
    }

    async fn create_workspace(
        &self,
        request: Request<CreateWorkspaceRequest>,
    ) -> Result<Response<Workspace>, Status> {
        let req = request.into_inner();
        let home = self.home.clone();
        let repo_id = req.repo_id;
        let name = req.name;

        let ws = self
            .with_db(move |conn| {
                Ok(core::workspace_create(
                    &conn,
                    &home,
                    &repo_id,
                    name.as_deref(),
                    None,
                    None,
                )?)
            })
            .await?;

        Ok(Response::new(Workspace {
            id: ws.id,
            repository_id: ws.repo_id,
            directory_name: ws.name,
            path: ws.path,
            branch: ws.branch,
            base_branch: ws.base_branch,
            state: ws.state.to_string(),
        }))
    }

    async fn archive_workspace(
        &self,
        request: Request<ArchiveWorkspaceRequest>,
    ) -> Result<Response<ArchiveWorkspaceResponse>, Status> {
        let req = request.into_inner();
        let home = self.home.clone();
        let workspace_id = req.workspace_id;
        let force = req.force;

        let result: Result<core::ArchiveResult, Status> = self
            .with_db(move |conn| Ok(core::workspace_archive(&conn, &home, &workspace_id, force)?))
            .await;

        match result {
            Ok(_) => Ok(Response::new(ArchiveWorkspaceResponse {
                success: true,
                error: None,
            })),
            Err(e) => Ok(Response::new(ArchiveWorkspaceResponse {
                success: false,
                error: Some(e.to_string()),
            })),
        }
    }

    // =========================================================================
    // Workspace Files
    // =========================================================================

    async fn get_workspace_files(
        &self,
        request: Request<GetWorkspaceFilesRequest>,
    ) -> Result<Response<GetWorkspaceFilesResponse>, Status> {
        let req = request.into_inner();
        let workspace_id = req.workspace_id;

        let files: Vec<String> = self
            .with_db(move |conn| Ok(core::workspace_files(&conn, &workspace_id)?))
            .await?;

        Ok(Response::new(GetWorkspaceFilesResponse {
            files: files
                .into_iter()
                .map(|path| FileEntry {
                    path,
                    status: "tracked".to_string(),
                })
                .collect(),
        }))
    }

    async fn get_workspace_changes(
        &self,
        request: Request<GetWorkspaceChangesRequest>,
    ) -> Result<Response<GetWorkspaceChangesResponse>, Status> {
        let req = request.into_inner();
        let workspace_id = req.workspace_id;

        let changes: Vec<core::WorkspaceChange> = self
            .with_db(move |conn| Ok(core::workspace_changes(&conn, &workspace_id)?))
            .await?;

        Ok(Response::new(GetWorkspaceChangesResponse {
            changes: changes
                .into_iter()
                .map(|c| ChangedFile {
                    path: c.path,
                    status: c.status,
                    insertions: 0, // Not available in core::WorkspaceChange
                    deletions: 0,
                })
                .collect(),
        }))
    }

    async fn get_file_content(
        &self,
        request: Request<GetFileContentRequest>,
    ) -> Result<Response<GetFileContentResponse>, Status> {
        let req = request.into_inner();
        let workspace_id = req.workspace_id;
        let file_path = req.file_path;

        let content = self
            .with_db(move |conn| Ok(core::workspace_file_content(&conn, &workspace_id, &file_path)?))
            .await?;

        Ok(Response::new(GetFileContentResponse { content }))
    }

    async fn get_file_diff(
        &self,
        request: Request<GetFileDiffRequest>,
    ) -> Result<Response<GetFileDiffResponse>, Status> {
        let req = request.into_inner();
        let workspace_id = req.workspace_id;
        let file_path = req.file_path;

        let diff = self
            .with_db(move |conn| Ok(core::workspace_file_diff(&conn, &workspace_id, &file_path)?))
            .await?;

        Ok(Response::new(GetFileDiffResponse { diff }))
    }

    // =========================================================================
    // Session Management
    // =========================================================================

    async fn get_session(
        &self,
        request: Request<GetSessionRequest>,
    ) -> Result<Response<SessionState>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.workspace_path);

        let session = tokio::task::spawn_blocking(move || core::session_read(&path))
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(match session {
            Some(s) => SessionState {
                agent_id: Some(s.agent_id),
                resume_id: s.resume_id,
                started_at: Some(s.started_at),
                updated_at: Some(s.updated_at),
            },
            None => SessionState {
                agent_id: None,
                resume_id: None,
                started_at: None,
                updated_at: None,
            },
        }))
    }

    async fn create_session(
        &self,
        request: Request<CreateSessionRequest>,
    ) -> Result<Response<SessionState>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.workspace_path);
        let agent_id = req.agent_id;

        let session = tokio::task::spawn_blocking(move || core::session_create(&path, &agent_id))
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(SessionState {
            agent_id: Some(session.agent_id),
            resume_id: session.resume_id,
            started_at: Some(session.started_at),
            updated_at: Some(session.updated_at),
        }))
    }

    async fn set_resume_id(
        &self,
        request: Request<SetResumeIdRequest>,
    ) -> Result<Response<SessionState>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.workspace_path);
        let resume_id = req.resume_id;

        let session =
            tokio::task::spawn_blocking(move || core::session_set_resume_id(&path, &resume_id))
                .await
                .map_err(|e| Status::internal(e.to_string()))?
                .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(SessionState {
            agent_id: Some(session.agent_id),
            resume_id: session.resume_id,
            started_at: Some(session.started_at),
            updated_at: Some(session.updated_at),
        }))
    }

    // =========================================================================
    // Chat Management
    // =========================================================================

    async fn get_chat(
        &self,
        request: Request<GetChatRequest>,
    ) -> Result<Response<GetChatResponse>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.workspace_path);

        let content = tokio::task::spawn_blocking(move || core::chat_read(&path))
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .map_err(|e| Status::internal(e.to_string()))?;

        // Return raw content for now
        Ok(Response::new(GetChatResponse {
            messages: vec![ChatMessage {
                role: "raw".to_string(),
                content,
                timestamp: "".to_string(),
            }],
        }))
    }

    async fn append_chat(
        &self,
        request: Request<AppendChatRequest>,
    ) -> Result<Response<AppendChatResponse>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.workspace_path);
        let role = req.role;
        let content = req.content;

        tokio::task::spawn_blocking(move || core::chat_append(&path, &role, &content))
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(AppendChatResponse { success: true }))
    }

    async fn clear_chat(
        &self,
        request: Request<ClearChatRequest>,
    ) -> Result<Response<ClearChatResponse>, Status> {
        let req = request.into_inner();
        let path = PathBuf::from(&req.workspace_path);

        tokio::task::spawn_blocking(move || core::chat_clear(&path))
            .await
            .map_err(|e| Status::internal(e.to_string()))?
            .map_err(|e| Status::internal(e.to_string()))?;

        Ok(Response::new(ClearChatResponse { success: true }))
    }

    // =========================================================================
    // Agent Execution - The Key Streaming RPC
    // =========================================================================

    type RunAgentStream = Pin<Box<dyn Stream<Item = Result<AgentEvent, Status>> + Send>>;

    async fn run_agent(
        &self,
        request: Request<RunAgentRequest>,
    ) -> Result<Response<Self::RunAgentStream>, Status> {
        let req = request.into_inner();
        let session_id = req.session_id.clone();
        let engine = req.engine.clone();
        let cwd = req.cwd.clone();

        // Check if session is already running (prevent double-starts)
        {
            let agents = self.agents.lock().await;
            if agents.contains_key(&session_id) {
                return Err(Status::already_exists(format!(
                    "Agent session {} is already running",
                    session_id
                )));
            }
        }

        // Build command based on engine
        let (cmd, args) = match engine.as_str() {
            "claude" | "claude-code" => {
                let mut args = vec![
                    "-p".to_string(),
                    "--output-format".to_string(),
                    "stream-json".to_string(),
                    "--verbose".to_string(),
                    "--dangerously-skip-permissions".to_string(),
                ];
                if let Some(ref resume) = req.resume_id {
                    args.push("--resume".to_string());
                    args.push(resume.clone());
                }
                args.push("--".to_string());
                args.push(req.prompt.clone());
                ("claude", args)
            }
            "codex" => (
                "codex",
                vec!["--full-auto".to_string(), req.prompt.clone()],
            ),
            "gemini" => (
                "gemini",
                vec![
                    "-m".to_string(),
                    "gemini-3-pro-preview".to_string(),
                    "--yolo".to_string(),
                    req.prompt.clone(),
                ],
            ),
            _ => {
                return Err(Status::invalid_argument(format!(
                    "Unknown engine: {}",
                    engine
                )))
            }
        };

        // Spawn the process
        let mut child = Command::new(cmd)
            .args(&args)
            .current_dir(&cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| Status::internal(format!("Failed to spawn {}: {}", cmd, e)))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Status::internal("Failed to capture stdout"))?;

        // Create broadcast channel for this agent's events
        let (tx, _) = broadcast::channel::<AgentEvent>(256);
        let tx_clone = tx.clone();

        // Register agent
        {
            let mut agents = self.agents.lock().await;
            agents.insert(
                session_id.clone(),
                ActiveAgentHandle {
                    engine: engine.clone(),
                    cwd: cwd.clone(),
                    started_at: Instant::now(),
                    sender: tx.clone(),
                    child: Some(child),
                },
            );
        }

        info!("Started agent {} with engine {}", session_id, engine);

        // Spawn task to read stdout and broadcast events
        let session_id_clone = session_id.clone();
        let engine_clone = engine.clone();
        let agents_clone = self.agents.clone();

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut parser = AgentParser::new();

            // Send started event
            let _ = tx_clone.send(AgentEvent {
                session_id: session_id_clone.clone(),
                event_type: "started".to_string(),
                payload: serde_json::json!({
                    "engine": engine_clone,
                })
                .to_string(),
            });

            // Process lines
            while let Ok(Some(line)) = reader.next_line().await {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    if let Some(events) = parser.parse_value(&value) {
                        for event in events {
                            let _ = tx_clone.send(AgentEvent {
                                session_id: session_id_clone.clone(),
                                event_type: "event".to_string(),
                                payload: event.to_string(),
                            });
                        }
                    }
                }
            }

            // Send completed event
            let _ = tx_clone.send(AgentEvent {
                session_id: session_id_clone.clone(),
                event_type: "completed".to_string(),
                payload: "{}".to_string(),
            });

            // Remove from active agents (child will be killed via Drop)
            let mut agents = agents_clone.lock().await;
            agents.remove(&session_id_clone);
            info!("Agent {} completed", session_id_clone);
        });

        // Create stream from broadcast receiver
        let mut rx = tx.subscribe();
        let stream = async_stream::stream! {
            while let Ok(event) = rx.recv().await {
                yield Ok(event);
            }
        };

        Ok(Response::new(Box::pin(stream)))
    }

    type AttachAgentStream = Pin<Box<dyn Stream<Item = Result<AgentEvent, Status>> + Send>>;

    async fn attach_agent(
        &self,
        request: Request<AttachAgentRequest>,
    ) -> Result<Response<Self::AttachAgentStream>, Status> {
        let req = request.into_inner();
        let session_id = req.session_id;

        // Look up the running agent
        let agents = self.agents.lock().await;
        let handle = agents
            .get(&session_id)
            .ok_or_else(|| Status::not_found(format!("No running agent with session_id: {}", session_id)))?;

        // Subscribe to the existing broadcast channel
        let mut rx = handle.sender.subscribe();
        info!("Client attached to agent {}", session_id);

        // Create stream
        let stream = async_stream::stream! {
            while let Ok(event) = rx.recv().await {
                yield Ok(event);
            }
        };

        Ok(Response::new(Box::pin(stream)))
    }

    async fn stop_agent(
        &self,
        request: Request<StopAgentRequest>,
    ) -> Result<Response<StopAgentResponse>, Status> {
        let req = request.into_inner();
        let mut agents = self.agents.lock().await;

        if let Some(mut handle) = agents.remove(&req.session_id) {
            // Kill child process explicitly
            if let Some(ref mut child) = handle.child {
                let _ = child.kill().await;
            }
            info!("Stopped agent {}", req.session_id);
            Ok(Response::new(StopAgentResponse { success: true }))
        } else {
            Err(Status::not_found("No agent with that session_id"))
        }
    }

    async fn list_active_agents(
        &self,
        _request: Request<ListActiveAgentsRequest>,
    ) -> Result<Response<ListActiveAgentsResponse>, Status> {
        let agents = self.agents.lock().await;

        Ok(Response::new(ListActiveAgentsResponse {
            agents: agents
                .iter()
                .map(|(id, handle)| ActiveAgent {
                    session_id: id.clone(),
                    engine: handle.engine.clone(),
                    cwd: handle.cwd.clone(),
                    started_at: handle.started_at.elapsed().as_secs().to_string(),
                })
                .collect(),
        }))
    }

    // =========================================================================
    // Daemon Lifecycle
    // =========================================================================

    async fn ping(&self, _request: Request<PingRequest>) -> Result<Response<PingResponse>, Status> {
        Ok(Response::new(PingResponse {
            version: VERSION.to_string(),
            uptime_secs: self.start_time.elapsed().as_secs() as i64,
        }))
    }

    async fn shutdown(
        &self,
        _request: Request<ShutdownRequest>,
    ) -> Result<Response<ShutdownResponse>, Status> {
        info!("Shutdown requested");

        // Kill all running agents first
        {
            let mut agents = self.agents.lock().await;
            for (id, mut handle) in agents.drain() {
                if let Some(ref mut child) = handle.child {
                    let _ = child.kill().await;
                }
                info!("Killed agent {} during shutdown", id);
            }
        }

        // Send response before exiting
        tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            std::process::exit(0);
        });
        Ok(Response::new(ShutdownResponse { success: true }))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive(tracing::Level::INFO.into()),
        )
        .init();

    // Clean up stale socket
    let socket_path = std::path::Path::new(SOCKET_PATH);
    if socket_path.exists() {
        warn!("Removing stale socket at {}", SOCKET_PATH);
        std::fs::remove_file(socket_path)?;
    }

    // Get home directory
    let home = core::default_home();
    info!("Using home directory: {:?}", home);

    // Ensure database is initialized (blocking is fine at startup)
    let conn = core::connect(&home)?;
    drop(conn);
    info!("Database initialized");

    // Create service
    let service = ConductorService::new(home);

    info!("Starting Conductor daemon v{} on {}", VERSION, SOCKET_PATH);

    // Bind to Unix socket
    let uds = tokio::net::UnixListener::bind(SOCKET_PATH)?;

    // Set socket permissions (user only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(SOCKET_PATH, std::fs::Permissions::from_mode(0o600))?;
    }

    let uds_stream = tokio_stream::wrappers::UnixListenerStream::new(uds);

    tonic::transport::Server::builder()
        .add_service(ConductorServer::new(service))
        .serve_with_incoming(uds_stream)
        .await?;

    Ok(())
}
