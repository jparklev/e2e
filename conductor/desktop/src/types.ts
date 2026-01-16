// =============================================================================
// Domain Types
// =============================================================================

export type Repo = {
  id: string;
  name: string;
  root_path: string;
  default_branch: string;
  remote_url?: string | null;
};

export type Workspace = {
  id: string;
  repo_id: string;
  repo: string;
  name: string;
  branch: string;
  base_branch: string;
  state: string;
  path: string;
};

export type SessionState = {
  agent_id: string;
  resume_id?: string | null;
  started_at: string;
  updated_at: string;
};

export type WorkspaceChange = {
  old_path?: string | null;
  path: string;
  status: string;
};

// =============================================================================
// Chat Types
// =============================================================================

export type ChatMessage = {
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

export type ActionState = {
  id: string;
  kind: string;
  title: string;
  phase: "started" | "updated" | "completed";
  ok?: boolean;
  firstSeen: number;
};

export type AgentEvent = {
  type: string;
  engine?: string;
  phase?: string;
  ok?: boolean;
  text?: string;
  answer?: string;
  error?: string;
  resume?: string;
  session_id?: string;
  action?: {
    id: string;
    kind: string;
    title: string;
    detail?: Record<string, unknown>;
  };
};

export type Agent = {
  id: string;
  name: string;
  description: string;
};

export type AgentTab = {
  id: string;
  agentId: string;
  name: string;
  messages: ChatMessage[];
  sessionId?: string;
  resumeId?: string; // Claude session ID for --resume
  running?: boolean;
  actions: Map<string, ActionState>;
};

// =============================================================================
// UI Types
// =============================================================================

export type OpenGroup = {
  repoId: string;
  repoName: string;
  workspaces: Workspace[];
};

// =============================================================================
// Constants
// =============================================================================

export const AGENTS: Agent[] = [
  { id: "claude-code", name: "Claude Code", description: "Full development assistant" },
  { id: "codex", name: "Codex", description: "OpenAI Codex agent" },
  { id: "gemini", name: "Gemini", description: "Google Gemini" },
];

export const STATUS_ICONS = {
  running: "▸",
  update: "↻",
  done: "✓",
  fail: "✗",
} as const;
