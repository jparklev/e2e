import type { OpenGroup } from "../types";

type Props = {
  openGroups: OpenGroup[];
  activeWorkspaceId: string | null;
  canPrev: boolean;
  canNext: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
};

export function TabsHeader({
  openGroups, activeWorkspaceId, canPrev, canNext,
  onActivate, onClose, onPrev, onNext,
}: Props) {
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
