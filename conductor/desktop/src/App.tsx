import { PatchDiff } from "@pierre/diffs/react";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

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
  role: "user" | "assistant" | "system";
  content: string;
  meta?: string;
};

type DataProvider = {
  listRepos: () => Promise<Repo[]>;
  listWorkspaces: () => Promise<Workspace[]>;
  addRepoUrl: (url: string) => Promise<Repo>;
  createWorkspace: (repoId: string, name?: string) => Promise<Workspace>;
  workspaceFiles: (workspaceId: string) => Promise<string[]>;
  workspaceChanges: (workspaceId: string) => Promise<WorkspaceChange[]>;
  workspaceFileDiff: (workspaceId: string, path: string) => Promise<string>;
  workspaceFileContent: (workspaceId: string, path: string) => Promise<string>;
  resolveHome: (path: string) => Promise<string>;
};

const demoRepos: Repo[] = [
  {
    id: "demo-repo-1",
    name: "apollo",
    root_path: "~/conductor/repos/apollo",
    default_branch: "main",
    remote_url: "https://github.com/example/apollo.git",
  },
  {
    id: "demo-repo-2",
    name: "atlas",
    root_path: "~/conductor/repos/atlas",
    default_branch: "main",
    remote_url: "https://github.com/example/atlas.git",
  },
];

const demoWorkspaces: Workspace[] = [
  {
    id: "demo-ws-1",
    repo_id: "demo-repo-1",
    repo: "apollo",
    name: "lahore",
    branch: "lahore",
    base_branch: "main",
    state: "ready",
    path: "~/conductor/workspaces/apollo-demo/lahore",
  },
  {
    id: "demo-ws-2",
    repo_id: "demo-repo-1",
    repo: "apollo",
    name: "oslo",
    branch: "oslo",
    base_branch: "main",
    state: "ready",
    path: "~/conductor/workspaces/apollo-demo/oslo",
  },
  {
    id: "demo-ws-3",
    repo_id: "demo-repo-2",
    repo: "atlas",
    name: "seoul",
    branch: "seoul",
    base_branch: "main",
    state: "ready",
    path: "~/conductor/workspaces/atlas-demo/seoul",
  },
  {
    id: "demo-ws-4",
    repo_id: "demo-repo-2",
    repo: "atlas",
    name: "kyoto",
    branch: "kyoto",
    base_branch: "main",
    state: "ready",
    path: "~/conductor/workspaces/atlas-demo/kyoto",
  },
];

const demoFiles = [
  "README.md",
  "src/app.tsx",
  "src/components/WorkspacePanel.tsx",
  "src/components/WorkspaceTabs.tsx",
  "src/hooks/useWorkspaces.ts",
  "src/styles/theme.css",
  "src/agent/plan.md",
];

const demoFilesByWorkspace: Record<string, string[]> = {
  "demo-ws-1": demoFiles,
  "demo-ws-2": demoFiles,
  "demo-ws-3": demoFiles,
  "demo-ws-4": demoFiles,
};

const demoChangesByWorkspace: Record<string, WorkspaceChange[]> = {
  "demo-ws-1": [
    { path: "README.md", status: "M" },
    { path: "src/app.tsx", status: "M" },
    { path: "src/styles/theme.css", status: "M" },
  ],
  "demo-ws-2": [
    { path: "src/components/WorkspaceTabs.tsx", status: "M" },
    { path: "src/agent/plan.md", status: "A" },
  ],
  "demo-ws-3": [{ path: "src/components/WorkspacePanel.tsx", status: "M" }],
};

const demoFileContents: Record<string, string> = {
  "README.md": `# Conductor Desktop

Workspace switcher for multi-repo worktrees.

- Grouped tabs and workspace stacks
- Fast repo add from URL
- Inline diff viewer
`,
  "src/components/WorkspaceTabs.tsx": `export function WorkspaceTabs() {
  return (
    <div className="tabs">
      {/* grouped tab pills render here */}
    </div>
  );
}
`,
  "src/hooks/useWorkspaces.ts": `export function useWorkspaces() {
  return { workspaces: [], activeWorkspace: null };
}
`,
  "src/agent/plan.md": `# Plan

- Sync workspace metadata
- Render diff previews
- Add repo URL flow
`,
};

const demoDiffs: Record<string, string> = {
  "README.md": `diff --git a/README.md b/README.md
index 2c1d4b1..a3c5a07 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,7 @@
-# Conductor
-Workspace switcher.
+# Conductor Desktop
+
+Workspace switcher for multi-repo worktrees.
+- Grouped tabs and workspace stacks
+- Inline diff viewer
`,
  "src/app.tsx": `diff --git a/src/app.tsx b/src/app.tsx
index 0c1f9ad..44b9e1a 100644
--- a/src/app.tsx
+++ b/src/app.tsx
@@ -12,7 +12,8 @@ export function WorkspacePanel() {
-  return <div className="panel">Workspace ready.</div>;
+  return (
+    <div className="panel">Workspace ready for review.</div>
+  );
 }
`,
  "src/styles/theme.css": `diff --git a/src/styles/theme.css b/src/styles/theme.css
index 0a13b10..b2a9c70 100644
--- a/src/styles/theme.css
+++ b/src/styles/theme.css
@@ -4,7 +4,8 @@
 :root {
-  --accent: #e4572e;
+  --accent: #e4572e;
+  --accent-soft: #f3b090;
 }
`,
  "src/components/WorkspaceTabs.tsx": `diff --git a/src/components/WorkspaceTabs.tsx b/src/components/WorkspaceTabs.tsx
index 7ce19aa..e8f1a0e 100644
--- a/src/components/WorkspaceTabs.tsx
+++ b/src/components/WorkspaceTabs.tsx
@@ -1,4 +1,6 @@
 export function WorkspaceTabs() {
   return (
     <div className="tabs">
+      {/* repo grouped tabs */}
     </div>
   );
 }
`,
  "src/components/WorkspacePanel.tsx": `diff --git a/src/components/WorkspacePanel.tsx b/src/components/WorkspacePanel.tsx
index 4bb32b1..2d4a662 100644
--- a/src/components/WorkspacePanel.tsx
+++ b/src/components/WorkspacePanel.tsx
@@ -5,6 +5,7 @@ export function WorkspacePanel() {
   return (
     <section className="panel">
+      <h2>Active workspace</h2>
       <p>Workspace status ready.</p>
     </section>
   );
 }
`,
};

const demoMessages: Record<string, ChatMessage[]> = {
  "demo-ws-1": [
    {
      id: "demo-msg-1",
      role: "system",
      content: "Workspace ready. Base is main.",
      meta: "agent",
    },
    {
      id: "demo-msg-2",
      role: "user",
      content: "Summarize the diff vs main and list any risks.",
      meta: "you",
    },
    {
      id: "demo-msg-3",
      role: "assistant",
      content:
        "Updated copy in the workspace panel and tweaked theme tokens. No behavior changes found.",
      meta: "assistant",
    },
  ],
  "demo-ws-2": [
    {
      id: "demo-msg-4",
      role: "system",
      content: "New branch created from main.",
      meta: "agent",
    },
    {
      id: "demo-msg-5",
      role: "assistant",
      content:
        "I added a quick plan checklist and refreshed the tab renderer stub.",
      meta: "assistant",
    },
  ],
  default: [
    {
      id: "demo-msg-6",
      role: "assistant",
      content: "Open a workspace to see the conversation thread.",
      meta: "assistant",
    },
  ],
};

const demoCityNames = [
  "lahore",
  "oslo",
  "seoul",
  "kyoto",
  "lisbon",
  "mumbai",
  "helsinki",
  "cairo",
  "santiago",
  "stockholm",
  "porto",
  "vienna",
];

const HOME_STORAGE_KEY = "conductor.home";
const DEMO_HOME_BASE = "/home/demo";

function pickDemoWorkspaceName(usedNames: Set<string>, nextId: number) {
  const next =
    demoCityNames.find((city) => !usedNames.has(city.toLowerCase())) ||
    `workspace-${nextId}`;
  return next;
}

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
    // Ignore storage failures.
  }
}

function resolveDemoHome(value: string) {
  const trimmed = value.trim() || "~/conductor";
  if (trimmed === "~") return DEMO_HOME_BASE;
  if (trimmed.startsWith("~/")) return `${DEMO_HOME_BASE}/${trimmed.slice(2)}`;
  return trimmed;
}

async function safeInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return await invoke<T>(cmd, args);
}

function repoNameFromUrl(url: string) {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? trimmed;
  const tail = last.includes(":") ? last.split(":").pop() ?? last : last;
  return tail.replace(/\.git$/, "") || "repo";
}

function splitFilePath(path: string) {
  const idx = path.lastIndexOf("/");
  if (idx === -1) {
    return { dir: "", base: path };
  }
  return { dir: path.slice(0, idx), base: path.slice(idx + 1) };
}

function statusLabel(status: string) {
  const code = status.startsWith("R") ? "R" : status;
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    default:
      return status;
  }
}

function statusClass(status: string) {
  const code = status[0]?.toLowerCase();
  if (code === "a") return "status added";
  if (code === "d") return "status deleted";
  if (code === "r") return "status renamed";
  return "status modified";
}

const diffOptions = {
  diffStyle: "unified",
  diffIndicators: "bars",
  overflow: "wrap",
  disableBackground: true,
  themeType: "light",
} as const;

type OpenGroup = {
  repoId: string;
  repoName: string;
  workspaces: Workspace[];
};

type RailProps = {
  isDemo: boolean;
  repos: Repo[];
  workspaces: Workspace[];
  openWorkspaceIds: string[];
  activeWorkspaceId: string | null;
  loading: boolean;
  repoAdding: boolean;
  homeDraft: string;
  homeResolved: string;
  homeDirty: boolean;
  filter: string;
  createRepoId: string;
  createName: string;
  creating: boolean;
  createError: string | null;
  repoUrl: string;
  repoError: string | null;
  collapsedRepoIds: Set<string>;
  workspacesByRepo: Map<string, Workspace[]>;
  openWorkspaces: Workspace[];
  filteredWorkspaces: Workspace[];
  onHomeDraftChange: (value: string) => void;
  onApplyHome: () => void;
  onRefresh: () => void;
  onFilterChange: (value: string) => void;
  onCreateRepoChange: (value: string) => void;
  onCreateNameChange: (value: string) => void;
  onCreateWorkspace: () => void;
  onRepoUrlChange: (value: string) => void;
  onAddRepo: () => void;
  onToggleRepo: (repoId: string) => void;
  onOpenWorkspace: (id: string) => void;
};

function Rail({
  isDemo,
  repos,
  workspaces,
  openWorkspaceIds,
  activeWorkspaceId,
  loading,
  repoAdding,
  homeDraft,
  homeResolved,
  homeDirty,
  filter,
  createRepoId,
  createName,
  creating,
  createError,
  repoUrl,
  repoError,
  collapsedRepoIds,
  workspacesByRepo,
  openWorkspaces,
  filteredWorkspaces,
  onHomeDraftChange,
  onApplyHome,
  onRefresh,
  onFilterChange,
  onCreateRepoChange,
  onCreateNameChange,
  onCreateWorkspace,
  onRepoUrlChange,
  onAddRepo,
  onToggleRepo,
  onOpenWorkspace,
}: RailProps) {
  return (
    <aside className="rail">
      <div className="brand">
        <div className="brand-title">Conductor</div>
        <div className="brand-sub">Workspace switcher</div>
        {isDemo && <div className="badge demo">Design mode</div>}
      </div>

      <div className="card">
        <div className="card-row">
          <div>
            <div className="card-title">Home</div>
            <div className="card-meta">
              {repos.length} repos / {workspaces.length} workspaces
            </div>
          </div>
          <button className="btn ghost" onClick={onRefresh} disabled={loading || repoAdding}>
            {loading ? "Refreshing" : "Refresh"}
          </button>
        </div>
        <div className="home-controls">
          <input
            className="input"
            placeholder="~/conductor"
            value={homeDraft}
            onChange={(e) => onHomeDraftChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onApplyHome();
              }
            }}
          />
          <button className="btn ghost" onClick={onApplyHome} disabled={!homeDirty || loading || repoAdding}>
            Apply
          </button>
        </div>
        {homeResolved && (
          <div className="home-resolved">
            Resolved: <span className="mono">{homeResolved}</span>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Add repo</div>
        <label className="label" htmlFor="repo-url">
          Repo URL
        </label>
        <input
          id="repo-url"
          className="input"
          placeholder="https://github.com/org/repo"
          value={repoUrl}
          disabled={repoAdding}
          onChange={(e) => onRepoUrlChange(e.currentTarget.value)}
        />
        <button className="btn primary" onClick={onAddRepo} disabled={repoAdding}>
          {repoAdding ? "Adding" : "Add repo"}
        </button>
        {repoAdding && <div className="help-text">Cloning repository...</div>}
        {repoError && <div className="inline-error">{repoError}</div>}
      </div>

      <div className="card">
        <div className="card-title">New workspace</div>
        {!repos.length ? (
          <div className="muted">Add a repo before creating a workspace.</div>
        ) : (
          <>
            <label className="label" htmlFor="repo-select">
              Repo
            </label>
            <select
              id="repo-select"
              className="input select"
              value={createRepoId}
              onChange={(e) => onCreateRepoChange(e.currentTarget.value)}
              disabled={repoAdding}
            >
              {repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
            <label className="label" htmlFor="workspace-name">
              Name
            </label>
            <input
              id="workspace-name"
              className="input"
              placeholder="Leave blank for a city name"
              value={createName}
              onChange={(e) => onCreateNameChange(e.currentTarget.value)}
              disabled={repoAdding}
            />
            <button className="btn primary" onClick={onCreateWorkspace} disabled={creating || repoAdding}>
              {creating ? "Creating" : "Create workspace"}
            </button>
            {isDemo && <div className="muted">Design mode uses sample data. New workspaces are local only.</div>}
            {createError && <div className="inline-error">{createError}</div>}
          </>
        )}
      </div>

      <div className="card grow">
        <div className="card-row">
          <div>
            <div className="card-title">Workspaces</div>
            <div className="card-meta">
              {openWorkspaceIds.length} open / {workspaces.length} total
            </div>
          </div>
          <input
            className="input small"
            placeholder="Filter"
            value={filter}
            onChange={(e) => onFilterChange(e.currentTarget.value)}
          />
        </div>
        <div className="repo-list">
          {repos.map((repo) => {
            const repoWorkspaces = workspacesByRepo.get(repo.id) ?? [];
            if (filter && repoWorkspaces.length === 0) {
              return null;
            }
            const isCollapsed = collapsedRepoIds.has(repo.id);
            const openCount = openWorkspaces.filter((ws) => ws.repo_id === repo.id).length;
            return (
              <div key={repo.id} className="repo-group">
                <button className="repo-header" onClick={() => onToggleRepo(repo.id)}>
                  <div>
                    <div className="repo-title">{repo.name}</div>
                    <div className="repo-meta">
                      {repoWorkspaces.length} workspaces / {openCount} open
                    </div>
                  </div>
                  <div className={`repo-toggle${isCollapsed ? " collapsed" : ""}`}>v</div>
                </button>
                {!isCollapsed && (
                  <div className="workspace-list">
                    {repoWorkspaces.map((ws) => {
                      const isOpen = openWorkspaceIds.includes(ws.id);
                      const isActive = ws.id === activeWorkspaceId;
                      return (
                        <button
                          key={ws.id}
                          className={`workspace-item${isActive ? " active" : ""}`}
                          onClick={() => onOpenWorkspace(ws.id)}
                        >
                          <div className="workspace-row">
                            <div className="workspace-name">{ws.name}</div>
                            {isActive && <span className="badge active">Active</span>}
                            {!isActive && isOpen && <span className="badge open">Open</span>}
                          </div>
                          <div className="workspace-meta">
                            <span>{ws.branch}</span>
                            <span className="sep">/</span>
                            <span>{ws.state}</span>
                          </div>
                        </button>
                      );
                    })}
                    {!repoWorkspaces.length && <div className="muted">No workspaces yet.</div>}
                  </div>
                )}
              </div>
            );
          })}
          {!repos.length && <div className="muted">Add a repo to get started.</div>}
          {repos.length > 0 && filter && filteredWorkspaces.length === 0 && (
            <div className="muted">No workspaces match "{filter}".</div>
          )}
        </div>
      </div>
    </aside>
  );
}

type TabsHeaderProps = {
  openGroups: OpenGroup[];
  activeWorkspaceId: string | null;
  canPrev: boolean;
  canNext: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
};

function TabsHeader({
  openGroups,
  activeWorkspaceId,
  canPrev,
  canNext,
  onActivate,
  onClose,
  onPrev,
  onNext,
}: TabsHeaderProps) {
  return (
    <header className="tabs-header">
      <div className="tabs">
        {openGroups.map((group) => (
          <div key={group.repoId} className="tab-group">
            <div className="tab-group-title">{group.repoName}</div>
            <div className="tab-group-list">
              {group.workspaces.map((ws) => (
                <div key={ws.id} className={`tab-pill${ws.id === activeWorkspaceId ? " active" : ""}`}>
                  <button className="tab-hit" onClick={() => onActivate(ws.id)}>
                    <div className="tab-title">{ws.name}</div>
                    <div className="tab-meta">{ws.branch}</div>
                  </button>
                  <button className="tab-close" onClick={() => onClose(ws.id)} aria-label={`Close ${ws.name}`}>
                    <span aria-hidden="true">×</span>
                    <span className="sr-only">Close</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!openGroups.length && <div className="tab-empty muted">Open a workspace to start.</div>}
      </div>
      <div className="tab-actions">
        <button className="btn ghost" onClick={onPrev} disabled={!canPrev} title="Previous tab">
          Prev tab
        </button>
        <button className="btn ghost" onClick={onNext} disabled={!canNext} title="Next tab">
          Next tab
        </button>
      </div>
    </header>
  );
}

type WorkspacePanelProps = {
  activeWorkspace: Workspace | null;
};

function WorkspacePanel({ activeWorkspace }: WorkspacePanelProps) {
  return (
    <div className="panel-card primary">
      {activeWorkspace ? (
        <>
          <div className="panel-kicker">Active workspace</div>
          <div className="panel-title">{activeWorkspace.name}</div>
          <div className="panel-route">
            <span>{activeWorkspace.repo}</span>
            <span className="route-dot">/</span>
            <span>{activeWorkspace.branch}</span>
          </div>
          <div className="chip-row">
            <span className="chip">State: {activeWorkspace.state}</span>
            <span className="chip">Base: {activeWorkspace.base_branch}</span>
          </div>
          <div className="panel-grid">
            <div className="panel-item">
              <div className="panel-label">Path</div>
              <div className="mono">{activeWorkspace.path}</div>
            </div>
            <div className="panel-item">
              <div className="panel-label">Workspace ID</div>
              <div className="mono">{activeWorkspace.id}</div>
            </div>
          </div>
        </>
      ) : (
        <div className="panel-empty">Pick a workspace to view details.</div>
      )}
    </div>
  );
}

type ChatPanelProps = {
  activeWorkspace: Workspace | null;
  chatEnabled: boolean;
  chatStatus: string;
  chatMessages: ChatMessage[];
  chatDraft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  chatEndRef: { current: HTMLDivElement | null };
};

function ChatPanel({
  activeWorkspace,
  chatEnabled,
  chatStatus,
  chatMessages,
  chatDraft,
  onDraftChange,
  onSend,
  chatEndRef,
}: ChatPanelProps) {
  return (
    <div className="panel-card chat">
      <div className="card-row">
        <div>
          <div className="card-title">Conversation</div>
          <div className="card-meta">
            {activeWorkspace ? `${activeWorkspace.repo} / ${activeWorkspace.name}` : "No workspace selected"}
          </div>
        </div>
        <span className={`badge${chatEnabled ? "" : " offline"}`}>{chatStatus}</span>
      </div>
      <div className="chat-body">
        {chatMessages.length ? (
          chatMessages.map((msg) => (
            <div key={msg.id} className={`chat-message ${msg.role}`}>
              <div className="chat-meta">{msg.meta}</div>
              <div className="chat-content">{msg.content}</div>
            </div>
          ))
        ) : (
          <div className="muted">
            {chatEnabled ? "Messages will appear here." : "Connect a runner to stream messages here."}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>
      <div className="chat-input">
        <textarea
          className="input textarea"
          placeholder={
            !activeWorkspace
              ? "Select a workspace to chat"
              : chatEnabled
                ? "Ask the workspace agent..."
                : "Connect a runner to chat"
          }
          value={chatDraft}
          onChange={(e) => onDraftChange(e.currentTarget.value)}
          disabled={!activeWorkspace || !chatEnabled}
        />
        <button className="btn primary" onClick={onSend} disabled={!chatDraft.trim() || !activeWorkspace || !chatEnabled}>
          Send
        </button>
      </div>
    </div>
  );
}

type FilesPanelProps = {
  activeWorkspace: Workspace | null;
  files: string[];
  changes: WorkspaceChange[];
  filteredChanges: WorkspaceChange[];
  filteredAllFiles: string[];
  filesLoading: boolean;
  fileFilter: string;
  showAllFiles: boolean;
  selectedFile: string | null;
  fileError: string | null;
  fileDiff: string | null;
  fileContent: string | null;
  fileViewLoading: boolean;
  onFileFilterChange: (value: string) => void;
  onToggleShowAll: () => void;
  onSelectFile: (path: string) => void;
};

function FilesPanel({
  activeWorkspace,
  files,
  changes,
  filteredChanges,
  filteredAllFiles,
  filesLoading,
  fileFilter,
  showAllFiles,
  selectedFile,
  fileError,
  fileDiff,
  fileContent,
  fileViewLoading,
  onFileFilterChange,
  onToggleShowAll,
  onSelectFile,
}: FilesPanelProps) {
  return (
    <aside className="files-panel">
      <div className="panel-card">
        <div className="card-row">
          <div>
            <div className="card-title">Files</div>
            <div className="card-meta">
              {activeWorkspace ? `Changed: ${changes.length} · Files: ${files.length}` : "No workspace selected"}
            </div>
          </div>
          {filesLoading && <span className="badge">Loading</span>}
        </div>
        <div className="file-controls">
          <input
            className="input small"
            placeholder="Filter files"
            value={fileFilter}
            onChange={(e) => onFileFilterChange(e.currentTarget.value)}
            disabled={!activeWorkspace || filesLoading}
          />
          <button
            className="btn ghost small"
            onClick={onToggleShowAll}
            disabled={!activeWorkspace || filesLoading || files.length === 0}
          >
            {showAllFiles ? "Hide all" : "Show all"}
          </button>
        </div>
        <div className="file-list">
          {!activeWorkspace && <div className="muted">Select a workspace to browse files.</div>}
          {activeWorkspace && !filesLoading && files.length === 0 && <div className="muted">No files available.</div>}
          {activeWorkspace && !filesLoading && files.length > 0 && (
            <>
              <div className="file-section">
                <div className="file-section-title">Changed ({filteredChanges.length})</div>
                {filteredChanges.length ? (
                  filteredChanges.map((change) => {
                    const { dir, base } = splitFilePath(change.path);
                    const isActive = change.path === selectedFile;
                    return (
                      <button
                        key={change.path}
                        className={`file-item${isActive ? " active" : ""}`}
                        onClick={() => onSelectFile(change.path)}
                      >
                        <div className="file-main">
                          <div className="file-path">
                            {dir && <span className="file-dir">{dir}/</span>}
                            <span className="file-name">{base}</span>
                          </div>
                          {change.old_path && <div className="file-rename">from {change.old_path}</div>}
                        </div>
                        <span className={`file-status ${statusClass(change.status)}`} title={statusLabel(change.status)}>
                          {change.status}
                        </span>
                      </button>
                    );
                  })
                ) : (
                  <div className="muted">No changed files.</div>
                )}
              </div>
              {showAllFiles && (
                <div className="file-section">
                  <div className="file-section-title">All files ({filteredAllFiles.length})</div>
                  {filteredAllFiles.length ? (
                    filteredAllFiles.map((file) => {
                      const { dir, base } = splitFilePath(file);
                      const isActive = file === selectedFile;
                      return (
                        <button
                          key={file}
                          className={`file-item${isActive ? " active" : ""}`}
                          onClick={() => onSelectFile(file)}
                        >
                          <div className="file-main">
                            <div className="file-path">
                              {dir && <span className="file-dir">{dir}/</span>}
                              <span className="file-name">{base}</span>
                            </div>
                          </div>
                        </button>
                      );
                    })
                  ) : (
                    <div className="muted">No matching files.</div>
                  )}
                </div>
              )}
              {!showAllFiles && <div className="muted">Show all files to browse everything.</div>}
            </>
          )}
        </div>
      </div>

      <div className="panel-card diff">
        <div className="card-row">
          <div>
            <div className="card-title">File preview</div>
            <div className="card-meta">{selectedFile ?? "Select a file"}</div>
          </div>
          {fileViewLoading && <span className="badge">Loading</span>}
        </div>
        <div className="diff-body">
          {fileError && <div className="inline-error">{fileError}</div>}
          {!fileError && !selectedFile && <div className="muted">Pick a file to inspect changes.</div>}
          {!fileError && selectedFile && fileDiff && (
            <div className="diff-viewer">
              <PatchDiff patch={fileDiff} options={diffOptions} />
            </div>
          )}
          {!fileError && selectedFile && !fileDiff && fileContent && (
            <pre className="file-content">{fileContent}</pre>
          )}
          {!fileError && selectedFile && !fileDiff && !fileContent && <div className="muted">No preview available.</div>}
        </div>
      </div>
    </aside>
  );
}

function App() {
  const isDemo = typeof (window as { __TAURI__?: unknown }).__TAURI__ === "undefined";
  const [home, setHome] = useState<string>(() => readStoredHome());
  const [homeDraft, setHomeDraft] = useState<string>(() => readStoredHome());
  const [homeResolved, setHomeResolved] = useState<string>("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [openWorkspaceIds, setOpenWorkspaceIds] = useState<string[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [createRepoId, setCreateRepoId] = useState("");
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [repoAdding, setRepoAdding] = useState(false);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<string[]>([]);
  const [changes, setChanges] = useState<WorkspaceChange[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileViewLoading, setFileViewLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileFilter, setFileFilter] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const [demoSeeded, setDemoSeeded] = useState(false);
  const demoNextId = useRef(demoWorkspaces.length + 1);
  const demoNextRepoId = useRef(demoRepos.length + 1);
  const chatStore = useRef(new Map<string, ChatMessage[]>());
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const filesReq = useRef(0);
  const previewReq = useRef(0);
  const lastRefreshHome = useRef<string | null>(null);

  const workspaceById = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const ws of workspaces) map.set(ws.id, ws);
    return map;
  }, [workspaces]);

  const openWorkspaces = useMemo(
    () => openWorkspaceIds.map((id) => workspaceById.get(id)).filter(Boolean) as Workspace[],
    [openWorkspaceIds, workspaceById],
  );

  const activeWorkspace = activeWorkspaceId ? workspaceById.get(activeWorkspaceId) ?? null : null;

  const filteredWorkspaces = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return workspaces;
    return workspaces.filter((ws) => {
      return (
        ws.name.toLowerCase().includes(query) ||
        ws.repo.toLowerCase().includes(query) ||
        ws.branch.toLowerCase().includes(query)
      );
    });
  }, [filter, workspaces]);

  const workspacesByRepo = useMemo(() => {
    const map = new Map<string, Workspace[]>();
    for (const ws of filteredWorkspaces) {
      const list = map.get(ws.repo_id);
      if (list) {
        list.push(ws);
      } else {
        map.set(ws.repo_id, [ws]);
      }
    }
    return map;
  }, [filteredWorkspaces]);

  const openGroups = useMemo<OpenGroup[]>(() => {
    const map = new Map<string, OpenGroup>();
    for (const ws of openWorkspaces) {
      const group = map.get(ws.repo_id);
      if (group) {
        group.workspaces.push(ws);
      } else {
        map.set(ws.repo_id, { repoId: ws.repo_id, repoName: ws.repo, workspaces: [ws] });
      }
    }
    const repoIds = new Set(repos.map((repo) => repo.id));
    const ordered: OpenGroup[] = [];
    for (const repo of repos) {
      const group = map.get(repo.id);
      if (group) ordered.push(group);
    }
    for (const group of map.values()) {
      if (!repoIds.has(group.repoId)) {
        ordered.push(group);
      }
    }
    return ordered;
  }, [openWorkspaces, repos]);

  const changesByPath = useMemo(() => {
    const map = new Map<string, WorkspaceChange>();
    for (const change of changes) {
      map.set(change.path, change);
    }
    return map;
  }, [changes]);

  const fileQuery = fileFilter.trim().toLowerCase();
  const allFiles = useMemo(
    () => files.filter((file) => !changesByPath.has(file)),
    [files, changesByPath],
  );
  const filteredChanges = useMemo(() => {
    if (!fileQuery) return changes;
    return changes.filter((change) => {
      if (change.path.toLowerCase().includes(fileQuery)) return true;
      return change.old_path?.toLowerCase().includes(fileQuery) ?? false;
    });
  }, [changes, fileQuery]);
  const filteredAllFiles = useMemo(() => {
    if (!fileQuery) return allFiles;
    return allFiles.filter((file) => file.toLowerCase().includes(fileQuery));
  }, [allFiles, fileQuery]);

  const activeIndex = activeWorkspaceId ? openWorkspaceIds.indexOf(activeWorkspaceId) : -1;
  const canPrev = activeIndex > 0;
  const canNext = activeIndex >= 0 && activeIndex < openWorkspaceIds.length - 1;
  const homeDirty = homeDraft.trim() !== home;
  const chatEnabled = isDemo;
  const chatStatus = isDemo ? "Local only" : "Not connected";

  const provider = useMemo<DataProvider>(() => {
    if (isDemo) {
      return {
        listRepos: async () => {
          if (!demoLoaded) {
            setDemoLoaded(true);
            return demoRepos;
          }
          return repos;
        },
        listWorkspaces: async () => {
          if (!demoLoaded) {
            setDemoLoaded(true);
            return demoWorkspaces;
          }
          return workspaces;
        },
        addRepoUrl: async (url: string) => {
          const name = repoNameFromUrl(url);
          const id = `demo-repo-${demoNextRepoId.current++}`;
          return {
            id,
            name,
            root_path: `~/conductor/repos/${name}`,
            default_branch: "main",
            remote_url: url,
          };
        },
        createWorkspace: async (repoId: string, name?: string) => {
          const repo = repos.find((item) => item.id === repoId) ?? demoRepos.find((item) => item.id === repoId);
          const usedNames = new Set(workspaces.map((ws) => ws.name.toLowerCase()));
          const picked = name?.trim() || pickDemoWorkspaceName(usedNames, demoNextId.current);
          const id = `demo-ws-${demoNextId.current++}`;
          const repoName = repo?.name ?? "repo";
          const baseBranch = repo?.default_branch ?? "main";
          return {
            id,
            repo_id: repoId,
            repo: repoName,
            name: picked,
            branch: picked,
            base_branch: baseBranch,
            state: "ready",
            path: `~/conductor/workspaces/${repoName}-demo/${picked}`,
          };
        },
        workspaceFiles: async (workspaceId: string) => demoFilesByWorkspace[workspaceId] ?? demoFiles,
        workspaceChanges: async (workspaceId: string) => demoChangesByWorkspace[workspaceId] ?? [],
        workspaceFileDiff: async (_workspaceId: string, path: string) => demoDiffs[path] ?? "",
        workspaceFileContent: async (_workspaceId: string, path: string) => demoFileContents[path] ?? "No preview available.",
        resolveHome: async (path: string) => resolveDemoHome(path),
      };
    }
    const args = home ? { home } : {};
    return {
      listRepos: async () => await safeInvoke<Repo[]>("list_repos", args),
      listWorkspaces: async () => await safeInvoke<Workspace[]>("list_workspaces", { ...args, repo: null }),
      addRepoUrl: async (url: string) => await safeInvoke<Repo>("add_repo_url", { ...args, url }),
      createWorkspace: async (repoId: string, name?: string) =>
        await safeInvoke<Workspace>("create_workspace", { ...args, repo: repoId, name: name || null }),
      workspaceFiles: async (workspaceId: string) =>
        await safeInvoke<string[]>("workspace_files", { ...args, workspace: workspaceId }),
      workspaceChanges: async (workspaceId: string) =>
        await safeInvoke<WorkspaceChange[]>("workspace_changes", { ...args, workspace: workspaceId }),
      workspaceFileDiff: async (workspaceId: string, path: string) =>
        await safeInvoke<string>("workspace_file_diff", { ...args, workspace: workspaceId, path }),
      workspaceFileContent: async (workspaceId: string, path: string) =>
        await safeInvoke<string>("workspace_file_content", { ...args, workspace: workspaceId, path }),
      resolveHome: async (path: string) =>
        await safeInvoke<string>("resolve_home_path", path ? { home: path } : {}),
    };
  }, [isDemo, demoLoaded, home, repos, workspaces]);

  async function updateHomeResolved(nextHome: string) {
    try {
      const resolved = await provider.resolveHome(nextHome);
      setHomeResolved(resolved);
    } catch {
      const fallback = nextHome.trim();
      setHomeResolved(fallback);
    }
  }

  function applyHome() {
    const nextHome = homeDraft.trim();
    setHome(nextHome);
    setHomeDraft(nextHome);
    storeHome(nextHome);
  }

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [nextRepos, nextWorkspaces] = await Promise.all([
        provider.listRepos(),
        provider.listWorkspaces(),
      ]);
      setRepos(nextRepos);
      setWorkspaces(nextWorkspaces);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [provider]);

  async function addRepo() {
    const url = repoUrl.trim();
    if (!url) {
      setRepoError("Enter a repo URL.");
      return;
    }
    setRepoError(null);
    setRepoAdding(true);
    try {
      const repo = await provider.addRepoUrl(url);
      setRepoUrl("");
      setCreateRepoId(repo.id);
      setRepos((prev) => [repo, ...prev]);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setRepoError(message);
    } finally {
      setRepoAdding(false);
    }
  }

  async function createWorkspace() {
    if (!createRepoId) {
      setCreateError("Pick a repo before creating a workspace.");
      return;
    }
    setCreateError(null);
    setCreating(true);
    try {
      const created = await provider.createWorkspace(createRepoId, createName.trim() || undefined);
      setWorkspaces((prev) => [created, ...prev]);
      setCreateName("");
      openWorkspace(created.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCreateError(message);
    } finally {
      setCreating(false);
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
        const nextIdx = Math.min(idx, next.length - 1);
        return next[nextIdx];
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
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }

  function updateChatMessages(next: ChatMessage[]) {
    setChatMessages(next);
    if (activeWorkspaceId) {
      chatStore.current.set(activeWorkspaceId, next);
    }
  }

  function sendChat() {
    const trimmed = chatDraft.trim();
    if (!trimmed || !activeWorkspaceId || !chatEnabled) return;
    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: trimmed,
      meta: "you",
    };
    if (isDemo) {
      const reply: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        role: "assistant",
        content: "Queued. I will summarize the changes next.",
        meta: "assistant",
      };
      updateChatMessages([...chatMessages, userMsg, reply]);
    } else {
      updateChatMessages([...chatMessages, userMsg]);
    }
    setChatDraft("");
  }

  useEffect(() => {
    if (lastRefreshHome.current === home) {
      return;
    }
    lastRefreshHome.current = home;
    void refresh();
  }, [home, refresh]);

  useEffect(() => {
    void updateHomeResolved(home);
  }, [home, provider]);

  useEffect(() => {
    if (!isDemo || demoSeeded) return;
    if (workspaces.length && openWorkspaceIds.length === 0) {
      const ids = workspaces.slice(0, 2).map((ws) => ws.id);
      setOpenWorkspaceIds(ids);
      setActiveWorkspaceId(ids[0] ?? null);
      setDemoSeeded(true);
    }
  }, [isDemo, demoSeeded, workspaces, openWorkspaceIds.length]);

  useEffect(() => {
    if (!createRepoId && repos.length) {
      setCreateRepoId(repos[0].id);
    }
  }, [createRepoId, repos]);

  useEffect(() => {
    const ids = new Set(workspaces.map((ws) => ws.id));
    const filtered = openWorkspaceIds.filter((id) => ids.has(id));
    if (filtered.length !== openWorkspaceIds.length) {
      setOpenWorkspaceIds(filtered);
    }
    if (activeWorkspaceId && !ids.has(activeWorkspaceId)) {
      setActiveWorkspaceId(filtered.length ? filtered[0] : null);
    }
  }, [workspaces, openWorkspaceIds, activeWorkspaceId]);

  useEffect(() => {
    const req = ++filesReq.current;
    if (!activeWorkspace) {
      setFiles([]);
      setChanges([]);
      setSelectedFile(null);
      setFileContent(null);
      setFileDiff(null);
      setFileError(null);
      setFilesLoading(false);
      return;
    }
    setFilesLoading(true);
    setFileError(null);
    void (async () => {
      try {
        const [nextFiles, nextChanges] = await Promise.all([
          provider.workspaceFiles(activeWorkspace.id),
          provider.workspaceChanges(activeWorkspace.id),
        ]);
        if (filesReq.current !== req) {
          return;
        }
        setFiles(nextFiles);
        setChanges(nextChanges);
        setSelectedFile(nextChanges[0]?.path ?? nextFiles[0] ?? null);
      } catch (e) {
        if (filesReq.current !== req) {
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        setFileError(message);
        setFiles([]);
        setChanges([]);
        setSelectedFile(null);
      } finally {
        if (filesReq.current === req) {
          setFilesLoading(false);
        }
      }
    })();
  }, [activeWorkspace, provider]);

  useEffect(() => {
    const req = ++previewReq.current;
    if (!activeWorkspace || !selectedFile) {
      setFileContent(null);
      setFileDiff(null);
      setFileViewLoading(false);
      return;
    }
    setFileViewLoading(true);
    setFileError(null);
    const change = changesByPath.get(selectedFile);
    void (async () => {
      try {
        if (change) {
          const patch = await provider.workspaceFileDiff(activeWorkspace.id, selectedFile);
          if (previewReq.current !== req) {
            return;
          }
          if (patch.trim()) {
            setFileDiff(patch);
            setFileContent(null);
          } else {
            const content = await provider.workspaceFileContent(activeWorkspace.id, selectedFile);
            if (previewReq.current !== req) {
              return;
            }
            setFileDiff(null);
            setFileContent(content);
          }
        } else {
          const content = await provider.workspaceFileContent(activeWorkspace.id, selectedFile);
          if (previewReq.current !== req) {
            return;
          }
          setFileDiff(null);
          setFileContent(content);
        }
      } catch (e) {
        if (previewReq.current !== req) {
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        setFileError(message);
        setFileContent(null);
        setFileDiff(null);
      } finally {
        if (previewReq.current === req) {
          setFileViewLoading(false);
        }
      }
    })();
  }, [activeWorkspace, changesByPath, provider, selectedFile]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setChatMessages([]);
      return;
    }
    const stored = chatStore.current.get(activeWorkspaceId);
    if (stored) {
      setChatMessages(stored);
      return;
    }
    const seed = isDemo
      ? demoMessages[activeWorkspaceId] ?? demoMessages.default
      : [];
    chatStore.current.set(activeWorkspaceId, seed);
    setChatMessages(seed);
  }, [activeWorkspaceId, isDemo]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages, activeWorkspaceId]);

  return (
    <div className="app">
      <Rail
        isDemo={isDemo}
        repos={repos}
        workspaces={workspaces}
        openWorkspaceIds={openWorkspaceIds}
        activeWorkspaceId={activeWorkspaceId}
        loading={loading}
        repoAdding={repoAdding}
        homeDraft={homeDraft}
        homeResolved={homeResolved}
        homeDirty={homeDirty}
        filter={filter}
        createRepoId={createRepoId}
        createName={createName}
        creating={creating}
        createError={createError}
        repoUrl={repoUrl}
        repoError={repoError}
        collapsedRepoIds={collapsedRepoIds}
        workspacesByRepo={workspacesByRepo}
        openWorkspaces={openWorkspaces}
        filteredWorkspaces={filteredWorkspaces}
        onHomeDraftChange={(value) => setHomeDraft(value)}
        onApplyHome={applyHome}
        onRefresh={() => void refresh()}
        onFilterChange={(value) => setFilter(value)}
        onCreateRepoChange={(value) => setCreateRepoId(value)}
        onCreateNameChange={(value) => setCreateName(value)}
        onCreateWorkspace={() => void createWorkspace()}
        onRepoUrlChange={(value) => {
          setRepoUrl(value);
          setRepoError(null);
        }}
        onAddRepo={() => void addRepo()}
        onToggleRepo={toggleRepo}
        onOpenWorkspace={openWorkspace}
      />

      <main className="content">
        {error && (
          <div className="error-banner">
            <div className="error-title">Backend error</div>
            <div className="error-body">{error}</div>
            <div className="error-hint">
              Ensure the Conductor home directory is writable and `git` is available. Tauri on Linux also requires
              WebKit/GTK prerequisites.
            </div>
          </div>
        )}

        <TabsHeader
          openGroups={openGroups}
          activeWorkspaceId={activeWorkspaceId}
          canPrev={canPrev}
          canNext={canNext}
          onActivate={(id) => setActiveWorkspaceId(id)}
          onClose={closeWorkspace}
          onPrev={() => activateOffset(-1)}
          onNext={() => activateOffset(1)}
        />

        <section className="workspace-view">
          <div className="workspace-panel">
            <WorkspacePanel activeWorkspace={activeWorkspace} />
            <ChatPanel
              activeWorkspace={activeWorkspace}
              chatEnabled={chatEnabled}
              chatStatus={chatStatus}
              chatMessages={chatMessages}
              chatDraft={chatDraft}
              onDraftChange={(value) => setChatDraft(value)}
              onSend={sendChat}
              chatEndRef={chatEndRef}
            />
          </div>

          <FilesPanel
            activeWorkspace={activeWorkspace}
            files={files}
            changes={changes}
            filteredChanges={filteredChanges}
            filteredAllFiles={filteredAllFiles}
            filesLoading={filesLoading}
            fileFilter={fileFilter}
            showAllFiles={showAllFiles}
            selectedFile={selectedFile}
            fileError={fileError}
            fileDiff={fileDiff}
            fileContent={fileContent}
            fileViewLoading={fileViewLoading}
            onFileFilterChange={(value) => setFileFilter(value)}
            onToggleShowAll={() => setShowAllFiles((prev) => !prev)}
            onSelectFile={(path) => setSelectedFile(path)}
          />
        </section>
      </main>
    </div>
  );
}

export default App;
