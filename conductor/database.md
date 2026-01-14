# Conductor Database

SQLite database at `~/Library/Application Support/com.conductor.app/conductor.db`

## Schema

### repos

Registered git repositories.

```sql
CREATE TABLE repos (
    id TEXT PRIMARY KEY,
    remote_url TEXT,
    name TEXT,
    default_branch TEXT DEFAULT 'main',
    root_path TEXT,
    setup_script TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    storage_version INTEGER DEFAULT 1,
    archive_script TEXT,
    display_order INTEGER DEFAULT 0,
    run_script TEXT,
    run_script_mode TEXT DEFAULT 'concurrent',
    remote TEXT,
    custom_prompt_code_review TEXT,
    custom_prompt_create_pr TEXT,
    custom_prompt_rename_branch TEXT
);
```

**Example data:**
```
id                                   | name                          | remote_url
-------------------------------------|-------------------------------|----------------------------------------
dc865b35-e06a-4bd2-aea0-273a61ba1028 | 2025-12-20-observable-desktop | https://github.com/jparklev/observable-desktop-notebooks.git
28eb3188-14d3-4de9-9684-a0f775a7b31b | personal                      | https://github.com/jparklev/obsidian-personal.git
77064749-d097-45e0-b7c5-905cfd758790 | personal-assistant            | https://github.com/jparklev/personal-assistant.git
ee851379-bf9c-4e99-ae19-78339310b20a | VoiceInk                      | https://github.com/jparklev/voiceink-fork.git
```

### workspaces

City-named task contexts. Each workspace has its own branch.

```sql
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    repository_id TEXT,
    DEPRECATED_city_name TEXT,
    directory_name TEXT,
    DEPRECATED_archived INTEGER DEFAULT 0,
    active_session_id TEXT,
    branch TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    unread INTEGER DEFAULT 0,
    placeholder_branch_name TEXT,
    state TEXT DEFAULT 'active',           -- 'active', 'ready', 'archived'
    initialization_parent_branch TEXT,
    big_terminal_mode INTEGER DEFAULT 0,
    setup_log_path TEXT,
    initialization_log_path TEXT,
    initialization_files_copied INTEGER,
    pinned_at TEXT,
    linked_workspace_ids TEXT,
    notes TEXT,
    intended_target_branch TEXT
);
```

**Example data:**
```
directory_name | branch                        | state    | created_at
---------------|-------------------------------|----------|--------------------
victoria       | jparklev/victoria             | ready    | 2026-01-13 19:36:19
copenhagen     | jparklev/copenhagen           | ready    | 2026-01-13 19:16:40
sun-valley     | jparklev/safe-v1.4.1-compat   | archived | 2026-01-13 08:20:21
lahore-v2      | jparklev/lahore-v2            | archived | 2026-01-13 04:29:28
kathmandu      | jparklev/kathmandu            | archived | 2026-01-13 03:39:06
```

### sessions

AI conversation sessions (Claude or GPT).

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    status TEXT DEFAULT 'idle',            -- 'idle', 'running', 'error'
    claude_session_id TEXT,
    unread_count INTEGER DEFAULT 0,
    freshly_compacted INTEGER DEFAULT 0,
    context_token_count INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_compacting INTEGER DEFAULT 0,
    model TEXT,                            -- 'opus', 'gpt-5.2', 'gpt-5.2-codex'
    permission_mode TEXT DEFAULT 'default',
    DEPRECATED_thinking_level TEXT DEFAULT 'NONE',
    last_user_message_at TEXT,
    resume_session_at TEXT,
    workspace_id TEXT,
    is_hidden INTEGER DEFAULT 0,
    agent_type,
    title TEXT DEFAULT 'Untitled',
    context_used_percent FLOAT,
    thinking_enabled INTEGER DEFAULT 1
);
```

**Example data:**
```
title                      | model   | context_used_percent | status
---------------------------|---------|----------------------|-------
Auditing system safety     | gpt-5.2 | NULL                 | idle
Confirm Safe v1.4.1 setup  | opus    | 42.0                 | idle
Create PR                  | opus    | 20.0                 | error
Testing frontend contracts | opus    | 39.0                 | idle
```

### session_messages

Individual messages in a session. Content is stored as JSON.

```sql
CREATE TABLE session_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    role TEXT,                             -- 'user', 'assistant'
    content TEXT,                          -- JSON blob
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at TEXT,
    full_message TEXT,
    cancelled_at TEXT,
    model TEXT,
    sdk_message_id TEXT,
    last_assistant_message_id TEXT,
    turn_id TEXT
);

CREATE INDEX idx_session_messages_sent_at ON session_messages(session_id, sent_at);
CREATE INDEX idx_session_messages_turn_id ON session_messages(turn_id);
```

**Message content format:**
```json
// User message
{"type":"user","session_id":"...","message":{"role":"user","content":[{"type":"text","text":"..."}]}}

// Assistant message
{"type":"assistant","session_id":"...","message":{"role":"assistant","content":[{"type":"text","text":"..."}]}}

// Tool use
{"type":"assistant","session_id":"...","message":{"role":"assistant","content":[{"type":"tool_use","id":"...","name":"Bash","input":{"command":"..."}}]}}

// Usage stats
{"type":"result","session_id":"...","usage":{"input_tokens":99319,"output_tokens":113,"cache_read_input_tokens":4352}}
```

### attachments

Files attached to sessions.

```sql
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    type TEXT,
    original_name TEXT,
    path TEXT,
    is_loading INTEGER DEFAULT 0,
    session_id TEXT,
    session_message_id TEXT,
    is_draft INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_attachments_session_id ON attachments(session_id);
CREATE INDEX idx_attachments_session_message_id ON attachments(session_message_id);
CREATE INDEX idx_attachments_is_draft ON attachments(is_draft);
```

### diff_comments

PR review comments.

```sql
CREATE TABLE diff_comments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    file_path TEXT,
    line_number INTEGER,
    body TEXT,
    state TEXT,
    location TEXT,
    created_at INTEGER NOT NULL,
    remote_url TEXT,
    author TEXT,
    thread_id TEXT,
    reply_to_comment_id TEXT,
    update_memory INTEGER
);

CREATE INDEX idx_diff_comments_workspace ON diff_comments(workspace_id);
```

### settings

User preferences.

```sql
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

See [settings.md](./settings.md) for all settings.

## Queries

### Sessions by message count
```sql
SELECT s.title, s.model, COUNT(sm.id) as msg_count
FROM sessions s
LEFT JOIN session_messages sm ON s.id = sm.session_id
GROUP BY s.id
ORDER BY msg_count DESC
LIMIT 15;
```

### Workspaces with sessions
```sql
SELECT w.directory_name, s.title, s.model, COUNT(sm.id) as msgs
FROM workspaces w
JOIN sessions s ON s.workspace_id = w.id
LEFT JOIN session_messages sm ON sm.session_id = s.id
GROUP BY s.id
ORDER BY msgs DESC;
```

### Recent active workspaces
```sql
SELECT directory_name, branch, state, created_at
FROM workspaces
WHERE state = 'ready'
ORDER BY created_at DESC;
```
