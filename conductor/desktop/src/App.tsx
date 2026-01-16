import { PatchDiff } from "@pierre/diffs/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import Fuse from "fuse.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { codeToHtml } from "shiki";
import "./App.css";
import { ActionMessage } from "./lib/tool-registry";
import { CommandPalette } from "./components/CommandPalette";
import {
  useRepos,
  useWorkspaces,
  useWorkspaceFiles,
  useWorkspaceChanges,
  useFileDiff,
  useFileContent,
  useAddRepo,
  useCreateWorkspace,
  useSession,
  useChat,
  useUpsertResumeId,
  useAppendChat,
} from "./lib/hooks";
import { parseChatMd } from "./lib/chat-parser";
import { Terminal } from "./components/Terminal";
import { queryKeys } from "./lib/query";

// Play a gentle bell notification sound when agent completes
function playNotificationSound() {
  try {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Gentle bell-like sound: high frequency, quick decay
    oscillator.frequency.setValueAtTime(830, audioContext.currentTime); // E5 note
    oscillator.type = "sine";

    // Soft volume with quick fade
    gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);
  } catch {
    // Audio not available, silently ignore
  }
}

// =============================================================================
// Types
// =============================================================================

type Repo = {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  remote_url?: string | null;
};

type Workspace = {
  id: string;
  repo_id: string;
  repo: string;
  name: string;
  branch: string;
  base_branch: string;
  state: string;
  path: string;
};

type WorkspaceChange = {
  old_path?: string | null;
  path: string;
  status: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "action";
  content: string;
  meta?: string;
  actionKind?: string;
  actionPhase?: string;
  actionId?: string;
  actionDetail?: Record<string, unknown>;
  ok?: boolean;
};

type ActionState = {
  id: string;
  kind: string;
  title: string;
  phase: "started" | "updated" | "completed";
  ok?: boolean;
  firstSeen: number;
  detail?: Record<string, unknown>;
};

type AgentEvent = {
  type: string;
  engine?: string;
  phase?: string;
  ok?: boolean;
  text?: string;
  answer?: string;
  error?: string;
  resume?: string;
  action?: {
    id: string;
    kind: string;
    title: string;
    detail?: Record<string, unknown>;
  };
};

type Agent = {
  id: string;
  name: string;
  description: string;
};

const AGENTS: Agent[] = [
  { id: "claude-code", name: "Claude Code", description: "Full development assistant" },
  { id: "codex", name: "Codex", description: "OpenAI Codex agent" },
  { id: "gemini", name: "Gemini", description: "Google Gemini" },
];

// formatActionKind and helpers moved to ./lib/tool-registry

// ActionMessage is now imported from ./lib/tool-registry

// ChatInput with @ file autocomplete, auto-expand, and integrated send/stop button
function ChatInput({
  value, onChange, onSend, onStop, placeholder, disabled, running, files,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  placeholder: string;
  disabled: boolean;
  running: boolean;
  files: string[];
}) {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  }, [value]);

  // Create Fuse instance for fuzzy search
  const fuse = useMemo(() => new Fuse(files, {
    threshold: 0.4,
    distance: 100,
    includeScore: true,
  }), [files]);

  // Get search results
  const results = useMemo(() => {
    if (!autocompleteQuery) return files.slice(0, 10);
    return fuse.search(autocompleteQuery).slice(0, 10).map(r => r.item);
  }, [fuse, files, autocompleteQuery]);

  // Handle text change and detect @ mentions
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const pos = e.target.selectionStart;
    onChange(newValue);
    setCursorPos(pos);

    // Check if we're in an @ mention context
    const textBeforeCursor = newValue.slice(0, pos);
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);

    if (atMatch) {
      setAutocompleteQuery(atMatch[1]);
      setShowAutocomplete(true);
      setSelectedIndex(0);
    } else {
      setShowAutocomplete(false);
      setAutocompleteQuery("");
    }
  };

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showAutocomplete && results.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex(i => Math.min(i + 1, results.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        selectFile(results[selectedIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowAutocomplete(false);
        return;
      }
    }

    // Normal Enter to send (without autocomplete)
    // Allow sending even when running (will be queued)
    if (e.key === "Enter" && !e.shiftKey && !showAutocomplete) {
      e.preventDefault();
      if (value.trim() && !disabled) onSend();
    }
  };

  const canSend = value.trim() && !disabled;
  const showButton = canSend || running;

  // Select a file from autocomplete
  const selectFile = (file: string) => {
    const textBeforeCursor = value.slice(0, cursorPos);
    const textAfterCursor = value.slice(cursorPos);
    const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);

    if (atMatch) {
      const beforeAt = textBeforeCursor.slice(0, atMatch.index);
      const newValue = `${beforeAt}@${file} ${textAfterCursor}`;
      onChange(newValue);
      setShowAutocomplete(false);
      setAutocompleteQuery("");

      // Focus back on textarea
      setTimeout(() => {
        if (textareaRef.current) {
          const newPos = beforeAt.length + 1 + file.length + 1;
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newPos, newPos);
        }
      }, 0);
    }
  };

  return (
    <div className="chat-input-wrapper">
      <textarea
        ref={textareaRef}
        className="input textarea"
        placeholder={placeholder}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        disabled={disabled}
      />
      {showAutocomplete && results.length > 0 && (
        <div className="autocomplete-dropdown">
          {results.map((file, i) => {
            const parts = file.split("/");
            const fileName = parts.pop() || file;
            const dirPath = parts.join("/");
            return (
              <button
                key={file}
                className={`autocomplete-item${i === selectedIndex ? " selected" : ""}`}
                onClick={() => selectFile(file)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <span className="autocomplete-name">{fileName}</span>
                {dirPath && <span className="autocomplete-path">{dirPath}/</span>}
              </button>
            );
          })}
        </div>
      )}
      {/* Integrated send/stop button */}
      {showButton && (
        <button
          className={`input-action-btn ${running ? "stop" : "send"}`}
          onClick={running ? onStop : onSend}
          disabled={!running && !canSend}
          title={running ? "Stop (Esc)" : "Send (Enter)"}
        >
          {running ? "■" : "↑"}
        </button>
      )}
    </div>
  );
}

type AgentTab = {
  id: string;
  agentId: string;
  name: string;
  messages: ChatMessage[];
  sessionId?: string;
  resumeId?: string; // Claude session ID for --resume
  running?: boolean;
  startTime?: number; // Timestamp when agent started (for elapsed time)
  actions: Map<string, ActionState>;
};

// Hook for elapsed time display (Takopi pattern)
function useElapsedTime(startTime: number | undefined, running: boolean): string {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running || !startTime) { setElapsed(0); return; }
    const interval = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 100);
    return () => clearInterval(interval);
  }, [running, startTime]);
  if (!running || elapsed === 0) return "";
  const secs = elapsed / 1000;
  return secs < 60 ? `${secs.toFixed(1)}s` : `${Math.floor(secs / 60)}m ${(secs % 60).toFixed(0)}s`;
}

// =============================================================================
// Tauri API Helpers
// =============================================================================

const HOME_STORAGE_KEY = "conductor.home";

function readStoredHome(): string {
  try {
    return localStorage.getItem(HOME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeHome(value: string) {
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

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof invoke !== "function") {
    throw new Error("Tauri not available - are you running in the Tauri window?");
  }
  return await invoke<T>(cmd, args);
}

// =============================================================================
// Utility Functions
// =============================================================================

function splitFilePath(path: string) {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", base: path };
  return { dir: path.slice(0, idx), base: path.slice(idx + 1) };
}

function statusLabel(status: string) {
  const code = status.startsWith("R") ? "R" : status;
  switch (code) {
    case "A": return "added";
    case "D": return "deleted";
    case "M": return "modified";
    case "R": return "renamed";
    case "?": return "new";
    default: return status;
  }
}

function statusClass(status: string) {
  const code = status[0]?.toLowerCase();
  if (code === "a" || code === "?") return "status added";
  if (code === "d") return "status deleted";
  if (code === "r") return "status renamed";
  return "status modified";
}

function getLangFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    css: "css", scss: "scss", less: "less", html: "html",
    json: "json", md: "markdown", py: "python", rs: "rust",
    go: "go", sh: "bash", bash: "bash", zsh: "bash",
    yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql",
  };
  return langMap[ext] ?? "plaintext";
}

const diffOptions = {
  diffStyle: "unified",
  diffIndicators: "bars",
  overflow: "wrap",
  disableBackground: true,
  themeType: "light",
} as const;

// =============================================================================
// Components
// =============================================================================

function CodePreview({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    codeToHtml(code, { lang: lang || "plaintext", theme: "github-light" })
      .then((result) => { if (!cancelled) { setHtml(result); setLoading(false); } })
      .catch(() => { if (!cancelled) { setHtml(""); setLoading(false); } });
    return () => { cancelled = true; };
  }, [code, lang]);

  if (loading) return <div className="muted">Loading preview...</div>;
  if (!html) return <pre className="file-content">{code}</pre>;
  return <div className="code-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ResizeHandle({ onResize, direction }: { onResize: (delta: number) => void; direction: "left" | "right" }) {
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = direction === "right" ? moveEvent.clientX - startX : startX - moveEvent.clientX;
      onResize(delta);
    };
    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [onResize, direction]);

  return <div className="resize-handle" onMouseDown={handleMouseDown} />;
}

type OpenGroup = { repoId: string; repoName: string; workspaces: Workspace[] };

function Rail({
  repos, workspaces, openWorkspaceIds, activeWorkspaceId, loading, repoAdding,
  homeDraft, homeResolved, homeDirty, filter, creating, createError, repoUrl, repoError,
  collapsedRepoIds, workspacesByRepo, filteredWorkspaces, repoUrlInputRef, showHomePopover,
  onHomeDraftChange, onApplyHome, onRefresh, onFilterChange, onCreateWorkspaceForRepo,
  onRepoUrlChange, onAddRepo, onToggleRepo, onOpenWorkspace, onToggleHomePopover,
}: {
  repos: Repo[]; workspaces: Workspace[]; openWorkspaceIds: string[];
  activeWorkspaceId: string | null; loading: boolean; repoAdding: boolean;
  homeDraft: string; homeResolved: string; homeDirty: boolean; filter: string;
  creating: boolean; createError: string | null; repoUrl: string; repoError: string | null;
  collapsedRepoIds: Set<string>; workspacesByRepo: Map<string, Workspace[]>;
  filteredWorkspaces: Workspace[]; repoUrlInputRef: React.RefObject<HTMLInputElement | null>;
  showHomePopover: boolean;
  onHomeDraftChange: (v: string) => void; onApplyHome: () => void; onRefresh: () => void;
  onFilterChange: (v: string) => void; onCreateWorkspaceForRepo: (id: string) => void;
  onRepoUrlChange: (v: string) => void; onAddRepo: () => void;
  onToggleRepo: (id: string) => void; onOpenWorkspace: (id: string) => void;
  onToggleHomePopover: () => void;
}) {
  return (
    <aside className="rail">
      <div className="brand">
        <div>
          <div className="brand-title">Conductor</div>
          <div className="brand-sub">{repos.length} repos · {workspaces.length} workspaces</div>
        </div>
      </div>

      <div className="card grow">
        <div className="card-row">
          <div className="card-title">Workspaces</div>
          <input className="input small" placeholder="Filter..." value={filter}
            onChange={(e) => onFilterChange(e.currentTarget.value)} style={{ width: 100 }} />
        </div>
        <div className="repo-list">
          {repos.map((repo) => {
            const repoWorkspaces = workspacesByRepo.get(repo.id) ?? [];
            if (filter && repoWorkspaces.length === 0) return null;
            const isCollapsed = collapsedRepoIds.has(repo.id);
            return (
              <div key={repo.id} className="repo-group">
                <div className="repo-header-row">
                  <button className="repo-header" onClick={() => onToggleRepo(repo.id)}>
                    <div>
                      <div className="repo-title">{repo.name}</div>
                      <div className="repo-meta">{repoWorkspaces.length} workspaces</div>
                    </div>
                    <span className={`repo-toggle${isCollapsed ? " collapsed" : ""}`}>▾</span>
                  </button>
                  <button className="btn ghost small repo-add" onClick={() => onCreateWorkspaceForRepo(repo.id)}
                    disabled={creating || repoAdding} title="New workspace">+</button>
                </div>
                {!isCollapsed && (
                  <div className="workspace-list">
                    {repoWorkspaces.map((ws) => {
                      const isOpen = openWorkspaceIds.includes(ws.id);
                      const isActive = ws.id === activeWorkspaceId;
                      return (
                        <button key={ws.id} className={`workspace-item${isActive ? " active" : ""}`}
                          onClick={() => onOpenWorkspace(ws.id)}>
                          <div className="workspace-row">
                            <span className="workspace-name">{ws.name}</span>
                            {isActive && <span className="badge active">Active</span>}
                            {!isActive && isOpen && <span className="badge open">Open</span>}
                          </div>
                          <div className="workspace-meta">
                            <span>{ws.branch}</span><span className="sep">·</span><span>{ws.state}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {createError && <div className="inline-error" style={{ paddingLeft: 12 }}>{createError}</div>}
              </div>
            );
          })}
          {!repos.length && <div className="muted">Add a repo below to get started.</div>}
          {repos.length > 0 && filter && filteredWorkspaces.length === 0 && (
            <div className="muted">No matches for "{filter}"</div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Add repo</div>
        <div className="repo-url-row">
          <input ref={repoUrlInputRef} className="input small" placeholder="https://github.com/org/repo" value={repoUrl}
            disabled={repoAdding} onChange={(e) => onRepoUrlChange(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAddRepo(); } }} />
          <button className="btn primary small" onClick={onAddRepo} disabled={repoAdding}>
            {repoAdding ? "..." : "Add"}
          </button>
        </div>
        {repoError && <div className="inline-error">{repoError}</div>}
      </div>

      <div className="rail-footer">
        <div className="rail-footer-left">
          {homeResolved && <span className="home-path-hint mono" title={homeResolved}>{homeResolved}</span>}
        </div>
        <div className="rail-footer-actions">
          <button className="btn ghost small" onClick={onRefresh} disabled={loading || repoAdding} title="Refresh">
            {loading ? "..." : "↻"}
          </button>
          <div className="home-popover-container">
            <button className={`btn ghost small${showHomePopover ? " active" : ""}`} onClick={onToggleHomePopover} title="Settings">
              ⚙
            </button>
            {showHomePopover && (
              <div className="home-popover">
                <div className="home-popover-header">
                  <span className="home-popover-title">Home Directory</span>
                </div>
                <div className="home-popover-body">
                  <input className="input small" placeholder="~/conductor" value={homeDraft}
                    onChange={(e) => onHomeDraftChange(e.currentTarget.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onApplyHome(); onToggleHomePopover(); } }} />
                  <button className="btn primary small" onClick={() => { onApplyHome(); onToggleHomePopover(); }} disabled={!homeDirty || loading}>
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function TabsHeader({ openGroups, activeWorkspaceId, canPrev, canNext, onActivate, onClose, onPrev, onNext }: {
  openGroups: OpenGroup[]; activeWorkspaceId: string | null;
  canPrev: boolean; canNext: boolean;
  onActivate: (id: string) => void; onClose: (id: string) => void;
  onPrev: () => void; onNext: () => void;
}) {
  return (
    <header className="tabs-header">
      <div className="tabs">
        {openGroups.map((group) => (
          <div key={group.repoId} className="tab-group">
            <span className="tab-group-title">{group.repoName}</span>
            <div className="tab-group-list">
              {group.workspaces.map((ws) => (
                <div key={ws.id} className={`tab-pill${ws.id === activeWorkspaceId ? " active" : ""}`}>
                  <button className="tab-hit" onClick={() => onActivate(ws.id)}>
                    <span className="tab-title">{ws.name}</span>
                  </button>
                  <button className="tab-close" onClick={() => onClose(ws.id)} aria-label={`Close ${ws.name}`}>×</button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!openGroups.length && <span className="tab-empty">Open a workspace to start</span>}
      </div>
      <div className="tab-actions">
        <button className="btn ghost small" onClick={onPrev} disabled={!canPrev} title="Previous">←</button>
        <button className="btn ghost small" onClick={onNext} disabled={!canNext} title="Next">→</button>
      </div>
    </header>
  );
}

function WelcomeHero({ hasRepos, onAddRepoFocus }: { hasRepos: boolean; onAddRepoFocus: () => void }) {
  return (
    <div className="welcome-hero">
      <div className="welcome-content">
        <h1 className="welcome-title">Welcome to Conductor</h1>
        <p className="welcome-subtitle">
          {hasRepos
            ? "Select a workspace from the sidebar to get started, or create a new one."
            : "Manage your AI-assisted development workspaces in one place."}
        </p>
        <div className="welcome-actions">
          {!hasRepos && (
            <button className="btn primary welcome-btn" onClick={onAddRepoFocus}>
              Add your first repository
            </button>
          )}
          <a
            href="https://github.com/your-org/conductor"
            target="_blank"
            rel="noopener noreferrer"
            className="btn welcome-btn"
          >
            Open Documentation
          </a>
        </div>
        <div className="welcome-hints">
          <div className="welcome-hint">
            <span className="welcome-hint-icon">+</span>
            <span>Click the + button on any repo to create a workspace</span>
          </div>
          <div className="welcome-hint">
            <span className="welcome-hint-icon">@</span>
            <span>Use @ mentions in chat to reference files</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspacePanel({ activeWorkspace }: { activeWorkspace: Workspace | null }) {
  return (
    <div className="panel-card primary">
      {activeWorkspace ? (
        <>
          <div className="card-row">
            <div>
              <div className="panel-title">{activeWorkspace.name}</div>
              <div className="panel-route">{activeWorkspace.repo} / {activeWorkspace.branch}</div>
            </div>
            <div className="chip-row">
              <span className="chip">{activeWorkspace.state}</span>
              <span className="chip">← {activeWorkspace.base_branch}</span>
            </div>
          </div>
          <div className="panel-item">
            <span className="panel-label">Path</span>
            <span className="mono">{activeWorkspace.path}</span>
          </div>
        </>
      ) : (
        <div className="panel-empty">Select a workspace</div>
      )}
    </div>
  );
}

function ChatPanel({
  activeWorkspace, tabs, activeTabId, chatDraft, running, startTime, files,
  onTabChange, onTabClose, onTabAdd, onAgentChange, onDraftChange, onSend, onStop, chatEndRef,
}: {
  activeWorkspace: Workspace | null;
  tabs: AgentTab[]; activeTabId: string | null; chatDraft: string; running: boolean;
  startTime?: number; files: string[];
  onTabChange: (id: string) => void; onTabClose: (id: string) => void;
  onTabAdd: () => void; onAgentChange: (id: string) => void;
  onDraftChange: (v: string) => void; onSend: () => void; onStop: () => void;
  chatEndRef: { current: HTMLDivElement | null };
}) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeAgent = AGENTS.find((a) => a.id === activeTab?.agentId) ?? AGENTS[0];
  const elapsedTime = useElapsedTime(startTime, running);

  return (
    <div className="panel-card chat">
      <div className="agent-tabs">
        <div className="agent-tabs-list">
          {tabs.map((tab) => {
            const agent = AGENTS.find((a) => a.id === tab.agentId) ?? AGENTS[0];
            const isActive = tab.id === activeTabId;
            return (
              <div key={tab.id} className={`agent-tab${isActive ? " active" : ""}${tab.running ? " running" : ""}`}>
                <button className="agent-tab-btn" onClick={() => onTabChange(tab.id)}>
                  <span className="agent-tab-name">{agent.name}</span>
                  {tab.messages.length > 0 && <span className="agent-tab-count">{tab.messages.length}</span>}
                  {tab.running && <span className="agent-tab-spinner">●</span>}
                </button>
                {tabs.length > 1 && (
                  <button className="agent-tab-close" onClick={(e) => { e.stopPropagation(); onTabClose(tab.id); }}>×</button>
                )}
              </div>
            );
          })}
          <button className="btn ghost small agent-tab-add" onClick={onTabAdd} disabled={!activeWorkspace}>+</button>
        </div>
        <div className="status-area">
          {running && elapsedTime && <span className="elapsed-time">{elapsedTime}</span>}
          <span className={`badge${running ? " running" : ""}`}>{running ? "Running" : "Ready"}</span>
        </div>
      </div>

      <div className="chat-body">
        {activeTab && activeTab.messages.length ? (
          activeTab.messages.map((msg) => {
            if (msg.role === "action") {
              return <ActionMessage key={msg.id} msg={msg} workspacePath={activeWorkspace?.path} />;
            }
            return (
              <div key={msg.id} className={`chat-message ${msg.role}${msg.meta === "queued" ? " queued" : ""}`}>
                <span className="chat-meta">{msg.meta === "queued" ? "you" : msg.meta}</span>
                <span className="chat-content">{msg.content}</span>
              </div>
            );
          })
        ) : (
          <div className="muted">Send a message to start</div>
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="chat-input">
        <div className="chat-input-row">
          <select className="agent-picker" value={activeTab?.agentId ?? "claude-code"}
            onChange={(e) => onAgentChange(e.currentTarget.value)} disabled={!activeWorkspace || !activeTab || running}>
            {AGENTS.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
          <ChatInput
            value={chatDraft}
            onChange={onDraftChange}
            onSend={onSend}
            onStop={onStop}
            placeholder={!activeWorkspace ? "Select workspace" : `Message ${activeAgent.name}... (@ for files)`}
            disabled={!activeWorkspace || !activeTab}
            running={running}
            files={files}
          />
        </div>
      </div>
    </div>
  );
}

function FilesPanel({
  activeWorkspace, files, changes, filteredChanges, filteredAllFiles, filesLoading,
  fileFilter, showAllFiles, selectedFile, fileError, fileDiff, fileContent, fileViewLoading,
  onFileFilterChange, onToggleShowAll, onSelectFile,
}: {
  activeWorkspace: Workspace | null; files: string[]; changes: WorkspaceChange[];
  filteredChanges: WorkspaceChange[]; filteredAllFiles: string[];
  filesLoading: boolean; fileFilter: string; showAllFiles: boolean;
  selectedFile: string | null; fileError: string | null;
  fileDiff: string | null; fileContent: string | null; fileViewLoading: boolean;
  onFileFilterChange: (v: string) => void; onToggleShowAll: () => void; onSelectFile: (p: string) => void;
}) {
  return (
    <aside className="files-panel">
      <div className="panel-card">
        <div className="card-row">
          <span className="card-title">Files</span>
          <span className="card-meta">{activeWorkspace ? `${changes.length} changed` : "—"}</span>
        </div>
        <div className="file-controls">
          <input className="input small" placeholder="Filter..." value={fileFilter}
            onChange={(e) => onFileFilterChange(e.currentTarget.value)} disabled={!activeWorkspace || filesLoading} />
          <button className="btn ghost small" onClick={onToggleShowAll}
            disabled={!activeWorkspace || filesLoading || files.length === 0}>
            {showAllFiles ? "Changed" : "All"}
          </button>
        </div>
        <div className="file-list">
          {!activeWorkspace && <div className="muted">Select workspace</div>}
          {activeWorkspace && filesLoading && <div className="muted">Loading...</div>}
          {activeWorkspace && !filesLoading && files.length === 0 && <div className="muted">No files</div>}
          {activeWorkspace && !filesLoading && files.length > 0 && (
            <>
              {filteredChanges.length > 0 && (
                <div className="file-section">
                  <div className="file-section-title">Changed ({filteredChanges.length})</div>
                  {filteredChanges.map((change) => {
                    const { dir, base } = splitFilePath(change.path);
                    const isActive = change.path === selectedFile;
                    return (
                      <button key={change.path} className={`file-item${isActive ? " active" : ""}`}
                        onClick={() => onSelectFile(change.path)}>
                        <div className="file-main">
                          <span className="file-path">
                            {dir && <span className="file-dir">{dir}/</span>}
                            <span className="file-name">{base}</span>
                          </span>
                          {change.old_path && <span className="file-rename">← {change.old_path}</span>}
                        </div>
                        <span className={`file-status ${statusClass(change.status)}`} title={statusLabel(change.status)}>
                          {statusLabel(change.status)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showAllFiles && filteredAllFiles.length > 0 && (
                <div className="file-section">
                  <div className="file-section-title">All ({filteredAllFiles.length})</div>
                  {filteredAllFiles.map((file) => {
                    const { dir, base } = splitFilePath(file);
                    const isActive = file === selectedFile;
                    return (
                      <button key={file} className={`file-item${isActive ? " active" : ""}`}
                        onClick={() => onSelectFile(file)}>
                        <div className="file-main">
                          <span className="file-path">
                            {dir && <span className="file-dir">{dir}/</span>}
                            <span className="file-name">{base}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="panel-card diff">
        <div className="card-row">
          <span className="card-title">Preview</span>
          {fileViewLoading && <span className="badge">Loading</span>}
        </div>
        {selectedFile && <div className="card-meta mono">{selectedFile}</div>}
        <div className="diff-body">
          {fileError && <div className="inline-error">{fileError}</div>}
          {!fileError && !selectedFile && <div className="muted">Select a file</div>}
          {!fileError && selectedFile && fileDiff && (
            <div className="diff-viewer"><PatchDiff patch={fileDiff} options={diffOptions} /></div>
          )}
          {!fileError && selectedFile && !fileDiff && fileContent && (
            <CodePreview code={fileContent} lang={getLangFromPath(selectedFile)} />
          )}
          {!fileError && selectedFile && !fileDiff && !fileContent && <div className="muted">No preview</div>}
        </div>
      </div>
    </aside>
  );
}

// =============================================================================
// Main App
// =============================================================================

function App() {
  // Query client for manual invalidation
  const queryClient = useQueryClient();

  // Core app state
  const [home, setHome] = useState<string>(() => readStoredHome());
  const [homeDraft, setHomeDraft] = useState<string>(() => readStoredHome());
  const [homeResolved, setHomeResolved] = useState<string>("");

  // TanStack Query hooks for server state
  const { data: repos = [], isLoading: reposLoading, error: reposError } = useRepos(home || undefined);
  const { data: workspaces = [], isLoading: workspacesLoading, error: workspacesError } = useWorkspaces(home || undefined);

  // UI state
  const [openWorkspaceIds, setOpenWorkspaceIds] = useState<string[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(new Set());
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const queuedMessageRef = useRef<string | null>(null);
  const [agentTabs, setAgentTabs] = useState<AgentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);

  // Derive loading/error from queries
  const loading = reposLoading || workspacesLoading;
  const error = reposError?.message ?? workspacesError?.message ?? null;

  // Mutations
  const addRepoMutation = useAddRepo(home || undefined);
  const createWorkspaceMutation = useCreateWorkspace(home || undefined);
  const repoAdding = addRepoMutation.isPending;
  const repoError = addRepoMutation.error?.message ?? null;
  const creating = createWorkspaceMutation.isPending;
  const createError = createWorkspaceMutation.error?.message ?? null;

  // Compute running state early (needed for queue effect)
  const activeTab = agentTabs.find((t) => t.id === activeTabId) ?? null;
  const running = activeTab?.running ?? false;

  // Keep ref in sync with state (for use in event handlers)
  useEffect(() => { queuedMessageRef.current = queuedMessage; }, [queuedMessage]);

  // State to trigger sending a queued message (avoids stale closure issues)
  const [pendingSendMessage, setPendingSendMessage] = useState<string | null>(null);

  // Process queued message when agent finishes (running becomes false)
  const prevRunningRef = useRef(false);
  useEffect(() => {
    const wasRunning = prevRunningRef.current;
    prevRunningRef.current = running;
    // If we just stopped running and have a queued message, trigger send
    if (wasRunning && !running && queuedMessage) {
      setPendingSendMessage(queuedMessage);
      setQueuedMessage(null);
    }
  }, [running, queuedMessage]);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [filesWidth, setFilesWidth] = useState(360);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [showHomePopover, setShowHomePopover] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // Global keyboard shortcut for command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Refs
  const tabStore = useRef(new Map<string, AgentTab[]>());
  const tabIdCounter = useRef(1);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const agentSessionRef = useRef<{ wsId: string; tabId: string; sessionId: string } | null>(null);
  const repoUrlInputRef = useRef<HTMLInputElement | null>(null);

  // Derived state
  const workspaceById = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const ws of workspaces) map.set(ws.id, ws);
    return map;
  }, [workspaces]);

  const openWorkspaces = useMemo(
    () => openWorkspaceIds.map((id) => workspaceById.get(id)).filter(Boolean) as Workspace[],
    [openWorkspaceIds, workspaceById]
  );

  const activeWorkspace = activeWorkspaceId ? workspaceById.get(activeWorkspaceId) ?? null : null;

  // Workspace files and changes queries (depend on activeWorkspace)
  const { data: files = [], isLoading: filesLoading } = useWorkspaceFiles(home || undefined, activeWorkspaceId);
  const { data: changes = [] } = useWorkspaceChanges(home || undefined, activeWorkspaceId);

  // Session persistence hooks
  const { data: sessionState } = useSession(activeWorkspace?.path ?? null);
  const { data: chatHistory } = useChat(activeWorkspace?.path ?? null);
  const upsertResumeIdMutation = useUpsertResumeId();
  const appendChatMutation = useAppendChat();

  // Auto-select first file when files change
  const prevFilesRef = useRef<string[]>([]);
  useEffect(() => {
    if (files !== prevFilesRef.current && files.length > 0 && !selectedFile) {
      const firstChange = changes[0]?.path;
      setSelectedFile(firstChange ?? files[0] ?? null);
    }
    prevFilesRef.current = files;
  }, [files, changes, selectedFile]);

  // File content and diff queries (depend on selectedFile)
  const isChangedFile = selectedFile ? changes.some(c => c.path === selectedFile) : false;
  const { data: fileDiff, isLoading: diffLoading, error: diffError } = useFileDiff(
    home || undefined,
    activeWorkspaceId,
    isChangedFile ? selectedFile : null
  );
  const { data: fileContent, isLoading: contentLoading, error: contentError } = useFileContent(
    home || undefined,
    activeWorkspaceId,
    // Only fetch content if no diff or diff is empty
    (!isChangedFile || (fileDiff !== undefined && !fileDiff?.trim())) ? selectedFile : null
  );
  const fileViewLoading = diffLoading || contentLoading;
  const fileError = diffError?.message ?? contentError?.message ?? null;

  const filteredWorkspaces = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter((ws) =>
      ws.name.toLowerCase().includes(query) ||
      ws.repo.toLowerCase().includes(query) ||
      ws.branch.toLowerCase().includes(query)
    );
  }, [filter, workspaces]);

  const workspacesByRepo = useMemo(() => {
    const map = new Map<string, Workspace[]>();
    for (const ws of filteredWorkspaces) {
      const list = map.get(ws.repo_id);
      if (list) list.push(ws);
      else map.set(ws.repo_id, [ws]);
    }
    return map;
  }, [filteredWorkspaces]);

  const openGroups = useMemo<OpenGroup[]>(() => {
    const map = new Map<string, OpenGroup>();
    for (const ws of openWorkspaces) {
      const group = map.get(ws.repo_id);
      if (group) group.workspaces.push(ws);
      else map.set(ws.repo_id, { repoId: ws.repo_id, repoName: ws.repo, workspaces: [ws] });
    }
    return Array.from(map.values());
  }, [openWorkspaces]);

  const changesByPath = useMemo(() => {
    const map = new Map<string, WorkspaceChange>();
    for (const change of changes) map.set(change.path, change);
    return map;
  }, [changes]);

  const fileQuery = fileFilter.trim().toLowerCase();
  const allFiles = useMemo(() => files.filter((file) => !changesByPath.has(file)), [files, changesByPath]);
  const filteredChanges = useMemo(() => {
    if (!fileQuery) return changes;
    return changes.filter((c) => c.path.toLowerCase().includes(fileQuery) || c.old_path?.toLowerCase().includes(fileQuery));
  }, [changes, fileQuery]);
  const filteredAllFiles = useMemo(() => {
    if (!fileQuery) return allFiles;
    return allFiles.filter((file) => file.toLowerCase().includes(fileQuery));
  }, [allFiles, fileQuery]);

  const activeIndex = activeWorkspaceId ? openWorkspaceIds.indexOf(activeWorkspaceId) : -1;
  const canPrev = activeIndex > 0;
  const canNext = activeIndex >= 0 && activeIndex < openWorkspaceIds.length - 1;
  const homeDirty = homeDraft.trim() !== home;

  // API helpers (only resolveHome still needed directly)
  const resolveHomeApi = useCallback((path: string) =>
    safeInvoke<string>("resolve_home_path", path ? { home: path } : {}), []);

  // Actions
  async function updateHomeResolved(nextHome: string) {
    try {
      const resolved = await resolveHomeApi(nextHome);
      setHomeResolved(resolved);
    } catch {
      setHomeResolved(nextHome.trim());
    }
  }

  function applyHome() {
    const nextHome = homeDraft.trim();
    setHome(nextHome);
    setHomeDraft(nextHome);
    storeHome(nextHome);
  }

  // Refresh all data (invalidate queries)
  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.repos(home || undefined) });
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(home || undefined) });
  }, [queryClient, home]);

  // Invalidate workspace files (for after agent changes)
  const invalidateWorkspaceFiles = useCallback(() => {
    if (activeWorkspaceId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles(home || undefined, activeWorkspaceId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaceChanges(home || undefined, activeWorkspaceId) });
    }
  }, [queryClient, home, activeWorkspaceId]);

  async function addRepo() {
    const url = repoUrl.trim();
    if (!url) return;
    addRepoMutation.reset();
    try {
      await addRepoMutation.mutateAsync(url);
      setRepoUrl("");
    } catch {
      // Error is handled by mutation state
    }
  }

  async function createWorkspaceForRepo(repoId: string) {
    if (!repoId) return;
    createWorkspaceMutation.reset();
    try {
      const created = await createWorkspaceMutation.mutateAsync({ repoId });
      openWorkspace(created.id);
    } catch {
      // Error is handled by mutation state
    }
  }

  function openWorkspace(id: string) {
    setOpenWorkspaceIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setActiveWorkspaceId(id);
  }

  function closeWorkspace(id: string) {
    setOpenWorkspaceIds((prev) => {
      const idx = prev.indexOf(id);
      const next = prev.filter((x) => x !== id);
      setActiveWorkspaceId((cur) => {
        if (cur !== id) return cur;
        if (!next.length) return null;
        return next[Math.min(idx, next.length - 1)];
      });
      return next;
    });
  }

  function activateOffset(offset: number) {
    if (!openWorkspaceIds.length || activeIndex === -1) return;
    const next = openWorkspaceIds[activeIndex + offset];
    if (next) setActiveWorkspaceId(next);
  }

  function toggleRepo(repoId: string) {
    setCollapsedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  }

  function createNewTab(agentId: string = "claude-code"): AgentTab {
    const id = `tab-${tabIdCounter.current++}`;
    return { id, agentId, name: AGENTS.find((a) => a.id === agentId)?.name ?? "Agent", messages: [], actions: new Map() };
  }

  function updateTabMessages(tabId: string, messages: ChatMessage[], updates?: Partial<AgentTab>) {
    setAgentTabs((prev) => {
      const next = prev.map((t) => t.id === tabId ? { ...t, messages, ...updates } : t);
      if (activeWorkspaceId) tabStore.current.set(activeWorkspaceId, next);
      return next;
    });
  }

  function addAgentTab() {
    if (!activeWorkspaceId) return;
    const newTab = createNewTab();
    setAgentTabs((prev) => {
      const next = [...prev, newTab];
      tabStore.current.set(activeWorkspaceId, next);
      return next;
    });
    setActiveTabId(newTab.id);
  }

  function closeAgentTab(tabId: string) {
    setAgentTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (activeWorkspaceId) tabStore.current.set(activeWorkspaceId, next);
      if (activeTabId === tabId && next.length > 0) {
        setActiveTabId(next[Math.min(idx, next.length - 1)].id);
      } else if (next.length === 0) {
        setActiveTabId(null);
      }
      return next;
    });
  }

  function changeTabAgent(agentId: string) {
    if (!activeTabId) return;
    setAgentTabs((prev) => {
      const next = prev.map((t) => t.id === activeTabId ? { ...t, agentId } : t);
      if (activeWorkspaceId) tabStore.current.set(activeWorkspaceId, next);
      return next;
    });
  }

  async function sendChat(messageOverride?: string) {
    const currentTab = agentTabs.find((t) => t.id === activeTabId);
    const trimmed = (messageOverride ?? chatDraft).trim();
    if (!trimmed || !activeWorkspaceId || !activeTabId || !currentTab || !activeWorkspace) return;

    // If running, queue the message for later
    if (running) {
      const queuedMsg: ChatMessage = { id: `msg-${Date.now()}-queued`, role: "user", content: trimmed, meta: "queued" };
      updateTabMessages(activeTabId, [...currentTab.messages, queuedMsg]);
      setQueuedMessage(trimmed);
      setChatDraft("");
      return;
    }

    const userMsg: ChatMessage = { id: `msg-${Date.now()}`, role: "user", content: trimmed, meta: "you" };
    updateTabMessages(activeTabId, [...currentTab.messages, userMsg], { running: true, startTime: Date.now() });
    setChatDraft("");

    // Persist user message to chat.md
    if (activeWorkspace?.path) {
      appendChatMutation.mutate({ wsPath: activeWorkspace.path, role: "User", content: trimmed });
    }

    const sessionId = `${activeWorkspaceId}-${activeTabId}-${Date.now()}`;
    agentSessionRef.current = { wsId: activeWorkspaceId, tabId: activeTabId, sessionId };

    try {
      await invoke("run_agent", {
        engine: currentTab.agentId,
        prompt: trimmed,
        cwd: activeWorkspace.path,
        sessionId,
        resumeId: currentTab.resumeId ?? null, // Pass resume ID for session continuity
      });
    } catch (e) {
      const errorMsg: ChatMessage = {
        id: `msg-${Date.now()}-error`,
        role: "system",
        content: `Error: ${e instanceof Error ? e.message : String(e)}`,
        meta: "error",
      };
      setAgentTabs((prev) => {
        const tab = prev.find((t) => t.id === activeTabId);
        if (!tab) return prev;
        const next = prev.map((t) => t.id === activeTabId ? { ...t, messages: [...t.messages, errorMsg], running: false } : t);
        if (activeWorkspaceId) tabStore.current.set(activeWorkspaceId, next);
        return next;
      });
    }
  }

  async function stopAgent() {
    const session = agentSessionRef.current;
    if (!session) return;
    try {
      await invoke("stop_agent", { sessionId: session.sessionId });
    } catch (e) {
      console.error("Failed to stop agent:", e);
    }
  }

  // Process pending send message (from queue) after sendChat is defined
  useEffect(() => {
    if (pendingSendMessage) {
      const msg = pendingSendMessage;
      setPendingSendMessage(null);
      // Small delay to ensure UI has settled
      setTimeout(() => void sendChat(msg), 100);
    }
  }, [pendingSendMessage]);

  // Effects - TanStack Query handles data fetching, these are for UI sync
  useEffect(() => { void updateHomeResolved(home); }, [home]);

  // Sync open workspace IDs with available workspaces
  useEffect(() => {
    const ids = new Set(workspaces.map((ws) => ws.id));
    const filtered = openWorkspaceIds.filter((id) => ids.has(id));
    if (filtered.length !== openWorkspaceIds.length) setOpenWorkspaceIds(filtered);
    if (activeWorkspaceId && !ids.has(activeWorkspaceId)) {
      setActiveWorkspaceId(filtered.length ? filtered[0] : null);
    }
  }, [workspaces, openWorkspaceIds, activeWorkspaceId]);

  // Clear selected file when workspace changes
  useEffect(() => {
    setSelectedFile(null);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId) { setAgentTabs([]); setActiveTabId(null); return; }
    const stored = tabStore.current.get(activeWorkspaceId);
    if (stored && stored.length > 0) { setAgentTabs(stored); setActiveTabId(stored[0].id); return; }
    // Create new tab with saved resumeId and restored chat history
    const initialTab = createNewTab();
    if (sessionState?.resume_id) {
      initialTab.resumeId = sessionState.resume_id;
    }
    // Restore chat history from chat.md if available
    if (chatHistory) {
      const restoredMessages = parseChatMd(chatHistory);
      if (restoredMessages.length > 0) {
        initialTab.messages = restoredMessages;
      }
    }
    tabStore.current.set(activeWorkspaceId, [initialTab]);
    setAgentTabs([initialTab]);
    setActiveTabId(initialTab.id);
  }, [activeWorkspaceId, sessionState, chatHistory]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [agentTabs, activeTabId]);

  // Ref to store the latest invalidation function (avoids stale closures in event listener)
  const invalidateFilesRef = useRef(invalidateWorkspaceFiles);
  useEffect(() => { invalidateFilesRef.current = invalidateWorkspaceFiles; }, [invalidateWorkspaceFiles]);

  // Listen for agent events
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      // Listen for agent events (fixed event name, session_id in payload)
      unlisten = await listen<AgentEvent & { session_id?: string }>("agent_event", (event) => {
        const agentEvent = event.payload;
        const session = agentSessionRef.current;
        if (!session) return;

        // Check session_id matches
        if (agentEvent.session_id !== session.sessionId) return;

        // Trigger file refresh on file_change completion or session end (debounced via setTimeout)
        if (agentEvent.type === "agent.action" && agentEvent.action?.kind === "file_change" && agentEvent.phase === "completed") {
          setTimeout(() => invalidateFilesRef.current(), 500);
        }
        // Also refresh when agent session ends (catches any missed changes)
        if (agentEvent.type === "agent.completed" || agentEvent.type === "session_ended" || agentEvent.type === "session_stopped") {
          setTimeout(() => invalidateFilesRef.current(), 500);
        }
        // Play notification sound only on final session end (not agent.completed which may come first)
        if (agentEvent.type === "session_ended") {
          playNotificationSound();
        }

        setAgentTabs((prev) => {
          const tab = prev.find((t) => t.id === session.tabId);
          if (!tab) return prev;

          let newMsg: ChatMessage | null = null;
          let updates: Partial<AgentTab> = {};
          let updatedActions: Map<string, ActionState> | null = null;
          let updateExistingAction: { actionId: string; phase: string; ok?: boolean } | null = null;

          if (agentEvent.type === "agent.message" && agentEvent.text) {
            // Update existing assistant message or create new one (handles streaming updates)
            const existingMsgIdx = tab.messages.findIndex((m) => m.role === "assistant" && m.id.startsWith("msg-stream-"));
            if (existingMsgIdx >= 0) {
              // Update existing streaming message in place
              const existingMsg = tab.messages[existingMsgIdx];
              if (existingMsg.content !== agentEvent.text) {
                const updatedMsgs = [...tab.messages];
                updatedMsgs[existingMsgIdx] = { ...existingMsg, content: agentEvent.text };
                const next = prev.map((t) => t.id === session.tabId ? { ...t, messages: updatedMsgs } : t);
                tabStore.current.set(session.wsId, next);
                return next;
              }
              return prev; // No change
            }
            // Create new streaming message
            newMsg = { id: `msg-stream-${Date.now()}`, role: "assistant", content: agentEvent.text, meta: agentEvent.engine ?? "agent" };
          } else if (agentEvent.type === "agent.action" && agentEvent.action) {
            const { action, phase, ok } = agentEvent;
            const phaseTyped = (phase ?? "started") as "started" | "updated" | "completed";
            const existing = tab.actions.get(action.id);

            // Track action state
            updatedActions = new Map(tab.actions);
            updatedActions.set(action.id, {
              id: action.id,
              kind: action.kind,
              title: action.title,
              phase: phaseTyped,
              ok,
              firstSeen: existing?.firstSeen ?? Date.now(),
            });

            if (existing) {
              // Update existing action message
              updateExistingAction = { actionId: action.id, phase: phaseTyped, ok };
            } else {
              // Create new action message
              newMsg = {
                id: `msg-action-${action.id}`,
                role: "action", content: action.title, meta: action.kind,
                actionKind: action.kind, actionPhase: phaseTyped, actionId: action.id,
                actionDetail: action.detail, ok,
              };
            }
          } else if (agentEvent.type === "agent.completed" || agentEvent.type === "session_ended" || agentEvent.type === "session_stopped") {
            updates.running = false;
            // Clear actions on completion
            updatedActions = new Map();
            // Add stopped message if manually stopped
            if (agentEvent.type === "session_stopped") {
              newMsg = { id: `msg-${Date.now()}-stopped`, role: "system", content: "Agent stopped", meta: "stopped" };
            }
            // Finalize streaming message so next session won't update it
            const streamMsgIdx = tab.messages.findIndex((m) => m.id.startsWith("msg-stream-"));
            if (streamMsgIdx >= 0) {
              const updatedMsgs = [...tab.messages];
              const streamMsg = updatedMsgs[streamMsgIdx];
              updatedMsgs[streamMsgIdx] = { ...streamMsg, id: `msg-final-${Date.now()}` };
              // Persist assistant message to chat.md
              const ws = workspaceById.get(session.wsId);
              if (ws?.path && streamMsg.content) {
                appendChatMutation.mutate({ wsPath: ws.path, role: "Assistant", content: streamMsg.content });
              }
              const next = prev.map((t) => t.id === session.tabId ? { ...t, messages: updatedMsgs, actions: new Map(), running: false } : t);
              tabStore.current.set(session.wsId, next);
              return next;
            }
            // Only add error messages
            if (agentEvent.type === "agent.completed" && agentEvent.error) {
              newMsg = { id: `msg-${Date.now()}-error`, role: "system", content: agentEvent.error, meta: "error" };
            }
          } else if (agentEvent.type === "agent.started" || agentEvent.type === "session_started") {
            // Clear previous actions on new session (don't show a message)
            updatedActions = new Map();
            // Capture resume token for session continuity (Takopi pattern)
            if (agentEvent.resume) {
              updates.resumeId = agentEvent.resume;
              // Persist resume ID to .conductor-app/session.json (upsert creates if missing)
              const ws = workspaceById.get(session.wsId);
              if (ws?.path) {
                upsertResumeIdMutation.mutate({ wsPath: ws.path, agentId: tab.agentId, resumeId: agentEvent.resume });
              }
            }
          }

          // Build updated messages
          let nextMsgs = tab.messages;
          if (updateExistingAction) {
            // Update existing action message in place
            nextMsgs = tab.messages.map((m) =>
              m.actionId === updateExistingAction!.actionId
                ? { ...m, actionPhase: updateExistingAction!.phase, ok: updateExistingAction!.ok }
                : m
            );
          } else if (newMsg) {
            nextMsgs = [...tab.messages, newMsg];
          }

          const nextTab = {
            ...tab,
            messages: nextMsgs,
            ...(updatedActions ? { actions: updatedActions } : {}),
            ...updates,
          };
          const next = prev.map((t) => t.id === session.tabId ? nextTab : t);
          tabStore.current.set(session.wsId, next);
          return next;
        });
      });
    };

    setupListener();
    return () => { if (unlisten) unlisten(); };
  }, []);

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((prev) => Math.max(180, Math.min(400, prev + delta)));
  }, []);

  const handleFilesResize = useCallback((delta: number) => {
    setFilesWidth((prev) => Math.max(240, Math.min(500, prev + delta)));
  }, []);

  return (
    <div className="app" style={{ gridTemplateColumns: sidebarCollapsed ? `0 0 1fr` : `${sidebarWidth}px auto 1fr` }}>
      {!sidebarCollapsed && (
        <Rail
          repos={repos} workspaces={workspaces} openWorkspaceIds={openWorkspaceIds}
          activeWorkspaceId={activeWorkspaceId} loading={loading} repoAdding={repoAdding}
          homeDraft={homeDraft} homeResolved={homeResolved} homeDirty={homeDirty}
          filter={filter} creating={creating} createError={createError}
          repoUrl={repoUrl} repoError={repoError} collapsedRepoIds={collapsedRepoIds}
          workspacesByRepo={workspacesByRepo} filteredWorkspaces={filteredWorkspaces}
          repoUrlInputRef={repoUrlInputRef} showHomePopover={showHomePopover}
          onHomeDraftChange={setHomeDraft} onApplyHome={applyHome} onRefresh={() => void refresh()}
          onFilterChange={setFilter} onCreateWorkspaceForRepo={(id) => void createWorkspaceForRepo(id)}
          onRepoUrlChange={(v) => { setRepoUrl(v); addRepoMutation.reset(); }}
          onAddRepo={() => void addRepo()} onToggleRepo={toggleRepo} onOpenWorkspace={openWorkspace}
          onToggleHomePopover={() => setShowHomePopover(p => !p)}
        />
      )}
      {!sidebarCollapsed && <ResizeHandle onResize={handleSidebarResize} direction="right" />}

      <main className="content">
        {error && (
          <div className="error-banner">
            <div className="error-title">Backend error</div>
            <div className="error-body">{error}</div>
          </div>
        )}

        <TabsHeader
          openGroups={openGroups} activeWorkspaceId={activeWorkspaceId}
          canPrev={canPrev} canNext={canNext}
          onActivate={setActiveWorkspaceId} onClose={closeWorkspace}
          onPrev={() => activateOffset(-1)} onNext={() => activateOffset(1)}
        />

        {openWorkspaceIds.length === 0 ? (
          <WelcomeHero
            hasRepos={repos.length > 0}
            onAddRepoFocus={() => {
              if (sidebarCollapsed) setSidebarCollapsed(false);
              setTimeout(() => repoUrlInputRef.current?.focus(), 100);
            }}
          />
        ) : (
          <section className="workspace-view" style={{ gridTemplateColumns: filesCollapsed ? "1fr 0 0" : `1fr auto ${filesWidth}px` }}>
            <div className="workspace-panel">
              <WorkspacePanel activeWorkspace={activeWorkspace} />
              <ChatPanel
                activeWorkspace={activeWorkspace} tabs={agentTabs} activeTabId={activeTabId}
                chatDraft={chatDraft} running={running} startTime={activeTab?.startTime} files={files}
                onTabChange={setActiveTabId} onTabClose={closeAgentTab} onTabAdd={addAgentTab}
                onAgentChange={changeTabAgent} onDraftChange={setChatDraft}
                onSend={() => void sendChat()} onStop={() => void stopAgent()}
                chatEndRef={chatEndRef}
              />
              {/* Terminal toggle and panel */}
              <button className="terminal-toggle" onClick={() => setTerminalOpen((p) => !p)}>
                <span>{terminalOpen ? "▼" : "▲"}</span>
                <span>Terminal</span>
              </button>
              {terminalOpen && activeWorkspace && activeTabId && (
                <div className="terminal-panel">
                  <div className="terminal-header">
                    <span className="terminal-title">Terminal</span>
                    <div className="terminal-actions">
                      <button className="terminal-btn" onClick={() => setTerminalOpen(false)}>×</button>
                    </div>
                  </div>
                  <Terminal
                    workspacePath={activeWorkspace.path}
                    sessionId={activeTabId}
                  />
                </div>
              )}
            </div>

            {!filesCollapsed && <ResizeHandle onResize={handleFilesResize} direction="left" />}
            {!filesCollapsed && (
              <FilesPanel
                activeWorkspace={activeWorkspace} files={files} changes={changes}
                filteredChanges={filteredChanges} filteredAllFiles={filteredAllFiles}
                filesLoading={filesLoading} fileFilter={fileFilter} showAllFiles={showAllFiles}
                selectedFile={selectedFile} fileError={fileError} fileDiff={fileDiff ?? null}
                fileContent={fileContent ?? null} fileViewLoading={fileViewLoading}
                onFileFilterChange={setFileFilter} onToggleShowAll={() => setShowAllFiles((p) => !p)}
                onSelectFile={setSelectedFile}
              />
            )}
          </section>
        )}
      </main>

      <button className="collapse-toggle sidebar-toggle" onClick={() => setSidebarCollapsed((p) => !p)}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}>
        {sidebarCollapsed ? "→" : "←"}
      </button>
      <button className="collapse-toggle files-toggle" onClick={() => setFilesCollapsed((p) => !p)}
        title={filesCollapsed ? "Show files" : "Hide files"}>
        {filesCollapsed ? "←" : "→"}
      </button>

      <CommandPalette
        open={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        repos={repos}
        workspaces={workspaces}
        onOpenWorkspace={openWorkspace}
        onCreateWorkspace={(repoId) => void createWorkspaceForRepo(repoId)}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}

export default App;
