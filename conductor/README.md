# Conductor

A Tauri desktop application for AI-assisted development. Manages workspaces, git checkpoints, and multi-model AI sessions.

**Version**: 0.29.5
**Bundle ID**: `com.conductor.app`
**Install Location**: `/Applications/Conductor.app`

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Conductor Desktop App                     │
│                      (Tauri + React)                         │
├─────────────────────────────────────────────────────────────┤
│  Workspaces          │  Sessions           │  Checkpoints   │
│  (city-named)        │  (Claude/GPT)       │  (git refs)    │
├──────────────────────┴─────────────────────┴────────────────┤
│                      SQLite Database                         │
│            ~/Library/Application Support/com.conductor.app/  │
├─────────────────────────────────────────────────────────────┤
│                    Bundled CLI Tools                         │
│  claude │ codex │ gh │ node │ watchexec │ checkpointer      │
└─────────────────────────────────────────────────────────────┘
```

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Repo** | A git repository registered with Conductor |
| **Workspace** | A city-named task context with its own branch |
| **Session** | An AI conversation (Claude or GPT) within a workspace |
| **Checkpoint** | Git-based snapshot of full working tree state |

## Multi-Model Strategy

| Task | Model | Usage |
|------|-------|-------|
| Coding | `opus` | Primary development work |
| Code Review | `gpt-5.2` | Security audits, PR review |
| Research | `gemini-3-flash` | Online search, API lookups |

## Key Paths

| What | Path |
|------|------|
| Application | `/Applications/Conductor.app` |
| Database | `~/Library/Application Support/com.conductor.app/conductor.db` |
| Workspaces | `~/conductor/workspaces/` |
| Repos | `~/conductor/repos/` |
| Bundled tools | `/Applications/Conductor.app/Contents/Resources/bin/` |

## Bundled Tools

| Binary | Size | Purpose |
|--------|------|---------|
| `claude` | 178 MB | Anthropic Claude CLI |
| `codex` | 42 MB | OpenAI Codex CLI |
| `gh` | 53 MB | GitHub CLI |
| `node` | 111 MB | Node.js runtime |
| `watchexec` | 7 MB | File watcher |
| `checkpointer.sh` | 8 KB | Git checkpoint manager |
| `spotlighter.sh` | 4 KB | Live file sync |

## Documentation

- [Database Schema](./database.md) - SQLite tables and relationships
- [Scripts](./scripts.md) - checkpointer.sh and spotlighter.sh
- [Workspaces](./workspaces.md) - How workspaces are managed
- [Sessions](./sessions.md) - AI session management
- [Settings](./settings.md) - Configuration options
