import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { backgroundAgents, describeAgents, describeLive, estimateTurnTokens, trailingWork } from "../lib/agent";
import { Activity as ActivityIcon, ArrowDown, TriangleAlert, Bug, ChevronRight, CircleAlert, FlaskConical, FolderOpen, GitBranch, GitCompareArrows, GitFork, History, LoaderCircle, PanelRight, Pencil, RotateCcw, ScanSearch, SquarePen, WifiOff, X } from "lucide-react";
import { Orb } from "./Orb";
import { currentThread, currentWorkspace, needsGrant, turnTokens, useAppStore } from "../lib/store";
import { formatDuration, formatTokens, shortcutLabel } from "../lib/format";
import type { Thread } from "../lib/types";
import { AgentTimeline, WorkingIndicator } from "./AgentTimeline";
import { defaultTier, isPeak, modelFor, tiersFor } from "../lib/effort";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { UserInputCards } from "./UserInputCard";
import { AGENT_LABELS, type AgentId } from "../lib/types";

function Activity({ thread }: { thread: Thread }) {
  const waiting = !!thread.pendingApproval || Boolean(thread.userInputs?.length);
  // Turns the host started (or ones already running when the thread opened) have no send time; count from when we saw them.
  const [seen] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const reported = turnTokens(thread) ?? 0;
  const estimated = estimateTurnTokens(thread.items);
  // Prefer the host's count; until it catches up, show the streamed estimate marked with "~".
  const tokens = reported >= estimated ? (reported ? `${formatTokens(reported)} tokens` : "") : `~${formatTokens(estimated)} tokens`;
  const meta = [formatDuration(now - (thread.turnStartedAt ?? seen)), tokens].filter(Boolean).join(" · ");
  const live = useMemo(() => trailingWork(thread.items), [thread.items]);
  const label = thread.userInputs?.length ? "Waiting for your answer" : thread.pendingApproval ? "Waiting for approval" : thread.cancelRequested ? "Stopping…" : thread.activity === "composing" ? "Writing a reply" : describeLive(live) ?? describeAgents(backgroundAgents(thread.items)) ?? thread.goal?.currentWork ?? "Thinking";
  const models = useAppStore((state) => state.models);
  const model = modelFor(models, thread.config ?? {});
  const tiers = tiersFor(model, thread.agentId);
  const peak = isPeak(thread.config?.effort ?? defaultTier(model, tiers), tiers);
  const agentId: AgentId = thread.agentId ?? "muse";
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  const retry = thread.retry && (!thread.activeTurnId || thread.activeTurnId === thread.retry.turnId) ? thread.retry : null;
  const retryIn = retry ? Math.max(0, Math.ceil((retry.retryAt - now) / 1000)) : 0;
  const stop = useAppStore((state) => state.stopTurn);
  return (
    <>
      <WorkingIndicator label={/retrying/i.test(thread.notice?.message ?? "") ? "Retrying" : thread.notice?.level === "warning" ? "Couldn't complete" : label} paused={waiting || thread.cancelRequested} peak={peak} meta={meta} live={live} agentId={agentId} agentName={agentName} />
      {retry ? (
        <div className="agent-notice info retry-notice" role="status">
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
          <span>Attempt {retry.attempt} of {retry.maxAttempts} failed ({retry.reason}) · retrying{retryIn > 0 ? ` in ${retryIn}s` : "…"}</span>
          <button type="button" className="ghost-btn small" disabled={thread.cancelRequested} onClick={() => void stop()}>Stop</button>
        </div>
      ) : null}
      {thread.notice ? <div className={`agent-notice ${thread.notice.level}`} role="status"><TriangleAlert size={13} aria-hidden="true" /><span>{thread.notice.message}</span></div> : null}
    </>
  );
}

/** Agents launched by a finished turn can keep working; say so, so the thread doesn't look stopped. */
function BackgroundAgents({ thread }: { thread: Thread }) {
  const running = useMemo(() => backgroundAgents(thread.items), [thread.items]);
  const label = describeAgents(running);
  const agentId: AgentId = thread.agentId ?? "muse";
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  if (!label) return null;
  return <WorkingIndicator label={`${label} in the background`} agentId={agentId} agentName={agentName} />;
}

const SUGGESTIONS = [
  { icon: ScanSearch, title: "Explain this codebase", prompt: "Give me a tour of this codebase: the architecture, the main entry points, and how the pieces fit together." },
  { icon: Bug, title: "Find and fix a bug", prompt: "Look for a likely bug in this project, explain the root cause, and fix it." },
  { icon: FlaskConical, title: "Add missing tests", prompt: "Find the most important untested code in this project and write tests for it." },
  { icon: GitCompareArrows, title: "Review my changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything I should clean up before committing." },
];

export function ThreadView() {
  const thread = useAppStore(currentThread);
  const workspace = useAppStore(currentWorkspace);
  const s = useAppStore(useShallow((state) => ({
    error: state.error,
    agents: state.agents,
    git: state.git,
    dockOpen: state.dockOpen,
    inspectorTab: state.inspectorTab,
    offline: state.offline,
    starting: state.starting,
    renameThread: state.renameThread,
    forkThread: state.forkThread,
    setInspectorTab: state.setInspectorTab,
    setDockOpen: state.setDockOpen,
    chooseProject: state.chooseProject,
    rebuildThread: state.rebuildThread,
    selectThread: state.selectThread,
    setSettingsOpen: state.setSettingsOpen,
    dismissError: state.dismissError,
    persistNotice: state.persistNotice,
    dismissPersistNotice: state.dismissPersistNotice,
    newThread: state.newThread,
    setComposer: state.setComposer,
    loadOlderHistory: state.loadOlderHistory,
  })));
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const positions = useRef(new Map<string, { top: number; follow: boolean }>());
  const [showLatest, setShowLatest] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const empty = !thread || thread.items.length === 0;
  const turnFault = thread?.lastOutcome === "failed" || thread?.lastOutcome === "cancelled";
  const error = s.error || (turnFault ? null : thread?.error);
  const jump = () => {
    following.current = true;
    setShowLatest(false);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };
  useEffect(() => {
    const node = scroller.current;
    const id = thread?.sessionId;
    const saved = id ? positions.current.get(id) : undefined;
    following.current = saved?.follow ?? true;
    setShowLatest(!following.current);
    if (node) node.scrollTop = following.current ? node.scrollHeight : saved?.top ?? 0;
    if (positions.current.size > 30) {
      const oldest = Array.from(positions.current.keys()).slice(0, positions.current.size - 30);
      for (const key of oldest) positions.current.delete(key);
    }
  }, [thread?.sessionId]);
  useEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follow = () => {
      if (following.current) node.scrollTop = node.scrollHeight;
      else setShowLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 80);
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [thread?.sessionId, empty]);
  const activeAgentId: AgentId = thread?.agentId ?? "muse";
  const activeAgentName = s.agents.find((agent) => agent.id === activeAgentId)?.name ?? AGENT_LABELS[activeAgentId];
  useEffect(() => { document.title = `${thread?.title ?? (workspace ? "No thread selected" : "Welcome")} · ${activeAgentName}`; }, [activeAgentName, thread?.title, workspace?.name]);

  const topTitle = thread?.title ?? (workspace ? "No thread selected" : "Welcome");
  const branch = s.git?.branch ?? thread?.hostBranch;
  const monitorOpen = s.dockOpen && s.inspectorTab === "activity";
  const changesOpen = s.dockOpen && s.inspectorTab !== "activity";
  const newThreadView = !thread || (empty && thread.status !== "running");
  return <main id="main-content" tabIndex={-1} className={`main ${s.dockOpen ? "" : "solo"}`}>
    <div className="max-effort-glow" aria-hidden="true" />
    <header className="topbar" data-tauri-drag-region>
      <nav className="crumbs" aria-label="Location">
        {workspace ? <><span className="crumb-root" title={workspace.path}>{workspace.name}</span><ChevronRight size={13} className="crumb-sep" aria-hidden="true" /></> : null}
        {editingTitle && thread ? (
          <input
            className="title-edit"
            defaultValue={thread.title}
            autoFocus
            aria-label="Thread name"
            onFocus={(event) => event.target.select()}
            onBlur={(event) => { s.renameThread(thread.sessionId, event.target.value); setEditingTitle(false); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { s.renameThread(thread.sessionId, (event.target as HTMLInputElement).value); setEditingTitle(false); }
              if (event.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <>
            <h1 title={thread ? `${topTitle} — double-click to rename` : topTitle} onDoubleClick={() => thread && setEditingTitle(true)}>{thread ? topTitle : workspace ? "New thread" : "Welcome"}</h1>
            {thread ? <button className="icon-btn title-rename" aria-label="Rename conversation" title="Rename conversation" onClick={() => setEditingTitle(true)}><Pencil size={12} /></button> : null}
            {thread?.forkedFrom ? <span className="fork-chip" title={`Branched from ${thread.forkedFrom.title}`}><GitFork size={11} aria-hidden="true" />Fork of {thread.forkedFrom.title}</span> : null}
          </>
        )}
        {thread?.status === "running" ? <span className="live-pill"><i aria-hidden="true" />Running</span> : null}
      </nav>
      <span className="grow" />
      {thread && !thread.agentId ? <button className="icon-btn" aria-label="Fork thread" title="Fork thread — branch history into a new thread" onClick={() => void s.forkThread(thread.sessionId)}><GitFork size={15} /></button> : null}
      {branch ? <button className="branch" aria-label="Open changes" title={s.git?.dirty ? `${branch} · uncommitted changes — open` : `${branch} — open`} onClick={() => { s.setInspectorTab("changes"); s.setDockOpen(true); }}><GitBranch size={12} />{branch}{s.git?.dirty ? <i className="dirty" aria-label="uncommitted changes" /> : null}</button> : null}
      <button className="icon-btn" aria-label="Toggle task monitor" aria-pressed={monitorOpen} title="Task monitor" onClick={() => {
        if (monitorOpen) s.setDockOpen(false);
        else { s.setInspectorTab("activity"); s.setDockOpen(true); }
      }}><ActivityIcon size={15} /></button>
      <button className="icon-btn" aria-label="Toggle changes" aria-pressed={changesOpen} title={`Changes  ${shortcutLabel("I")}`} onClick={() => {
        if (changesOpen) s.setDockOpen(false);
        else { s.setInspectorTab("changes"); s.setDockOpen(true); }
      }}><PanelRight size={15} /></button>
    </header>
    {s.offline && <div className="banner warn" role="status"><WifiOff size={14} aria-hidden="true" /><span>You are offline. Muse can’t reach the host until the network returns.</span></div>}
    {s.persistNotice && <div className="banner warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{s.persistNotice}</span><button className="icon-btn small" aria-label="Dismiss" onClick={s.dismissPersistNotice}><X size={13} /></button></div>}
    {error && <div className="banner" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{error}</span>{needsGrant(error) && <button className="ghost-btn small" onClick={() => void s.chooseProject()}><FolderOpen size={13} />Open workspace</button>}{thread && (thread.viewGap?.state === "failed" || thread.historyFailed) && <button className="ghost-btn small" onClick={() => void s.rebuildThread()}>Retry rebuild</button>}{thread && !thread.opened && <button className="ghost-btn small" onClick={() => void s.selectThread(thread.sessionId)}>Reconnect</button>}<button className="ghost-btn small" onClick={() => s.setSettingsOpen(true)}>Settings</button><button className="icon-btn small" aria-label="Dismiss" onClick={s.dismissError}><X size={13} /></button></div>}
    {thread?.viewGap?.state === "filling" && <div className="banner info" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /><span>Recovering dropped events…</span></div>}
    {thread?.viewGap?.state === "failed" && !error && <div className="banner" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>Events after {thread.viewGap.after.slice(-8)} never arrived. Retry the rebuild to replay them from the log.</span><button className="ghost-btn small" onClick={() => void s.rebuildThread()}>Retry rebuild</button></div>}
    {thread?.viewHealth && <div className="banner warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>Live updates unavailable{thread.viewHealth.noneReason ? ` (${thread.viewHealth.noneReason})` : ""}. Reconnect to restore them.</span>{thread && <button className="ghost-btn small" onClick={() => void s.selectThread(thread.sessionId)}>Reconnect</button>}</div>}
    {!workspace ? (
      <div className="empty">
        <Orb state="breathing" size={64} aria-label="Muse" />
        <h2>Open a workspace</h2>
        <p>Pick a project folder. Muse can plan, edit files, and run commands inside it.</p>
        <button className="primary lg" onClick={() => void s.chooseProject()}><FolderOpen size={15} />Open a workspace<kbd>{shortcutLabel("P")}</kbd></button>
      </div>
    ) : newThreadView ? (
      <div className="empty">
        <Orb state={thread?.opening ? "connecting" : "breathing"} size={64} aria-label="Muse" />
        <h2>{thread?.opening ? "Opening thread…" : `What should we build in ${workspace.name}?`}</h2>
        <p>{!thread ? "Start a thread to plan, edit, and run commands." : "Describe a task, or start from one of these."}</p>
        {!thread ? (
          <button className="primary lg" onClick={() => void s.newThread()} disabled={s.starting}><SquarePen size={15} />New thread<kbd>{shortcutLabel("N")}</kbd></button>
        ) : thread.historyFailed ? (
          <button className="primary lg" onClick={() => void s.rebuildThread()} disabled={thread.opening}><RotateCcw size={15} />Retry loading history</button>
        ) : !thread.opening ? (
          <div className="suggestions">
            {SUGGESTIONS.map(({ icon: Icon, title, prompt }) => (
              <button key={title} className="suggestion" onClick={() => { s.setComposer(prompt); document.getElementById("prompt")?.focus(); }}>
                <Icon size={15} aria-hidden="true" />
                <span>{title}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    ) : <div className="conversation" ref={scroller} aria-label="Agent" onScroll={() => {
        const node = scroller.current;
        if (!node) return;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        setShowLatest(!following.current);
        if (thread) positions.current.set(thread.sessionId, { top: node.scrollTop, follow: following.current });
      }}><div className="conversation-inner" ref={content} role="log" aria-label="Agent activity" aria-live="off">
        {thread && !thread.agentId && !thread.historyExhausted && thread.historyCursor ? (
          <div className="history-pager">
            <button type="button" className="ghost-btn small" disabled={thread.historyLoading} onClick={() => void s.loadOlderHistory()}>
              {thread.historyLoading ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <History size={13} aria-hidden="true" />}
              {thread.historyLoading ? "Loading older history…" : "Load older history"}
            </button>
          </div>
        ) : null}
        {thread ? <AgentTimeline thread={thread} scrollContainerRef={scroller} /> : null}
        <ApprovalCard />
        <UserInputCards />
        {thread?.status === "running" && <Activity key={thread.sessionId} thread={thread} />}
        {thread && thread.status !== "running" ? <BackgroundAgents thread={thread} /> : null}
        {thread && thread.status !== "running" && thread.turnStats && thread.turnStats.turnId === thread.lastTurnId && !backgroundAgents(thread.items).length ? (
          <p className="turn-stats">Worked for {formatDuration(thread.turnStats.durationMs)}{thread.turnStats.outputTokens ? ` · ${thread.turnStats.estimated ? "~" : ""}${formatTokens(thread.turnStats.outputTokens)} tokens` : ""}</p>
        ) : null}
        {thread?.lastOutcome === "cancelled" && thread.status !== "running" && !thread.items.length ? <p className="muted">Turn cancelled.</p> : null}
      </div></div>}
    {showLatest && <button className="jump-latest" onClick={jump}><ArrowDown size={13} />Jump to latest</button>}
    <Composer />
  </main>;
}
