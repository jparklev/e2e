# Conductor

Workspace and git worktree management tool for AI-assisted development.

## MCP Integration (Debug Builds Only)

The desktop app includes MCP (Model Context Protocol) integration for AI agents to interact with and audit the UI. This is enabled only in debug builds.

**Status: Working**

### Taking Screenshots

The standard MCP `take_screenshot` tool does NOT work on macOS due to WebKit GPU compositing limitations. Use the native `capture_snapshot` command instead:

```javascript
// Via MCP execute_js - wrap in async IIFE
(async () => await window.__TAURI_INTERNALS__.invoke("capture_snapshot"))()
```

This writes a PNG to `/tmp/conductor-snapshot.png` which can then be read with Claude's Read tool.

**Two-step flow for agents:**
1. Execute JS: `(async () => await window.__TAURI_INTERNALS__.invoke("capture_snapshot"))()`
2. Read the file: `/tmp/conductor-snapshot.png`

### Available MCP Tools

When the app is running in dev mode (`npm run tauri dev`), the following MCP tools are available via socket at `/tmp/conductor-mcp.sock`:

- `execute_js` - Run JavaScript in the webview (works!)
- `get_dom` - Get full HTML of the page
- `simulate_mouse_movement` - Click, scroll, move mouse
- `simulate_text_input` - Type text
- `get_element_position` - Find element coordinates
- `manage_window` - Focus, resize, move window
- `manage_local_storage` - Read/write localStorage
- `take_screenshot` - Returns JPEG but **broken on macOS** (use `capture_snapshot` instead)

### Socket Communication

Commands are JSON over Unix socket:
```bash
echo '{"command": "execute_js", "payload": {"code": "document.title", "window_label": "main"}}' | nc -U /tmp/conductor-mcp.sock
```

### Closing the Loop

When developing UI features, agents should:
1. Make changes to the code
2. Wait for hot reload
3. Take a screenshot to verify the change worked
4. Iterate as needed

Example workflow:
```bash
# 1. Make code changes...

# 2. Take screenshot
echo '{"command": "execute_js", "payload": {"code": "(async () => await window.__TAURI_INTERNALS__.invoke(\"capture_snapshot\"))()", "window_label": "main"}}' | nc -U /tmp/conductor-mcp.sock

# 3. View result
# Read /tmp/conductor-snapshot.png
```

### Configuration

- **Socket path**: `/tmp/conductor-mcp.sock`
- **Screenshot path**: `/tmp/conductor-snapshot.png`
- **MCP server config**: `.mcp.json` in project root
- **Window label**: `main`

### Troubleshooting

**Socket already in use**: Remove stale socket file:
```bash
rm -f /tmp/conductor-mcp.sock
```

**execute_js times out**: Make sure `setupPluginListeners()` is called in `main.tsx` (frontend).

**Black screenshots**: Use `capture_snapshot` instead of `take_screenshot` on macOS.
