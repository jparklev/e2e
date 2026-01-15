import { PatchDiff } from "@pierre/diffs/react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
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
  path: string;
  status: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta?: string;
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

function App() {
  const isDemo = typeof (window as { __TAURI__?: unknown }).__TAURI__ === "undefined";
  const [home, setHome] = useState<string>("");
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
  const filesReq = useRef(0);
  const previewReq = useRef(0);

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

  const openGroups = useMemo(() => {
    const map = new Map<string, { repoId: string; repoName: string; workspaces: Workspace[] }>();
    for (const ws of openWorkspaces) {
      const group = map.get(ws.repo_id);
      if (group) {
        group.workspaces.push(ws);
      } else {
        map.set(ws.repo_id, { repoId: ws.repo_id, repoName: ws.repo, workspaces: [ws] });
      }
    }
    const repoIds = new Set(repos.map((repo) => repo.id));
    const ordered: { repoId: string; repoName: string; workspaces: Workspace[] }[] = [];
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

  const activeIndex = activeWorkspaceId ? openWorkspaceIds.indexOf(activeWorkspaceId) : -1;
  const canPrev = activeIndex > 0;
  const canNext = activeIndex >= 0 && activeIndex < openWorkspaceIds.length - 1;

  const diffOptions = useMemo(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      overflow: "wrap" as const,
      disableBackground: true,
      themeType: "light" as const,
    }),
    [],
  );

  async function refresh() {
    setError(null);
    setLoading(true);
    if (isDemo) {
      if (!demoLoaded) {
        setRepos(demoRepos);
        setWorkspaces(demoWorkspaces);
        setDemoLoaded(true);
      }
      setLoading(false);
      return;
    }
    const args = home ? { home } : {};
    try {
      const [nextRepos, nextWorkspaces] = await Promise.all([
        safeInvoke<Repo[]>("list_repos", args),
        safeInvoke<Workspace[]>("list_workspaces", { ...args, repo: null }),
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
  }

  async function addRepo() {
    const url = repoUrl.trim();
    if (!url) {
      setRepoError("Enter a repo URL.");
      return;
    }
    setRepoError(null);
    setRepoAdding(true);
    if (isDemo) {
      const name = repoNameFromUrl(url);
      const id = `demo-repo-${demoNextRepoId.current++}`;
      const repo: Repo = {
        id,
        name,
        root_path: `~/conductor/repos/${name}`,
        default_branch: "main",
        remote_url: url,
      };
      setRepos((prev) => [repo, ...prev]);
      setRepoUrl("");
      setCreateRepoId(id);
      setRepoAdding(false);
      return;
    }
    const args = home ? { home } : {};
    try {
      const repo = await safeInvoke<Repo>("add_repo_url", { ...args, url });
      setRepoUrl("");
      setCreateRepoId(repo.id);
      await refresh();
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
    if (isDemo) {
      const repo = repos.find((item) => item.id === createRepoId);
      if (!repo) {
        setCreateError("Select a repo before creating a workspace.");
        setCreating(false);
        return;
      }
      const trimmed = createName.trim();
      const usedNames = new Set(workspaces.map((ws) => ws.name.toLowerCase()));
      const picked =
        trimmed ||
        demoCityNames.find((city) => !usedNames.has(city.toLowerCase())) ||
        `workspace-${demoNextId.current}`;
      const id = `demo-ws-${demoNextId.current++}`;
      const next: Workspace = {
        id,
        repo_id: repo.id,
        repo: repo.name,
        name: picked,
        branch: picked,
        base_branch: repo.default_branch || "main",
        state: "ready",
        path: `~/conductor/workspaces/${repo.name}-demo/${picked}`,
      };
      setWorkspaces((prev) => [next, ...prev]);
      setCreateName("");
      openWorkspace(id);
      setCreating(false);
      return;
    }
    const args = home ? { home } : {};
    try {
      const payload: Record<string, unknown> = { ...args, repo: createRepoId };
      const name = createName.trim();
      if (name) {
        payload.name = name;
      }
      const created = await safeInvoke<Workspace>("create_workspace", payload);
      setCreateName("");
      openWorkspace(created.id);
      await refresh();
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
    if (!trimmed || !activeWorkspaceId) return;
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
    void refresh();
  }, []);

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
    if (isDemo) {
      const nextFiles = demoFilesByWorkspace[activeWorkspace.id] ?? demoFiles;
      const nextChanges = demoChangesByWorkspace[activeWorkspace.id] ?? [];
      if (filesReq.current !== req) {
        return;
      }
      setFiles(nextFiles);
      setChanges(nextChanges);
      setSelectedFile(nextChanges[0]?.path ?? nextFiles[0] ?? null);
      setFilesLoading(false);
      return;
    }
    const args = home ? { home } : {};
    void (async () => {
      try {
        const [nextFiles, nextChanges] = await Promise.all([
          safeInvoke<string[]>("workspace_files", { ...args, workspace: activeWorkspace.id }),
          safeInvoke<WorkspaceChange[]>("workspace_changes", { ...args, workspace: activeWorkspace.id }),
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
  }, [activeWorkspace, isDemo, home]);

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
    if (isDemo) {
      const diff = demoDiffs[selectedFile];
      if (previewReq.current !== req) {
        return;
      }
      if (diff && diff.trim()) {
        setFileDiff(diff);
        setFileContent(null);
      } else {
        setFileDiff(null);
        setFileContent(demoFileContents[selectedFile] ?? "No preview available.");
      }
      setFileViewLoading(false);
      return;
    }
    const args = home ? { home } : {};
    void (async () => {
      try {
        if (change) {
          const patch = await safeInvoke<string>("workspace_file_diff", {
            ...args,
            workspace: activeWorkspace.id,
            path: selectedFile,
          });
          if (previewReq.current !== req) {
            return;
          }
          if (patch.trim()) {
            setFileDiff(patch);
            setFileContent(null);
          } else {
            const content = await safeInvoke<string>("workspace_file_content", {
              ...args,
              workspace: activeWorkspace.id,
              path: selectedFile,
            });
            if (previewReq.current !== req) {
              return;
            }
            setFileDiff(null);
            setFileContent(content);
          }
        } else {
          const content = await safeInvoke<string>("workspace_file_content", {
            ...args,
            workspace: activeWorkspace.id,
            path: selectedFile,
          });
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
  }, [activeWorkspace, changesByPath, isDemo, home, selectedFile]);

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

  return (
    <div className="app">
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
            <button className="btn ghost" onClick={() => void refresh()} disabled={loading}>
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
          <input
            className="input"
            placeholder="~/conductor"
            value={home}
            onChange={(e) => setHome(e.currentTarget.value)}
            onBlur={() => void refresh()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
          />
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
            onChange={(e) => {
              setRepoUrl(e.currentTarget.value);
              setRepoError(null);
            }}
          />
          <button className="btn primary" onClick={() => void addRepo()} disabled={repoAdding}>
            {repoAdding ? "Adding" : "Add repo"}
          </button>
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
                onChange={(e) => setCreateRepoId(e.currentTarget.value)}
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
                onChange={(e) => setCreateName(e.currentTarget.value)}
              />
              <button className="btn primary" onClick={() => void createWorkspace()} disabled={creating}>
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
              onChange={(e) => setFilter(e.currentTarget.value)}
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
                  <button className="repo-header" onClick={() => toggleRepo(repo.id)}>
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
                            onClick={() => openWorkspace(ws.id)}
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

        <header className="tabs-header">
          <div className="tabs">
            {openGroups.map((group) => (
              <div key={group.repoId} className="tab-group">
                <div className="tab-group-title">{group.repoName}</div>
                <div className="tab-group-list">
                  {group.workspaces.map((ws) => (
                    <div key={ws.id} className={`tab-pill${ws.id === activeWorkspaceId ? " active" : ""}`}>
                      <button className="tab-hit" onClick={() => setActiveWorkspaceId(ws.id)}>
                        <div className="tab-title">{ws.name}</div>
                        <div className="tab-meta">{ws.branch}</div>
                      </button>
                      <button className="tab-close" onClick={() => closeWorkspace(ws.id)} aria-label={`Close ${ws.name}`}>
                        x
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {!openGroups.length && <div className="tab-empty muted">Open a workspace to start.</div>}
          </div>
          <div className="tab-actions">
            <button className="btn ghost" onClick={() => activateOffset(-1)} disabled={!canPrev} title="Previous tab">
              Prev tab
            </button>
            <button className="btn ghost" onClick={() => activateOffset(1)} disabled={!canNext} title="Next tab">
              Next tab
            </button>
          </div>
        </header>

        <section className="workspace-view">
          <div className="workspace-panel">
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

            <div className="panel-card chat">
              <div className="card-row">
                <div>
                  <div className="card-title">Conversation</div>
                  <div className="card-meta">
                    {activeWorkspace ? `${activeWorkspace.repo} / ${activeWorkspace.name}` : "No workspace selected"}
                  </div>
                </div>
                <span className="badge">Live</span>
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
                  <div className="muted">Connect a runner to stream messages here.</div>
                )}
              </div>
              <div className="chat-input">
                <textarea
                  className="input textarea"
                  placeholder={activeWorkspace ? "Ask the workspace agent..." : "Select a workspace to chat"}
                  value={chatDraft}
                  onChange={(e) => setChatDraft(e.currentTarget.value)}
                  disabled={!activeWorkspace}
                />
                <button className="btn primary" onClick={() => sendChat()} disabled={!chatDraft.trim() || !activeWorkspace}>
                  Send
                </button>
              </div>
            </div>
          </div>

          <aside className="files-panel">
            <div className="panel-card">
              <div className="card-row">
                <div>
                  <div className="card-title">Files</div>
                  <div className="card-meta">
                    {activeWorkspace ? `${changes.length} changed / ${files.length} total` : "No workspace selected"}
                  </div>
                </div>
                {filesLoading && <span className="badge">Loading</span>}
              </div>
              <div className="file-list">
                {!activeWorkspace && <div className="muted">Select a workspace to browse files.</div>}
                {activeWorkspace && !filesLoading && files.length === 0 && (
                  <div className="muted">No files available.</div>
                )}
                {activeWorkspace &&
                  files.map((file) => {
                    const change = changesByPath.get(file);
                    const { dir, base } = splitFilePath(file);
                    const isActive = file === selectedFile;
                    return (
                      <button
                        key={file}
                        className={`file-item${isActive ? " active" : ""}`}
                        onClick={() => setSelectedFile(file)}
                      >
                        <div className="file-path">
                          {dir && <span className="file-dir">{dir}/</span>}
                          <span className="file-name">{base}</span>
                        </div>
                        {change && (
                          <span className={`file-status ${statusClass(change.status)}`} title={statusLabel(change.status)}>
                            {change.status}
                          </span>
                        )}
                      </button>
                    );
                  })}
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
                {!fileError && selectedFile && !fileDiff && !fileContent && (
                  <div className="muted">No preview available.</div>
                )}
              </div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

export default App;
