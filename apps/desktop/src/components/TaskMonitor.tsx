import { useMemo, useState } from "react";
import { Bot, Check, CircleAlert, CircleSlash, FileText, GitBranch, GitCompareArrows, ImageIcon, LoaderCircle, Monitor, Pause, Pencil, Play, Plus, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openPath } from "../lib/bridge";
import { isTauri } from "../lib/format";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { agentCounts, itemStatus } from "../lib/agent";
import type { GoalState, TranscriptItem } from "../lib/types";

type MonitorSource =
  | { key: string; kind: "file"; name: string; path: string }
  | { key: string; kind: "image"; name: string; src: string };

type Subagent = { id: string; title: string; detail?: string; status: ReturnType<typeof itemStatus> };

// Subagents spawned inside this conversation: the host's own subagent items, plus
// Task/Agent-style tool calls from agents that delegate through a tool.
const SUBAGENT_TOOL = /^(task|agent|subagent|spawn_?agent|dispatch_?agent)$/i;

/** A workflow's agents, one entry each, labelled with the workflow's name. */
function workflowAgents(item: TranscriptItem): Subagent[] {
  const { states } = agentCounts(item);
  return (item.children ?? []).map((child, index) => {
    const state = states[index];
    return {
      id: `${item.itemId}:${child.childId}:${child.attempt}`,
      title: child.label || `Agent ${index + 1}`,
      detail: [item.entryId, child.phase].filter(Boolean).join(" · ") || undefined,
      status: state === "pending" ? "running" : state,
    };
  });
}

function subagentFrom(item: TranscriptItem): Subagent | null {
  if (item.kind !== "subagent" && !(item.kind === "toolCall" && SUBAGENT_TOOL.test(item.tool ?? ""))) return null;
  let args: Record<string, unknown> = {};
  try { args = item.args ? JSON.parse(item.args) : {}; } catch { /* free-form args */ }
  const pick = (...keys: string[]) => keys.map((key) => args[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const title = item.objective || pick("description", "title", "name") || "Subagent";
  const detail = pick("subagent_type", "agent", "prompt") ?? item.fallbackText?.split("\n").find(Boolean);
  const status = item.failureReason ? "failed" : itemStatus(item.status);
  return { id: item.itemId, title, detail: detail && detail !== title ? detail : undefined, status };
}

function SubagentMark({ status }: { status: Subagent["status"] }) {
  if (status === "running") return <LoaderCircle size={14} className="spin" aria-label="Running" />;
  if (status === "failed") return <CircleAlert size={14} aria-label="Failed" />;
  if (status === "cancelled" || status === "skipped") return <CircleSlash size={14} aria-label="Stopped" />;
  return <Check size={14} aria-label="Done" />;
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Session-goal controls (`goal/*`): set/edit/pause/resume/clear with the settled block echoed back. */
function GoalControls({ sessionId, goal }: { sessionId: string; goal: GoalState | null | undefined }) {
  const controlGoal = useAppStore((s) => s.controlGoal);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const run = (action: string, objective?: string) => {
    setBusy(true);
    setError(null);
    setDriving(false);
    void controlGoal(sessionId, action, objective)
      .then((ack) => {
        setEditing(false);
        setDraft("");
        if (ack.turnId) setDriving(true);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const paused = goal?.status === "paused";
  return (
    <div className="goal-controls">
      {goal?.objective ? (
        <>
          <p title={goal.objective}>{goal.objective}</p>
          <div className="monitor-task-meta">
            {goal.status ? <span>{goal.status}</span> : null}
            {goal.percentComplete != null ? <span>{goal.percentComplete}%</span> : null}
            {driving ? <span>Driving turn started</span> : null}
          </div>
        </>
      ) : (
        <p className="monitor-empty">No session goal.</p>
      )}
      {editing ? (
        <form
          className="goal-compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) run(goal?.objective ? "edit" : "set", draft.trim());
          }}
        >
          <input type="text" value={draft} autoFocus disabled={busy} maxLength={100000} placeholder="Goal objective…" aria-label="Goal objective" onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="agent-btn primary" disabled={busy || !draft.trim()}>{goal?.objective ? "Save" : "Set"}</button>
          <button type="button" className="agent-btn" disabled={busy} onClick={() => { setEditing(false); setDraft(""); }}>Cancel</button>
        </form>
      ) : (
        <div className="agent-buttons" role="toolbar" aria-label="Goal controls">
          {goal?.objective ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run(paused ? "resume" : "pause")} title={paused ? "Resume the goal" : "Pause the goal"}>{paused ? <Play size={12} /> : <Pause size={12} />}{paused ? "Resume" : "Pause"}</button> : null}
          {goal?.objective ? <button type="button" className="agent-btn" disabled={busy} onClick={() => { setDraft(goal.objective); setEditing(true); }} title="Edit the goal objective"><Pencil size={12} />Edit</button> : null}
          {goal?.objective ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run("clear")} title="Clear the session goal"><X size={12} />Clear</button> : null}
          {!goal?.objective ? <button type="button" className="agent-btn" disabled={busy} onClick={() => setEditing(true)} title="Set a session goal"><Plus size={12} />Set goal</button> : null}
        </div>
      )}
      {error ? <p className="monitor-error" role="alert">{error}</p> : null}
    </div>
  );
}

const LIVE_TASK = new Set(["inProgress", "running", "pending"]);

/** Backgrounded tool tasks (`task/*`): stop one, or stop them all. */
function BackgroundTasks() {
  const thread = useAppStore(currentThread);
  const controlTask = useAppStore((s) => s.controlTask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tasks = useMemo(
    () => (thread?.items ?? []).filter((item) => item.background && LIVE_TASK.has(item.status) && (item.kind === "toolCall" || item.kind === "userShell")),
    [thread?.items],
  );
  if (thread?.agentId) return null;
  const run = (action: string, taskId?: string) => {
    if (!thread) return;
    setBusy(true);
    setError(null);
    void controlTask(thread.sessionId, action, taskId)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="monitor-section">
      <div className="monitor-heading"><span>Background tasks</span><span className="monitor-count">{tasks.length}</span></div>
      {tasks.map((item) => (
        <div key={item.itemId} className="monitor-row task-row">
          <span className="monitor-icon"><LoaderCircle size={14} className="spin" aria-label="Running in background" /></span>
          <span className="monitor-copy">
            <strong title={item.commandText || item.tool || "Task"}>{item.commandText || item.tool || "Task"}</strong>
            {item.backgroundInitiator ? <small>Backgrounded by {item.backgroundInitiator}</small> : null}
          </span>
          <button type="button" className="agent-btn danger" disabled={busy} onClick={() => run("stop", item.itemId)} title="Stop this background task"><X size={12} />Stop</button>
        </div>
      ))}
      {!tasks.length ? <p className="monitor-empty">Running tool tasks can move here.</p> : (
        <div className="agent-buttons" role="toolbar" aria-label="Background task controls">
          <button type="button" className="agent-btn danger" disabled={busy} onClick={() => run("stopAll")} title="Stop every background task"><X size={12} />Stop all</button>
        </div>
      )}
      {error ? <p className="monitor-error" role="alert">{error}</p> : null}
    </section>
  );
}

export function TaskMonitor() {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    contextRefs: state.contextRefs,
    images: state.images,
    git: state.git,
    setInspectorTab: state.setInspectorTab,
  })));
  const workspace = currentWorkspace(s);
  const thread = currentThread(s);
  const [error, setError] = useState<string | null>(null);
  const subagents = useMemo(() => (thread?.items ?? []).flatMap((item) => item.kind === "workflow" ? workflowAgents(item) : [subagentFrom(item)].filter((entry): entry is Subagent => entry != null)), [thread?.items]);
  const activeSubagents = subagents.filter((item) => item.status === "running").length;
  const sources = useMemo(() => {
    const collected = new Map<string, MonitorSource>();
    const addFile = (path: string) => collected.set(`file:${path}`, { key: `file:${path}`, kind: "file", name: fileName(path), path });
    const addImage = (name: string, mediaType: string, base64Data: string, key: string) => collected.set(key, { key, kind: "image", name, src: `data:${mediaType};base64,${base64Data}` });

    for (const item of thread?.items ?? []) {
      for (const ref of item.refs ?? []) addFile(ref.path);
      for (const [index, image] of (item.images ?? []).entries()) addImage(image.name, image.mediaType, image.base64Data, `image:${item.itemId}:${index}`);
    }
    for (const ref of s.contextRefs) addFile(ref.path);
    for (const [index, image] of s.images.entries()) addImage(image.name, image.mediaType, image.base64Data, `image:draft:${index}`);
    return [...collected.values()];
  }, [thread?.items, s.contextRefs, s.images]);

  const contextPercent = thread?.context?.windowTokens && thread.context.usedTokens != null
    ? Math.min(100, Math.round((thread.context.usedTokens / thread.context.windowTokens) * 100))
    : null;
  const openSource = (path: string) => {
    if (!workspace) return;
    if (!workspace.grantId && isTauri()) { setError("This folder is not granted. Re-open it to restore access."); return; }
    const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    void openPath(absolute ? path : `${workspace.path}/${path}`, workspace.grantId ?? "preview").catch((cause) => setError(`Could not open file: ${String(cause)}`));
  };

  return (
    <div className="task-monitor scroll" aria-label="Task monitor">
      <section className="monitor-section">
        <div className="monitor-heading"><span>Environment</span></div>
        <button className="monitor-row actionable" onClick={() => s.setInspectorTab("changes")}>
          <span className="monitor-icon"><GitCompareArrows size={15} /></span>
          <span className="monitor-copy"><strong>Changes</strong><small>{s.git?.files.length ?? 0} changed files</small></span>
          {s.git?.dirty ? <span className="monitor-diff"><span className="add">+{s.git.files.reduce((sum, file) => sum + file.added, 0)}</span><span className="del">−{s.git.files.reduce((sum, file) => sum + file.removed, 0)}</span></span> : <span className="monitor-state">Clean</span>}
        </button>
        <div className="monitor-row">
          <span className="monitor-icon"><Monitor size={15} /></span>
          <span className="monitor-copy"><strong>Local</strong><small title={workspace?.path}>{workspace?.name ?? "No workspace open"}</small></span>
        </div>
        <button className="monitor-row actionable" aria-label="Open changes" onClick={() => s.setInspectorTab("changes")}>
          <span className="monitor-icon"><GitBranch size={15} /></span>
          <span className="monitor-copy"><strong>{s.git?.branch ?? thread?.hostBranch ?? "No branch"}</strong><small>{s.git?.dirty ? "Uncommitted changes" : "Working tree clean"}</small></span>
        </button>
      </section>

      <section className="monitor-section">
        <div className="monitor-heading"><span>Current task</span></div>
        {thread ? <div className="monitor-task">
          <div className="monitor-task-title"><span className={`monitor-status ${thread.status}`} />{thread.title}</div>
          <div className="monitor-task-meta">
            <span>{thread.status === "running" ? thread.activity === "composing" ? "Writing a reply" : thread.goal?.currentWork || "Working" : thread.status === "error" ? "Needs attention" : "Idle"}</span>
            {contextPercent != null ? <span>{contextPercent}% context</span> : null}
          </div>
          {thread.agentId ? (thread.goal?.objective ? <p>{thread.goal.objective}</p> : null) : <GoalControls sessionId={thread.sessionId} goal={thread.goal} />}
        </div> : <p className="monitor-empty">Select a conversation to inspect its task.</p>}
      </section>

      <BackgroundTasks />

      <section className="monitor-section">
        <div className="monitor-heading"><span>Subagents</span><span className="monitor-count" title={`${activeSubagents} running`}>{activeSubagents ? `${activeSubagents} running` : subagents.length}</span></div>
        {subagents.map((item) => (
          <div key={item.id} className={`monitor-row subagent-row ${item.status}`}>
            <span className="monitor-icon"><SubagentMark status={item.status} /></span>
            <span className="monitor-copy"><strong title={item.title}>{item.title}</strong>{item.detail ? <small title={item.detail}>{item.detail}</small> : null}</span>
          </div>
        ))}
        {!subagents.length ? <div className="monitor-row muted-row"><span className="monitor-icon"><Bot size={15} /></span><span className="monitor-copy"><strong>No subagents</strong><small>{thread ? "Subagents this conversation spawns will appear here." : "Select a conversation to see its subagents."}</small></span></div> : null}
      </section>

      <section className="monitor-section">
        <div className="monitor-heading"><span>Sources</span><span className="monitor-count">{sources.length}</span></div>
        {sources.map((source) => source.kind === "image" ? (
          <div key={source.key} className="monitor-row source-row">
            <img className="source-thumb" src={source.src} alt="" />
            <span className="monitor-copy"><strong title={source.name}>{source.name}</strong><small>Attached image</small></span>
          </div>
        ) : (
          <button key={source.key} className="monitor-row source-row actionable" title={source.path} onClick={() => openSource(source.path)}>
            <span className="monitor-icon"><FileText size={15} /></span>
            <span className="monitor-copy"><strong>{source.name}</strong><small>{source.path}</small></span>
          </button>
        ))}
        {!sources.length ? <div className="monitor-row muted-row"><span className="monitor-icon"><ImageIcon size={15} /></span><span className="monitor-copy"><strong>No attached files</strong><small>Files and images from this conversation will appear here.</small></span></div> : null}
        {error ? <p className="monitor-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
