import { QueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import type { Repo, SessionState, Workspace, WorkspaceChange } from "../types";

// Query client with sensible defaults
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Type-safe Tauri invoke wrapper
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

// Query keys factory
export const queryKeys = {
  repos: (home?: string) => ["repos", home] as const,
  workspaces: (home?: string) => ["workspaces", home] as const,
  workspaceFiles: (home: string | undefined, wsId: string) => ["workspace-files", home, wsId] as const,
  workspaceChanges: (home: string | undefined, wsId: string) => ["workspace-changes", home, wsId] as const,
  workspaceFileDiff: (home: string | undefined, wsId: string, path: string) => ["workspace-file-diff", home, wsId, path] as const,
  workspaceFileContent: (home: string | undefined, wsId: string, path: string) => ["workspace-file-content", home, wsId, path] as const,
  session: (wsPath: string) => ["session", wsPath] as const,
  chat: (wsPath: string) => ["chat", wsPath] as const,
};

// Query functions
export const queryFns = {
  listRepos: (home?: string) =>
    tauriInvoke<Repo[]>("list_repos", home ? { home } : {}),

  listWorkspaces: (home?: string) =>
    tauriInvoke<Workspace[]>("list_workspaces", { ...(home ? { home } : {}), repo: null }),

  workspaceFiles: (home: string | undefined, wsId: string) =>
    tauriInvoke<string[]>("workspace_files", { ...(home ? { home } : {}), workspace: wsId }),

  workspaceChanges: (home: string | undefined, wsId: string) =>
    tauriInvoke<WorkspaceChange[]>("workspace_changes", { ...(home ? { home } : {}), workspace: wsId }),

  workspaceFileDiff: (home: string | undefined, wsId: string, path: string) =>
    tauriInvoke<string>("workspace_file_diff", { ...(home ? { home } : {}), workspace: wsId, path }),

  workspaceFileContent: (home: string | undefined, wsId: string, path: string) =>
    tauriInvoke<string>("workspace_file_content", { ...(home ? { home } : {}), workspace: wsId, path }),

  resolveHome: (path: string) =>
    tauriInvoke<string>("resolve_home_path", path ? { home: path } : {}),

  addRepoUrl: (home: string | undefined, url: string) =>
    tauriInvoke<Repo>("add_repo_url", { ...(home ? { home } : {}), url }),

  createWorkspace: (home: string | undefined, repoId: string, name?: string) =>
    tauriInvoke<Workspace>("create_workspace", { ...(home ? { home } : {}), repo: repoId, name: name || null }),

  // Session persistence
  sessionRead: (wsPath: string) =>
    tauriInvoke<SessionState | null>("session_read", { workspacePath: wsPath }),

  sessionCreate: (wsPath: string, agentId: string) =>
    tauriInvoke<SessionState>("session_create", { workspacePath: wsPath, agentId }),

  sessionSetResumeId: (wsPath: string, resumeId: string) =>
    tauriInvoke<SessionState>("session_set_resume_id", { workspacePath: wsPath, resumeId }),

  sessionUpsertResumeId: (wsPath: string, agentId: string, resumeId: string) =>
    tauriInvoke<SessionState>("session_upsert_resume_id", { workspacePath: wsPath, agentId, resumeId }),

  // Chat persistence
  chatRead: (wsPath: string) =>
    tauriInvoke<string>("chat_read", { workspacePath: wsPath }),

  chatAppend: (wsPath: string, role: string, content: string) =>
    tauriInvoke<void>("chat_append", { workspacePath: wsPath, role, content }),

  chatClear: (wsPath: string) =>
    tauriInvoke<void>("chat_clear", { workspacePath: wsPath }),
};
