# Conductor MCP Integration

Conductor exposes tools via Model Context Protocol (MCP) for use by Claude and other AI assistants.

## Evidence

MCP tool results found in Claude project cache:
```
~/.claude/projects/.../tool-results/mcp-conductor-GetWorkspaceDiff-*.txt
```

## Known MCP Tools

| Tool | Purpose |
|------|---------|
| `GetWorkspaceDiff` | Get diff of workspace changes |

## Tool Result Locations

MCP tool results are cached in:
```
~/.claude/projects/<project-hash>/<session-uuid>/tool-results/
```

Example files:
```
mcp-conductor-GetWorkspaceDiff-1768117960497.txt
mcp-conductor-GetWorkspaceDiff-1768116640238.txt
mcp-conductor-GetWorkspaceDiff-1767991054834.txt
```

## How It Works

1. Conductor runs as an MCP server
2. Claude Code (or other MCP clients) connects to Conductor
3. Tools like `GetWorkspaceDiff` are exposed
4. Results are cached for the session

## Integration with Claude

When Claude is running inside a Conductor workspace:
- Has access to workspace-aware tools
- Can query diffs, file changes
- Workspace context is provided automatically

## Workspace Context

The MCP server likely provides:
- Current workspace name
- Branch information
- Checkpoint state
- Session context
