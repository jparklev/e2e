import { useMemo, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { ChatMessage } from "../types";

// Tool metadata for registry-based rendering
export type ToolMeta = {
  icon: string;
  label: (detail?: Record<string, unknown>) => string;
  subtitle?: (detail?: Record<string, unknown>) => string | null;
  variant: "simple" | "expandable";
  renderExpanded?: (msg: ChatMessage) => React.ReactNode;
};

// Diff options for inline diffs
const diffOptions = {
  diffStyle: "unified",
  diffIndicators: "bars",
  overflow: "wrap",
  disableBackground: true,
  themeType: "light",
} as const;

// Helper to safely convert unknown to string
function safeString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

// Build diff patch for Edit operations
function buildEditPatch(detail?: Record<string, unknown>): string | null {
  const toolInput = detail?.input as Record<string, unknown> | undefined;
  const oldString = toolInput?.old_string as string | undefined;
  const newString = toolInput?.new_string as string | undefined;
  const filePath = toolInput?.file_path as string | undefined;
  if (!oldString || !newString || !filePath) return null;
  const fileName = filePath.split("/").pop() || "file";
  return `--- a/${fileName}\n+++ b/${fileName}\n@@ -1,${oldString.split("\n").length} +1,${newString.split("\n").length} @@\n${oldString.split("\n").map(l => `-${l}`).join("\n")}\n${newString.split("\n").map(l => `+${l}`).join("\n")}`;
}

// Build new file patch for Write operations
function buildWritePatch(detail?: Record<string, unknown>): string | null {
  const toolInput = detail?.input as Record<string, unknown> | undefined;
  const fileContent = toolInput?.content as string | undefined;
  const filePath = toolInput?.file_path as string | undefined;
  if (!fileContent || !filePath) return null;
  const fileName = filePath.split("/").pop() || "file";
  const lines = fileContent.split("\n");
  return `--- /dev/null\n+++ b/${fileName}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join("\n")}`;
}

// The tool registry - metadata-driven rendering
export const TOOL_REGISTRY: Record<string, ToolMeta> = {
  command: {
    icon: "⌘",
    label: () => "CMD",
    subtitle: (detail) => safeString(detail?.command).slice(0, 60) || null,
    variant: "expandable",
    renderExpanded: (msg) => {
      const detail = msg.actionDetail;
      const result = safeString(detail?.result_preview);
      if (!result) return null;
      return (
        <div className="action-result mono">
          <pre>{result.slice(0, 500)}{result.length > 500 ? "..." : ""}</pre>
        </div>
      );
    },
  },
  file_change_write: {
    icon: "📝",
    label: () => "WRITE",
    subtitle: (detail) => {
      const input = detail?.input as Record<string, unknown> | undefined;
      return input?.file_path as string | null;
    },
    variant: "expandable",
    renderExpanded: (msg) => {
      const patch = buildWritePatch(msg.actionDetail);
      if (!patch) return null;
      return (
        <div className="action-diff">
          <PatchDiff patch={patch} options={diffOptions} />
        </div>
      );
    },
  },
  file_change_edit: {
    icon: "✏️",
    label: () => "EDIT",
    subtitle: (detail) => {
      const input = detail?.input as Record<string, unknown> | undefined;
      return input?.file_path as string | null;
    },
    variant: "expandable",
    renderExpanded: (msg) => {
      const patch = buildEditPatch(msg.actionDetail);
      if (!patch) return null;
      return (
        <div className="action-diff">
          <PatchDiff patch={patch} options={diffOptions} />
        </div>
      );
    },
  },
  file_change_read: {
    icon: "📖",
    label: () => "READ",
    subtitle: (detail) => {
      const input = detail?.input as Record<string, unknown> | undefined;
      return input?.file_path as string | null;
    },
    variant: "simple",
  },
  file_change: {
    icon: "📄",
    label: () => "FILE",
    subtitle: () => null,
    variant: "simple",
  },
  web_search: {
    icon: "🔍",
    label: () => "SEARCH",
    subtitle: (detail) => safeString(detail?.query).slice(0, 50) || null,
    variant: "expandable",
    renderExpanded: (msg) => {
      const result = safeString(msg.actionDetail?.result_preview);
      if (!result) return null;
      return (
        <div className="action-result mono">
          <pre>{result.slice(0, 500)}{result.length > 500 ? "..." : ""}</pre>
        </div>
      );
    },
  },
  subagent: {
    icon: "🤖",
    label: () => "AGENT",
    subtitle: (detail) => safeString(detail?.name) || null,
    variant: "simple",
  },
  tool: {
    icon: "🔧",
    label: () => "TOOL",
    subtitle: (detail) => safeString(detail?.name) || null,
    variant: "simple",
  },
  note: {
    icon: "💭",
    label: () => "NOTE",
    subtitle: () => null,
    variant: "expandable",
    renderExpanded: (msg) => {
      const thinking = safeString(msg.actionDetail?.thinking);
      if (!thinking) return null;
      return (
        <div className="action-thinking">
          <pre className="thinking-content">{thinking}</pre>
        </div>
      );
    },
  },
  warning: {
    icon: "⚠️",
    label: () => "WARN",
    subtitle: () => null,
    variant: "simple",
  },
  todo: {
    icon: "☑",
    label: () => "TODO",
    subtitle: (detail) => {
      const todos = detail?.todos as Array<{ status?: string }> | undefined;
      if (!todos) return null;
      const done = todos.filter(t => t.status === "completed").length;
      return `${done}/${todos.length} done`;
    },
    variant: "expandable",
    renderExpanded: (msg) => {
      const todos = msg.actionDetail?.todos as Array<{ content?: string; activeForm?: string; status?: string }> | undefined;
      if (!todos) return null;
      return (
        <div className="action-todos">
          {todos.map((todo, i) => (
            <div key={i} className={`todo-item ${todo.status ?? "pending"}`}>
              <span className="todo-checkbox">
                {todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "◐" : "☐"}
              </span>
              <span className="todo-text">{todo.activeForm || todo.content}</span>
            </div>
          ))}
        </div>
      );
    },
  },
};

// Get the registry key for a message
export function getToolKey(msg: ChatMessage): string {
  const kind = msg.actionKind ?? "tool";
  if (kind === "file_change") {
    const toolName = (msg.actionDetail?.name as string)?.toLowerCase();
    if (toolName === "write") return "file_change_write";
    if (toolName === "edit") return "file_change_edit";
    if (toolName === "read") return "file_change_read";
    return "file_change";
  }
  return kind;
}

// Get tool meta for a message
export function getToolMeta(msg: ChatMessage): ToolMeta {
  const key = getToolKey(msg);
  return TOOL_REGISTRY[key] ?? TOOL_REGISTRY.tool;
}

// Status icons
export const STATUS_ICONS: Record<string, string> = {
  running: "▸",
  update: "↻",
  done: "✓",
  fail: "✗",
};

// ActionMessage component using the registry
export function ActionMessage({ msg, workspacePath }: { msg: ChatMessage; workspacePath?: string }) {
  const [expanded, setExpanded] = useState(false);
  const meta = getToolMeta(msg);

  // Abbreviate paths relative to workspace
  const displayContent = useMemo(() => {
    if (!workspacePath) return msg.content;
    const wsPath = workspacePath.endsWith("/") ? workspacePath.slice(0, -1) : workspacePath;
    if (msg.content.startsWith(wsPath + "/")) return msg.content.slice(wsPath.length + 1);
    if (msg.content.startsWith(wsPath)) return msg.content.slice(wsPath.length);
    return msg.content;
  }, [msg.content, workspacePath]);

  // Status icon
  let statusIcon = STATUS_ICONS.running;
  if (msg.actionPhase === "completed") {
    statusIcon = msg.ok === false ? STATUS_ICONS.fail : STATUS_ICONS.done;
  } else if (msg.actionPhase === "updated") {
    statusIcon = STATUS_ICONS.update;
  }

  const subtitle = meta.subtitle?.(msg.actionDetail);
  const hasExpandable = meta.variant === "expandable" && meta.renderExpanded;

  return (
    <div className={`chat-message action ${msg.actionPhase ?? "started"}${msg.ok === false ? " error" : ""}`}>
      <div className="action-header" onClick={() => hasExpandable && setExpanded(!expanded)}>
        <span className={`action-status ${msg.actionPhase ?? "started"}`}>{statusIcon}</span>
        <span className="action-icon">{meta.icon}</span>
        <span className="action-kind">{meta.label(msg.actionDetail)}</span>
        <span className="chat-content">{displayContent}</span>
        {subtitle && <span className="action-subtitle">{subtitle}</span>}
        {hasExpandable && (
          <span className={`action-expand${expanded ? " open" : ""}`}>▾</span>
        )}
      </div>
      {expanded && hasExpandable && meta.renderExpanded?.(msg)}
    </div>
  );
}
