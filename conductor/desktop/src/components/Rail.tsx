import type { Repo, Workspace } from "../types";

type Props = {
  repos: Repo[];
  openWorkspaceIds: string[];
  activeWorkspaceId: string | null;
  loading: boolean;
  repoAdding: boolean;
  homeDraft: string;
  homeResolved: string;
  homeDirty: boolean;
  filter: string;
  creating: boolean;
  createError: string | null;
  repoUrl: string;
  repoError: string | null;
  collapsedRepoIds: Set<string>;
  workspacesByRepo: Map<string, Workspace[]>;
  filteredWorkspaces: Workspace[];
  onHomeDraftChange: (v: string) => void;
  onApplyHome: () => void;
  onRefresh: () => void;
  onFilterChange: (v: string) => void;
  onCreateWorkspaceForRepo: (id: string) => void;
  onRepoUrlChange: (v: string) => void;
  onAddRepo: () => void;
  onToggleRepo: (id: string) => void;
  onOpenWorkspace: (id: string) => void;
};

export function Rail({
  repos, openWorkspaceIds, activeWorkspaceId, loading, repoAdding,
  homeDraft, homeResolved, homeDirty, filter, creating, createError, repoUrl, repoError,
  collapsedRepoIds, workspacesByRepo, filteredWorkspaces,
  onHomeDraftChange, onApplyHome, onRefresh, onFilterChange, onCreateWorkspaceForRepo,
  onRepoUrlChange, onAddRepo, onToggleRepo, onOpenWorkspace,
}: Props) {
  return (
    <aside className="sidebar rail">
      <div className="card">
        <div className="card-title">Workspaces</div>
        <input className="input small" placeholder="Filter workspaces..." value={filter}
          onChange={(e) => onFilterChange(e.currentTarget.value)} disabled={loading || repoAdding} />
        <div className="repo-list">
          {repos.map((repo) => {
            const repoWorkspaces = workspacesByRepo.get(repo.id) ?? [];
            const isCollapsed = collapsedRepoIds.has(repo.id);
            const filteredRepoWorkspaces = filteredWorkspaces.filter((ws) => ws.repo_id === repo.id);
            if (filter && filteredRepoWorkspaces.length === 0) return null;
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
                    {(filter ? filteredRepoWorkspaces : repoWorkspaces).map((ws) => {
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
          <input className="input small" placeholder="https://github.com/org/repo" value={repoUrl}
            disabled={repoAdding} onChange={(e) => onRepoUrlChange(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onAddRepo(); } }} />
          <button className="btn primary small" onClick={onAddRepo} disabled={repoAdding}>
            {repoAdding ? "..." : "Add"}
          </button>
        </div>
        {repoError && <div className="inline-error">{repoError}</div>}
      </div>

      <div className="card">
        <div className="card-row">
          <div className="card-title">Home</div>
          <button className="btn ghost small" onClick={onRefresh} disabled={loading || repoAdding}>
            {loading ? "..." : "↻"}
          </button>
        </div>
        <div className="home-controls">
          <input className="input small" placeholder="~/conductor" value={homeDraft}
            onChange={(e) => onHomeDraftChange(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onApplyHome(); } }} />
          <button className="btn ghost small" onClick={onApplyHome} disabled={!homeDirty || loading || repoAdding}>
            Apply
          </button>
        </div>
        {homeResolved && <div className="home-resolved mono">{homeResolved}</div>}
      </div>
    </aside>
  );
}
