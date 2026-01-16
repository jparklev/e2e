import { PatchDiff } from "@pierre/diffs/react";
import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import type { Workspace, WorkspaceChange } from "../types";
import { splitFilePath, statusClass, statusLabel } from "../utils";

type Props = {
  activeWorkspace: Workspace | null;
  files: string[];
  changes: WorkspaceChange[];
  filteredChanges: WorkspaceChange[];
  filteredAllFiles: string[];
  filesLoading: boolean;
  fileFilter: string;
  showAllFiles: boolean;
  selectedFile: string | null;
  fileError: string | null;
  fileDiff: string | null;
  fileContent: string | null;
  fileViewLoading: boolean;
  onFileFilterChange: (v: string) => void;
  onToggleShowAll: () => void;
  onSelectFile: (p: string) => void;
};

function inferLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    rs: "rust", py: "python", go: "go", java: "java",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", css: "css", html: "html", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash",
  };
  return langMap[ext] ?? "text";
}

function CodeHighlight({ code, filename }: { code: string; filename: string }) {
  const [html, setHtml] = useState<string>("");
  const lang = inferLanguage(filename);

  useEffect(() => {
    let cancelled = false;
    codeToHtml(code, { lang, theme: "github-light" })
      .then((result) => { if (!cancelled) setHtml(result); })
      .catch(() => { if (!cancelled) setHtml(`<pre>${code}</pre>`); });
    return () => { cancelled = true; };
  }, [code, lang]);

  if (!html) return <pre className="code-pre">{code}</pre>;
  return <div className="code-highlight" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function FilesPanel({
  activeWorkspace, files, changes, filteredChanges, filteredAllFiles, filesLoading,
  fileFilter, showAllFiles, selectedFile, fileError, fileDiff, fileContent, fileViewLoading,
  onFileFilterChange, onToggleShowAll, onSelectFile,
}: Props) {
  return (
    <aside className="files-panel">
      <div className="panel-card">
        <div className="card-row">
          <span className="card-title">Files</span>
          <span className="card-meta">{activeWorkspace ? `${changes.length} changed` : "—"}</span>
        </div>
        <div className="file-controls">
          <input className="input small" placeholder="Filter..." value={fileFilter}
            onChange={(e) => onFileFilterChange(e.currentTarget.value)} disabled={!activeWorkspace || filesLoading} />
          <button className="btn ghost small" onClick={onToggleShowAll}
            disabled={!activeWorkspace || filesLoading || files.length === 0}>
            {showAllFiles ? "Changed" : "All"}
          </button>
        </div>
        <div className="file-list">
          {!activeWorkspace && <div className="muted">Select workspace</div>}
          {activeWorkspace && filesLoading && <div className="muted">Loading...</div>}
          {activeWorkspace && !filesLoading && files.length === 0 && <div className="muted">No files</div>}
          {activeWorkspace && !filesLoading && files.length > 0 && (
            <>
              {filteredChanges.length > 0 && (
                <div className="file-section">
                  <div className="file-section-title">Changed ({filteredChanges.length})</div>
                  {filteredChanges.map((change) => {
                    const { dir, base } = splitFilePath(change.path);
                    const isActive = change.path === selectedFile;
                    return (
                      <button key={change.path} className={`file-item${isActive ? " active" : ""}`}
                        onClick={() => onSelectFile(change.path)}>
                        <div className="file-main">
                          <span className="file-path">
                            {dir && <span className="file-dir">{dir}/</span>}
                            <span className="file-name">{base}</span>
                          </span>
                          {change.old_path && <span className="file-rename">← {change.old_path}</span>}
                        </div>
                        <span className={`file-status ${statusClass(change.status)}`} title={statusLabel(change.status)}>
                          {change.status}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {showAllFiles && filteredAllFiles.length > 0 && (
                <div className="file-section">
                  <div className="file-section-title">All ({filteredAllFiles.length})</div>
                  {filteredAllFiles.map((file) => {
                    const { dir, base } = splitFilePath(file);
                    const isActive = file === selectedFile;
                    return (
                      <button key={file} className={`file-item${isActive ? " active" : ""}`}
                        onClick={() => onSelectFile(file)}>
                        <div className="file-main">
                          <span className="file-path">
                            {dir && <span className="file-dir">{dir}/</span>}
                            <span className="file-name">{base}</span>
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className="panel-card diff">
        <div className="card-title">Preview</div>
        <div className="preview-body">
          {!selectedFile && <div className="muted">Select a file</div>}
          {selectedFile && fileViewLoading && <div className="muted">Loading...</div>}
          {selectedFile && fileError && <div className="inline-error">{fileError}</div>}
          {selectedFile && !fileViewLoading && !fileError && fileDiff && <PatchDiff patch={fileDiff} />}
          {selectedFile && !fileViewLoading && !fileError && !fileDiff && fileContent !== null && (
            <CodeHighlight code={fileContent} filename={selectedFile} />
          )}
        </div>
      </div>
    </aside>
  );
}
