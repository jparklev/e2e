use anyhow::{anyhow, bail, Context, Result};
use rand::seq::SliceRandom;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ValueRef};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::fmt;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use uuid::Uuid;
use chrono::Utc;

pub const SCHEMA_VERSION: i64 = 3;

const CITIES: &[&str] = &[
    "almaty",
    "amsterdam",
    "anchorage",
    "athens",
    "auckland",
    "bandung",
    "bangkok",
    "barcelona",
    "belfast",
    "berlin",
    "bogota",
    "boston",
    "brasilia",
    "brisbane",
    "brussels",
    "bucharest",
    "budapest",
    "buenos-aires",
    "cairo",
    "calgary",
    "capetown",
    "caracas",
    "chicago",
    "copenhagen",
    "dakar",
    "delhi",
    "denver",
    "dubai",
    "dublin",
    "edmonton",
    "florence",
    "frankfurt",
    "geneva",
    "hanoi",
    "helsinki",
    "hong-kong",
    "honolulu",
    "houston",
    "istanbul",
    "jakarta",
    "johannesburg",
    "kathmandu",
    "kyoto",
    "lahore",
    "lima",
    "lisbon",
    "london",
    "los-angeles",
    "madrid",
    "managua",
    "manila",
    "melbourne",
    "mexico-city",
    "miami",
    "milan",
    "minneapolis",
    "montreal",
    "mumbai",
    "munich",
    "nairobi",
    "osaka",
    "oslo",
    "ottawa",
    "paris",
    "perth",
    "porto",
    "prague",
    "reykjavik",
    "riga",
    "rio",
    "rome",
    "seattle",
    "seoul",
    "shanghai",
    "singapore",
    "stockholm",
    "sydney",
    "taipei",
    "tehran",
    "tokyo",
    "toronto",
    "valencia",
    "vancouver",
    "venice",
    "vienna",
    "victoria",
    "warsaw",
    "wellington",
    "zurich",
];

#[derive(Debug)]
enum UserError {
    Command { area: &'static str, command: String, message: String },
    Database(String),
    Filesystem(String),
}

impl fmt::Display for UserError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UserError::Command { area, command, message } => write!(f, "{area}: {message}\n$ {command}"),
            UserError::Database(message) => write!(f, "db: {message}"),
            UserError::Filesystem(message) => write!(f, "fs: {message}"),
        }
    }
}

impl std::error::Error for UserError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Repo {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub default_branch: String,
    pub remote_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub repo_id: String,
    pub repo: String,
    pub name: String,
    pub branch: String,
    pub base_branch: String,
    pub state: WorkspaceState,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceState {
    Ready,
    Archived,
    Error,
}

impl WorkspaceState {
    fn as_str(self) -> &'static str {
        match self {
            WorkspaceState::Ready => "ready",
            WorkspaceState::Archived => "archived",
            WorkspaceState::Error => "error",
        }
    }
}

impl fmt::Display for WorkspaceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug)]
struct StateParseError(String);

impl fmt::Display for StateParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid workspace state: {}", self.0)
    }
}

impl std::error::Error for StateParseError {}

impl FromSql for WorkspaceState {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let value = value.as_str()?;
        match value {
            "ready" => Ok(WorkspaceState::Ready),
            "archived" => Ok(WorkspaceState::Archived),
            "error" => Ok(WorkspaceState::Error),
            _ => Err(FromSqlError::Other(Box::new(StateParseError(value.to_string())))),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveResult {
    pub id: String,
    pub ok: bool,
    pub removed: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub path: String,
    pub status: String,
}

pub fn default_home() -> PathBuf {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join("conductor")
}

pub fn db_path(home: &Path) -> PathBuf {
    home.join("conductor.db")
}

pub fn ensure_home_dirs(home: &Path) -> Result<()> {
    fs(std::fs::create_dir_all(home.join("repos")))?;
    fs(std::fs::create_dir_all(home.join("workspaces")))?;
    Ok(())
}

pub fn connect(home: &Path) -> Result<Connection> {
    ensure_home_dirs(home)?;
    let path = db_path(home);
    let mut conn = db(Connection::open(path))?;
    db(conn.execute_batch("PRAGMA foreign_keys = ON"))?;
    db(conn.execute_batch("PRAGMA journal_mode = WAL"))?;
    db(conn.busy_timeout(Duration::from_secs(5)))?;
    migrate(&mut conn)?;
    Ok(conn)
}

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = db(conn.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }

    let tx = db(conn.transaction_with_behavior(TransactionBehavior::Immediate))?;
    let version: i64 = db(tx.query_row("PRAGMA user_version", [], |row| row.get(0)))?;
    if version == SCHEMA_VERSION {
        db(tx.commit())?;
        return Ok(());
    }

    if version == 0 {
        db(tx.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS repos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL,
                default_branch TEXT NOT NULL,
                remote_url TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_root_path ON repos(root_path);

            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                directory_name TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                base_branch TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready', 'archived', 'error')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(repository_id) REFERENCES repos(id)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_dir ON workspaces(repository_id, directory_name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_branch ON workspaces(repository_id, branch);

            PRAGMA user_version = 3;
            ",
        ))?;
        db(tx.commit())?;
        return Ok(());
    }

    if version == 1 {
        db(tx.execute_batch(
            "
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_root_path ON repos(root_path);
            ",
        ))?;
    }

    if version == 1 || version == 2 {
        db(tx.execute_batch(
            "
            DROP TABLE IF EXISTS workspaces_new;
            CREATE TABLE workspaces_new (
                id TEXT PRIMARY KEY,
                repository_id TEXT NOT NULL,
                directory_name TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                base_branch TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'ready' CHECK(state IN ('ready', 'archived', 'error')),
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(repository_id) REFERENCES repos(id)
            );

            INSERT INTO workspaces_new (id, repository_id, directory_name, path, branch, base_branch, state, created_at, updated_at)
            SELECT
                id,
                repository_id,
                directory_name,
                path,
                branch,
                base_branch,
                CASE
                    WHEN state IN ('ready', 'archived', 'error') THEN state
                    ELSE 'error'
                END,
                created_at,
                updated_at
            FROM workspaces;

            DROP TABLE workspaces;
            ALTER TABLE workspaces_new RENAME TO workspaces;

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_dir ON workspaces(repository_id, directory_name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_branch ON workspaces(repository_id, branch);

            PRAGMA user_version = 3;
            ",
        ))?;
        db(tx.commit())?;
        return Ok(());
    }

    bail!("unsupported DB schema version: {version}");
}

fn db<T>(result: std::result::Result<T, rusqlite::Error>) -> Result<T> {
    result.map_err(|err| UserError::Database(err.to_string()).into())
}

fn fs<T>(result: std::result::Result<T, std::io::Error>) -> Result<T> {
    result.map_err(|err| UserError::Filesystem(err.to_string()).into())
}

fn collect_rows<T>(rows: impl Iterator<Item = rusqlite::Result<T>>) -> Result<Vec<T>> {
    db(rows.collect::<std::result::Result<Vec<_>, _>>())
}

fn format_command(cmd: &str, args: &[&str]) -> String {
    let mut out = String::from(cmd);
    for arg in args {
        out.push(' ');
        out.push_str(arg);
    }
    out
}

fn run(cmd: &str, args: &[&str], cwd: Option<&Path>) -> Result<String> {
    let mut command = Command::new(cmd);
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let display = format_command(cmd, args);
    let output = command.output().with_context(|| format!("failed to run {display}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let msg = if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { "command failed".to_string() };
    Err(UserError::Command {
        area: "git",
        command: display,
        message: msg,
    }
    .into())
}

fn git(repo_root: &Path, args: &[&str]) -> Result<String> {
    run("git", args, Some(repo_root))
}

fn git_try(repo_root: &Path, args: &[&str]) -> Option<String> {
    git(repo_root, args).ok()
}

fn git_ref_exists(repo_root: &Path, full_ref: &str) -> bool {
    git_try(repo_root, &["show-ref", "--verify", "--quiet", full_ref]).is_some()
}

fn resolve_repo_root(path: &Path) -> Result<PathBuf> {
    let out = git(path, &["rev-parse", "--show-toplevel"])?;
    let path = PathBuf::from(&out);
    Ok(path.canonicalize().unwrap_or_else(|_| PathBuf::from(out)))
}

fn resolve_base_ref(repo_root: &Path, base_branch: &str) -> Result<String> {
    if git_try(repo_root, &["rev-parse", "--verify", "--quiet", base_branch]).is_some() {
        return Ok(base_branch.to_string());
    }
    let refs = git(repo_root, &["for-each-ref", "--format=%(refname:short)", &format!("refs/remotes/*/{base_branch}")])?;
    let remote_refs: Vec<&str> = refs.lines().filter(|line| !line.is_empty()).collect();
    if remote_refs.len() == 1 {
        return Ok(remote_refs[0].to_string());
    }
    if remote_refs.len() > 1 {
        let preferred = format!("origin/{base_branch}");
        if remote_refs.contains(&preferred.as_str()) {
            return Ok(preferred);
        }
        bail!(
            "base branch is ambiguous across remotes: {base_branch} ({})",
            remote_refs.join(", ")
        );
    }
    bail!("base branch not found: {base_branch}");
}

fn repo_name_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let tail = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let tail = tail.rsplit(':').next().unwrap_or(tail);
    let tail = tail.strip_suffix(".git").unwrap_or(tail);
    let tail = tail.trim();
    if tail.is_empty() {
        "repo".to_string()
    } else {
        tail.to_string()
    }
}

pub fn safe_dir_name(name: &str) -> String {
    let mut out = String::new();
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "repo".to_string()
    } else {
        trimmed.to_string()
    }
}

fn safe_workspace_relpath(path: &str) -> Result<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        bail!("file path is required");
    }
    let rel = PathBuf::from(trimmed);
    for component in rel.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                bail!("file path must be relative");
            }
            _ => {}
        }
    }
    Ok(rel)
}

fn auto_workspace_name(conn: &Connection, repo_id: &str) -> Result<String> {
    let mut stmt = db(conn.prepare("SELECT directory_name FROM workspaces WHERE repository_id = ?"))?;
    let rows = db(stmt.query_map([repo_id], |row| row.get::<_, String>(0)))?;
    let mut used = HashSet::new();
    for row in rows {
        used.insert(db(row)?);
    }
    let mut rng = rand::thread_rng();
    for _ in 0..200 {
        let name = CITIES.choose(&mut rng).unwrap_or(&"ws");
        let safe = safe_dir_name(name);
        if !safe.is_empty() && !used.contains(&safe) {
            return Ok(safe);
        }
    }
    Ok(format!("ws-{}", &Uuid::new_v4().to_string()[..8]))
}

fn repo_from_row(row: &Row) -> rusqlite::Result<Repo> {
    Ok(Repo {
        id: row.get(0)?,
        name: row.get(1)?,
        root_path: row.get(2)?,
        default_branch: row.get(3)?,
        remote_url: row.get(4)?,
    })
}

fn get_repo(conn: &Connection, repo_ref: &str) -> Result<Repo> {
    let mut stmt = db(conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE id = ?"))?;
    if let Some(repo) = db(stmt.query_row([repo_ref], repo_from_row).optional())?
    {
        return Ok(repo);
    }

    let mut stmt = db(conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE name = ?"))?;
    if let Some(repo) = db(stmt.query_row([repo_ref], repo_from_row).optional())?
    {
        return Ok(repo);
    }

    let like = format!("{repo_ref}%");
    let mut stmt = db(conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE id LIKE ?"))?;
    let rows = db(stmt.query_map([like], repo_from_row))?;
    let rows = collect_rows(rows)?;
    if rows.len() == 1 {
        return Ok(rows[0].clone());
    }
    if rows.len() > 1 {
        bail!("ambiguous repo reference: {repo_ref}");
    }
    bail!("repo not found: {repo_ref}");
}

#[derive(Clone)]
struct WorkspaceRow {
    id: String,
    path: String,
    base_branch: String,
    repo_root: String,
}

fn workspace_row_from_row(row: &Row) -> rusqlite::Result<WorkspaceRow> {
    Ok(WorkspaceRow {
        id: row.get(0)?,
        path: row.get(1)?,
        base_branch: row.get(2)?,
        repo_root: row.get(3)?,
    })
}

fn get_workspace(conn: &Connection, ws_ref: &str) -> Result<WorkspaceRow> {
    let sql = "\
        SELECT \
            w.id, \
            w.path, \
            w.base_branch, \
            r.root_path \
        FROM workspaces w \
        JOIN repos r ON r.id = w.repository_id \
        WHERE w.id = ?\
    ";
    let mut stmt = db(conn.prepare(sql))?;
    if let Some(row) = db(stmt.query_row([ws_ref], workspace_row_from_row).optional())? {
        return Ok(row);
    }

    let like = format!("{ws_ref}%");
    let sql = "\
        SELECT \
            w.id, \
            w.path, \
            w.base_branch, \
            r.root_path \
        FROM workspaces w \
        JOIN repos r ON r.id = w.repository_id \
        WHERE w.id LIKE ?\
    ";
    let mut stmt = db(conn.prepare(sql))?;
    let rows = db(stmt.query_map([like], workspace_row_from_row))?;
    let rows = collect_rows(rows)?;
    if rows.len() == 1 {
        return Ok(rows[0].clone());
    }
    if rows.len() > 1 {
        bail!("ambiguous workspace reference: {ws_ref}");
    }
    bail!("workspace not found: {ws_ref}");
}

struct WorkspaceContext {
    repo_root: PathBuf,
    base_branch: String,
    path: PathBuf,
}

fn workspace_context(conn: &Connection, ws_ref: &str) -> Result<WorkspaceContext> {
    let ws = get_workspace(conn, ws_ref)?;
    Ok(WorkspaceContext {
        repo_root: PathBuf::from(ws.repo_root),
        base_branch: ws.base_branch,
        path: PathBuf::from(ws.path),
    })
}

pub fn workspace_path(conn: &Connection, ws_ref: &str) -> Result<PathBuf> {
    let ws = get_workspace(conn, ws_ref)?;
    Ok(PathBuf::from(ws.path))
}

pub fn init(home: &Path) -> Result<PathBuf> {
    ensure_home_dirs(home)?;
    Ok(db_path(home))
}

pub fn repo_add(conn: &Connection, path: &Path, name: Option<&str>, default_branch: Option<&str>) -> Result<Repo> {
    let repo_root = resolve_repo_root(path)?;
    let root_str = repo_root.to_string_lossy().to_string();

    let mut stmt = db(conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE root_path = ?"))?;
    if let Some(repo) = db(stmt.query_row([root_str.clone()], repo_from_row).optional())? {
        return Ok(repo);
    }

    let name = name.map(|s| s.to_string()).unwrap_or_else(|| repo_root.file_name().unwrap_or_default().to_string_lossy().to_string());
    let by_name: Option<(String, String)> = db(
        conn.query_row("SELECT id, root_path FROM repos WHERE name = ?", [name.clone()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional(),
    )?;
    if let Some((_, path)) = by_name {
        bail!("repo name already registered: {name} ({path})");
    }

    let remote_url = git_try(&repo_root, &["remote", "get-url", "origin"]);
    let default_branch = if let Some(branch) = default_branch {
        branch.to_string()
    } else {
        git_try(&repo_root, &["symbolic-ref", "--quiet", "--short", "HEAD"]).unwrap_or_else(|| "main".to_string())
    };

    let repo_id = Uuid::new_v4().to_string();
    db(conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote_url) VALUES (?, ?, ?, ?, ?)",
        params![repo_id, name, root_str, default_branch, remote_url],
    ))?;

    Ok(Repo {
        id: repo_id,
        name,
        root_path: repo_root.to_string_lossy().to_string(),
        default_branch,
        remote_url,
    })
}

pub fn repo_add_url(
    conn: &Connection,
    home: &Path,
    url: &str,
    name: Option<&str>,
    default_branch: Option<&str>,
) -> Result<Repo> {
    if url.starts_with('-') {
        bail!("repo url must not start with '-'");
    }
    ensure_home_dirs(home)?;
    let display_name = match name {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        _ => repo_name_from_url(url),
    };
    let dir_name = safe_dir_name(&display_name);
    let repo_dir = home.join("repos").join(&dir_name);
    if repo_dir.exists() {
        if repo_dir.join(".git").exists() {
            return repo_add(conn, &repo_dir, Some(&display_name), default_branch);
        }
        bail!("repo path already exists: {}", repo_dir.display());
    }
    let repo_dir_str = repo_dir.to_string_lossy().to_string();
    let args = ["clone", url, repo_dir_str.as_str()];
    if let Err(err) = run("git", &args, Some(home)) {
        let _ = std::fs::remove_dir_all(&repo_dir);
        return Err(err);
    }
    repo_add(conn, &repo_dir, Some(&display_name), default_branch)
}

pub fn repo_list(conn: &Connection) -> Result<Vec<Repo>> {
    let mut stmt = db(conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos ORDER BY created_at DESC"))?;
    let rows = db(stmt.query_map([], repo_from_row))?;
    collect_rows(rows)
}

pub fn workspace_create(
    conn: &Connection,
    home: &Path,
    repo_ref: &str,
    name: Option<&str>,
    base: Option<&str>,
    branch: Option<&str>,
) -> Result<Workspace> {
    let repo = get_repo(conn, repo_ref)?;
    let repo_root = PathBuf::from(&repo.root_path);
    let base_branch = base.unwrap_or(&repo.default_branch);
    let base_ref = resolve_base_ref(&repo_root, base_branch)?;

    let name = if let Some(name) = name {
        name.to_string()
    } else if let Some(branch) = branch {
        safe_dir_name(branch.split('/').last().unwrap_or(branch))
    } else {
        auto_workspace_name(conn, &repo.id)?
    };
    let branch = branch.map(|b| b.to_string()).unwrap_or_else(|| name.clone());

    let repo_dir = format!("{}-{}", safe_dir_name(&repo.name), &repo.id[..8]);
    let workspace_path = home.join("workspaces").join(repo_dir).join(&name);
    if workspace_path.exists() {
        bail!("workspace path already exists: {}", workspace_path.display());
    }
    fs(std::fs::create_dir_all(
        workspace_path
            .parent()
            .ok_or_else(|| anyhow!("invalid workspace path"))?,
    ))?;
    let workspace_path_str = workspace_path.to_string_lossy().to_string();

    if git_ref_exists(&repo_root, &format!("refs/heads/{branch}")) {
        let args = ["worktree", "add", "--", workspace_path_str.as_str(), branch.as_str()];
        run("git", &args, Some(&repo_root))?;
    } else {
        let args = [
            "worktree",
            "add",
            "-b",
            branch.as_str(),
            "--",
            workspace_path_str.as_str(),
            base_ref.as_str(),
        ];
        run("git", &args, Some(&repo_root))?;
    }

    let ws_id = Uuid::new_v4().to_string();
    let insert = db(conn.execute(
        "
        INSERT INTO workspaces (id, repository_id, directory_name, path, branch, base_branch, state)
        VALUES (?, ?, ?, ?, ?, ?, 'ready')
        ",
        params![ws_id, repo.id, name, workspace_path_str.clone(), branch, base_ref.clone()],
    ));

    if let Err(err) = insert {
        let args = ["worktree", "remove", "--force", "--", workspace_path_str.as_str()];
        let _ = run("git", &args, Some(&repo_root));
        return Err(err.into());
    }

    // Initialize .conductor-app/ folder
    let _ = ensure_conductor_app(&workspace_path);

    Ok(Workspace {
        id: ws_id,
        repo_id: repo.id,
        repo: repo.name,
        name,
        branch,
        base_branch: base_ref,
        state: WorkspaceState::Ready,
        path: workspace_path_str,
    })
}

pub fn workspace_list(conn: &Connection, repo_filter: Option<&str>) -> Result<Vec<Workspace>> {
    let mut sql = String::from(
        "
        SELECT
            w.id,
            r.id AS repo_id,
            r.name AS repo,
            w.directory_name,
            w.branch,
            w.base_branch,
            w.state,
            w.path
        FROM workspaces w
        JOIN repos r ON r.id = w.repository_id
        ",
    );

    let mut params_vec: Vec<String> = Vec::new();
    if let Some(repo_ref) = repo_filter {
        let repo = get_repo(conn, repo_ref)?;
        sql.push_str(" WHERE w.repository_id = ?");
        params_vec.push(repo.id);
    }
    sql.push_str(" ORDER BY w.created_at DESC");

    let mut stmt = db(conn.prepare(&sql))?;
    let rows = db(stmt.query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
        Ok(Workspace {
            id: row.get(0)?,
            repo_id: row.get(1)?,
            repo: row.get(2)?,
            name: row.get(3)?,
            branch: row.get(4)?,
            base_branch: row.get(5)?,
            state: row.get(6)?,
            path: row.get(7)?,
        })
    }))?;
    collect_rows(rows)
}

pub fn workspace_files(conn: &Connection, ws_ref: &str) -> Result<Vec<String>> {
    let context = workspace_context(conn, ws_ref)?;
    // Get tracked files
    let tracked = git(&context.path, &["ls-files", "-z"])?;
    let mut files: Vec<String> = tracked
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.to_string())
        .collect();
    // Also get untracked files (excluding .gitignore patterns)
    if let Ok(untracked) = git(&context.path, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        files.extend(
            untracked
                .split('\0')
                .filter(|entry| !entry.is_empty())
                .map(|entry| entry.to_string())
        );
    }
    files.sort();
    files.dedup();
    Ok(files)
}

pub fn workspace_changes(conn: &Connection, ws_ref: &str) -> Result<Vec<WorkspaceChange>> {
    let context = workspace_context(conn, ws_ref)?;
    let base_ref = resolve_base_ref(&context.repo_root, &context.base_branch)?;
    let diff = git(
        &context.path,
        &[
            "diff",
            "--name-status",
            "--no-color",
            "-z",
            &format!("{base_ref}...HEAD"),
        ],
    )?;
    let mut changes = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();
    let mut parts = diff.split('\0').filter(|part| !part.is_empty());
    while let Some(status) = parts.next() {
        if status.starts_with('R') || status.starts_with('C') {
            let old_path = match parts.next() {
                Some(path) => path,
                None => break,
            };
            let new_path = match parts.next() {
                Some(path) => path,
                None => break,
            };
            seen_paths.insert(new_path.to_string());
            changes.push(WorkspaceChange {
                old_path: Some(old_path.to_string()),
                path: new_path.to_string(),
                status: status.to_string(),
            });
        } else {
            let path = match parts.next() {
                Some(path) => path,
                None => break,
            };
            seen_paths.insert(path.to_string());
            changes.push(WorkspaceChange {
                old_path: None,
                path: path.to_string(),
                status: status.to_string(),
            });
        }
    }
    // Also include untracked files as new additions
    if let Ok(untracked) = git(&context.path, &["ls-files", "--others", "--exclude-standard", "-z"]) {
        for path in untracked.split('\0').filter(|p| !p.is_empty()) {
            if !seen_paths.contains(path) {
                changes.push(WorkspaceChange {
                    old_path: None,
                    path: path.to_string(),
                    status: "?".to_string(), // Untracked
                });
            }
        }
    }
    // Also include modified but unstaged files
    if let Ok(modified) = git(&context.path, &["diff", "--name-status", "-z"]) {
        let mut mod_parts = modified.split('\0').filter(|p| !p.is_empty());
        while let Some(status) = mod_parts.next() {
            if let Some(path) = mod_parts.next() {
                if !seen_paths.contains(path) {
                    seen_paths.insert(path.to_string());
                    changes.push(WorkspaceChange {
                        old_path: None,
                        path: path.to_string(),
                        status: status.to_string(),
                    });
                }
            }
        }
    }
    Ok(changes)
}

pub fn workspace_file_content(conn: &Connection, ws_ref: &str, file_path: &str) -> Result<String> {
    let context = workspace_context(conn, ws_ref)?;
    let rel = safe_workspace_relpath(file_path)?;
    let full_path = context.path.join(rel);
    let bytes = fs(std::fs::read(&full_path))?;
    String::from_utf8(bytes).map_err(|_| anyhow!("file is not valid utf-8"))
}

pub fn workspace_file_diff(conn: &Connection, ws_ref: &str, file_path: &str) -> Result<String> {
    let context = workspace_context(conn, ws_ref)?;
    let rel = safe_workspace_relpath(file_path)?;
    let base_ref = resolve_base_ref(&context.repo_root, &context.base_branch)?;
    let rel_str = rel.to_string_lossy().to_string();
    git(
        &context.path,
        &[
            "diff",
            "--no-color",
            &format!("{base_ref}...HEAD"),
            "--",
            &rel_str,
        ],
    )
}

// =============================================================================
// .conductor-app/ Folder Structure
// =============================================================================

/// Session state stored in .conductor-app/session.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub agent_id: String,
    pub resume_id: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}

/// Chat message for persistence in .conductor-app/chat.md
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatEntry {
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

/// Get the path to .conductor-app/ folder within a workspace
pub fn conductor_app_path(ws_path: &Path) -> PathBuf {
    ws_path.join(".conductor-app")
}

/// Ensure .conductor-app/ folder exists with initial structure
pub fn ensure_conductor_app(ws_path: &Path) -> Result<PathBuf> {
    let app_dir = conductor_app_path(ws_path);
    fs(std::fs::create_dir_all(&app_dir))?;
    Ok(app_dir)
}

/// Read session state from .conductor-app/session.json
pub fn session_read(ws_path: &Path) -> Result<Option<SessionState>> {
    let session_path = conductor_app_path(ws_path).join("session.json");
    if !session_path.exists() {
        return Ok(None);
    }
    let content = fs(std::fs::read_to_string(&session_path))?;
    let session: SessionState = serde_json::from_str(&content)
        .map_err(|e| anyhow!("failed to parse session.json: {}", e))?;
    Ok(Some(session))
}

/// Write session state to .conductor-app/session.json
pub fn session_write(ws_path: &Path, session: &SessionState) -> Result<()> {
    let app_dir = ensure_conductor_app(ws_path)?;
    let session_path = app_dir.join("session.json");
    let content = serde_json::to_string_pretty(session)
        .map_err(|e| anyhow!("failed to serialize session: {}", e))?;
    let mut file = fs(std::fs::File::create(&session_path))?;
    fs(file.write_all(content.as_bytes()))?;
    Ok(())
}

/// Create a new session with the given agent ID
pub fn session_create(ws_path: &Path, agent_id: &str) -> Result<SessionState> {
    let now = Utc::now().to_rfc3339();
    let session = SessionState {
        agent_id: agent_id.to_string(),
        resume_id: None,
        started_at: now.clone(),
        updated_at: now,
    };
    session_write(ws_path, &session)?;
    Ok(session)
}

/// Update session with a resume ID (for CLI --resume flag)
pub fn session_set_resume_id(ws_path: &Path, resume_id: &str) -> Result<SessionState> {
    let mut session = session_read(ws_path)?
        .ok_or_else(|| anyhow!("no session found"))?;
    session.resume_id = Some(resume_id.to_string());
    session.updated_at = Utc::now().to_rfc3339();
    session_write(ws_path, &session)?;
    Ok(session)
}

/// Read chat history from .conductor-app/chat.md
pub fn chat_read(ws_path: &Path) -> Result<String> {
    let chat_path = conductor_app_path(ws_path).join("chat.md");
    if !chat_path.exists() {
        return Ok(String::new());
    }
    fs(std::fs::read_to_string(&chat_path))
}

/// Append a message to .conductor-app/chat.md
pub fn chat_append(ws_path: &Path, role: &str, content: &str) -> Result<()> {
    let app_dir = ensure_conductor_app(ws_path)?;
    let chat_path = app_dir.join("chat.md");
    let timestamp = Utc::now().to_rfc3339();

    let mut file = fs(std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&chat_path))?;

    // Format: ## Role (timestamp)\n\ncontent\n\n---\n\n
    let entry = format!("## {} ({})\n\n{}\n\n---\n\n", role, timestamp, content);
    fs(file.write_all(entry.as_bytes()))?;
    Ok(())
}

/// Clear chat history
pub fn chat_clear(ws_path: &Path) -> Result<()> {
    let chat_path = conductor_app_path(ws_path).join("chat.md");
    if chat_path.exists() {
        fs(std::fs::remove_file(&chat_path))?;
    }
    Ok(())
}

/// Archive session data before workspace archive (to global archive location)
pub fn conductor_app_archive(home: &Path, ws_id: &str, ws_path: &Path) -> Result<()> {
    let app_dir = conductor_app_path(ws_path);
    if !app_dir.exists() {
        return Ok(());
    }

    // Create archive in global location (survives worktree removal)
    // Uses .conductor-app/archive/ at the home level for consistency
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S").to_string();
    let archive_dir = home.join(".conductor-app").join("archive").join(ws_id).join(&timestamp);
    fs(std::fs::create_dir_all(&archive_dir))?;

    // Copy (not move) session.json and chat.md to archive
    let session_path = app_dir.join("session.json");
    if session_path.exists() {
        fs(std::fs::copy(&session_path, archive_dir.join("session.json")))?;
    }
    let chat_path = app_dir.join("chat.md");
    if chat_path.exists() {
        fs(std::fs::copy(&chat_path, archive_dir.join("chat.md")))?;
    }

    Ok(())
}

/// Update session with a resume ID, creating session if it doesn't exist
pub fn session_upsert_resume_id(ws_path: &Path, agent_id: &str, resume_id: &str) -> Result<SessionState> {
    let now = Utc::now().to_rfc3339();
    let session = match session_read(ws_path)? {
        Some(mut s) => {
            s.resume_id = Some(resume_id.to_string());
            s.updated_at = now;
            s
        }
        None => SessionState {
            agent_id: agent_id.to_string(),
            resume_id: Some(resume_id.to_string()),
            started_at: now.clone(),
            updated_at: now,
        }
    };
    session_write(ws_path, &session)?;
    Ok(session)
}

// =============================================================================
// Workspace Archive
// =============================================================================

pub fn workspace_archive(conn: &Connection, home: &Path, workspace_ref: &str, force: bool) -> Result<ArchiveResult> {
    let ws = get_workspace(conn, workspace_ref)?;
    let ws_id = ws.id.clone();
    let repo_root = PathBuf::from(ws.repo_root);
    let ws_path = PathBuf::from(ws.path);
    let mut removed = false;
    let mut message = "archived".to_string();
    if ws_path.exists() {
        // Archive .conductor-app/ data before removing worktree (to global archive)
        if let Err(err) = conductor_app_archive(home, &ws_id, &ws_path) {
            message = format!("warning: failed to archive session data: {err}");
        }

        if !force {
            let status = git(&ws_path, &["status", "--porcelain", "--untracked-files=all"])?;
            if !status.trim().is_empty() {
                bail!(
                    "workspace has uncommitted changes; commit or stash before archiving, or pass --force: {}",
                    ws_path.display()
                );
            }
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        let ws_path_str = ws_path.to_string_lossy().to_string();
        args.push("--");
        args.push(ws_path_str.as_str());
        run("git", &args, Some(&repo_root))?;
        removed = true;
    } else {
        message = "workspace path already removed".to_string();
    }
    if let Err(err) = run("git", &["worktree", "prune"], Some(&repo_root)) {
        message = format!("{message} (prune failed: {err})");
    }

    db(conn.execute(
        "UPDATE workspaces SET state = ?, updated_at = datetime('now') WHERE id = ?",
        [WorkspaceState::Archived.as_str(), ws_id.as_str()],
    ))?;

    Ok(ArchiveResult {
        id: ws_id,
        ok: true,
        removed,
        message,
    })
}
