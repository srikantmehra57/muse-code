import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Download, Folder, FolderOpen, GitFork, LoaderCircle, LogOut, MoreHorizontal, PanelLeft, Pencil, Pin, PinOff, Plus, RotateCcw, ScanSearch, Search, Settings, ShieldCheck, SquarePen, Trash2, X } from "lucide-react";
import { formatResetIn, relativeTime, shortcutLabel, threadMatches, usageWindowLabel } from "../lib/format";
import { exportSession } from "../lib/bridge";
import { currentWorkspace, readyAgents, useAppStore } from "../lib/store";
import { AgentMark } from "./AgentPicker";
import { agentEnabled, type SubscriptionUsage, type Thread, type Workspace } from "../lib/types";

function ThreadStatus({ thread }: { thread: Thread }) {
  if (thread.status === "running") return <span className="thread-status running" aria-label="Running" />;
  if (thread.status === "error" || thread.lastOutcome === "failed") return <span className="thread-status error" aria-label="Failed" />;
  if (thread.unread) return <span className="thread-status unread" aria-label="Unread" />;
  return null;
}

function UsageBar({ percent }: { percent: number }) {
  const rounded = Math.round(percent);
  const tone = rounded >= 100 ? " over" : rounded >= 80 ? " high" : "";
  return (
    <span className={`usage-bar${tone}`} role="img" aria-label={`${rounded}% used`}>
      <span style={{ width: `${Math.min(100, Math.max(0, rounded))}%` }} />
    </span>
  );
}

function UsageRow({ label, percent, resetsAtMs, now }: { label: string; percent: number; resetsAtMs: number; now: number }) {
  return (
    <div className="usage-row">
      <div className="usage-row-head"><span>{label}</span><span className="usage-pct">{Math.round(percent)}%</span></div>
      <UsageBar percent={percent} />
      <div className="usage-sub">{formatResetIn(resetsAtMs, now)}</div>
    </div>
  );
}

function UsageCard({ usage, now, refreshing, onRefresh }: { usage: SubscriptionUsage; now: number; refreshing: boolean; onRefresh: () => void }) {
  const ago = relativeTime(new Date(usage.observedAtMs).toISOString());
  return (
    <div className="usage-pop" role="status" aria-label="Subscription usage">
      <div className="usage-head">
        <span className="usage-title">Subscription usage</span>
        <button
          type="button"
          className="icon-btn small usage-refresh"
          aria-label="Refresh usage"
          title="Refresh usage"
          disabled={refreshing}
          onClick={(event) => { event.stopPropagation(); onRefresh(); }}
        >
          {refreshing ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
        </button>
      </div>
      <UsageRow label={usageWindowLabel(usage.window.windowDurationMins)} percent={usage.window.usedPercent} resetsAtMs={usage.window.resetsAtMs} now={now} />
      <UsageRow label="Weekly" percent={usage.weekly.usedPercent} resetsAtMs={usage.weekly.resetsAtMs} now={now} />
      <div className="usage-foot"><span>as of {ago === "now" ? "now" : `${ago} ago`}</span></div>
    </div>
  );
}

function AccountUsage() {
  const usage = useAppStore((state) => state.subscriptionUsage);
  const loading = useAppStore((state) => state.subscriptionUsageLoading);
  const error = useAppStore((state) => state.subscriptionUsageError);
  const authenticated = useAppStore((state) => state.detection?.authenticated);
  const refresh = useAppStore((state) => state.refreshSubscriptionUsage);
  const [now] = useState(() => Date.now());
  if (usage) return <UsageCard usage={usage} now={now} refreshing={loading} onRefresh={() => void refresh(true)} />;
  if (loading) return <div className="usage-pop" role="status"><div className="usage-state"><LoaderCircle size={13} className="spin" aria-hidden="true" />Reading usage…</div></div>;
  if (error) {
    return (
      <div className="usage-pop" role="alert">
        <div className="usage-state">{error}</div>
        <button type="button" className="ghost-btn small" onClick={(event) => { event.stopPropagation(); void refresh(true); }}><RotateCcw size={11} />Retry</button>
      </div>
    );
  }
  return (
    <div className="usage-pop" role="status">
      <div className="usage-state">{authenticated === false ? "Sign in with the Muse CLI to see usage." : "No usage observed yet — it appears after your first turn."}</div>
      {authenticated !== false ? <button type="button" className="ghost-btn small" onClick={(event) => { event.stopPropagation(); void refresh(true); }}><RotateCcw size={11} />Check again</button> : null}
    </div>
  );
}

export function Sidebar({ onOpenThreads }: { onOpenThreads?: () => void } = {}) {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    threadsLoading: state.threadsLoading,
    threadSearch: state.threadSearch,
    enabledAgents: state.enabledAgents,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    preview: state.preview,
    offline: state.offline,
    detection: state.detection,
    agents: state.agents,
    museBin: state.museBin,
    starting: state.starting,
    sidebarCollapsed: state.sidebarCollapsed,
    loadWorkspaceThreads: state.loadWorkspaceThreads,
    newThread: state.newThread,
    exitPreview: state.exitPreview,
    setThreadSearch: state.setThreadSearch,
    selectWorkspace: state.selectWorkspace,
    chooseProject: state.chooseProject,
    removeWorkspace: state.removeWorkspace,
    renameThread: state.renameThread,
    selectThread: state.selectThread,
    pinThread: state.pinThread,
    reorderThreads: state.reorderThreads,
    setSidebarCollapsed: state.setSidebarCollapsed,
    setSettingsOpen: state.setSettingsOpen,
    forkThread: state.forkThread,
    openPreview: state.openPreview,
    deleteThread: state.deleteThread,
    refreshSubscriptionUsage: state.refreshSubscriptionUsage,
    confirm: state.confirm,
    openTrustDialog: state.openTrustDialog,
  })));
  const workspace = useAppStore(currentWorkspace);
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  // Every workspace expands on its own; selecting one opens it.
  const [expanded, setExpanded] = useState<string[]>(() => s.selectedWorkspaceId ? [s.selectedWorkspaceId] : []);
  const loaded = useRef(new Set<string>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const isOpen = (id: string) => expanded.includes(id);
  // The caret toggles expansion without touching the selection; collapsing
  // drops the loaded mark so the next expand refetches the list.
  const toggleOpen = (id: string) => setExpanded((ids) => {
    if (!ids.includes(id)) return [...ids, id];
    loaded.current.delete(id);
    return ids.filter((item) => item !== id);
  });

  const visible = useMemo(() => {
    return s.threads
      .filter((thread) => !thread.archived)
      .filter((thread) => agentEnabled(s, thread.agentId ?? "muse"))
      .filter((thread) => threadMatches(thread, s.threadSearch))
      .slice()
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.order ?? 0) - (a.order ?? 0));
  }, [s.threads, s.threadSearch, s.enabledAgents]);
  const threadsFor = (item: Workspace) => visible.filter((thread) => thread.workspacePath === item.path);

  useEffect(() => {
    if (s.selectedWorkspaceId) setExpanded((ids) => ids.includes(s.selectedWorkspaceId!) ? ids : [...ids, s.selectedWorkspaceId!]);
  }, [s.selectedWorkspaceId]);

  // An expanded workspace fills its own list; the selected one is already
  // loading through selectWorkspace, so mark it instead of listing twice.
  useEffect(() => {
    for (const id of expanded) {
      if (id === s.selectedWorkspaceId) { loaded.current.add(id); continue; }
      if (loaded.current.has(id)) continue;
      loaded.current.add(id);
      void s.loadWorkspaceThreads(id);
    }
  }, [expanded, s.selectedWorkspaceId]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => { window.clearTimeout(timer); document.removeEventListener("click", close); };
  }, [menu]);

  const showSearch = searching || Boolean(s.threadSearch);
  const ready = readyAgents(s);
  const accountName = s.detection?.accountName || s.detection?.accountEmail || "Muse Code";
  const installed = s.agents.filter((agent) => agent.found);
  const status = s.preview ? "Preview · demo data" : s.offline ? "Offline" : ready.length ? ready.map((agent) => agent.name).join(" · ") : installed.length ? "Sign in needed" : "No agent CLI found";
  const statusTone = s.preview ? "idle" : s.offline || !installed.length ? "bad" : ready.length ? "good" : "warn";
  const statusTitle = installed.map((agent) => `${agent.name}${agent.version ? ` ${agent.version}` : ""} — ${agent.path}`).join("\n") || undefined;
  const newThread = () => { onOpenThreads?.(); void s.newThread(); };
  const exportThread = async (thread: Thread, redacted: boolean) => {
    setMenu(null);
    try {
      const path = await exportSession({ sessionId: thread.sessionId, title: thread.title, museBin: s.museBin, redacted });
      if (path) window.alert(`Muse session exported to:\n${path}`);
    } catch (error) {
      window.alert(`Could not export this Muse session.\n\n${String(error)}`);
    }
  };

  // Dragging reorders within one workspace and one pin group; the dropped list
  // is handed to the store verbatim so what you see is what gets saved.
  const canDrop = (list: Thread[], target: Thread) => {
    const source = list.find((thread) => thread.sessionId === dragging);
    return Boolean(source && source.sessionId !== target.sessionId && Boolean(source.pinned) === Boolean(target.pinned));
  };
  const drop = (list: Thread[], target: Thread) => {
    setDropTarget(null);
    const from = list.findIndex((thread) => thread.sessionId === dragging);
    const to = list.findIndex((thread) => thread.sessionId === target.sessionId);
    setDragging(null);
    if (from < 0 || to < 0 || from === to) return;
    const next = list.slice();
    next.splice(to, 0, ...next.splice(from, 1));
    s.reorderThreads(next.map((thread) => thread.sessionId));
  };

  if (s.sidebarCollapsed) {
    return (
      <aside className="sidebar collapsed" aria-label="Sidebar collapsed">
        <div className="drag" data-tauri-drag-region />
        <div className="sidebar-rail">
          <button className="icon-btn" aria-label="Show sidebar" title={`Show sidebar  ${shortcutLabel("B")}`} onClick={() => s.setSidebarCollapsed(false)}><PanelLeft size={16} /></button>
          <button className="icon-btn" aria-label="New thread" title={`New thread  ${shortcutLabel("N")}`} disabled={s.starting || !workspace} onClick={newThread}><SquarePen size={16} /></button>
          <button className="icon-btn" aria-label="Open workspace" title={`Open workspace  ${shortcutLabel("P")}`} onClick={() => void s.chooseProject()}><Plus size={16} /></button>
          <span className="grow" />
          <button className="icon-btn" aria-label="Settings" title={`Settings  ${shortcutLabel(",")}`} onClick={() => s.setSettingsOpen(true)}><Settings size={16} /></button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="drag" data-tauri-drag-region />
      <div className="sidebar-top">
        <button className="icon-btn" aria-label="Search threads" title={`Search threads  ${shortcutLabel("F")}`} aria-pressed={showSearch} onClick={() => { setSearching(true); window.setTimeout(() => document.getElementById("thread-search")?.focus(), 0); }}><Search size={15} /></button>
      </div>

      <nav className="sidebar-nav" aria-label="Primary">
        <button className="nav-row" onClick={newThread} disabled={s.starting || !workspace} title={!workspace ? "Open a workspace first" : undefined}>
          <SquarePen size={15} />
          <span>New thread</span>
          <kbd>{shortcutLabel("N")}</kbd>
        </button>
        {s.preview ? <button className="nav-row" onClick={() => void s.exitPreview()}><LogOut size={15} /><span>Exit preview</span></button> : null}
      </nav>

      {showSearch ? (
        <label className="search-field">
          <Search size={13} aria-hidden="true" />
          <input
            id="thread-search"
            value={s.threadSearch}
            placeholder="Search threads"
            aria-label="Search threads"
            onChange={(event) => s.setThreadSearch(event.target.value)}
            onBlur={() => { if (!s.threadSearch) setSearching(false); }}
            onKeyDown={(event) => { if (event.key === "Escape") { s.setThreadSearch(""); setSearching(false); (event.target as HTMLInputElement).blur(); } }}
          />
          {s.threadSearch ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => s.setThreadSearch("")}><X size={12} /></button> : null}
        </label>
      ) : <input id="thread-search" className="visually-hidden" aria-label="Search threads" tabIndex={-1} onFocus={() => { setSearching(true); window.setTimeout(() => document.getElementById("thread-search")?.focus(), 0); }} readOnly />}

      <div className="section-label">
        <span>Workspaces</span>
        <button className="icon-btn small" aria-label="Open workspace" title={`Open workspace  ${shortcutLabel("P")}`} onClick={() => void s.chooseProject()}><Plus size={14} /></button>
      </div>

      <div className="scroll sidebar-tree">
        {!s.workspaces.length ? (
          <button className="tree-empty" onClick={() => void s.chooseProject()}>
            <FolderOpen size={15} />
            <span>Open a workspace</span>
          </button>
        ) : null}
        {s.workspaces.map((item) => {
          const active = item.id === s.selectedWorkspaceId;
          const open = isOpen(item.id);
          const threads = open ? threadsFor(item) : [];
          const reorderable = !s.threadSearch;
          return (
            <div key={item.id} className={`workspace-group ${active ? "active" : ""}`}>
              <div className={`workspace-row ${active ? "active" : ""} ${open ? "open" : ""}`}>
                <button
                  className="workspace-toggle"
                  aria-label={open ? `Collapse ${item.name}` : `Expand ${item.name}`}
                  aria-expanded={open}
                  title={open ? "Collapse" : "Expand"}
                  onClick={() => toggleOpen(item.id)}
                >
                  <ChevronRight size={12} className="workspace-caret" aria-hidden="true" />
                </button>
                <button
                  className="workspace"
                  title={item.path}
                  onClick={() => {
                    if (!active) {
                      setExpanded((ids) => ids.includes(item.id) ? ids : [...ids, item.id]);
                      void s.selectWorkspace(item.id);
                      return;
                    }
                    toggleOpen(item.id);
                  }}
                >
                  {open ? <FolderOpen size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
                  <span className="workspace-name">{item.name}</span>
                </button>
                {!item.grantId ? (
                  <button className="regrant-btn" title="This folder lost its access grant. Pick it again to restore access." onClick={() => void s.chooseProject()}>Re-open</button>
                ) : null}
                <div className="row-actions">
                  {active ? <button className="icon-btn small" aria-label={`New thread in ${item.name}`} title="New thread" disabled={s.starting} onClick={newThread}><SquarePen size={13} /></button> : null}
                  {!item.trusted && item.grantId ? <button className="icon-btn small" aria-label={`Trust ${item.name}`} title="Trust workspace…" onClick={() => void s.openTrustDialog(item.id)}><ShieldCheck size={13} /></button> : null}
                  <button
                    className="icon-btn small"
                    aria-label={`Remove ${item.name}`}
                    title="Remove from sidebar"
                    onClick={() => {
                      void s.confirm({ title: `Remove ${item.name} from the sidebar?`, body: "Running turns in this workspace will be stopped.", confirmLabel: "Remove", danger: true }).then((ok) => { if (ok) s.removeWorkspace(item.id); });
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>

              {open ? (
                <div className="thread-list" role="list">
                  {threads.map((thread) => (
                    <div
                      key={thread.sessionId}
                      role="listitem"
                      className={`thread-wrap ${menu === thread.sessionId ? "menu-open" : ""} ${dragging === thread.sessionId ? "dragging" : ""} ${dropTarget === thread.sessionId ? "drop-target" : ""}`}
                      draggable={reorderable && renaming !== thread.sessionId}
                      onDragStart={(event) => { setDragging(thread.sessionId); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", thread.sessionId); }}
                      onDragOver={(event) => {
                        if (!canDrop(threads, thread)) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropTarget(thread.sessionId);
                      }}
                      onDragLeave={() => setDropTarget((id) => id === thread.sessionId ? null : id)}
                      onDrop={(event) => { if (!canDrop(threads, thread)) return; event.preventDefault(); drop(threads, thread); }}
                      onDragEnd={() => { setDragging(null); setDropTarget(null); }}
                    >
                      {renaming === thread.sessionId ? (
                        <input
                          className="rename"
                          defaultValue={thread.title}
                          autoFocus
                          aria-label="Thread name"
                          onFocus={(event) => event.target.select()}
                          onBlur={(event) => { s.renameThread(thread.sessionId, event.target.value); setRenaming(null); }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") { s.renameThread(thread.sessionId, (event.target as HTMLInputElement).value); setRenaming(null); }
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                      ) : (
                        <>
                          <button
                            className={`thread ${thread.sessionId === s.selectedSessionId ? "active" : ""} ${thread.unread ? "unread" : ""}`}
                            title={`${thread.title} · ${new Date(thread.updatedAt).toLocaleString()}`}
                            aria-current={thread.sessionId === s.selectedSessionId ? "page" : undefined}
                            onClick={() => { onOpenThreads?.(); void s.selectThread(thread.sessionId); }}
                            onContextMenu={(event) => { event.preventDefault(); setMenu(thread.sessionId); }}
                            onDoubleClick={() => setRenaming(thread.sessionId)}
                          >
                            {thread.pinned ? <Pin size={11} className="pin-mark" aria-label="Pinned" /> : null}
                            {thread.agentId ? <span className="thread-agent" title={s.agents.find((agent) => agent.id === thread.agentId)?.name}><AgentMark id={thread.agentId} size={14} /></span> : null}
                            <span className="title">{thread.title}</span>
                            <ThreadStatus thread={thread} />
                            <span className="time">{thread.status === "running" ? "" : relativeTime(thread.updatedAt)}</span>
                          </button>
                          <button
                            className="icon-btn small thread-more"
                            aria-label={`Actions for ${thread.title}`}
                            aria-haspopup="menu"
                            aria-expanded={menu === thread.sessionId}
                            onClick={(event) => { event.stopPropagation(); setMenu(menu === thread.sessionId ? null : thread.sessionId); }}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </>
                      )}
                      {menu === thread.sessionId ? (
                        <div className="menu thread-menu" role="menu">
                          <button type="button" role="menuitem" onClick={() => { setRenaming(thread.sessionId); setMenu(null); }}><Pencil size={13} />Rename</button>
                          <button type="button" role="menuitem" onClick={() => { s.pinThread(thread.sessionId); setMenu(null); }}>{thread.pinned ? <PinOff size={13} /> : <Pin size={13} />}{thread.pinned ? "Unpin" : "Pin"}</button>
                          {(thread.agentId ?? "muse") === "muse" && !s.preview ? <>
                            <button type="button" role="menuitem" onClick={() => void exportThread(thread, true)}><ShieldCheck size={13} />Export share-safe JSON</button>
                            <button type="button" role="menuitem" onClick={() => void exportThread(thread, false)}><Download size={13} />Export raw JSON</button>
                            <button type="button" role="menuitem" onClick={() => { setMenu(null); void s.forkThread(thread.sessionId); }}><GitFork size={13} />Fork thread</button>
                            {!thread.opened ? <button type="button" role="menuitem" onClick={() => { setMenu(null); void s.openPreview(thread.sessionId); }}><ScanSearch size={13} />Preview without opening</button> : null}
                          </> : null}
                          <div className="menu-sep" />
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            onClick={() => {
                              setMenu(null);
                              void s.confirm({ title: `Delete “${thread.title}”?`, body: "It is removed from Muse Code. This cannot be undone.", confirmLabel: "Delete", danger: true }).then((ok) => { if (ok) s.deleteThread(thread.sessionId); });
                            }}
                          >
                            <Trash2 size={13} />Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {!threads.length ? (
                    <div className="tree-note">
                      {s.threadsLoading.includes(item.id)
                        ? <span className="tree-loading"><LoaderCircle size={12} className="spin" aria-hidden="true" />Loading threads…</span>
                        : s.threadSearch ? "No matching threads" : "No threads yet"}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="sidebar-foot">
        <div
          className="account"
          tabIndex={0}
          aria-label={`${accountName}. ${status}. Hover for subscription usage.`}
          onMouseEnter={() => { setUsageOpen(true); void s.refreshSubscriptionUsage(); }}
          onMouseLeave={() => setUsageOpen(false)}
          onFocus={() => { setUsageOpen(true); void s.refreshSubscriptionUsage(); }}
          onBlur={() => setUsageOpen(false)}
        >
          <img src="/spark.svg" alt="" className="account-mark" />
          <span className="account-copy">
            <span className="account-name">{accountName}</span>
            <span className={`account-status ${statusTone}`} title={statusTitle}><i aria-hidden="true" />{status}</span>
          </span>
          {usageOpen ? <AccountUsage /> : null}
        </div>
        <button className="icon-btn" aria-label="Settings" title={`Settings  ${shortcutLabel(",")}`} onClick={() => s.setSettingsOpen(true)}><Settings size={15} /></button>
      </div>
    </aside>
  );
}
