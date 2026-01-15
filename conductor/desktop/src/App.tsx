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

const demoRepos: Repo[] = [
  {
    id: "demo-repo-1",
    name: "apollo",
    root_path: "~/conductor/repos/apollo",
    default_branch: "main",
  },
  {
    id: "demo-repo-2",
    name: "atlas",
    root_path: "~/conductor/repos/atlas",
    default_branch: "main",
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
  const [demoSeeded, setDemoSeeded] = useState(false);
  const openTabsLabel = openWorkspaceIds.length === 1 ? "tab" : "tabs";
  const demoNextId = useRef(demoWorkspaces.length + 1);

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

  const activeIndex = activeWorkspaceId ? openWorkspaceIds.indexOf(activeWorkspaceId) : -1;
  const canPrev = activeIndex > 0;
  const canNext = activeIndex >= 0 && activeIndex < openWorkspaceIds.length - 1;

  async function refresh() {
    setError(null);
    setLoading(true);
    if (isDemo) {
      setRepos(demoRepos);
      setWorkspaces(demoWorkspaces);
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
      setWorkspaces((prev) => [...prev, next]);
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
                {openWorkspaceIds.length} open {openTabsLabel}
              </div>
            </div>
            <input
              className="input small"
              placeholder="Filter"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <div className="workspace-list">
            {filteredWorkspaces.map((ws) => {
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
                    {!isActive && isOpen && <span className="badge">Open</span>}
                  </div>
                  <div className="workspace-meta">
                    <span>{ws.repo}</span>
                    <span className="sep">/</span>
                    <span>{ws.branch}</span>
                    <span className="sep">/</span>
                    <span>{ws.state}</span>
                  </div>
                </button>
              );
            })}
            {!filteredWorkspaces.length && (
              <div className="muted">
                No workspaces found in {home ? home : "~/conductor"}.
              </div>
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
            {openWorkspaces.map((ws) => (
              <div key={ws.id} className={`tab${ws.id === activeWorkspaceId ? " active" : ""}`}>
                <button className="tab-hit" onClick={() => setActiveWorkspaceId(ws.id)}>
                  <div className="tab-title">{ws.name}</div>
                  <div className="tab-meta">
                    <span>{ws.repo}</span>
                    <span className="tab-dot">·</span>
                    <span>{ws.branch}</span>
                  </div>
                </button>
                <button className="tab-close" onClick={() => closeWorkspace(ws.id)} aria-label={`Close ${ws.name}`}>
                  x
                </button>
              </div>
            ))}
            {!openWorkspaces.length && <div className="tab-empty muted">Open a workspace to start.</div>}
          </div>
          <div className="tab-actions">
            <button className="btn ghost" onClick={() => activateOffset(-1)} disabled={!canPrev}>
              Prev
            </button>
            <button className="btn ghost" onClick={() => activateOffset(1)} disabled={!canNext}>
              Next
            </button>
          </div>
        </header>

        <section className="panel">
          {activeWorkspace ? (
            <div className="panel-grid">
              <div className="panel-card primary">
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
              </div>
              <div className="panel-card">
                <div className="panel-label">Path</div>
                <div className="mono">{activeWorkspace.path}</div>
                <div className="panel-label">Branch</div>
                <div className="mono">{activeWorkspace.branch}</div>
                <div className="panel-label">Base</div>
                <div className="mono">{activeWorkspace.base_branch}</div>
              </div>
              <div className="panel-card">
                <div className="panel-label">Workspace ID</div>
                <div className="mono">{activeWorkspace.id}</div>
                <div className="panel-label">Repo ID</div>
                <div className="mono">{activeWorkspace.repo_id}</div>
              </div>
            </div>
          ) : (
            <div className="panel-empty">Pick a workspace from the left to open it in a tab.</div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
