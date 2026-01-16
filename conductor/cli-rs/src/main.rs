use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use conductor_agent::AgentParser;
use conductor_core as core;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::thread;

#[derive(Parser)]
#[command(name = "conductor", version, about = "Conductor workspace manager")]
struct Cli {
    #[arg(long)]
    home: Option<PathBuf>,
    #[arg(long)]
    json: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Init,
    Repo {
        #[command(subcommand)]
        command: RepoCommands,
    },
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommands,
    },
    Exec {
        #[arg(long)]
        workspace: Option<String>,
        #[arg(long)]
        cwd: Option<PathBuf>,
        #[arg(last = true)]
        cmd: Vec<String>,
    },
}

#[derive(Subcommand)]
enum RepoCommands {
    Add {
        path: Option<PathBuf>,
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        name: Option<String>,
        #[arg(long = "default-branch")]
        default_branch: Option<String>,
    },
    List,
}

#[derive(Subcommand)]
enum WorkspaceCommands {
    Create {
        repo: String,
        name: Option<String>,
        #[arg(long)]
        base: Option<String>,
        #[arg(long)]
        branch: Option<String>,
    },
    List {
        #[arg(long)]
        repo: Option<String>,
    },
    Archive {
        workspace: String,
        #[arg(long)]
        force: bool,
    },
    Files {
        workspace: String,
    },
    Changes {
        workspace: String,
    },
    File {
        workspace: String,
        path: String,
    },
    Diff {
        workspace: String,
        path: String,
    },
}

fn print_json<T: Serialize>(value: &T) -> Result<()> {
    let text = serde_json::to_string(value)?;
    println!("{text}");
    Ok(())
}

fn print_json_value(value: &Value) -> Result<()> {
    let text = serde_json::to_string(value)?;
    println!("{text}");
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let home = cli.home.unwrap_or_else(core::default_home);

    match cli.command {
        Commands::Init => {
            let db_path = core::init(&home)?;
            if cli.json {
                print_json(&json!({"home": home, "db_path": db_path}))?;
            } else {
                println!("{}", db_path.display());
            }
        }
        Commands::Repo { command } => {
            let conn = core::connect(&home)?;
            match command {
                RepoCommands::Add {
                    path,
                    url,
                    name,
                    default_branch,
                } => {
                    let repo = if let Some(url) = url {
                        if path.is_some() {
                            return Err(anyhow!("repo add: use either a path or --url"));
                        }
                        core::repo_add_url(
                            &conn,
                            &home,
                            &url,
                            name.as_deref(),
                            default_branch.as_deref(),
                        )?
                    } else {
                        let path = path.unwrap_or_else(|| PathBuf::from("."));
                        core::repo_add(
                            &conn,
                            &path,
                            name.as_deref(),
                            default_branch.as_deref(),
                        )?
                    };
                    if cli.json {
                        print_json(&repo)?;
                    } else {
                        println!("{}\t{}\t{}", repo.id, repo.name, repo.root_path);
                    }
                }
                RepoCommands::List => {
                    let repos = core::repo_list(&conn)?;
                    if cli.json {
                        print_json(&repos)?;
                    } else if !repos.is_empty() {
                        println!("id\tname\tdefault_branch\troot_path");
                        for repo in repos {
                            println!(
                                "{}\t{}\t{}\t{}",
                                repo.id, repo.name, repo.default_branch, repo.root_path
                            );
                        }
                    }
                }
            }
        }
        Commands::Workspace { command } => {
            let conn = core::connect(&home)?;
            match command {
                WorkspaceCommands::Create {
                    repo,
                    name,
                    base,
                    branch,
                } => {
                    let ws = core::workspace_create(
                        &conn,
                        &home,
                        &repo,
                        name.as_deref(),
                        base.as_deref(),
                        branch.as_deref(),
                    )?;
                    if cli.json {
                        print_json(&ws)?;
                    } else {
                        println!("{}\t{}\t{}\t{}", ws.id, ws.path, ws.branch, ws.base_branch);
                    }
                }
                WorkspaceCommands::List { repo } => {
                    let workspaces = core::workspace_list(&conn, repo.as_deref())?;
                    if cli.json {
                        print_json(&workspaces)?;
                    } else if !workspaces.is_empty() {
                        println!("id\trepo\tname\tbranch\tbase\tstate\tpath");
                        for ws in workspaces {
                            println!(
                                "{}\t{}\t{}\t{}\t{}\t{}\t{}",
                                ws.id, ws.repo, ws.name, ws.branch, ws.base_branch, ws.state, ws.path
                            );
                        }
                    }
                }
                WorkspaceCommands::Archive { workspace, force } => {
                    let result = core::workspace_archive(&conn, &home, &workspace, force)?;
                    if cli.json {
                        print_json(&result)?;
                    } else {
                        println!("{}", result.id);
                    }
                }
                WorkspaceCommands::Files { workspace } => {
                    let files = core::workspace_files(&conn, &workspace)?;
                    if cli.json {
                        print_json(&files)?;
                    } else {
                        for path in files {
                            println!("{path}");
                        }
                    }
                }
                WorkspaceCommands::Changes { workspace } => {
                    let changes = core::workspace_changes(&conn, &workspace)?;
                    if cli.json {
                        print_json(&changes)?;
                    } else {
                        for change in changes {
                            if let Some(old_path) = change.old_path {
                                println!("{}\t{}\t{}", change.status, old_path, change.path);
                            } else {
                                println!("{}\t{}", change.status, change.path);
                            }
                        }
                    }
                }
                WorkspaceCommands::File { workspace, path } => {
                    let content = core::workspace_file_content(&conn, &workspace, &path)?;
                    if cli.json {
                        print_json(&json!({ "content": content }))?;
                    } else {
                        println!("{content}");
                    }
                }
                WorkspaceCommands::Diff { workspace, path } => {
                    let diff = core::workspace_file_diff(&conn, &workspace, &path)?;
                    if cli.json {
                        print_json(&json!({ "patch": diff }))?;
                    } else {
                        println!("{diff}");
                    }
                }
            }
        }
        Commands::Exec { workspace, cwd, mut cmd } => {
            if cmd.first().map(|s| s.as_str()) == Some("--") {
                cmd.remove(0);
            }
            if cmd.is_empty() {
                return Err(anyhow!("Usage: conductor exec [--workspace <id>|--cwd <path>] -- <command...>"));
            }
            if workspace.is_some() && cwd.is_some() {
                return Err(anyhow!("exec: only one of --workspace or --cwd may be set"));
            }

            let cwd = match (workspace, cwd) {
                (Some(ws), None) => {
                    let conn = core::connect(&home)?;
                    Some(core::workspace_path(&conn, &ws)?)
                }
                (None, Some(path)) => Some(path),
                _ => None,
            };

            if cli.json {
                let exit_code = exec_json(&cmd, cwd.as_deref())?;
                std::process::exit(exit_code);
            } else {
                let status = run_command(&cmd, cwd.as_deref())?;
                std::process::exit(status);
            }
        }
    }

    Ok(())
}

fn run_command(cmd: &[String], cwd: Option<&Path>) -> Result<i32> {
    let mut command = Command::new(&cmd[0]);
    command.args(&cmd[1..]);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let status = command.status()?;
    Ok(status.code().unwrap_or(1))
}

struct LineEvent {
    kind: &'static str,
    line: Option<String>,
}

fn pump_lines(stream: impl std::io::Read + Send + 'static, kind: &'static str, tx: Sender<LineEvent>) {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            if let Ok(line) = line {
                let _ = tx.send(LineEvent {
                    kind,
                    line: Some(line),
                });
            }
        }
        let _ = tx.send(LineEvent { kind, line: None });
    });
}

struct ResumePattern {
    engine: &'static str,
    regex: Regex,
}

struct ResumeEvent {
    engine: &'static str,
    token: String,
}

fn resume_patterns() -> Result<Vec<ResumePattern>> {
    Ok(vec![
        ResumePattern {
            engine: "codex",
            regex: Regex::new(r"(?i)`?codex\s+resume\s+(?P<token>[^`\s]+)`?")?,
        },
        ResumePattern {
            engine: "claude",
            regex: Regex::new(r"(?i)`?claude\s+(?:--resume|-r)\s+(?P<token>[^`\s]+)`?")?,
        },
    ])
}

fn extract_resume_tokens(line: &str, patterns: &[ResumePattern]) -> Vec<ResumeEvent> {
    let mut events = Vec::new();
    for pattern in patterns {
        for caps in pattern.regex.captures_iter(line) {
            if let Some(token) = caps.name("token").map(|m| m.as_str()) {
                events.push(ResumeEvent {
                    engine: pattern.engine,
                    token: token.to_string(),
                });
            }
        }
    }
    events
}

fn route_stdout_line(parser: &mut AgentParser, line: &str) -> Vec<Value> {
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    if let Some(events) = parser.parse_value(&value) {
        return events;
    }
    if value.is_object() || value.is_array() {
        return vec![json!({"type": "json", "data": value})];
    }
    Vec::new()
}

fn exec_json(cmd: &[String], cwd: Option<&Path>) -> Result<i32> {
    let mut command = Command::new(&cmd[0]);
    command.args(&cmd[1..]);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("exec: failed to open subprocess pipes"))?;
    let stderr = child.stderr.take().ok_or_else(|| anyhow!("exec: failed to open subprocess pipes"))?;

    let (tx, rx) = mpsc::channel();
    pump_lines(stdout, "stdout", tx.clone());
    pump_lines(stderr, "stderr", tx);

    print_json_value(&json!({
        "type": "started",
        "command": cmd,
        "cwd": cwd.map(|p| p.to_string_lossy().to_string()),
    }))?;

    let patterns = resume_patterns()?;
    let mut parser = AgentParser::new();
    let mut closed = 0;
    while closed < 2 {
        let event = rx.recv()?;
        match event.line {
            None => {
                closed += 1;
            }
            Some(line) => {
                for resume in extract_resume_tokens(&line, &patterns) {
                    print_json_value(&json!({
                        "type": "resume",
                        "engine": resume.engine,
                        "token": resume.token,
                    }))?;
                }

                if event.kind == "stdout" {
                    let routed = route_stdout_line(&mut parser, &line);
                    if !routed.is_empty() {
                        for event in routed {
                            print_json_value(&event)?;
                        }
                        continue;
                    }
                }

                print_json_value(&json!({
                    "type": event.kind,
                    "text": line,
                }))?;
            }
        }
    }

    let status = child.wait()?;
    let exit_code = status.code().unwrap_or(1);
    print_json_value(&json!({"type": "exit", "exit_code": exit_code}))?;
    std::io::stdout().flush()?;
    Ok(exit_code)
}
