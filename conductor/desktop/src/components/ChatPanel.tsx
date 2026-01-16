import type { AgentTab, Workspace } from "../types";
import { AGENTS, STATUS_ICONS } from "../types";
import { formatActionKind } from "../utils";

type Props = {
  activeWorkspace: Workspace | null;
  tabs: AgentTab[];
  activeTabId: string | null;
  chatDraft: string;
  running: boolean;
  onTabChange: (id: string) => void;
  onTabClose: (id: string) => void;
  onTabAdd: () => void;
  onAgentChange: (id: string) => void;
  onDraftChange: (v: string) => void;
  onSend: () => void;
  chatEndRef: { current: HTMLDivElement | null };
};

export function ChatPanel({
  activeWorkspace, tabs, activeTabId, chatDraft, running,
  onTabChange, onTabClose, onTabAdd, onAgentChange, onDraftChange, onSend, chatEndRef,
}: Props) {
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const activeAgent = AGENTS.find((a) => a.id === activeTab?.agentId) ?? AGENTS[0];

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
        <span className={`badge${running ? " running" : ""}`}>{running ? "Running" : "Ready"}</span>
      </div>

      <div className="chat-body">
        {activeTab && activeTab.messages.length ? (
          activeTab.messages.map((msg) => {
            // Render status icon for action messages
            let statusIcon = "";
            if (msg.role === "action") {
              if (msg.actionPhase === "completed") {
                statusIcon = msg.ok === false ? STATUS_ICONS.fail : STATUS_ICONS.done;
              } else if (msg.actionPhase === "updated") {
                statusIcon = STATUS_ICONS.update;
              } else {
                statusIcon = STATUS_ICONS.running;
              }
            }

            return (
              <div key={msg.id} className={`chat-message ${msg.role}${msg.actionPhase ? ` ${msg.actionPhase}` : ""}${msg.ok === false ? " error" : ""}`}>
                {msg.role === "action" ? (
                  <>
                    <span className={`action-status ${msg.actionPhase ?? "started"}`}>{statusIcon}</span>
                    <span className="action-kind">{formatActionKind(msg.actionKind)}</span>
                    <span className="chat-content">{msg.content}</span>
                  </>
                ) : (
                  <>
                    <span className="chat-meta">{msg.meta}</span>
                    <span className="chat-content">{msg.content}</span>
                  </>
                )}
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
          <textarea className="input textarea" placeholder={!activeWorkspace ? "Select workspace" : `Message ${activeAgent.name}...`}
            value={chatDraft} onChange={(e) => onDraftChange(e.currentTarget.value)}
            disabled={!activeWorkspace || running}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); } }} />
          <button className="btn primary send-btn" onClick={onSend}
            disabled={!activeWorkspace || !chatDraft.trim() || running}>
            {running ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
