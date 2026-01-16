import type { Workspace } from "../types";

type Props = {
  activeWorkspace: Workspace | null;
};

export function WorkspacePanel({ activeWorkspace }: Props) {
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
