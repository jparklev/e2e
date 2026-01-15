use anyhow::{anyhow, bail, Context, Result};
use rand::seq::SliceRandom;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::env;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use uuid::Uuid;

pub const SCHEMA_VERSION: i64 = 2;

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
    pub state: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveResult {
    pub id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceChange {
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
    std::fs::create_dir_all(home.join("repos"))?;
    std::fs::create_dir_all(home.join("workspaces"))?;
    Ok(())
}

pub fn connect(home: &Path) -> Result<Connection> {
    ensure_home_dirs(home)?;
    let path = db_path(home);
    let mut conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    conn.busy_timeout(Duration::from_secs(5))?;
    migrate(&mut conn)?;
    Ok(conn)
}

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == SCHEMA_VERSION {
        return Ok(());
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version == SCHEMA_VERSION {
        tx.commit()?;
        return Ok(());
    }

    if version == 0 {
        tx.execute_batch(
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
                state TEXT NOT NULL DEFAULT 'ready',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY(repository_id) REFERENCES repos(id)
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_dir ON workspaces(repository_id, directory_name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_branch ON workspaces(repository_id, branch);

            PRAGMA user_version = 2;
            ",
        )?;
        tx.commit()?;
        return Ok(());
    }

    if version == 1 {
        tx.execute_batch(
            "
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_root_path ON repos(root_path);
            PRAGMA user_version = 2;
            ",
        )?;
        tx.commit()?;
        return Ok(());
    }

    bail!("unsupported DB schema version: {version}");
}

fn run(cmd: &[String], cwd: Option<&Path>) -> Result<String> {
    let mut command = Command::new(&cmd[0]);
    command.args(&cmd[1..]);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let output = command.output().with_context(|| format!("failed to run {}", cmd.join(" ")))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let msg = if !stderr.is_empty() { stderr } else if !stdout.is_empty() { stdout } else { "command failed".to_string() };
    Err(anyhow!("{msg}\n$ {}", cmd.join(" ")))
}

fn git(repo_root: &Path, args: &[&str]) -> Result<String> {
    let mut cmd = vec!["git".to_string()];
    cmd.extend(args.iter().map(|arg| arg.to_string()));
    run(&cmd, Some(repo_root))
}

fn git_try(repo_root: &Path, args: &[&str]) -> Option<String> {
    git(repo_root, args).ok()
}

fn git_ref_exists(repo_root: &Path, full_ref: &str) -> bool {
    Command::new("git")
        .args(["show-ref", "--verify", "--quiet", full_ref])
        .current_dir(repo_root)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn resolve_repo_root(path: &Path) -> Result<PathBuf> {
    let cmd = vec![
        "git".to_string(),
        "rev-parse".to_string(),
        "--show-toplevel".to_string(),
    ];
    let out = run(&cmd, Some(path))?;
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
    let mut stmt = conn.prepare("SELECT directory_name FROM workspaces WHERE repository_id = ?")?;
    let rows = stmt.query_map([repo_id], |row| row.get::<_, String>(0))?;
    let mut used = HashSet::new();
    for row in rows {
        used.insert(row?);
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

fn get_repo(conn: &Connection, repo_ref: &str) -> Result<Repo> {
    let mut stmt = conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE id = ?")?;
    if let Some(repo) = stmt
        .query_row([repo_ref], |row| {
            Ok(Repo {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
            })
        })
        .optional()?
    {
        return Ok(repo);
    }

    let mut stmt = conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE name = ?")?;
    if let Some(repo) = stmt
        .query_row([repo_ref], |row| {
            Ok(Repo {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
            })
        })
        .optional()?
    {
        return Ok(repo);
    }

    let like = format!("{repo_ref}%");
    let mut stmt = conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE id LIKE ?")?;
    let rows: Vec<Repo> = stmt
        .query_map([like], |row| {
            Ok(Repo {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<_, _>>()?;
    if rows.len() == 1 {
        return Ok(rows[0].clone());
    }
    if rows.len() > 1 {
        bail!("ambiguous repo reference: {repo_ref}");
    }
    bail!("repo not found: {repo_ref}");
}

fn get_workspace(conn: &Connection, ws_ref: &str) -> Result<(String, String, String, String)> {
    let mut stmt = conn.prepare("SELECT id, repository_id, path, branch FROM workspaces WHERE id = ?")?;
    if let Some(row) = stmt
        .query_row([ws_ref], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .optional()?
    {
        return Ok(row);
    }

    let like = format!("{ws_ref}%");
    let mut stmt = conn.prepare("SELECT id, repository_id, path, branch FROM workspaces WHERE id LIKE ?")?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([like], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
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
    let (ws_id, repo_id, path, _branch) = get_workspace(conn, ws_ref)?;
    let base_branch: String = conn.query_row(
        "SELECT base_branch FROM workspaces WHERE id = ?",
        [ws_id],
        |row| row.get(0),
    )?;
    let repo_root: String = conn.query_row(
        "SELECT root_path FROM repos WHERE id = ?",
        [repo_id],
        |row| row.get(0),
    )?;
    Ok(WorkspaceContext {
        repo_root: PathBuf::from(repo_root),
        base_branch,
        path: PathBuf::from(path),
    })
}

pub fn workspace_path(conn: &Connection, ws_ref: &str) -> Result<PathBuf> {
    let (_id, _repo_id, path, _branch) = get_workspace(conn, ws_ref)?;
    Ok(PathBuf::from(path))
}

pub fn init(home: &Path) -> Result<PathBuf> {
    ensure_home_dirs(home)?;
    Ok(db_path(home))
}

pub fn repo_add(conn: &Connection, path: &Path, name: Option<&str>, default_branch: Option<&str>) -> Result<Repo> {
    let repo_root = resolve_repo_root(path)?;
    let root_str = repo_root.to_string_lossy().to_string();

    let mut stmt = conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE root_path = ?")?;
    if let Some(repo) = stmt
        .query_row([root_str.clone()], |row| {
            Ok(Repo {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
            })
        })
        .optional()?
    {
        return Ok(repo);
    }

    let name = name.map(|s| s.to_string()).unwrap_or_else(|| repo_root.file_name().unwrap_or_default().to_string_lossy().to_string());
    let by_name: Option<(String, String)> = conn
        .query_row("SELECT id, root_path FROM repos WHERE name = ?", [name.clone()], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
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
    conn.execute(
        "INSERT INTO repos (id, name, root_path, default_branch, remote_url) VALUES (?, ?, ?, ?, ?)",
        params![repo_id, name, root_str, default_branch, remote_url],
    )?;

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
    let cmd = vec![
        "git".to_string(),
        "clone".to_string(),
        url.to_string(),
        repo_dir.to_string_lossy().to_string(),
    ];
    run(&cmd, Some(home))?;
    repo_add(conn, &repo_dir, Some(&display_name), default_branch)
}

pub fn repo_list(conn: &Connection) -> Result<Vec<Repo>> {
    let mut stmt = conn.prepare("SELECT id, name, root_path, default_branch, remote_url FROM repos ORDER BY created_at DESC")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Repo {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
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
    std::fs::create_dir_all(workspace_path.parent().ok_or_else(|| anyhow!("invalid workspace path"))?)?;

    if git_ref_exists(&repo_root, &format!("refs/heads/{branch}")) {
        let cmd = vec![
            "git".to_string(),
            "worktree".to_string(),
            "add".to_string(),
            workspace_path.to_string_lossy().to_string(),
            branch.clone(),
        ];
        run(&cmd, Some(&repo_root))?;
    } else {
        let cmd = vec![
            "git".to_string(),
            "worktree".to_string(),
            "add".to_string(),
            "-b".to_string(),
            branch.clone(),
            workspace_path.to_string_lossy().to_string(),
            base_ref.clone(),
        ];
        run(&cmd, Some(&repo_root))?;
    }

    let ws_id = Uuid::new_v4().to_string();
    let insert = conn.execute(
        "
        INSERT INTO workspaces (id, repository_id, directory_name, path, branch, base_branch, state)
        VALUES (?, ?, ?, ?, ?, ?, 'ready')
        ",
        params![ws_id, repo.id, name, workspace_path.to_string_lossy().to_string(), branch, base_ref.clone()],
    );

    if let Err(err) = insert {
        let _ = run(
            &[
                "git".to_string(),
                "worktree".to_string(),
                "remove".to_string(),
                "--force".to_string(),
                workspace_path.to_string_lossy().to_string(),
            ],
            Some(&repo_root),
        );
        return Err(err.into());
    }

    Ok(Workspace {
        id: ws_id,
        repo_id: repo.id,
        repo: repo.name,
        name,
        branch,
        base_branch: base_ref,
        state: "ready".to_string(),
        path: workspace_path.to_string_lossy().to_string(),
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

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.iter()), |row| {
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
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn workspace_files(conn: &Connection, ws_ref: &str) -> Result<Vec<String>> {
    let context = workspace_context(conn, ws_ref)?;
    let tracked = git(&context.path, &["ls-files"])?;
    let mut files: Vec<String> = tracked
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
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
            &format!("{base_ref}...HEAD"),
        ],
    )?;
    let mut changes = Vec::new();
    for line in diff.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 2 {
            continue;
        }
        let status = parts[0].to_string();
        let path = parts.last().unwrap().to_string();
        changes.push(WorkspaceChange { path, status });
    }
    Ok(changes)
}

pub fn workspace_file_content(conn: &Connection, ws_ref: &str, file_path: &str) -> Result<String> {
    let context = workspace_context(conn, ws_ref)?;
    let rel = safe_workspace_relpath(file_path)?;
    let full_path = context.path.join(rel);
    let bytes = std::fs::read(&full_path)?;
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

pub fn workspace_archive(conn: &Connection, workspace_ref: &str, force: bool) -> Result<ArchiveResult> {
    let (ws_id, repo_id, path, _branch) = get_workspace(conn, workspace_ref)?;
    let repo: Repo = conn.query_row(
        "SELECT id, name, root_path, default_branch, remote_url FROM repos WHERE id = ?",
        [repo_id],
        |row| {
            Ok(Repo {
                id: row.get(0)?,
                name: row.get(1)?,
                root_path: row.get(2)?,
                default_branch: row.get(3)?,
                remote_url: row.get(4)?,
            })
        },
    )?;

    let repo_root = PathBuf::from(repo.root_path);
    let ws_path = PathBuf::from(path);
    let mut removed = false;
    if ws_path.exists() {
        if !force {
            let status = git(&ws_path, &["status", "--porcelain", "--untracked-files=all"])?;
            if !status.trim().is_empty() {
                bail!(
                    "workspace has uncommitted changes; commit or stash before archiving, or pass --force: {}",
                    ws_path.display()
                );
            }
        }
        let mut cmd = vec![
            "git".to_string(),
            "worktree".to_string(),
            "remove".to_string(),
        ];
        if force {
            cmd.push("--force".to_string());
        }
        cmd.push(ws_path.to_string_lossy().to_string());
        run(&cmd, Some(&repo_root))?;
        removed = true;
    }
    let prune = run(
        &["git".to_string(), "worktree".to_string(), "prune".to_string()],
        Some(&repo_root),
    );
    if let Err(err) = prune {
        if removed {
            return Err(err);
        }
    }

    conn.execute(
        "UPDATE workspaces SET state = 'archived', updated_at = datetime('now') WHERE id = ?",
        [ws_id.clone()],
    )?;

    Ok(ArchiveResult {
        id: ws_id,
        state: "archived".to_string(),
    })
}
