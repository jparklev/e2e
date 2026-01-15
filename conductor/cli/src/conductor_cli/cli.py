from __future__ import annotations

import argparse
import json
import queue
import random
import re
import sqlite3
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2


class ConductorError(RuntimeError):
    pass


_CITIES = [
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
]

_RESUME_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("codex", re.compile(r"`?codex\s+resume\s+(?P<token>[^`\s]+)`?", re.IGNORECASE)),
    ("claude", re.compile(r"`?claude\s+(?:--resume|-r)\s+(?P<token>[^`\s]+)`?", re.IGNORECASE)),
]


@dataclass(slots=True)
class CodexState:
    resume: str | None = None
    answer: str | None = None
    turn_index: int = 0
    note_seq: int = 0


@dataclass(slots=True)
class ClaudeState:
    resume: str | None = None
    pending: dict[str, dict[str, object]] = field(default_factory=dict)
    note_seq: int = 0


def _agent_event(kind: str, engine: str, payload: dict[str, object]) -> dict[str, object]:
    return {"type": f"agent.{kind}", "engine": engine, **payload}


def _tool_input_path(tool_input: dict[str, Any], *, keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = tool_input.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _tool_kind_and_title(name: str, tool_input: dict[str, Any]) -> tuple[str, str]:
    name_lower = name.lower()
    if name_lower in {"bash", "shell"}:
        command = tool_input.get("command")
        return ("command", str(command) if command else name)
    if name_lower in {"read", "edit", "write", "multiedit"}:
        path = _tool_input_path(tool_input, keys=("file_path", "path"))
        return ("file_change", path or name)
    if name_lower in {"websearch", "web_search", "webfetch", "browser"}:
        query = tool_input.get("query") or tool_input.get("url")
        return ("web_search", str(query) if query else name)
    if name_lower in {"task", "agent"}:
        title = tool_input.get("title") or tool_input.get("name")
        return ("subagent", str(title) if title else name)
    return ("tool", name)


def _claude_result_preview(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str) and text:
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str):
            return text
    return str(content)


def _codex_mcp_result_summary(result: Any) -> dict[str, Any] | None:
    if not isinstance(result, dict):
        return None
    summary: dict[str, Any] = {}
    content = result.get("content")
    if isinstance(content, list):
        summary["content_blocks"] = len(content)
    elif content is not None:
        summary["content_blocks"] = 1
    if "structured_content" in result:
        summary["has_structured"] = result.get("structured_content") is not None
    elif "structured" in result:
        summary["has_structured"] = result.get("structured") is not None
    return summary or None


def _codex_change_summary(changes: Any) -> tuple[str, list[dict[str, str]]]:
    if not isinstance(changes, list):
        return ("files", [])
    paths: list[str] = []
    normalized: list[dict[str, str]] = []
    for change in changes:
        if not isinstance(change, dict):
            continue
        path = change.get("path")
        kind = change.get("kind")
        if isinstance(path, str) and path:
            paths.append(path)
            entry = {"path": path}
            if isinstance(kind, str) and kind:
                entry["kind"] = kind
            normalized.append(entry)
    if paths:
        return (", ".join(paths), normalized)
    count = len(changes)
    return (f"{count} files" if count else "files", normalized)


def _codex_todo_summary(items: Any) -> tuple[int, int, str | None]:
    if not isinstance(items, list):
        return (0, 0, None)
    done = 0
    total = 0
    next_text: str | None = None
    for item in items:
        if not isinstance(item, dict):
            continue
        total += 1
        if item.get("completed") is True:
            done += 1
            continue
        if next_text is None:
            text = item.get("text")
            next_text = str(text) if text else None
    return (done, total, next_text)


def _codex_item_events(phase: str, item: Any, state: CodexState) -> list[dict[str, object]]:
    if not isinstance(item, dict):
        return []
    item_type = item.get("type")
    action_id = item.get("id")
    if item_type == "agent_message":
        text = item.get("text")
        if isinstance(text, str):
            state.answer = text
            return [_agent_event("message", "codex", {"text": text})]
        return []
    if not isinstance(action_id, str) or not action_id:
        return []
    if item_type == "command_execution":
        command = item.get("command")
        status = item.get("status")
        exit_code = item.get("exit_code")
        action = {
            "id": action_id,
            "kind": "command",
            "title": str(command) if command else "command",
            "detail": {"status": status, "exit_code": exit_code},
        }
        payload: dict[str, object] = {"phase": phase, "action": action}
        if phase == "completed":
            ok = status == "completed"
            if isinstance(exit_code, int):
                ok = ok and exit_code == 0
            payload["ok"] = ok
        return [_agent_event("action", "codex", payload)]
    if item_type == "mcp_tool_call":
        server = item.get("server")
        tool = item.get("tool")
        status = item.get("status")
        title = ".".join(part for part in (server, tool) if part) or "tool"
        detail: dict[str, Any] = {
            "server": server,
            "tool": tool,
            "status": status,
            "arguments": item.get("arguments"),
        }
        payload = {
            "phase": phase,
            "action": {"id": action_id, "kind": "tool", "title": title, "detail": detail},
        }
        if phase == "completed":
            error = item.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if isinstance(message, str) and message:
                    detail["error_message"] = message
            result_summary = _codex_mcp_result_summary(item.get("result"))
            if result_summary is not None:
                detail["result_summary"] = result_summary
            payload["ok"] = status == "completed" and not error
        return [_agent_event("action", "codex", payload)]
    if item_type == "web_search":
        query = item.get("query")
        action = {
            "id": action_id,
            "kind": "web_search",
            "title": str(query) if query else "search",
            "detail": {"query": query},
        }
        payload = {"phase": phase, "action": action}
        if phase == "completed":
            payload["ok"] = True
        return [_agent_event("action", "codex", payload)]
    if item_type == "file_change":
        if phase != "completed":
            return []
        status = item.get("status")
        title, normalized = _codex_change_summary(item.get("changes"))
        action = {
            "id": action_id,
            "kind": "file_change",
            "title": title,
            "detail": {"changes": normalized, "status": status},
        }
        return [_agent_event("action", "codex", {"phase": "completed", "action": action, "ok": status == "completed"})]
    if item_type == "todo_list":
        done, total, next_text = _codex_todo_summary(item.get("items"))
        if total <= 0:
            title = "todo"
        elif next_text:
            title = f"todo {done}/{total}: {next_text}"
        else:
            title = f"todo {done}/{total}: done"
        action = {
            "id": action_id,
            "kind": "note",
            "title": title,
            "detail": {"done": done, "total": total},
        }
        payload = {"phase": phase, "action": action}
        if phase == "completed":
            payload["ok"] = True
        return [_agent_event("action", "codex", payload)]
    if item_type == "reasoning":
        text = item.get("text")
        action = {"id": action_id, "kind": "note", "title": str(text) if text else "note", "detail": {}}
        payload = {"phase": phase, "action": action}
        if phase == "completed":
            payload["ok"] = True
        return [_agent_event("action", "codex", payload)]
    if item_type == "error":
        message = item.get("message")
        action = {
            "id": action_id,
            "kind": "warning",
            "title": str(message) if message else "error",
            "detail": {"message": message},
        }
        return [_agent_event("action", "codex", {"phase": "completed", "action": action, "ok": False, "message": message, "level": "warning"})]
    return []


def _parse_codex_event(data: dict[str, Any], state: CodexState) -> list[dict[str, object]] | None:
    event_type = data.get("type")
    if not isinstance(event_type, str):
        return None
    phase_map = {"item.started": "started", "item.updated": "updated", "item.completed": "completed"}
    if event_type == "thread.started":
        thread_id = data.get("thread_id")
        if isinstance(thread_id, str) and thread_id:
            state.resume = thread_id
            return [_agent_event("started", "codex", {"resume": thread_id, "title": "Codex"})]
        return []
    if event_type == "turn.started":
        turn_id = f"turn:{state.turn_index}"
        state.turn_index += 1
        action = {"id": turn_id, "kind": "turn", "title": "turn started", "detail": {}}
        return [_agent_event("action", "codex", {"phase": "started", "action": action})]
    if event_type == "turn.completed":
        turn_id = f"turn:{max(state.turn_index - 1, 0)}"
        action = {"id": turn_id, "kind": "turn", "title": "turn completed", "detail": {}}
        events = [_agent_event("action", "codex", {"phase": "completed", "action": action, "ok": True})]
        usage = data.get("usage")
        payload: dict[str, object] = {"ok": True, "answer": state.answer or "", "resume": state.resume}
        if isinstance(usage, dict):
            payload["usage"] = usage
        events.append(_agent_event("completed", "codex", payload))
        return events
    if event_type == "turn.failed":
        error = data.get("error")
        message = None
        if isinstance(error, dict):
            message = error.get("message")
        payload = {"ok": False, "answer": state.answer or "", "resume": state.resume}
        if isinstance(message, str) and message:
            payload["error"] = message
        return [_agent_event("completed", "codex", payload)]
    if event_type == "error":
        message = data.get("message")
        if isinstance(message, str) and message:
            state.note_seq += 1
            action = {
                "id": f"codex.note.{state.note_seq}",
                "kind": "warning",
                "title": message,
                "detail": {"message": message},
            }
            return [_agent_event("action", "codex", {"phase": "completed", "action": action, "ok": False, "message": message, "level": "warning"})]
        return []
    if event_type in phase_map:
        phase = phase_map[event_type]
        return _codex_item_events(phase, data.get("item"), state)
    return None


def _parse_claude_event(data: dict[str, Any], state: ClaudeState) -> list[dict[str, object]] | None:
    event_type = data.get("type")
    if not isinstance(event_type, str):
        return None
    if event_type == "system":
        if data.get("subtype") != "init":
            return []
        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            return []
        state.resume = session_id
        meta: dict[str, Any] = {}
        for key in ("cwd", "tools", "permissionMode", "output_style", "model"):
            value = data.get(key)
            if value is not None:
                meta[key] = value
        payload: dict[str, object] = {"resume": session_id}
        if meta:
            payload["meta"] = meta
        model = data.get("model")
        if isinstance(model, str) and model:
            payload["title"] = model
        return [_agent_event("started", "claude", payload)]
    if event_type == "assistant":
        message = data.get("message")
        if not isinstance(message, dict):
            return []
        content = message.get("content")
        if not isinstance(content, list):
            return []
        events: list[dict[str, object]] = []
        text_parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "tool_use":
                tool_id = block.get("id")
                name = block.get("name") or "tool"
                tool_input = block.get("input")
                if not isinstance(tool_id, str) or not tool_id:
                    continue
                tool_input_dict = tool_input if isinstance(tool_input, dict) else {}
                kind, title = _tool_kind_and_title(str(name), tool_input_dict)
                detail: dict[str, Any] = {"name": name, "input": tool_input_dict}
                if kind == "file_change":
                    path = _tool_input_path(tool_input_dict, keys=("file_path", "path"))
                    if path:
                        detail["changes"] = [{"path": path, "kind": "update"}]
                action = {"id": tool_id, "kind": kind, "title": title, "detail": detail}
                state.pending[tool_id] = action
                events.append(_agent_event("action", "claude", {"phase": "started", "action": action}))
                continue
            if block_type == "tool_result":
                tool_use_id = block.get("tool_use_id")
                if not isinstance(tool_use_id, str) or not tool_use_id:
                    continue
                action = state.pending.pop(tool_use_id, None)
                if action is None:
                    action = {"id": tool_use_id, "kind": "tool", "title": "tool", "detail": {}}
                preview = _claude_result_preview(block.get("content"))
                detail = dict(action.get("detail") or {})
                detail["tool_use_id"] = tool_use_id
                detail["result_preview"] = preview
                detail["result_len"] = len(preview)
                is_error = block.get("is_error") is True
                detail["is_error"] = is_error
                action = {**action, "detail": detail}
                events.append(_agent_event("action", "claude", {"phase": "completed", "action": action, "ok": not is_error}))
                continue
            if block_type == "thinking":
                thinking = block.get("thinking")
                if isinstance(thinking, str) and thinking:
                    state.note_seq += 1
                    title = thinking.strip().splitlines()[0]
                    action = {
                        "id": f"claude.note.{state.note_seq}",
                        "kind": "note",
                        "title": title if title else "thinking",
                        "detail": {"thinking": thinking},
                    }
                    events.append(_agent_event("action", "claude", {"phase": "completed", "action": action, "ok": True}))
                continue
            if block_type == "text":
                text = block.get("text")
                if isinstance(text, str) and text:
                    text_parts.append(text)
        if text_parts:
            events.append(_agent_event("message", "claude", {"text": "".join(text_parts)}))
        return events
    if event_type == "result":
        ok = data.get("is_error") is not True
        answer = data.get("result")
        payload: dict[str, object] = {"ok": ok, "answer": str(answer) if answer else "", "resume": state.resume}
        usage = data.get("usage")
        if isinstance(usage, dict):
            payload["usage"] = usage
        if not ok and isinstance(answer, str) and answer:
            payload["error"] = answer
        return [_agent_event("completed", "claude", payload)]
    return None


class AgentParser:
    def __init__(self) -> None:
        self.codex = CodexState()
        self.claude = ClaudeState()

    def parse(self, data: dict[str, Any]) -> list[dict[str, object]] | None:
        codex_events = _parse_codex_event(data, self.codex)
        if codex_events is not None:
            return codex_events
        return _parse_claude_event(data, self.claude)


def default_home() -> Path:
    return Path.home() / "conductor"


def db_path(home: Path) -> Path:
    return home / "conductor.db"


def ensure_home_dirs(home: Path) -> None:
    (home / "repos").mkdir(parents=True, exist_ok=True)
    (home / "workspaces").mkdir(parents=True, exist_ok=True)


def connect(home: Path) -> sqlite3.Connection:
    ensure_home_dirs(home)
    path = db_path(home)
    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    if version == SCHEMA_VERSION:
        return

    if version == 0:
        conn.executescript(
            """
            CREATE TABLE repos (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                root_path TEXT NOT NULL,
                default_branch TEXT NOT NULL,
                remote_url TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE UNIQUE INDEX idx_repos_name ON repos(name);
            CREATE UNIQUE INDEX idx_repos_root_path ON repos(root_path);

            CREATE TABLE workspaces (
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

            CREATE UNIQUE INDEX idx_workspaces_repo_dir ON workspaces(repository_id, directory_name);
            CREATE UNIQUE INDEX idx_workspaces_repo_branch ON workspaces(repository_id, branch);

            PRAGMA user_version = 2;
            """
        )
        conn.commit()
        return

    if version == 1:
        conn.executescript(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_name ON repos(name);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_root_path ON repos(root_path);
            PRAGMA user_version = 2;
            """
        )
        conn.commit()
        return

    raise ConductorError(f"unsupported DB schema version: {version}")


def run(cmd: list[str], cwd: Path | None = None) -> str:
    proc = subprocess.run(cmd, cwd=cwd, text=True, capture_output=True)
    if proc.returncode == 0:
        return proc.stdout.strip()
    stderr = proc.stderr.strip()
    stdout = proc.stdout.strip()
    msg = stderr or stdout or "command failed"
    raise ConductorError(f"{msg}\n$ {' '.join(cmd)}")


def git(repo_root: Path, args: list[str]) -> str:
    return run(["git", *args], cwd=repo_root)


def git_try(repo_root: Path, args: list[str]) -> str | None:
    try:
        return git(repo_root, args)
    except ConductorError:
        return None


def git_ref_exists(repo_root: Path, full_ref: str) -> bool:
    proc = subprocess.run(
        ["git", "show-ref", "--verify", "--quiet", full_ref],
        cwd=repo_root,
        text=True,
        capture_output=True,
    )
    return proc.returncode == 0


def resolve_repo_root(path: Path) -> Path:
    out = run(["git", "rev-parse", "--show-toplevel"], cwd=path)
    return Path(out).resolve()


def get_repo(conn: sqlite3.Connection, repo_ref: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM repos WHERE id = ?", (repo_ref,)).fetchone()
    if row is not None:
        return row

    row = conn.execute("SELECT * FROM repos WHERE name = ?", (repo_ref,)).fetchone()
    if row is not None:
        return row

    rows = conn.execute("SELECT * FROM repos WHERE id LIKE ?", (f"{repo_ref}%",)).fetchall()
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1:
        raise ConductorError(f"ambiguous repo reference: {repo_ref}")
    raise ConductorError(f"repo not found: {repo_ref}")


def get_workspace(conn: sqlite3.Connection, ws_ref: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM workspaces WHERE id = ?", (ws_ref,)).fetchone()
    if row is not None:
        return row

    rows = conn.execute("SELECT * FROM workspaces WHERE id LIKE ?", (f"{ws_ref}%",)).fetchall()
    if len(rows) == 1:
        return rows[0]
    if len(rows) > 1:
        raise ConductorError(f"ambiguous workspace reference: {ws_ref}")
    raise ConductorError(f"workspace not found: {ws_ref}")


def safe_dir_name(name: str) -> str:
    out = []
    for ch in name.strip():
        if ch.isalnum() or ch in ("-", "_", "."):
            out.append(ch.lower())
        elif ch.isspace():
            out.append("-")
    return "".join(out).strip("-") or "repo"


def auto_workspace_name(conn: sqlite3.Connection, repo_id: str) -> str:
    used = {
        str(row["directory_name"])
        for row in conn.execute(
            "SELECT directory_name FROM workspaces WHERE repository_id = ?",
            (repo_id,),
        ).fetchall()
    }
    rng = random.SystemRandom()
    for _ in range(200):
        name = safe_dir_name(rng.choice(_CITIES))
        if name and name not in used:
            return name
    return f"ws-{uuid.uuid4().hex[:8]}"


def row_dict(row: sqlite3.Row) -> dict[str, object]:
    return {key: row[key] for key in row.keys()}


def cmd_init(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> None:  # noqa: ARG001
    ensure_home_dirs(home)
    if args.json:
        print(json.dumps({"home": str(home), "db_path": str(db_path(home))}))
        return
    print(db_path(home))


def cmd_repo_add(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> None:  # noqa: ARG001
    repo_root = resolve_repo_root(Path(args.path))
    existing = conn.execute("SELECT * FROM repos WHERE root_path = ?", (str(repo_root),)).fetchone()
    if existing is not None:
        if args.json:
            print(json.dumps(row_dict(existing)))
            return
        print(f"{existing['id']}\t{existing['name']}\t{existing['root_path']}")
        return

    name = args.name or repo_root.name
    by_name = conn.execute("SELECT id, root_path FROM repos WHERE name = ?", (name,)).fetchone()
    if by_name is not None:
        raise ConductorError(f"repo name already registered: {name} ({by_name['root_path']})")

    remote_url = git_try(repo_root, ["remote", "get-url", "origin"])
    default_branch = args.default_branch
    if default_branch is None:
        default_branch = git_try(repo_root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) or "main"

    repo_id = str(uuid.uuid4())
    try:
        conn.execute(
            "INSERT INTO repos (id, name, root_path, default_branch, remote_url) VALUES (?, ?, ?, ?, ?)",
            (repo_id, name, str(repo_root), default_branch, remote_url),
        )
        conn.commit()
    except sqlite3.IntegrityError as exc:
        raise ConductorError(str(exc)) from exc
    if args.json:
        print(json.dumps({"id": repo_id, "name": name, "root_path": str(repo_root), "default_branch": default_branch, "remote_url": remote_url}))
        return
    print(f"{repo_id}\t{name}\t{repo_root}")


def cmd_repo_list(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> None:  # noqa: ARG001
    rows = conn.execute("SELECT id, name, root_path, default_branch FROM repos ORDER BY created_at DESC").fetchall()
    if not rows:
        if args.json:
            print("[]")
        return
    if args.json:
        print(json.dumps([row_dict(r) for r in rows]))
        return
    print("id\tname\tdefault_branch\troot_path")
    for r in rows:
        print(f"{r['id']}\t{r['name']}\t{r['default_branch']}\t{r['root_path']}")


def resolve_base_ref(repo_root: Path, base_branch: str) -> str:
    if git_try(repo_root, ["rev-parse", "--verify", "--quiet", base_branch]) is not None:
        return base_branch
    remote_refs = git(repo_root, ["for-each-ref", "--format=%(refname:short)", f"refs/remotes/*/{base_branch}"]).splitlines()
    remote_refs = [r for r in remote_refs if r]
    if len(remote_refs) == 1:
        return remote_refs[0]
    if len(remote_refs) > 1:
        preferred = f"origin/{base_branch}"
        if preferred in remote_refs:
            return preferred
        raise ConductorError(f"base branch is ambiguous across remotes: {base_branch} ({', '.join(remote_refs)})")
    raise ConductorError(f"base branch not found: {base_branch}")


def cmd_workspace_create(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> None:
    repo = get_repo(conn, args.repo)
    repo_root = Path(repo["root_path"])
    base_branch = args.base or repo["default_branch"]

    name = args.name
    if name is None:
        if args.branch:
            name = safe_dir_name(args.branch.split("/")[-1])
        else:
            name = auto_workspace_name(conn, str(repo["id"]))
    branch = args.branch or name

    repo_dir = f"{safe_dir_name(repo['name'])}-{repo['id'][:8]}"
    workspace_path = home / "workspaces" / repo_dir / name
    if workspace_path.exists():
        raise ConductorError(f"workspace path already exists: {workspace_path}")
    workspace_path.parent.mkdir(parents=True, exist_ok=True)

    if git_ref_exists(repo_root, f"refs/heads/{branch}"):
        run(["git", "worktree", "add", str(workspace_path), branch], cwd=repo_root)
    else:
        base_ref = resolve_base_ref(repo_root, base_branch)
        run(["git", "worktree", "add", "-b", branch, str(workspace_path), base_ref], cwd=repo_root)

    ws_id = str(uuid.uuid4())
    try:
        conn.execute(
            """
            INSERT INTO workspaces (id, repository_id, directory_name, path, branch, base_branch, state)
            VALUES (?, ?, ?, ?, ?, ?, 'ready')
            """,
            (ws_id, repo["id"], name, str(workspace_path), branch, base_branch),
        )
        conn.commit()
    except Exception as exc:
        try:
            run(["git", "worktree", "remove", "--force", str(workspace_path)], cwd=repo_root)
        except ConductorError:
            pass
        raise ConductorError(str(exc)) from exc

    if args.json:
        payload = {
            "id": ws_id,
            "repo_id": str(repo["id"]),
            "repo": str(repo["name"]),
            "name": name,
            "branch": branch,
            "base_branch": base_branch,
            "state": "ready",
            "path": str(workspace_path),
        }
        print(json.dumps(payload))
        return
    print(f"{ws_id}\t{workspace_path}\t{branch}\t{base_branch}")


def cmd_workspace_list(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> None:  # noqa: ARG001
    sql = """
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
    """
    params: tuple[str, ...] = ()
    if args.repo is not None:
        repo = get_repo(conn, args.repo)
        sql += " WHERE w.repository_id = ?"
        params = (repo["id"],)
    sql += " ORDER BY w.created_at DESC"
    rows = conn.execute(sql, params).fetchall()
    if not rows:
        if args.json:
            print("[]")
        return
    if args.json:
        payload = [
            {
                "id": r["id"],
                "repo_id": r["repo_id"],
                "repo": r["repo"],
                "name": r["directory_name"],
                "branch": r["branch"],
                "base_branch": r["base_branch"],
                "state": r["state"],
                "path": r["path"],
            }
            for r in rows
        ]
        print(json.dumps(payload))
        return
    print("id\trepo\tname\tbranch\tbase\tstate\tpath")
    for r in rows:
        print(
            f"{r['id']}\t{r['repo']}\t{r['directory_name']}\t{r['branch']}\t{r['base_branch']}\t{r['state']}\t{r['path']}"
        )


def cmd_workspace_archive(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> None:  # noqa: ARG001
    ws = get_workspace(conn, args.workspace)
    repo = conn.execute("SELECT * FROM repos WHERE id = ?", (ws["repository_id"],)).fetchone()
    if repo is None:
        raise ConductorError(f"workspace repo missing in DB: {ws['repository_id']}")

    repo_root = Path(repo["root_path"])
    path = Path(ws["path"])
    if path.exists():
        run(["git", "worktree", "remove", "--force", str(path)], cwd=repo_root)
    run(["git", "worktree", "prune"], cwd=repo_root)

    conn.execute(
        "UPDATE workspaces SET state = 'archived', updated_at = datetime('now') WHERE id = ?",
        (ws["id"],),
    )
    conn.commit()
    if args.json:
        print(json.dumps({"id": ws["id"], "state": "archived"}))
        return
    print(ws["id"])


def cmd_exec(conn: sqlite3.Connection, home: Path, args: argparse.Namespace) -> int:  # noqa: ARG001
    cmd = list(args.cmd or [])
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        raise ConductorError("Usage: conductor exec [--workspace <id>|--cwd <path>] -- <command...>")

    if args.workspace and args.cwd:
        raise ConductorError("exec: only one of --workspace or --cwd may be set")

    cwd: Path | None = None
    if args.workspace:
        ws = get_workspace(conn, args.workspace)
        cwd = Path(ws["path"])
    elif args.cwd:
        cwd = Path(args.cwd)

    if not args.json:
        proc = subprocess.run(cmd, cwd=cwd)
        return proc.returncode

    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        bufsize=1,
    )
    if proc.stdout is None or proc.stderr is None:
        raise ConductorError("exec: failed to open subprocess pipes")

    def emit(obj: object) -> None:
        print(json.dumps(obj), flush=True)

    emit({"type": "started", "command": cmd, "cwd": str(cwd) if cwd else None})

    parser = AgentParser()

    q: queue.Queue[tuple[str, str | None]] = queue.Queue()

    def pump(stream: object, kind: str) -> None:
        for line in stream:  # type: ignore[assignment]
            q.put((kind, str(line).rstrip("\n")))
        q.put((kind, None))

    threads = [
        threading.Thread(target=pump, args=(proc.stdout, "stdout"), daemon=True),
        threading.Thread(target=pump, args=(proc.stderr, "stderr"), daemon=True),
    ]
    for t in threads:
        t.start()

    closed = 0
    try:
        while closed < 2:
            kind, line = q.get()
            if line is None:
                closed += 1
                continue
            for engine, pattern in _RESUME_PATTERNS:
                match = pattern.search(line)
                if match:
                    token = match.group("token")
                    if token:
                        emit({"type": "resume", "engine": engine, "token": token})
            if kind == "stdout":
                try:
                    data = json.loads(line)
                    if isinstance(data, dict):
                        agent_events = parser.parse(data)
                        if agent_events is not None:
                            for event in agent_events:
                                emit(event)
                            continue
                    if isinstance(data, (dict, list)):
                        emit({"type": "json", "data": data})
                        continue
                except json.JSONDecodeError:
                    pass
            emit({"type": kind, "text": line})
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        raise

    exit_code = int(proc.wait())
    emit({"type": "exit", "exit_code": exit_code})
    return exit_code


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="conductor")
    p.add_argument("--home", type=Path, default=default_home(), help="Conductor home directory (default: ~/conductor)")
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON output")

    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init", help="Initialize Conductor home + DB")
    sp.set_defaults(func=cmd_init)

    repo = sub.add_parser("repo", help="Manage repos")
    repo_sub = repo.add_subparsers(dest="repo_cmd", required=True)

    sp = repo_sub.add_parser("add", help="Register an existing git repo")
    sp.add_argument("path", nargs="?", default=".", help="Path inside the repo (default: .)")
    sp.add_argument("--name", help="Display name for the repo")
    sp.add_argument("--default-branch", help="Default branch (otherwise uses current branch or main)")
    sp.set_defaults(func=cmd_repo_add)

    sp = repo_sub.add_parser("list", help="List registered repos")
    sp.set_defaults(func=cmd_repo_list)

    ws = sub.add_parser("workspace", help="Manage workspaces")
    ws_sub = ws.add_subparsers(dest="ws_cmd", required=True)

    sp = ws_sub.add_parser("create", help="Create a new workspace (git worktree + branch)")
    sp.add_argument("repo", help="Repo id, id prefix, or name")
    sp.add_argument("name", nargs="?", help="Workspace directory name (defaults to a city)")
    sp.add_argument("--base", help="Base branch (default: repo default branch)")
    sp.add_argument("--branch", help="Workspace branch name (default: same as name)")
    sp.set_defaults(func=cmd_workspace_create)

    sp = ws_sub.add_parser("list", help="List workspaces")
    sp.add_argument("--repo", help="Filter by repo id/prefix/name")
    sp.set_defaults(func=cmd_workspace_list)

    sp = ws_sub.add_parser("archive", help="Remove worktree and mark workspace archived")
    sp.add_argument("workspace", help="Workspace id or id prefix")
    sp.set_defaults(func=cmd_workspace_archive)

    sp = sub.add_parser("exec", help="Run a command, optionally inside a workspace")
    sp.add_argument("--workspace", help="Workspace id or id prefix")
    sp.add_argument("--cwd", type=Path, help="Working directory")
    sp.add_argument("cmd", nargs=argparse.REMAINDER, help="Command to run (use -- before the command)")
    sp.set_defaults(func=cmd_exec)

    return p


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    p = build_parser()
    args = p.parse_args(argv)

    try:
        conn = connect(args.home)
        result = args.func(conn, args.home, args)
        if isinstance(result, int):
            return result
        return 0
    except BrokenPipeError:
        return 0
    except ConductorError as exc:
        print(f"conductor: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
