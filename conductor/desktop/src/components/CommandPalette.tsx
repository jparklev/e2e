import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Fuse from "fuse.js";
import type { Repo, Workspace } from "../types";

export type CommandAction = {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  category: "workspace" | "repo" | "action" | "navigation";
  onSelect: () => void;
};

type Props = {
  open: boolean;
  onClose: () => void;
  repos: Repo[];
  workspaces: Workspace[];
  onOpenWorkspace: (id: string) => void;
  onCreateWorkspace: (repoId: string) => void;
  onRefresh: () => void;
};

export function CommandPalette({
  open,
  onClose,
  repos,
  workspaces,
  onOpenWorkspace,
  onCreateWorkspace,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build command list
  const commands = useMemo<CommandAction[]>(() => {
    const cmds: CommandAction[] = [];

    // Workspace commands
    workspaces.forEach((ws) => {
      cmds.push({
        id: `open-ws-${ws.id}`,
        label: ws.name,
        description: `${ws.repo} · ${ws.branch}`,
        category: "workspace",
        onSelect: () => onOpenWorkspace(ws.id),
      });
    });

    // New workspace commands for each repo
    repos.forEach((repo) => {
      cmds.push({
        id: `new-ws-${repo.id}`,
        label: `New workspace in ${repo.name}`,
        description: "Create a new workspace",
        category: "repo",
        onSelect: () => onCreateWorkspace(repo.id),
      });
    });

    // General actions
    cmds.push({
      id: "refresh",
      label: "Refresh",
      description: "Reload repos and workspaces",
      shortcut: "⌘R",
      category: "action",
      onSelect: onRefresh,
    });

    return cmds;
  }, [repos, workspaces, onOpenWorkspace, onCreateWorkspace, onRefresh]);

  // Fuzzy search
  const fuse = useMemo(
    () =>
      new Fuse(commands, {
        keys: ["label", "description"],
        threshold: 0.4,
        distance: 100,
      }),
    [commands]
  );

  const results = useMemo(() => {
    if (!query.trim()) return commands.slice(0, 15);
    return fuse.search(query).slice(0, 15).map((r) => r.item);
  }, [fuse, commands, query]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[selectedIndex]) {
          results[selectedIndex].onSelect();
          onClose();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [results, selectedIndex, onClose]
  );

  // Global Cmd+K is handled in App.tsx
  // This component only handles local navigation (Arrows, Enter, Esc)

  if (!open) return null;

  const categoryLabels: Record<string, string> = {
    workspace: "Workspaces",
    repo: "Repositories",
    action: "Actions",
    navigation: "Navigation",
  };

  // Group results by category
  const grouped = results.reduce(
    (acc, cmd) => {
      if (!acc[cmd.category]) acc[cmd.category] = [];
      acc[cmd.category].push(cmd);
      return acc;
    },
    {} as Record<string, CommandAction[]>
  );

  let flatIndex = 0;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-header">
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Search workspaces, actions..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <kbd className="command-palette-shortcut">⌘K</kbd>
        </div>
        <div className="command-palette-results">
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category} className="command-palette-group">
              <div className="command-palette-group-title">
                {categoryLabels[category] ?? category}
              </div>
              {items.map((cmd) => {
                const idx = flatIndex++;
                return (
                  <button
                    key={cmd.id}
                    className={`command-palette-item${idx === selectedIndex ? " selected" : ""}`}
                    onClick={() => {
                      cmd.onSelect();
                      onClose();
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className="command-palette-item-main">
                      <span className="command-palette-item-label">{cmd.label}</span>
                      {cmd.description && (
                        <span className="command-palette-item-desc">{cmd.description}</span>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <kbd className="command-palette-item-shortcut">{cmd.shortcut}</kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
          {results.length === 0 && (
            <div className="command-palette-empty">No results found</div>
          )}
        </div>
      </div>
    </div>
  );
}
