import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, ExternalLink, Minus, Plus, RefreshCw, Undo2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { parseUnifiedDiff, type DiffLine } from "../lib/diff";
import { openPath, saveOutputText } from "../lib/bridge";
import { editedPaths } from "../lib/agent";
import { humanizeGitStatus, isTauri, shortcutLabel } from "../lib/format";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import type { GitFile } from "../lib/types";
import { TaskMonitor } from "./TaskMonitor";

export function ReviewDock() {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    git: state.git,
    gitLoading: state.gitLoading,
    gitError: state.gitError,
    preview: state.preview,
    dockOpen: state.dockOpen,
    inspectorTab: state.inspectorTab,
    diffTabs: state.diffTabs,
    diffActive: state.diffActive,
    refreshGit: state.refreshGit,
    openFileDiff: state.openFileDiff,
    closeFileDiff: state.closeFileDiff,
    setActiveDiff: state.setActiveDiff,
    setInspectorTab: state.setInspectorTab,
    setDockOpen: state.setDockOpen,
    discardGitFiles: state.discardGitFiles,
    discardGitHunk: state.discardGitHunk,
    discardAllGit: state.discardAllGit,
    stageGitFiles: state.stageGitFiles,
    commitGit: state.commitGit,
    confirm: state.confirm,
  })));
  const workspace = currentWorkspace(s);
  const thread = currentThread(s);
  const [showUntracked, setShowUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const parsed = useMemo(() => s.git?.diff ? parseUnifiedDiff(s.git.diff) : { files: [], truncated: false }, [s.git?.diff]);
  const autoOpen = parsed.files[0]?.path ?? null;
  const visible = s.diffTabs ?? (autoOpen ? [autoOpen] : []);
  const openFiles = parsed.files.filter((file) => visible.includes(file.path));
  const activeFile = openFiles.find((file) => file.path === s.diffActive) ?? openFiles[0];
  const sessionPaths = useMemo(() => new Set(editedPaths(thread?.items ?? [], workspace?.path)), [thread?.items, workspace?.path]);
  const sessionFiles = useMemo(() => (s.git?.files ?? []).filter((file) => sessionPaths.has(file.path)), [s.git?.files, sessionPaths]);
  const otherFiles = useMemo(() => (s.git?.files ?? []).filter((file) => !sessionPaths.has(file.path)), [s.git?.files, sessionPaths]);
  useEffect(() => { setShowUntracked(false); setError(null); }, [workspace?.id]);
  useEffect(() => {
    if (workspace && !s.git && !s.gitLoading && !s.gitError && !s.preview) void s.refreshGit();
  }, [workspace?.id]);
  const lines = activeFile?.lines ?? [];
  // Hunk groups with true per-file indices (the native side counts the same
  // `@@` blocks from a fresh diff); the render cap cuts groups, never indices.
  const hunks = useMemo(() => {
    const groups: { index: number; header: DiffLine; lines: DiffLine[]; start: number }[] = [];
    lines.forEach((line, at) => {
      if (line.type === "hunk") groups.push({ index: groups.length, header: line, lines: [], start: at });
      else if (groups.length) groups[groups.length - 1].lines.push(line);
    });
    return groups;
  }, [lines]);
  const renderedHunks = useMemo(() => {
    const capped: typeof hunks = [];
    let count = 0;
    for (const group of hunks) {
      if (count >= 2000) break;
      capped.push(group);
      count += 1 + group.lines.length;
    }
    return capped;
  }, [hunks]);
  // Every hook runs before the dock can bail out: a closed dock that skipped
  // the hunk memos would render more hooks the moment it opened, which React
  // rejects outright (error #310).
  if (!s.dockOpen) return null;
  const fileCount = s.git?.files.length ?? 0;
  const added = s.git?.files.reduce((sum, file) => sum + file.added, 0) ?? 0;
  const removed = s.git?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const openFile = (path: string) => {
    setError(null);
    s.openFileDiff(path);
  };
  const closeFile = (path: string) => s.closeFileDiff(path);
  const granted = () => {
    if (workspace?.grantId || !isTauri()) return true;
    setError("This folder is not granted. Re-open it to restore access.");
    return false;
  };
  const discardOne = async (file: GitFile) => {
    if (!workspace || !granted()) return;
    const label = file.status === "??"
      ? `Delete new file ${file.path}?`
      : `Discard changes to ${file.path}?`;
    if (!(await s.confirm({ title: label, body: "This cannot be undone.", confirmLabel: file.status === "??" ? "Delete" : "Discard", danger: true }))) return;
    setError(null);
    try {
      await s.discardGitFiles([file.path]);
    } catch (cause) {
      setError(`Could not discard ${file.path}: ${String(cause)}`);
    }
  };
  const discardHunk = async (path: string, hunk: number) => {
    if (!workspace || !granted()) return;
    if (!(await s.confirm({ title: `Discard hunk ${hunk + 1} of ${path}?`, body: "The file is unstaged first. This cannot be undone.", confirmLabel: "Discard", danger: true }))) return;
    setError(null);
    try {
      await s.discardGitHunk(path, hunk);
    } catch (cause) {
      setError(`Could not discard hunk: ${String(cause)}`);
    }
  };
  const discardAll = async () => {
    if (!workspace || !fileCount || !granted()) return;
    if (!(await s.confirm({ title: `Discard all ${fileCount} uncommitted change${fileCount === 1 ? "" : "s"}?`, body: "Tracked files restore, new files are deleted. This cannot be undone.", confirmLabel: "Discard all", danger: true }))) return;
    setError(null);
    try {
      await s.discardAllGit();
    } catch (cause) {
      setError(`Could not discard changes: ${String(cause)}`);
    }
  };
  const toggleStage = async (file: GitFile) => {
    if (!workspace || !granted()) return;
    const staged = file.status[0] !== " " && file.status[0] !== "?";
    setError(null);
    try {
      await s.stageGitFiles([file.path], !staged);
    } catch (cause) {
      setError(`Could not ${staged ? "unstage" : "stage"} ${file.path}: ${String(cause)}`);
    }
  };
  const renderRow = (file: GitFile) => {
    const staged = file.status[0] !== " " && file.status[0] !== "?";
    return (
    <div key={file.path} className={`file-row ${activeFile?.path === file.path ? "active" : ""}`}>
      <button className="file-open" title={`${humanizeGitStatus(file.status)} · ${file.path}`} onClick={() => openFile(file.path)}>
        <span className="path">{file.path}</span>
        <span className={`file-status s-${file.status.trim().replace("??", "new") || "m"}`}>{humanizeGitStatus(file.status)}</span>
        {file.status !== "??" && <><span className="add">+{file.added}</span><span className="del">−{file.removed}</span></>}
      </button>
      <button className="icon-btn small" aria-label={`${staged ? "Unstage" : "Stage"} ${file.path}`} title={staged ? "Unstage" : "Stage"} aria-pressed={staged} onClick={() => void toggleStage(file)}>{staged ? <Minus size={13} /> : <Plus size={13} />}</button>
      <button className="icon-btn small file-discard" aria-label={`Discard changes to ${file.path}`} title="Discard changes" onClick={() => void discardOne(file)}><Undo2 size={13} /></button>
    </div>
    );
  };
  const stagedCount = (s.git?.files ?? []).filter((file) => file.status[0] !== " " && file.status[0] !== "?").length;
  // Session files always show (new files the agent created included); unrelated
  // untracked files hide behind a toggle so the list stays scannable.
  const hiddenUntracked = otherFiles.filter((file) => file.status === "??");
  const visibleOther = showUntracked ? otherFiles : otherFiles.filter((file) => file.status !== "??");
  const untrackedToggle = hiddenUntracked.length ? (
    <button type="button" className="text-btn dock-toggle" aria-expanded={showUntracked} onClick={() => setShowUntracked((show) => !show)}>
      {showUntracked ? "Hide untracked files" : `Show ${hiddenUntracked.length} untracked file${hiddenUntracked.length === 1 ? "" : "s"}`}
    </button>
  ) : null;
  return <aside className="dock" aria-label="Inspector">
    <div className="dock-head">
      <div className="segmented" role="tablist" aria-label="Changes view">
        <button role="tab" className={s.inspectorTab === "changes" ? "active" : ""} aria-selected={s.inspectorTab === "changes"} onClick={() => s.setInspectorTab("changes")}>Changes{fileCount ? <span className="count">{fileCount}</span> : null}</button>
        <button role="tab" className={s.inspectorTab === "diff" ? "active" : ""} aria-selected={s.inspectorTab === "diff"} onClick={() => s.setInspectorTab("diff")}>Diff</button>
        <button role="tab" className={s.inspectorTab === "activity" ? "active" : ""} aria-selected={s.inspectorTab === "activity"} onClick={() => s.setInspectorTab("activity")}>Monitor</button>
      </div>
      {s.inspectorTab !== "activity" && fileCount ? <span className="dock-stat"><span className="add">+{added}</span><span className="del">−{removed}</span></span> : <span className="grow" />}
      <button className="icon-btn small" aria-label="Refresh changes" title="Refresh" disabled={!workspace || s.gitLoading} onClick={() => void s.refreshGit()}><RefreshCw size={13} className={s.gitLoading ? "spin" : ""} /></button>
      <button className="icon-btn small" aria-label="Close changes" title={`Close  ${shortcutLabel("I")}`} onClick={() => s.setDockOpen(false)}><X size={14} /></button>
    </div>
    {s.gitLoading && <p className="review-note">Refreshing changes…</p>}
    {(s.gitError || error) && <div className="banner" role="alert"><span>{s.gitError || error}</span><button className="ghost-btn small" onClick={() => { setError(null); void s.refreshGit(); }}>Retry</button></div>}
    {!workspace ? <p className="review-note">Open a workspace to review changes.</p> : !s.git && !s.gitLoading && !s.gitError ? <p className="review-note">Loading changes…</p> : null}
    {s.inspectorTab === "activity" ? <TaskMonitor /> : s.git && s.inspectorTab === "changes" ? <div className="scroll">
      {fileCount ? <form className="commit-box" onSubmit={(event) => {
        event.preventDefault();
        if (!workspace || !granted() || !commitMessage.trim() || !stagedCount) return;
        setError(null);
        void s.commitGit(commitMessage.trim()).then(() => setCommitMessage(""), (cause) => setError(`Could not commit: ${String(cause)}`));
      }}>
        <input aria-label="Commit message" placeholder={stagedCount ? `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}` : "Stage files to commit"} value={commitMessage} maxLength={2000} onChange={(event) => setCommitMessage(event.target.value)} />
        <button type="submit" className="ghost-btn small" disabled={!stagedCount || !commitMessage.trim()} title={stagedCount ? "Commit staged changes" : "Stage files first"}><Check size={12} />Commit</button>
      </form> : null}
      {sessionFiles.length ? <>
        <h3 className="dock-group">This session</h3>
        {sessionFiles.map(renderRow)}
        {visibleOther.length || untrackedToggle ? <h3 className="dock-group">Other uncommitted changes</h3> : null}
        {visibleOther.map(renderRow)}
        {untrackedToggle}
      </> : <>
        {visibleOther.map(renderRow)}
        {untrackedToggle}
        {!s.git.files.length && <p className="review-note">Working tree is clean.</p>}
      </>}
      {fileCount > 1 ? <button type="button" className="text-btn dock-toggle dock-danger" onClick={() => void discardAll()}>Discard all {fileCount} changes</button> : null}
    </div> : s.git ? <div className="diff-pane">
      {s.git.truncated || parsed.truncated ? <p className="review-note">Diff truncated for performance.</p> : null}
      {s.git.files.some((file) => file.status === "??") && <p className="review-note">New files are listed under Changes. The diff covers tracked changes.</p>}
      {openFiles.length ? <div className="file-tabs" role="tablist" aria-label="Open files">{openFiles.map((file) => <div key={file.path} className={`file-tab ${file.path === activeFile?.path ? "active" : ""}`}>
        <button role="tab" aria-selected={file.path === activeFile?.path} title={file.path} onClick={() => s.setActiveDiff(file.path)}>{file.path.split("/").pop()}</button>
        <button className="file-tab-close" aria-label={`Close ${file.path}`} title="Close file" onClick={() => closeFile(file.path)}><X size={11} /></button>
      </div>)}</div> : null}
      <div className="diff" role="log" aria-label="Uncommitted diff">
        {activeFile ? <div className="diff-toolbar"><span className="path">{activeFile.path}</span><button className="icon-btn small" aria-label="Open file" title="Open file" onClick={() => { if (!workspace) return; if (!workspace.grantId && isTauri()) { setError("This folder is not granted. Re-open it to restore access."); return; } void openPath(`${workspace.path}/${activeFile.path}`, workspace.grantId ?? "preview").catch((cause) => setError(`Could not open file: ${String(cause)}`)); }}><ExternalLink size={13} /></button><button className="icon-btn small" aria-label="Copy patch" title="Copy patch" onClick={() => void navigator.clipboard.writeText(activeFile.header.concat(activeFile.lines.map((line) => line.text)).join("\n"))}><Copy size={13} /></button><button className="icon-btn small" aria-label="Export patch" title="Export patch" onClick={() => { if (!activeFile) return; const name = activeFile.path.split("/").pop() ?? "patch"; void saveOutputText(`${name}.patch`, activeFile.header.concat(activeFile.lines.map((line) => line.text)).join("\n"), false).catch((cause) => setError(`Could not export patch: ${String(cause)}`)); }}><Download size={13} /></button><button className="icon-btn small" aria-label={`Discard changes to ${activeFile.path}`} title="Discard changes" onClick={() => { const match = (s.git?.files ?? []).find((file) => file.path === activeFile.path); if (match) void discardOne(match); }}><Undo2 size={13} /></button></div> : null}
        {!lines.length && <p className="review-note">{parsed.files.length && !openFiles.length ? "No file open. Choose one from Changes." : s.git.dirty ? "Changed files are untracked or non-text. See Changes." : "No uncommitted changes."}</p>}
        {renderedHunks.map((group) => (
          <div key={group.start} className="hunk-block">
            <div className="hunk hunk-head"><span>{group.header.text}</span>{activeFile ? <button className="icon-btn small" aria-label={`Discard hunk ${group.index + 1} of ${activeFile.path}`} title="Discard hunk (unstages the file)" onClick={() => void discardHunk(activeFile.path, group.index)}><Undo2 size={11} /></button> : null}</div>
            {group.lines.map((line, index) => <div key={index} className={line.type === "add" ? "plus" : line.type === "del" ? "minus" : line.type === "meta" ? "meta" : "ctx"}>{line.text}</div>)}
          </div>
        ))}
        {renderedHunks.length < hunks.length ? <p className="review-note">Showing the first hunks of this file.</p> : null}
      </div>
    </div> : null}
  </aside>;
}
