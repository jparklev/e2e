use conductor_agent::AgentParser;
use conductor_core::{self as core, ArchiveResult, Repo, Workspace, WorkspaceChange};
use serde_json::Value;
use std::env;
use std::path::PathBuf;

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
    core::workspace_archive(&conn, &workspace, force.unwrap_or(false)).map_err(map_err)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            parse_agent_lines
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
