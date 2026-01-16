import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys, queryFns } from "./query";

// Hook for repos list
export function useRepos(home?: string) {
  return useQuery({
    queryKey: queryKeys.repos(home),
    queryFn: () => queryFns.listRepos(home),
  });
}

// Hook for workspaces list
export function useWorkspaces(home?: string) {
  return useQuery({
    queryKey: queryKeys.workspaces(home),
    queryFn: () => queryFns.listWorkspaces(home),
  });
}

// Hook for workspace files
export function useWorkspaceFiles(home: string | undefined, wsId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaceFiles(home, wsId ?? ""),
    queryFn: () => queryFns.workspaceFiles(home, wsId!),
    enabled: !!wsId,
  });
}

// Hook for workspace changes
export function useWorkspaceChanges(home: string | undefined, wsId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaceChanges(home, wsId ?? ""),
    queryFn: () => queryFns.workspaceChanges(home, wsId!),
    enabled: !!wsId,
  });
}

// Hook for file diff
export function useFileDiff(home: string | undefined, wsId: string | null, path: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaceFileDiff(home, wsId ?? "", path ?? ""),
    queryFn: () => queryFns.workspaceFileDiff(home, wsId!, path!),
    enabled: !!wsId && !!path,
  });
}

// Hook for file content
export function useFileContent(home: string | undefined, wsId: string | null, path: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaceFileContent(home, wsId ?? "", path ?? ""),
    queryFn: () => queryFns.workspaceFileContent(home, wsId!, path!),
    enabled: !!wsId && !!path,
  });
}

// Hook for adding repo
export function useAddRepo(home?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => queryFns.addRepoUrl(home, url),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repos(home) });
    },
  });
}

// Hook for creating workspace
export function useCreateWorkspace(home?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ repoId, name }: { repoId: string; name?: string }) =>
      queryFns.createWorkspace(home, repoId, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces(home) });
    },
  });
}

// Hook to invalidate workspace files (for refreshing after agent changes)
export function useInvalidateWorkspaceFiles() {
  const queryClient = useQueryClient();
  return (home: string | undefined, wsId: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaceFiles(home, wsId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaceChanges(home, wsId) });
  };
}

// =============================================================================
// Session Persistence Hooks
// =============================================================================

// Hook for reading session state
export function useSession(wsPath: string | null) {
  return useQuery({
    queryKey: queryKeys.session(wsPath ?? ""),
    queryFn: () => queryFns.sessionRead(wsPath!),
    enabled: !!wsPath,
  });
}

// Hook for creating a new session
export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsPath, agentId }: { wsPath: string; agentId: string }) =>
      queryFns.sessionCreate(wsPath, agentId),
    onSuccess: (_, { wsPath }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.session(wsPath) });
    },
  });
}

// Hook for setting resume ID
export function useSetResumeId() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsPath, resumeId }: { wsPath: string; resumeId: string }) =>
      queryFns.sessionSetResumeId(wsPath, resumeId),
    onSuccess: (_, { wsPath }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.session(wsPath) });
    },
  });
}

// Hook for upserting resume ID (creates session if missing)
export function useUpsertResumeId() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsPath, agentId, resumeId }: { wsPath: string; agentId: string; resumeId: string }) =>
      queryFns.sessionUpsertResumeId(wsPath, agentId, resumeId),
    onSuccess: (_, { wsPath }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.session(wsPath) });
    },
  });
}

// =============================================================================
// Chat Persistence Hooks
// =============================================================================

// Hook for reading chat history
export function useChat(wsPath: string | null) {
  return useQuery({
    queryKey: queryKeys.chat(wsPath ?? ""),
    queryFn: () => queryFns.chatRead(wsPath!),
    enabled: !!wsPath,
  });
}

// Hook for appending to chat
export function useAppendChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ wsPath, role, content }: { wsPath: string; role: string; content: string }) =>
      queryFns.chatAppend(wsPath, role, content),
    onSuccess: (_, { wsPath }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(wsPath) });
    },
  });
}

// Hook for clearing chat
export function useClearChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (wsPath: string) => queryFns.chatClear(wsPath),
    onSuccess: (_, wsPath) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat(wsPath) });
    },
  });
}
