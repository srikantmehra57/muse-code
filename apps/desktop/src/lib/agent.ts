import { humanizeToolName } from "./format";
import type { PlanItem, Thread, TranscriptItem, WorkflowChild } from "./types";

export type AgentStepKind =
  | "user"
  | "message"
  | "reasoning"
  | "read"
  | "edit"
  | "search"
  | "command"
  | "web"
  | "tool"
  | "subagent"
  | "workflow"
  | "compaction"
  | "reminder"
  | "other"
  | "error";

export type AgentStepStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export type AgentStep = {
  id: string;
  kind: AgentStepKind;
  status: AgentStepStatus;
  title: string;
  detail?: string;
  path?: string;
  command?: string;
  output?: string;
  error?: string;
  durationMs?: number;
  item: TranscriptItem;
};

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled" | "waiting" | "interrupted";

export type AgentRun = {
  id: string;
  turnId?: string;
  status: AgentRunStatus;
  steps: AgentStep[];
};

const READ = /^(read_file|read|cat|get_file|view)$/i;
const EDIT = /^(edit_file|write_file|write|str_replace|apply_patch|create_file)$/i;
const SEARCH = /^(grep|search|codebase_search|glob|find|list_files)$/i;
const SHELL = /^(bash|shell|userShell)$/i;
const WEB = /^(web_search|web_fetch|web_lookup|fetch)$/i;

export function classifyTool(tool?: string, kind?: string): AgentStepKind {
  if (kind === "userShell" || SHELL.test(tool ?? "")) return "command";
  if (kind === "subagent") return "subagent";
  if (kind === "workflow") return "workflow";
  if (kind === "compaction") return "compaction";
  if (READ.test(tool ?? "")) return "read";
  if (EDIT.test(tool ?? "")) return "edit";
  if (SEARCH.test(tool ?? "")) return "search";
  if (WEB.test(tool ?? "")) return "web";
  return "tool";
}

export function itemStatus(status?: string): AgentStepStatus {
  if (status === "inProgress" || status === "running" || status === "pending") return "running";
  if (status === "failed" || status === "error" || status === "rejected" || status === "timedOut") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  return "completed";
}

export function stepFromItem(item: TranscriptItem): AgentStep {
  if (item.kind === "userMessage") {
    return { id: item.itemId, kind: "user", status: itemStatus(item.status), title: "You", detail: item.text, item };
  }
  if (item.kind === "reasoning") {
    const detail = item.summary?.filter(Boolean).join("\n") || item.text || item.fallbackText;
    return { id: item.itemId, kind: "reasoning", status: itemStatus(item.status), title: "Planning", detail, item };
  }
  if (item.kind === "toolCall" || item.kind === "userShell") {
    const kind = classifyTool(item.tool, item.kind);
    const title = kind === "read" ? "Reading" : kind === "edit" ? "Editing" : kind === "search" ? "Searching" : kind === "command" ? "Running" : kind === "web" ? "Looking up" : "Tool";
    return {
      id: item.itemId,
      kind,
      status: item.failureReason ? "failed" : itemStatus(item.status),
      title,
      path: pathFromItem(item),
      command: item.commandText || commandFromItem(item),
      output: item.visibleOutput,
      error: item.failureReason,
      durationMs: item.durationMs,
      item,
    };
  }
  if (item.kind === "subagent") {
    return { id: item.itemId, kind: "subagent", status: itemStatus(item.status), title: item.objective || "Subagent", detail: item.fallbackText, item };
  }
  if (item.kind === "workflow") {
    return { id: item.itemId, kind: "workflow", status: itemStatus(item.status), title: item.entryId || "Workflow", detail: parseWorkflowMessage(item.message).text || item.fallbackText || item.text, item };
  }
  if (item.kind === "compaction") {
    return { id: item.itemId, kind: "compaction", status: itemStatus(item.status), title: "Compacting context", detail: item.reason || item.fallbackText, item };
  }
  if (item.kind === "reminderChild") {
    return { id: item.itemId, kind: "reminder", status: itemStatus(item.status), title: "Reminder", detail: item.text || item.fallbackText, item };
  }
  if (item.kind === "systemMessage") {
    return { id: item.itemId, kind: "error", status: "failed", title: "System", detail: item.text || item.fallbackText, item };
  }
  if (item.kind === "agentMessage") {
    return { id: item.itemId, kind: "message", status: itemStatus(item.status), title: "Muse", detail: item.text || item.fallbackText, item };
  }
  // Open enum: unknown kinds render generically (kind + status + fallbackText), never as a reply.
  return { id: item.itemId, kind: "other", status: itemStatus(item.status), title: humanizeKind(item.kind), detail: item.text || item.fallbackText, item };
}

function humanizeKind(kind: string) {
  const words = kind.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "Event";
}

function pathFromItem(item: TranscriptItem): string | undefined {
  const parsed = parseArgs(item.args);
  const value = parsed?.path ?? parsed?.file ?? parsed?.filePath ?? parsed?.target;
  return typeof value === "string" ? value : undefined;
}

function commandFromItem(item: TranscriptItem): string | undefined {
  const parsed = parseArgs(item.args);
  const value = parsed?.command ?? parsed?.cmd ?? parsed?.query ?? parsed?.pattern ?? parsed?.url;
  return typeof value === "string" ? value : undefined;
}

function parseArgs(args?: string): Record<string, unknown> | null {
  if (!args) return null;
  try {
    const value = JSON.parse(args);
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function groupAgentRuns(items: TranscriptItem[], options?: { activeTurnId?: string | null; lastTurnId?: string | null; lastOutcome?: AgentRunStatus; waiting?: boolean; threadRunning?: boolean }): AgentRun[] {
  const runs: AgentRun[] = [];
  const index = new Map<string, AgentRun>();
  let current = "";
  for (const item of items) {
    if (item.turnId) current = item.turnId;
    else if (item.kind === "userMessage") current = `local:${item.itemId}`;
    else if (!current) current = "history";
    // Reminder children are background churn (dozens per turn, no user-facing content):
    // hidden from the timeline and excluded from run status.
    if (item.kind === "reminderChild") continue;
    let run = index.get(current);
    if (!run) {
      run = { id: current, turnId: item.turnId, status: "completed", steps: [] };
      index.set(current, run);
      runs.push(run);
    }
    run.steps.push(stepFromItem(item));
  }
  for (const run of runs) {
    const failed = run.steps.some((step) => step.status === "failed");
    // A stale activeTurnId must not resurrect an idle/error thread after cancel,
    // disconnect, or agent exit. Callers that do not know thread state keep the
    // historical behaviour; the conversation passes threadRunning explicitly.
    const active = options?.threadRunning !== false && run.turnId === options?.activeTurnId;
    const running = run.steps.some((step) => step.status === "running") || active;
    if (options?.waiting && running) run.status = "waiting";
    else if (running) run.status = "running";
    else if (failed) run.status = "failed";
    else run.status = "completed";
  }
  if (options?.lastOutcome && options.lastOutcome !== "completed") {
    const target = runs.find((item) => item.turnId === options.activeTurnId)
      ?? runs.find((item) => item.turnId === options.lastTurnId)
      ?? runs[runs.length - 1];
    if (target && target.status !== "running" && target.status !== "waiting") target.status = options.lastOutcome;
  }
  const last = runs[runs.length - 1];
  if (options?.threadRunning && last && last.status === "completed") {
    last.status = options.waiting ? "waiting" : "running";
  }
  return runs;
}

const LIVE_ITEM = new Set(["inProgress", "running", "pending"]);

/**
 * True once the visible reply is in but background-only work (hidden reminder
 * children) still holds the turn open — the timeline should stop pretending
 * the answer is being written and show a calm tail state instead.
 */
/** Items of the turn in progress: everything after the latest user message. */
export function currentTurnItems(items: TranscriptItem[]): TranscriptItem[] {
  let start = items.length;
  while (start > 0 && items[start - 1].kind !== "userMessage") start -= 1;
  return items.slice(start);
}

// Subagents and workflows are not folded into step groups: they render as their own agents card.
export const ACTIVITY_KINDS = new Set<AgentStepKind>(["reasoning", "read", "edit", "search", "command", "web", "tool", "compaction", "reminder", "other"]);

export type AgentState = "pending" | "running" | "completed" | "failed" | "cancelled";

/** One workflow child's state from the host's open vocabulary: the terminal outcome wins once set. */
export function childState(child: WorkflowChild): AgentState {
  const terminal = (child.terminal ?? "").toLowerCase();
  if (terminal) return /fail|error/.test(terminal) ? "failed" : /cancel|stop|abort/.test(terminal) ? "cancelled" : "completed";
  const status = child.status.toLowerCase();
  if (/pend|queue|sched|accept|wait/.test(status)) return "pending";
  if (/fail|error/.test(status)) return "failed";
  if (/cancel|stop|abort/.test(status)) return "cancelled";
  if (/complet|succe|done|finish|terminal/.test(status)) return "completed";
  return "running";
}

export type WorkflowOutcome = {
  /** Readable final summary (markdown), empty when the host sent none. */
  text: string;
  status?: string;
  evidence: string[];
  unresolved: string[];
  failure?: string;
  /** Per-agent activity the host reported at reconciliation, keyed by agent/child id. */
  activity: Map<string, { toolCalls?: number; durationMs?: number }>;
};

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) : [];
const parseJson = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };

/**
 * A workflow's final message. The host may send plain prose or a machine envelope such as
 * `<workflow-launch-reconciled>{…json…}</workflow-launch-reconciled>`; the envelope is unwrapped
 * into its summary and per-agent activity so raw JSON never reaches the transcript.
 */
export function parseWorkflowMessage(message: string | undefined): WorkflowOutcome {
  const empty: WorkflowOutcome = { text: "", evidence: [], unresolved: [], activity: new Map() };
  const raw = (message ?? "").trim();
  if (!raw) return empty;
  const envelope = /^<([a-z][\w-]*)>([\s\S]*)<\/\1>$/i.exec(raw);
  const body = (envelope ? envelope[2] : raw).trim();
  const data = body.startsWith("{") ? parseJson(body) : undefined;
  if (!data || typeof data !== "object") return envelope ? empty : { ...empty, text: raw };
  const record = data as Record<string, unknown>;
  const outcome: WorkflowOutcome = { ...empty, activity: new Map() };
  for (const entry of Array.isArray(record.agents_activity) ? record.agents_activity : []) {
    if (!entry || typeof entry !== "object" || typeof entry.agent !== "string") continue;
    outcome.activity.set(entry.agent, {
      toolCalls: typeof entry.tool_calls === "number" ? entry.tool_calls : undefined,
      durationMs: typeof entry.duration_ms === "number" ? entry.duration_ms : undefined,
    });
  }
  const failure = record.latest_failure;
  if (typeof failure === "string" && failure.trim()) outcome.failure = failure.trim();
  else if (failure && typeof failure === "object") {
    const text = (failure as Record<string, unknown>).message ?? (failure as Record<string, unknown>).reason;
    if (typeof text === "string" && text.trim()) outcome.failure = text.trim();
  }
  const final = (record.final_summary ?? record) as Record<string, unknown>;
  if (typeof final.status === "string") outcome.status = final.status;
  let summary: unknown = final.summary ?? final.message;
  // The summary itself is often a JSON string: {"complete":…, "evidence":[…], "unresolved":[…]}.
  if (typeof summary === "string" && summary.trim().startsWith("{")) summary = parseJson(summary.trim()) ?? summary;
  if (typeof summary === "string") outcome.text = summary.trim();
  else if (summary && typeof summary === "object") {
    const inner = summary as Record<string, unknown>;
    const prose = inner.summary ?? inner.message ?? inner.text;
    if (typeof prose === "string") outcome.text = prose.trim();
    outcome.evidence = strings(inner.evidence);
    outcome.unresolved = strings(inner.unresolved);
    if (!outcome.status && typeof inner.complete === "boolean") outcome.status = inner.complete ? "completed" : "incomplete";
  }
  return outcome;
}

/** Counts for a workflow's agents. A finished workflow can't have agents still running: they were cut off. */
export function agentCounts(item: TranscriptItem) {
  const ended = !LIVE_ITEM.has(item.status ?? "");
  // A workflow the host reconciled as completed ran every agent it reports activity for to the end,
  // even when the per-child terminal events never arrived.
  const outcome = ended ? parseWorkflowMessage(item.message) : null;
  const succeeded = !!outcome && /^complet|^succe/i.test(outcome.status ?? "");
  const states = (item.children ?? []).map((child) => {
    const state = childState(child);
    if (!ended || (state !== "running" && state !== "pending")) return state;
    return succeeded && (outcome!.activity.has(child.childId) || !outcome!.activity.size) ? "completed" : "cancelled";
  });
  const count = (state: AgentState) => states.filter((value) => value === state).length;
  return { total: states.length, running: count("running"), pending: count("pending"), completed: count("completed"), failed: count("failed"), cancelled: count("cancelled"), states };
}

/** Status-line words for agents still working, e.g. "Waiting on 6 agents · 5 done". */
export function describeAgents(items: TranscriptItem[]): string | undefined {
  const workflows = items.filter((item) => item.kind === "workflow");
  const subagents = items.filter((item) => item.kind === "subagent");
  const total = workflows.reduce((sum, item) => sum + agentCounts(item).total, 0) + subagents.length;
  if (!total) return workflows.length ? "Starting agents" : undefined;
  if (!workflows.length && subagents.length === 1) return `Waiting on agent: ${clip(subagents[0].objective || "subagent", 44)}`;
  const done = workflows.reduce((sum, item) => sum + agentCounts(item).completed, 0);
  return `Waiting on ${total} agent${total === 1 ? "" : "s"}${done ? ` · ${done} done` : ""}`;
}

/** Workflows and subagents still running in this thread (they can outlive the turn that started them). */
export function backgroundAgents(items: TranscriptItem[]): TranscriptItem[] {
  return items.filter((item) => (item.kind === "workflow" || item.kind === "subagent") && LIVE_ITEM.has(item.status ?? ""));
}

/**
 * The live run's work since its last message, in order: what the status line's dropdown shows
 * (and the timeline holds back) while the turn runs. Placeholder reminder children are skipped.
 */
export function trailingWork(items: TranscriptItem[]): AgentStep[] {
  const steps = currentTurnItems(items).map(stepFromItem);
  let start = steps.length;
  while (start > 0 && ACTIVITY_KINDS.has(steps[start - 1].kind)) start -= 1;
  return steps.slice(start).filter((step) => !(step.kind === "reminder" && !step.item.text?.trim()));
}

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * What the agent is doing right now, in words, for the live status line (like Claude desktop):
 * the newest running step of the current turn — "Reading store.ts", "Running npm test", or
 * the headline of the thought in progress. Undefined when nothing specific is running.
 */
export function describeLive(steps: AgentStep[]): string | undefined {
  const step = [...steps].reverse().find((item) => item.status === "running" && item.kind !== "reminder");
  if (!step) return undefined;
  const file = step.path?.split(/[\\/]/).filter(Boolean).pop();
  switch (step.kind) {
    case "reasoning": {
      const headline = (step.detail ?? "").replace(/[#*_`>]/g, "").split("\n").map((line) => line.trim()).find(Boolean);
      return headline ? clip(headline, 64) : undefined;
    }
    case "read": return file ? `Reading ${file}` : "Reading files";
    case "edit": return file ? `Editing ${file}` : "Editing files";
    case "search": return step.command ? `Searching for ${clip(step.command, 40)}` : "Searching the codebase";
    case "command": return step.command ? `Running ${clip(step.command, 48)}` : "Running a command";
    case "web": return step.command ? `Looking up ${clip(step.command, 44)}` : "Searching the web";
    case "subagent": return `Running an agent: ${clip(step.title, 44)}`;
    case "workflow": {
      const counts = agentCounts(step.item);
      return counts.total ? `Running ${counts.total} agents · ${counts.completed} done` : "Running a workflow";
    }
    case "compaction": return "Compacting context";
    case "tool": return `Using ${humanizeToolName(step.item.tool ?? "", step.item.kind)}`;
    default: return undefined;
  }
}

/** Steps still running in the current turn, for the live status dropdown. */
export function liveSteps(items: TranscriptItem[]): AgentStep[] {
  return currentTurnItems(items).filter((item) => LIVE_ITEM.has(item.status ?? "") && item.kind !== "reminderChild").map(stepFromItem);
}

/**
 * Rough output tokens for the current turn from what has streamed so far (~4 characters a token).
 * Hosts report real usage only when a model call finishes, so long thinking would otherwise show nothing.
 */
export function estimateTurnTokens(items: TranscriptItem[]): number {
  let chars = 0;
  for (const item of currentTurnItems(items)) {
    if (item.kind === "reasoning") chars += (item.text ?? item.summary?.join("\n") ?? "").length;
    else if (item.kind === "agentMessage") chars += (item.text ?? "").length;
    else if (item.kind === "toolCall") chars += (item.args ?? "").length;
  }
  return Math.round(chars / 4);
}

export function isBackgroundTail(items: TranscriptItem[]): boolean {
  const live = items.filter((item) => LIVE_ITEM.has(item.status ?? ""));
  if (!live.length || !live.every((item) => item.kind === "reminderChild")) return false;
  return items.some((item) => item.kind === "agentMessage" && !LIVE_ITEM.has(item.status ?? ""));
}

export function inferPlan(items: TranscriptItem[]): PlanItem[] {
  const text = [...items].reverse().find((item) => item.kind === "reasoning" || item.kind === "agentMessage")?.text ?? "";
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => /^[-*•]|\d+\./.test(line) || /^\[[ x~]\]/i.test(line));
  return lines.slice(0, 12).map((line, index) => {
    const label = line.replace(/^[-*•]\s*/, "").replace(/^\d+\.\s*/, "");
    const checked = /\[[xX]\]/.test(label) || /✓/.test(line);
    const text = label.replace(/^\[[ xX~]\]\s*/, "").replace(/^[✓●○]\s*/, "");
    return { id: `inferred-${index}`, text, status: checked ? "completed" : "pending" };
  });
}

/**
 * Terminal receipts (failed/cancelled/interrupted) are actionable state, not history:
 * only the latest run shows one, and it hides the moment a new turn starts so a
 * Continue/Retry never leaves a stale "Run failed" banner behind.
 */
export function showTerminalReceipt(status: AgentRunStatus, isLast: boolean, busy: boolean): boolean {
  if (status !== "failed" && status !== "cancelled" && status !== "interrupted") return false;
  return isLast && !busy;
}

/** Workspace-relative paths this thread's agent wrote (edit/write/create tool calls), in first-touch order. */
export function editedPaths(items: TranscriptItem[], workspaceRoot?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== "toolCall" && item.kind !== "userShell") continue;
    if (classifyTool(item.tool, item.kind) !== "edit") continue;
    const relative = relativeToWorkspace(pathFromItem(item), workspaceRoot);
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    out.push(relative);
  }
  return out;
}

/** Best-effort workspace-relative path for matching transcript paths against git/diff paths. */
export function relativeToWorkspace(raw: string | undefined, root?: string): string | null {
  if (!raw) return null;
  const norm = raw.replace(/\\/g, "/");
  const base = root?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (base) {
    if (norm === base) return null;
    if (norm.startsWith(`${base}/`)) return norm.slice(base.length + 1);
  }
  if (norm.startsWith("/") || /^[A-Za-z]:\//.test(norm)) return null;
  const stripped = norm.replace(/^\.\//, "").replace(/^\/+/, "");
  return stripped || null;
}

export function runSummary(run: AgentRun): { title: string; changed: string[]; files: number } {
  const message = [...run.steps].reverse().find((step) => step.kind === "message" && step.detail)?.detail?.split("\n\n")[0] ?? "Run finished.";
  const edits = run.steps.filter((step) => step.kind === "edit" && step.path).map((step) => step.path as string);
  return { title: message.slice(0, 240), changed: [...new Set(edits)], files: new Set(edits).size };
}

/** Keep the plan's position while its steps only change status; a new list of steps is a new plan, anchored at the latest item. */
/**
 * Prepend an older history chunk: the chunk is strictly older than anything
 * held, so existing items win every identity collision and the live stream
 * can never be regressed by a page that was already stale on arrival.
 */
export function mergeHistoryItems(existing: TranscriptItem[], older: TranscriptItem[]): TranscriptItem[] {
  const held = new Set(existing.map((item) => item.itemId));
  return [...older.filter((item) => !held.has(item.itemId)), ...existing];
}

export function planAnchorFor(thread: Pick<Thread, "items" | "plan" | "planAnchor">, next: PlanItem[]): string | undefined {
  const same = thread.plan?.length === next.length && thread.plan.every((item, index) => item.text === next[index].text);
  if (thread.planAnchor && (same || !next.length)) return thread.planAnchor;
  return thread.items[thread.items.length - 1]?.itemId;
}

/** Estimate run height in pixels before it has been measured in the DOM. */
export function estimateRunHeight(run: AgentRun): number {
  let est = 70;
  for (const step of run.steps) {
    if (step.kind === "message") est += step.detail && step.detail.length > 200 ? 120 : 60;
    else if (step.kind === "reasoning") est += 50;
    else if (step.kind === "workflow" || step.kind === "subagent") est += 160;
    else est += 36;
  }
  return Math.max(90, Math.min(1200, est));
}

export type VirtualWindow = {
  startIndex: number;
  endIndex: number;
  totalHeight: number;
  isVirtualized: boolean;
};

/**
 * Compute the visible slice of runs for long threads (100+ items).
 * When runs.length <= minThreshold, all runs are rendered directly.
 */
export function computeVirtualWindow(
  runs: AgentRun[],
  scrollTop: number,
  viewportHeight: number,
  getHeight: (run: AgentRun) => number,
  overscan = 4,
  minThreshold = 10,
): VirtualWindow {
  const count = runs.length;
  if (count <= minThreshold || viewportHeight <= 0) {
    const total = runs.reduce((sum, r) => sum + getHeight(r), 0);
    return { startIndex: 0, endIndex: Math.max(0, count - 1), totalHeight: total, isVirtualized: false };
  }

  const heights = runs.map(getHeight);
  const offsets: number[] = new Array(count);
  let currentOffset = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = currentOffset;
    currentOffset += heights[i];
  }
  const totalHeight = currentOffset;

  const viewTop = Math.max(0, scrollTop);
  const viewBottom = viewTop + viewportHeight;

  let start = 0;
  while (start < count - 1 && offsets[start] + heights[start] < viewTop) {
    start++;
  }

  let end = start;
  while (end < count - 1 && offsets[end] < viewBottom) {
    end++;
  }

  const startIndex = Math.max(0, start - overscan);
  const endIndex = Math.min(count - 1, end + overscan);

  return { startIndex, endIndex, totalHeight, isVirtualized: true };
}

