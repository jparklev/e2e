# Conductor Workspaces

Workspaces are city-named task contexts. Each workspace has its own branch and can contain multiple AI sessions.

## Directory Structure

```
~/conductor/
├── repos/                    # Cloned repositories
│   └── aphelion-app-fork/
├── workspaces/               # Active workspaces
│   ├── 2025-12-25-aphelion/
│   │   ├── amarillo/         # Workspace directory
│   │   ├── tehran/
│   │   └── copenhagen/
│   └── personal-assistant/
└── ...
```

## Workspace States

| State | Description |
|-------|-------------|
| `active` | Currently being worked on |
| `ready` | Set up and ready for work |
| `archived` | Completed or abandoned |

## Workspace Lifecycle

1. **Creation**: New workspace created with city name
2. **Initialization**: Branch created (e.g., `jparklev/victoria`)
3. **Active**: Sessions attached, work in progress
4. **Archived**: Work completed, branch may be merged

## Example Workspaces

| Name | Branch | State | Purpose |
|------|--------|-------|---------|
| victoria | jparklev/victoria | ready | Current work |
| copenhagen | jparklev/copenhagen | ready | System auditing |
| amarillo | jparklev/amarillo | archived | Smart contract implementation |
| tehran | jparklev/tehran | archived | AA for Safe exploration |
| bandung | jparklev/bandung | archived | Feedback and refactoring |

## Workspace Features

### Linked Workspaces
Workspaces can be linked via `linked_workspace_ids` for related tasks.

### Notes
Each workspace can have freeform notes stored in the `notes` field.

### Big Terminal Mode
Toggle for expanded terminal view (`big_terminal_mode`).

### Pinning
Workspaces can be pinned with `pinned_at` timestamp.

## Active Workspaces Query

```sql
SELECT
    directory_name,
    branch,
    state,
    created_at,
    notes
FROM workspaces
WHERE state IN ('active', 'ready')
ORDER BY created_at DESC;
```

## Workspace with Sessions

```sql
SELECT
    w.directory_name,
    w.branch,
    s.title,
    s.model,
    COUNT(sm.id) as message_count
FROM workspaces w
JOIN sessions s ON s.workspace_id = w.id
LEFT JOIN session_messages sm ON sm.session_id = s.id
GROUP BY s.id
ORDER BY message_count DESC;
```

## Top Workspaces by Activity

Based on session message counts:

| Workspace | Session | Model | Messages |
|-----------|---------|-------|----------|
| amarillo | Implement smart contract | gpt-5.2 | 3,106 |
| bandung | Address feedback | opus | 1,630 |
| bandung | Refactoring Tauri | gpt-5.2 | 1,267 |
| managua | Notebook verification | gpt-5.2 | 1,228 |
| lincoln | Provision VPS | opus | 778 |
| tehran | AA for Safe | gpt-5.2 | 773 |
| almaty | Health assistant | opus | 771 |
