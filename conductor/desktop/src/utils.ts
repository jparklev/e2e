// =============================================================================
// File Path Utilities
// =============================================================================

export function splitFilePath(path: string) {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", base: path };
  return { dir: path.slice(0, idx), base: path.slice(idx + 1) };
}

// =============================================================================
// Status Utilities
// =============================================================================

export function statusLabel(status: string) {
  const code = status.startsWith("R") ? "R" : status;
  switch (code) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "?": return "untracked";
    default: return status;
  }
}

export function statusClass(status: string) {
  const code = status.startsWith("R") ? "R" : status;
  switch (code) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    default: return "";
  }
}

// =============================================================================
// Action Formatting (Takopi-inspired)
// =============================================================================

export function formatActionKind(kind: string | undefined): string {
  switch (kind) {
    case "command": return "cmd";
    case "file_change": return "files";
    case "web_search": return "search";
    case "subagent": return "agent";
    case "tool": return "tool";
    case "note": return "note";
    case "warning": return "warn";
    case "turn": return "";
    default: return kind ?? "";
  }
}

// =============================================================================
// Storage Utilities
// =============================================================================

export const HOME_STORAGE_KEY = "conductor.home";

export function readStoredHome(): string {
  try {
    return localStorage.getItem(HOME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeHome(value: string) {
  try {
    if (value) {
      localStorage.setItem(HOME_STORAGE_KEY, value);
    } else {
      localStorage.removeItem(HOME_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures
  }
}
