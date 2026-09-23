import { create } from "zustand";
import { estimateTurnTokens, mergeHistoryItems, planAnchorFor } from "./agent";
import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";
import { SettingsPersistence, settingsFields } from "./settingsPersistence";
import { SessionMemoryPersistence, type SessionMemory, type ThreadMeta } from "./sessionMemory";
import { agentIdentities, bridge, cliLogout, confirmAgentBin, enterpriseStatus, gitCommit, gitDiscardAll, gitDiscardFiles, gitDiscardHunk, gitSnapshot, gitStage, listWorkspaceFiles, mockThreads, onBridgeEvent, persistStoreDocument, pickFolder, pickPluginBundle, pickSkillSource, pluginInstall, pluginList, projectInit, readDroppedPaths, removeGrant, repairStoreDocument, skillImport, skillInstall, skillList, skillUninstall, trustPreview, verifyGrants } from "./bridge";
import { MOCK_AGENT_MODELS, MOCK_AGENTS, MOCK_GIT, MOCK_MODELS } from "./mock";
import { clampTier, modelFor, tiersFor } from "./effort";
import { dropHunk, parseUnifiedDiff } from "./diff";
import { MAX_DROP_FILES, refPathForDrop } from "./drop";
import { authRequired, classifyError, timeoutUnknown } from "./errors";
import { log } from "./logger";
import { parseShellEscape, parseSkillInvocation } from "./composerText";
import { composePrompt, humanizeToolName, isTauri, timeFilterCutoff, titleFromText, uid, untitledThreadTitle, workspaceName } from "./format";
import { notify, shouldNotify } from "./notify";
import { rekeyThreadState } from "./agentSwitch";
import {
  DEFAULT_SETTINGS,
  agentEnabled,
  type AgentId,
  type AgentIdentity,
  type AgentInfo,
  type AgentSessionConfig,
  type ApprovalRequest,
  type Detection,
  type GitSnapshot,
  type PlanItem,
  type Settings,
  type Thread,
  type TranscriptItem,
  type Workspace,
  type ComposerImage, type ContextRef, type HostCompat, type HostInfo, type Model, type SessionConfig, type SessionMetadata, type SessionOpening, type SessionPreview,
  type UserInputRequest, type UserInputResponse, type GoalState, type ContextUsage, type TokenUsage, type SubscriptionUsage, type SubagentResult, type TrustPreview, type SkillRow, type McpServer, type PluginEntry, type SkillEntry, type HostPosture, type EnterpriseStatus,
} from "./types";

const persist = isTauri() ? new LazyStore("muse-desktop.json", { autoSave: false, defaults: {} }) : null;
/**
 * `tauri-plugin-store` saves with a bare truncate-and-write, so a crash mid-save
 * can leave `muse-desktop.json` half-written — silently destroying every draft
 * and thread title. Keep the plugin as the in-memory cache and reader, but route
 * saves through the native atomic writer (temp file + rename + `.bak`).
 */
const persistentStore: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<unknown>; save(): Promise<unknown> } | null = persist ? {
  get: <T,>(key: string) => persist.get<T>(key),
  set: (key: string, value: unknown) => persist.set(key, value),
  save: async () => {
    const entries = await persist.entries<unknown>();
    await persistStoreDocument(JSON.stringify(Object.fromEntries(entries)));
  },
} : null;

const settingsPersistence = persistentStore ? new SettingsPersistence(persistentStore, {
  get: () => invoke<string | null>("credential_get"),
  set: (value) => invoke<void>("credential_set", { value }),
}) : null;
const memoryPersistence = new SessionMemoryPersistence(persistentStore, typeof localStorage === "undefined" ? null : localStorage);
const pendingDeltas = new Map<string, { text?: string; output?: string }>();
let memoryTimer: ReturnType<typeof setTimeout> | null = null;
const previewTimers = new Map<string, number>();
let hostStart: Promise<void> | null = null;
let hydration: Promise<void> | null = null;
let selectionVersion = 0;
let gitVersion = 0;
let modelVersion = 0;
/** Sources with a `forkSession` in flight. `session/fork` is not idempotent. */
const forking = new Set<string>();
type Draft = { text: string; images: ComposerImage[]; config?: SessionConfig; refs?: ContextRef[] };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Validate a `usage/read` / `usage/changed` payload; malformed or absent snapshots become null. */
function asSubscriptionUsage(value: unknown): SubscriptionUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const window = record.window as Record<string, unknown> | null;
  const weekly = record.weekly as Record<string, unknown> | null;
  if (!window || typeof window !== "object" || !weekly || typeof weekly !== "object") return null;
  if (typeof record.tier !== "string" || !record.tier.trim()) return null;
  const required = [record.observedAtMs, window.usedPercent, window.resetsAtMs, weekly.usedPercent, weekly.resetsAtMs];
  if (!required.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  const duration = window.windowDurationMins;
  return {
    observedAtMs: record.observedAtMs as number,
    tier: (record.tier as string).trim(),
    window: {
      usedPercent: window.usedPercent as number,
      resetsAtMs: window.resetsAtMs as number,
      ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? { windowDurationMins: duration } : {}),
    },
    weekly: { usedPercent: weekly.usedPercent as number, resetsAtMs: weekly.resetsAtMs as number },
  };
}
/** "Thread settings updated" style confirmations fade after a few seconds. */
const noticeTokens = new Map<string, number>();
function scheduleConfigNoticeClear(sessionId: string, notice: string, delay = 4000) {
  // Keyed per thread: a second notice must not strand the first thread's clear.
  const token = (noticeTokens.get(sessionId) ?? 0) + 1;
  noticeTokens.set(sessionId, token);
  window.setTimeout(() => {
    if (noticeTokens.get(sessionId) !== token) return;
    useAppStore.setState((state) => ({
      threads: state.threads.map((thread) => thread.sessionId === sessionId && thread.configNotice === notice ? { ...thread, configNotice: undefined } : thread),
    }));
  }, delay);
}
const draftKey = (state: Pick<AppStore, "selectedSessionId" | "selectedWorkspaceId">) => state.selectedSessionId ? `thread:${state.selectedSessionId}` : `project:${state.selectedWorkspaceId}`;
const defaults = (state: Pick<Settings, "defaultAgentId" | "defaultModel" | "defaultProviderId" | "defaultApprovalMode" | "defaultEffort" | "enabledAgents">): SessionConfig => ({
  ...(state.defaultAgentId && state.defaultAgentId !== "muse" && agentEnabled(state, state.defaultAgentId) ? { agentId: state.defaultAgentId } : {}),
  ...(state.defaultModel.trim() ? { modelId: state.defaultModel.trim(), providerId: state.defaultProviderId } : {}),
  approvalMode: state.defaultApprovalMode,
  effort: state.defaultEffort,
});
const OPENCODE_MODES = [
  { value: "build", name: "build", description: "The default agent. Executes tools based on configured permissions." },
  { value: "plan", name: "plan", description: "Plan mode. Disallows all edit tools." },
];
const metadataConfig = (session: SessionMetadata, effort: SessionConfig["effort"]): SessionConfig => ({
  ...(session.modelId ? { modelId: session.modelId, providerId: session.providerId ?? undefined } : {}),
  approvalMode: session.approvalMode?.mode,
  effort,
});
function switchDraft(state: AppStore, workspaceId: string | null, sessionId: string | null) {
  const drafts = { ...state.drafts, [draftKey(state)]: { ...state.drafts[draftKey(state)], text: state.composer, images: state.images, refs: state.contextRefs } };
  const target = draftKey({ selectedWorkspaceId: workspaceId, selectedSessionId: sessionId });
  return { drafts, selectedWorkspaceId: workspaceId, selectedSessionId: sessionId, composer: drafts[target]?.text ?? "", images: drafts[target]?.images ?? [], contextRefs: drafts[target]?.refs ?? [] };
}

type AppStore = Settings & {
  ready: boolean;
  preview: boolean;
  detection: Detection | null;
  /** Live `muse serve` handshake facts; null when the host is not running. */
  hostInfo: HostInfo | null;
  /** Trust class the running host was constructed with; null while stopped. */
  hostTrust: boolean | null;
  /** Session-list time filter (`updatedAfter`) and all-workspace listing. */
  listSince: null | "day" | "week" | "month";
  showAllWorkspaces: boolean;
  setListSince: (value: null | "day" | "week" | "month") => void;
  setShowAllWorkspaces: (value: boolean) => void;
  /** Trust decision dialog state for one workspace. */
  trustDialog: { workspaceId: string; loading: boolean; error: string | null; preview: TrustPreview | null } | null;
  openTrustDialog: (workspaceId: string, prefetched?: TrustPreview) => Promise<void>;
  closeTrustDialog: () => void;
  /** First-open trust prompt: previews a workspace's skills/rules and opens the trust dialog once. */
  promptWorkspaceTrust: (workspaceId: string) => Promise<void>;
  /** File paths for @-mentions in the selected workspace (git ls-files / bounded walk). */
  fileIndex: { workspaceId: string; paths: string[]; loadedAt: number } | null;
  /** Debounced (2s) index refresh, rate-limited to one fetch per 10s. */
  refreshFileIndex: (workspaceId?: string) => void;
  confirmDialog: { title: string; body?: string; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void } | null;
  confirm: (options: { title: string; body?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
  confirmTrust: () => Promise<void>;
  /** Agent-config setup dialog: dry-run preview, then scaffold with conflict handling. */
  initDialog: { workspaceId: string; loading: boolean; error: string | null; preview: string | null; conflict: boolean; done: boolean } | null;
  openInitDialog: (workspaceId: string) => Promise<void>;
  closeInitDialog: () => void;
  runInit: (force: boolean) => Promise<void>;
  untrustWorkspace: (workspaceId: string) => Promise<void>;
  openLastThread: () => Promise<void>;
  /** Refresh the session skill catalog (`skill/list`). */
  refreshSkills: (sessionId?: string) => Promise<void>;
  /** Host-configured MCP servers (`mcpServers` verb); host-global, not per session. */
  mcpServers: McpServer[];
  mcpLoading: boolean;
  mcpError: string | null;
  refreshMcpServers: () => Promise<void>;
  /** Plugin inventory (`plugin_list`); `availableShown` selects marketplace-available rows. */
  pluginEntries: PluginEntry[];
  pluginsAvailableShown: boolean;
  pluginsLoading: boolean;
  pluginsError: string | null;
  refreshPlugins: (available?: boolean) => Promise<void>;
  /** Pick a bundle folder and install it, then show the installed inventory. */
  installPlugin: () => Promise<void>;
  /** CLI skill inventory (`skill_list`) for lifecycle management. */
  skillEntries: SkillEntry[];
  skillsLoading: boolean;
  skillsError: string | null;
  refreshManagedSkills: () => Promise<void>;
  /** Pick a bundle folder and install it, then refresh the inventory. */
  installSkill: () => Promise<void>;
  /** Import skills from another agent; dry runs return the preview text. */
  importSkills: (from: "claude" | "codex", dryRun: boolean) => Promise<string>;
  /** Uninstall a skill by id, then refresh the inventory. */
  uninstallSkill: (id: string) => Promise<void>;
  /** Enterprise configuration status (`config status`); null until loaded. */
  enterprise: EnterpriseStatus | null;
  enterpriseLoading: boolean;
  enterpriseError: string | null;
  refreshEnterprise: () => Promise<void>;
  /** Agent CLIs detected on this machine. */
  agents: AgentInfo[];
  /** Native ACP binary identities (canonical path, pin/drift state). */
  agentIdentities: AgentIdentity[];
  /** Which agent `models` belongs to. */
  modelsAgentId: AgentId;
  settingsOpen: boolean;
  dockOpen: boolean;
  dockTab: "changes" | "diff" | "activity";
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  threads: Thread[];
  /** Workspaces whose session listing is in flight; the sidebar shows a loading note. */
  threadsLoading: string[];
  git: GitSnapshot | null;
  models: Model[];
  modelsLoading: boolean;
  modelsError: string | null;
  gitLoading: boolean;
  gitError: string | null;
  subscriptionUsage: SubscriptionUsage | null;
  subscriptionUsageLoading: boolean;
  subscriptionUsageError: string | null;
  subscriptionUsageAt: number | null;
  starting: boolean;
  submitting: boolean;
  drafts: Record<string, Draft>;
  threadMeta: Record<string, ThreadMeta>;
  threadSearch: string;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  offline: boolean;
  inspectorTab: "changes" | "diff" | "activity";
  showArchived: boolean;
  refreshModels: () => Promise<void>;
  setSessionConfig: (patch: Partial<SessionConfig>) => Promise<void>;
  dismissError: () => void;
  dismissPersistNotice: () => void;
  composer: string;
  images: ComposerImage[];
  contextRefs: ContextRef[];
  addContextRefs: (refs: ContextRef[]) => void;
  removeContextRef: (id: string) => void;
  retryLast: () => Promise<void>;
  continueThread: () => Promise<void>;
  error: string | null;
  /** REC-002: local persistence failed, or the settings file was recovered after corruption. */
  persistNotice: string | null;
  hydrate: () => Promise<void>;
  save: () => Promise<void>;
  commitSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshDetection: () => Promise<void>;
  /** Remove CLI + desktop credentials, close sessions, and re-detect auth. */
  signOut: () => Promise<void>;
  refreshAgentIdentities: () => Promise<void>;
  confirmAgentBin: (agentId: AgentId) => Promise<void>;
  startHost: (restart?: boolean) => Promise<void>;
  chooseProject: () => Promise<void>;
  addWorkspace: (path: string, grantId?: string | null) => Promise<void>;
  removeWorkspace: (id: string) => void;
  renameThread: (sessionId: string, title: string) => void;
  pinThread: (sessionId: string) => void;
  /** Swap sidebar positions with a neighbouring thread. */
  swapThreadOrder: (sessionId: string, otherId: string) => void;
  /** Persist a drag-reordered thread list; ids are given in the order they now appear. */
  reorderThreads: (sessionIds: string[]) => void;
  archiveThread: (sessionId: string, archived?: boolean) => void;
  deleteThread: (sessionId: string) => void;
  forkThread: (sessionId?: string, lastTurnId?: string) => Promise<void>;
  compactThread: () => Promise<void>;
  /** Read-only session preview (metadata + recent transcript; never attaches). */
  previewSession: { sessionId: string; title: string; loading: boolean; error: string | null; snapshot: SessionPreview | null } | null;
  openPreview: (sessionId: string) => Promise<void>;
  closePreview: () => void;
  /** Full stored tool output (`item/readOutput` pages, concatenated). */
  outputViewer: { sessionId: string; itemId: string; title: string; loading: boolean; error: string | null; encoding: "utf8" | "base64"; mediaType: string; content: string; byteLen: number; complete: boolean } | null;
  openOutput: (sessionId: string, itemId: string) => Promise<void>;
  closeOutput: () => void;
  /** Child lifecycle/messaging (`subagent/*`); throws unless the host accepts. */
  controlSubagent: (sessionId: string, subagentId: string, action: string, extra?: { body?: string; reason?: string }) => Promise<void>;
  /** Foreground/background tool-task control (`task/*`); throws unless accepted. */
  controlTask: (sessionId: string, action: string, taskId?: string) => Promise<void>;
  /** Workflow-run control (`workflow/*`); throws unless accepted. */
  controlWorkflow: (sessionId: string, workflowRunId: string, action: string, child?: { childId: string; attempt: number }) => Promise<void>;
  /** Session-goal control (`goal/*`); resolves the ack (a `turnId` names the goal-driving turn). */
  controlGoal: (sessionId: string, action: string, objective?: string) => Promise<{ turnId?: string }>;
  /** Child drill-down: result envelope plus the child transcript via `session/read`. */
  childSession: { sessionId: string; itemId: string; title: string; loading: boolean; error: string | null; result: SubagentResult | null; items: TranscriptItem[]; consumed: boolean } | null;
  openChild: (sessionId: string, itemId: string) => Promise<void>;
  consumeChild: () => Promise<void>;
  closeChild: () => void;
  /** Fetch one more older-history chunk past the held cursor and prepend it. */
  loadOlderHistory: () => Promise<void>;
  /** Rebuild the transcript after a failed fill or history load (re-resume). */
  rebuildThread: () => Promise<void>;
  setThreadSearch: (value: string) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setOffline: (offline: boolean) => void;
  setShowArchived: (show: boolean) => void;
  setInspectorTab: (tab: "changes" | "diff" | "activity") => void;
  selectWorkspace: (id: string) => Promise<void>;
  loadWorkspaceThreads: (id: string) => Promise<void>;
  selectThread: (sessionId: string) => Promise<void>;
  newThread: () => Promise<void>;
  /** Bind this thread (or the project draft) to another agent CLI. */
  switchThreadAgent: (agentId: AgentId) => Promise<void>;
  sendPrompt: (options?: { resetTaskState?: boolean; disposition?: "queue" | "steer" | "replace" }) => Promise<void>;
  stopTurn: () => Promise<void>;
  unqueueTurn: (turnId: string) => Promise<void>;
  decide: (approvalId: string, choiceId: string) => Promise<void>;
  respondUserInput: (sessionId: string, userInputId: string, response: UserInputResponse) => Promise<void>;
  refreshGit: () => Promise<void>;
  discardGitFiles: (paths: string[]) => Promise<void>;
  discardGitHunk: (path: string, hunk: number) => Promise<void>;
  discardAllGit: () => Promise<void>;
  stageGitFiles: (paths: string[], stage: boolean) => Promise<void>;
  commitGit: (message: string) => Promise<void>;
  refreshSubscriptionUsage: (force?: boolean) => Promise<void>;
  attachImages: (files: FileList | File[]) => Promise<void>;
  attachDroppedPaths: (paths: string[]) => Promise<void>;
  clearImages: () => void;
  setComposer: (value: string) => void;
  viewer: { images: ComposerImage[]; index: number } | null;
  openViewer: (images: ComposerImage[], index?: number) => void;
  closeViewer: () => void;
  stepViewer: (delta: number) => void;
  setSettingsOpen: (open: boolean) => void;
  setDockOpen: (open: boolean) => void;
  setDockTab: (tab: "changes" | "diff" | "activity") => void;
  /** Explicitly opened diff tabs; null means the dock auto-shows the first file. */
  diffTabs: string[] | null;
  diffActive: string | null;
  openFileDiff: (path: string) => void;
  closeFileDiff: (path: string) => void;
  setActiveDiff: (path: string | null) => void;
  enterPreview: () => void;
  exitPreview: () => Promise<void>;
  /** Device-code prompt from an in-flight `muse login`; null when no sign-in is running. */
  loginPrompt: { url: string; code: string } | null;
  loginBusy: boolean;
  loginError: string | null;
  startLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
};

type PreviewSnapshot = Pick<AppStore, "workspaces" | "selectedWorkspaceId" | "selectedSessionId" | "threads" | "drafts" | "composer" | "images" | "contextRefs" | "git">;
let previewSnapshot: PreviewSnapshot | null = null;

/** Newest approval takes the slot; the displaced one waits (stack order). */
function parkApproval(thread: Thread, request: ApprovalRequest): Thread {
  if (thread.pendingApproval && thread.pendingApproval.approvalId !== request.approvalId) {
    return { ...thread, pendingApproval: request, queuedApprovals: [...(thread.queuedApprovals ?? []), thread.pendingApproval] };
  }
  return { ...thread, pendingApproval: request };
}

/** Clear the slot and surface the newest waiter, if any. */
function advanceApprovals(thread: Thread): Thread {
  const queued = [...(thread.queuedApprovals ?? [])];
  const next = queued.pop() ?? null;
  return { ...thread, pendingApproval: next, queuedApprovals: queued };
}

/** Drop one approval wherever it sits (resolved elsewhere), advancing the slot when hit. */
function dropApproval(thread: Thread, approvalId: string): { thread: Thread; slotted: boolean } {
  const queued = (thread.queuedApprovals ?? []).filter((item) => item.approvalId !== approvalId);
  if (thread.pendingApproval?.approvalId !== approvalId) return { thread: { ...thread, queuedApprovals: queued }, slotted: false };
  const next = queued[queued.length - 1] ?? null;
  return { thread: { ...thread, pendingApproval: next, queuedApprovals: next ? queued.slice(0, -1) : queued }, slotted: true };
}

/** Rename generations (per session) so only the latest settlement wins; plus the in-flight set for host-name racing. */
const renameGeneration = new Map<string, number>();
const renameInflight = new Set<string>();

function applyItem(thread: Thread, incoming: TranscriptItem): Thread {
  const buffered = pendingDeltas.get(incoming.itemId);
  if (buffered) {
    pendingDeltas.delete(incoming.itemId);
    incoming = {
      ...incoming,
      text: incoming.text || buffered.text,
      visibleOutput: incoming.visibleOutput || buffered.output,
    };
  }
  const index = thread.items.findIndex((item) => item.itemId === incoming.itemId);
  const items = index >= 0
    ? thread.items.map((item, i) => (i === index ? { ...item, ...incoming } : item))
    : [...thread.items, incoming];
  const user = items.find((item) => item.kind === "userMessage" && item.text);
  return {
    ...thread,
    items,
    updatedAt: new Date().toISOString(),
    title: thread.customTitle ? thread.title : user?.text ? titleFromText(user.text) : thread.title,
  };
}

function scheduleMemory(get: () => AppStore) {
  if (memoryTimer) clearTimeout(memoryTimer);
  memoryTimer = setTimeout(() => { void persistMemory(get()); }, 200);
}

/** Composer drafts persist on a slower cadence than thread metadata — per-keystroke saves are wasteful. */
let draftTimer: ReturnType<typeof setTimeout> | null = null;

// @-mention file index: debounced refresh, capped at one fetch per 10s.
const FILE_INDEX_DEBOUNCE_MS = 2000;
const FILE_INDEX_MIN_GAP_MS = 10_000;
let fileIndexTimer: ReturnType<typeof setTimeout> | null = null;
let fileIndexLastFetch = 0;
function scheduleDraft(get: () => AppStore) {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { draftTimer = null; void persistMemory(get()); }, 1000);
}

/** Persist now and drop the pending debounce, so a later fire cannot re-save a cleared composer. */
function flushDraft(get: () => AppStore) {
  if (!draftTimer) return;
  clearTimeout(draftTimer);
  draftTimer = null;
  void persistMemory(get());
}

async function persistMemory(state: AppStore) {
  if (state.preview) return;
  const threadMeta: Record<string, ThreadMeta> = { ...state.threadMeta };
  for (const thread of state.threads) {
    threadMeta[thread.sessionId] = {
      ...threadMeta[thread.sessionId],
      title: thread.title,
      agentId: thread.agentId,
      customTitle: thread.customTitle,
      pinned: thread.pinned,
      order: thread.order,
      archived: thread.archived,
      lastStatus: thread.status,
      lastOutcome: thread.lastOutcome,
      forkedFrom: thread.forkedFrom ?? undefined,
      deleted: undefined,
    };
  }
  const memory: SessionMemory = {
    version: 1,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    drafts: { ...state.drafts, [draftKey(state)]: { text: state.composer, images: state.images, refs: state.contextRefs, config: state.drafts[draftKey(state)]?.config } },
    threadMeta,
    dockOpen: state.dockOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    subscriptionUsage: state.subscriptionUsage,
  };
  try {
    await memoryPersistence.save(memory);
    notePersistResult(true);
  }
  catch (error) {
    log.warn("memory.save_failed", { error: String(error) });
    notePersistResult(false);
  }
}

let persistFailures = 0;

/**
 * REC-002: a save failure must be visible. The composer promises drafts are
 * kept locally, and that promise must not survive the moment it stops being
 * true. The banner appears on the first failure and clears on the next success.
 */
function notePersistResult(ok: boolean) {
  persistFailures = ok ? 0 : persistFailures + 1;
  if (ok || persistFailures === 1) {
    useAppStore.setState({
      persistNotice: ok ? null : "Drafts and thread titles are not being saved locally. Changes made now may be lost.",
    });
  }
}

/** Host session name first (Muse names sessions from the first prompt), then the last title we saw. */
function listedTitle(session: SessionMetadata, meta?: ThreadMeta): string {
  // Durable `name` is authoritative; derived `title` is the host's display
  // heuristic for sessions without an allocated name (SS2.14.1).
  const name = session.name?.trim() || session.title?.trim();
  if (name) return titleFromText(name);
  return meta?.title?.trim() || untitledThreadTitle(session.updatedAt);
}

function applyMeta(thread: Thread, meta?: ThreadMeta, sessionStatus?: string): Thread {
  if (!meta) return thread;
  const interrupted = meta.lastStatus === "running" && sessionStatus !== "running";
  return {
    ...thread,
    title: meta.customTitle && meta.title ? meta.title : thread.title,
    customTitle: meta.customTitle,
    pinned: meta.pinned,
    order: meta.order ?? thread.order,
    archived: meta.archived,
    lastOutcome: interrupted ? "interrupted" : meta.lastOutcome,
    forkedFrom: meta.forkedFrom ?? thread.forkedFrom,
  };
}

/**
 * Reconcile persisted workspaces against the native grant store via
 * verify-only checks (the native side never lists grants). A workspace keeps
 * its grant only when the id is live for the same directory; anything else
 * becomes ungranted (visible, but session/git/open operations fail until the
 * folder is re-opened through the native picker). Verified workspaces heal
 * their stored path to the canonical root, so re-opening re-attaches instead
 * of duplicating.
 */
async function reconcileGrants(workspaces: Workspace[]): Promise<{ workspaces: Workspace[]; dropped: number }> {
  if (!isTauri()) return { workspaces, dropped: 0 };
  const claimed = workspaces.filter((workspace) => workspace.grantId).map((workspace) => ({ id: workspace.grantId as string, path: workspace.path }));
  let verdicts: Array<{ id: string; ok: boolean; path?: string | null }> = [];
  try { verdicts = await verifyGrants(claimed); }
  catch { return { workspaces: workspaces.map((workspace) => ({ ...workspace, grantId: null })), dropped: claimed.length }; }
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  let dropped = 0;
  const next = workspaces.map((workspace) => {
    if (!workspace.grantId) return workspace;
    const verdict = byId.get(workspace.grantId);
    if (verdict?.ok) return verdict.path && verdict.path !== workspace.path ? { ...workspace, path: verdict.path, name: workspaceName(verdict.path) } : workspace;
    dropped += 1;
    return { ...workspace, grantId: null };
  });
  return { workspaces: next, dropped };
}

/** Output tokens spent since the turn started; undefined when the agent doesn't report usage. */
export function turnTokens(thread: Pick<Thread, "usage" | "turnStartOutput">): number | undefined {
  const now = thread.usage?.outputTokens;
  return now == null ? undefined : Math.max(0, now - (thread.turnStartOutput ?? 0));
}

/** Usage can land just after turnCompleted; fold it into the finished turn's count. */
function withLateUsage(thread: Thread): Thread {
  if (thread.status === "running" || !thread.turnStats || thread.turnStartOutput == null) return thread;
  const outputTokens = turnTokens(thread);
  if (!outputTokens || outputTokens === thread.turnStats.outputTokens) return thread;
  return { ...thread, turnStats: { ...thread.turnStats, outputTokens, estimated: false } };
}

/** Error text the renderer keys on to offer a one-click folder re-open. */
export const UNGRANTED_ERROR = "This folder is not granted. Re-open it with Open workspace to restore access.";
export const needsGrant = (text: string | null | undefined) => Boolean(text && text.includes("is not granted"));

/**
 * List one workspace's sessions from every ready agent and fold them into the
 * thread list. Shared by selecting a workspace and by merely expanding one in
 * the tree; `quiet` keeps a background expansion from raising banners that
 * belong to the workspace the user is actually looking at.
 */
async function listWorkspaceThreads(
  get: () => AppStore,
  set: (patch: Partial<AppStore>) => void,
  workspace: Workspace,
  current: () => boolean,
  quiet: boolean,
) {
  const fail = (text: string) => { if (!quiet) set({ error: text }); };
  if (!workspace.grantId && isTauri()) { fail(UNGRANTED_ERROR); return; }
  const ready = readyAgents(get());
  if (!ready.length) {
    if (get().detection?.found && !get().detection?.authenticated) fail("Muse needs credentials before it can open this project. Sign in with `muse` and `/login` for a subscription, or add an API key in Settings.");
    return;
  }
  // Every ready agent contributes its sessions; one failing never blocks the
  // rest. Muse lists at 200 rows × 10 pages with the time filter, across
  // every workspace when the all-projects view is on.
  const updatedAfter = get().listSince ? timeFilterCutoff(get().listSince as "day" | "week" | "month") : undefined;
  set({ threadsLoading: [...get().threadsLoading, workspace.id] });
  let listings: PromiseSettledResult<{ agentId: AgentId; sessions: SessionMetadata[] }>[];
  try {
    listings = await Promise.allSettled(ready.map(async (agent) => {
      if (agent.id === "muse") await get().startHost();
      const all = agent.id === "muse" && get().showAllWorkspaces;
      const { sessions, truncated } = await listWorkspaceSessions(all ? null : workspace, agent.id, 10, undefined, { updatedAfter });
      if (truncated) log.warn("sessions.truncated", { agent: agent.id, workspace: all ? "(all)" : workspace.path, pages: 10 });
      return { agentId: agent.id, sessions };
    }));
  } finally {
    set({ threadsLoading: get().threadsLoading.filter((id) => id !== workspace.id) });
  }
  if (!current()) return;
  const threads = [...get().threads];
  const roots = new Set(get().workspaces.map((item) => item.path));
  for (const [index, listing] of listings.entries()) {
    if (listing.status === "rejected") {
      if (ready[index].id === "muse") fail(`Could not load project: ${message(listing.reason)}`);
      else log.warn("agent.sessions.unavailable", { agent: ready[index].id, error: message(listing.reason) });
      continue;
    }
    const agentId = listing.value.agentId === "muse" ? undefined : listing.value.agentId;
    for (const session of listing.value.sessions) {
      // All-workspace rows for folders never registered have no grant path;
      // they cannot be opened, so they never become threads.
      if (session.workspaceRoot && !roots.has(session.workspaceRoot)) continue;
      const meta = get().threadMeta[session.sessionId];
      if (meta?.deleted || threads.some((thread) => thread.sessionId === session.sessionId)) continue;
      threads.push(applyMeta({ sessionId: session.sessionId, agentId, workspacePath: session.workspaceRoot ?? workspace.path, title: listedTitle(session, meta), order: Date.parse(session.updatedAt ?? "") || Date.now(), updatedAt: session.updatedAt ?? new Date().toISOString(), status: session.status === "running" ? "running" : "idle", unread: false, items: [], activeTurnId: session.activeTurnId, config: { ...metadataConfig(session, agentId ? undefined : get().defaultEffort), ...(agentId ? { agentId } : {}) } }, meta, session.status));
    }
  }
  set({ threads });
  scheduleMemory(get);
  if (!ready.some((agent) => agent.id === "muse")) void get().refreshModels();
}

/**
 * Settle every Muse thread for a host restart: the dead host held their
 * sessions, turns, approvals, and questions, so all of it unwinds to idle
 * with the transcripts kept and a notice on the open thread.
 */
function settleHostRestart(get: () => AppStore, set: (patch: Partial<AppStore>) => void, messageText: string) {
  const selected = get().selectedSessionId;
  set({
    threads: get().threads.map((thread) => thread.agentId ? thread : {
      ...thread,
      opened: false,
      opening: false,
      status: "idle",
      activeTurnId: null,
      pendingTurnKey: null,
      queuedTurns: [],
      pendingApproval: null,
      queuedApprovals: [],
      userInputs: [],
      userInputPending: undefined,
      cancelRequested: false,
      activity: undefined,
      retry: null,
      viewGap: null,
      plan: settlePlan(thread.plan, "cancelled"),
      items: settleItems(thread.items, "cancelled", true),
      ...(thread.sessionId === selected ? { notice: { level: "info" as const, message: messageText } } : {}),
    }),
  });
}

function finishTurn(thread: Thread, turnId?: string): Partial<Thread> {
  if (thread.turnStartedAt == null) return {};
  const reported = turnTokens(thread);
  const estimate = estimateTurnTokens(thread.items);
  const outputTokens = reported || estimate || undefined;
  return { turnStats: { turnId, durationMs: Date.now() - thread.turnStartedAt, outputTokens, estimated: !reported && Boolean(estimate) }, turnStartedAt: undefined };
}

function settlePlan(plan: PlanItem[] | undefined, outcome: "cancelled" | "failed" | "interrupted") {
  if (!plan) return plan;
  return plan.map((item) => item.status !== "inProgress" ? item : { ...item, status: outcome === "failed" ? "failed" as const : "cancelled" as const });
}

function settleItems(items: TranscriptItem[], outcome: "cancelled" | "failed" | "interrupted", includeAgents = false) {
  const status = outcome === "failed" ? "failed" : "cancelled";
  return items.map((item) => item.status !== "inProgress" || (!includeAgents && (item.kind === "workflow" || item.kind === "subagent")) ? item : { ...item, status });
}

/** Settle one stale turn's in-progress items (e.g. a replaced turn whose completion arrives after its successor started). */
function settleTurnItems(items: TranscriptItem[], turnId: string, terminal?: string) {
  const status = terminal === "failed" ? "failed" : "cancelled";
  return items.map((item) => item.turnId !== turnId || item.status !== "inProgress" ? item : { ...item, status });
}

export const useAppStore = create<AppStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  ready: false,
  preview: false,
  detection: null,
  hostInfo: null,
  hostTrust: null,
  listSince: null,
  showAllWorkspaces: false,
  agents: [],
  agentIdentities: [],
  mcpServers: [],
  mcpLoading: false,
  mcpError: null,
  pluginEntries: [],
  pluginsAvailableShown: false,
  pluginsLoading: false,
  pluginsError: null,
  skillEntries: [],
  skillsLoading: false,
  skillsError: null,
  enterprise: null,
  enterpriseLoading: false,
  enterpriseError: null,
  modelsAgentId: "muse",
  settingsOpen: false,
  dockOpen: true,
  dockTab: "changes",
  inspectorTab: "changes",
  selectedWorkspaceId: null,
  selectedSessionId: null,
  threads: [],
  threadsLoading: [],
  threadMeta: {},
  threadSearch: "",
  sidebarCollapsed: false,
  paletteOpen: false,
  offline: typeof navigator !== "undefined" ? navigator.onLine === false : false,
  showArchived: false,
  git: null,
  diffTabs: null,
  diffActive: null,
  models: [],
  modelsLoading: false,
  modelsError: null,
  gitLoading: false,
  gitError: null,
  subscriptionUsage: null,
  subscriptionUsageLoading: false,
  subscriptionUsageError: null,
  subscriptionUsageAt: null,
  starting: false,
  submitting: false,
  drafts: {},
  composer: "",
  images: [],
  contextRefs: [],
  error: null,
  persistNotice: null,
  loginPrompt: null,
  loginBusy: false,
  loginError: null,
  dismissPersistNotice: () => set({ persistNotice: null }),
  dismissError: () => set({ error: null, threads: get().threads.map((thread) => thread.sessionId === get().selectedSessionId ? { ...thread, error: null } : thread) }),

  startLogin: async () => {
    if (get().loginBusy || get().preview) return;
    set({ loginBusy: true, loginError: null, loginPrompt: null });
    try {
      const prompt = await bridge<{ url: string; code: string }>("startLogin", { museBin: get().museBin || undefined });
      if (!prompt?.url || !prompt?.code) throw new Error("Muse did not show a sign-in code.");
      set({ loginPrompt: { url: prompt.url, code: prompt.code } });
    } catch (error) {
      set({ loginError: message(error), loginPrompt: null });
    } finally {
      set({ loginBusy: false });
    }
  },
  cancelLogin: async () => {
    set({ loginPrompt: null, loginError: null });
    try { await bridge("cancelLogin"); }
    catch (error) { log.warn("login cancel failed", { error: message(error) }); }
  },

  hydrate: async () => {
    if (hydration) return hydration;
    hydration = (async () => {
      try {
        // Recover before reading. `tauri-plugin-store` hands back nothing useful
        // for a truncated file, which used to look like an empty state and then
        // get overwritten on the next save — silently losing every draft.
        try {
          const repair = await repairStoreDocument();
          if (repair.status === "restored") {
            set({ persistNotice: `Your saved drafts and thread titles were recovered from a backup (${repair.restoredFrom ?? "backup"}). Anything saved after that point was lost.` });
            log.warn("store.restored", { from: repair.restoredFrom, quarantined: repair.quarantinedTo });
          } else if (repair.status === "quarantined") {
            set({ persistNotice: "Your saved drafts and thread titles could not be read and were set aside (muse-desktop.json.corrupt). Muse started with empty local state." });
            log.warn("store.quarantined", { file: repair.quarantinedTo });
          }
        } catch (error) {
          log.warn("store.repair_failed", { error: String(error) });
        }
        const memory = await memoryPersistence.load();
        if (settingsPersistence) {
          const saved = await settingsPersistence.load();
          // `allowAll` is a per-thread composer choice, never a durable default:
          // a stored value (older build or hand-edited file) is clamped on load.
          if (saved.defaultApprovalMode === "allowAll") {
            log.info("settings.approval_default_coerced");
            saved.defaultApprovalMode = "promptUnmatched";
          }
          set({ ...DEFAULT_SETTINGS, ...saved, threadMeta: memory.threadMeta, drafts: memory.drafts, dockOpen: memory.dockOpen, sidebarCollapsed: memory.sidebarCollapsed });
          if (isTauri()) {
            try {
              const consented = await invoke<boolean>("acp_isolation_consent_get");
              set({ acpUnisolatedConsent: consented === true });
            } catch {
              set({ acpUnisolatedConsent: false });
            }
          }
        } else {
          set({ threadMeta: memory.threadMeta, drafts: memory.drafts, dockOpen: memory.dockOpen, sidebarCollapsed: memory.sidebarCollapsed });
        }
        const restored = asSubscriptionUsage(memory.subscriptionUsage);
        const expired = restored != null && restored.window.resetsAtMs < Date.now() && restored.weekly.resetsAtMs < Date.now();
        if (restored && !expired) set({ subscriptionUsage: restored, subscriptionUsageAt: restored.observedAtMs });
        applyTheme(get().theme, get().accentColor, get().accentSidebar);
        const reconciled = await reconcileGrants(get().workspaces);
        const ungranted = reconciled.workspaces.filter((workspace) => !workspace.grantId);
        if (reconciled.workspaces !== get().workspaces) set({ workspaces: reconciled.workspaces });
        if (ungranted.length && isTauri()) {
          set({ error: `${ungranted.length} ${ungranted.length === 1 ? "folder needs" : "folders need"} to be re-opened to restore access after a security upgrade. Use Open workspace and pick the folder again.` });
        }
        await get().save();
        await get().refreshDetection();
        const detected = get().detection;
        if (detected?.path && !get().museBin) {
          set({ museBin: detected.path });
          await get().save();
        }
        if (!isTauri()) await get().refreshModels();
        const restoreId = memory.selectedWorkspaceId && get().workspaces.some((workspace) => workspace.id === memory.selectedWorkspaceId)
          ? memory.selectedWorkspaceId
          : get().workspaces[0]?.id;
        if (restoreId) {
          await get().selectWorkspace(restoreId);
          if (memory.selectedSessionId && get().threads.some((thread) => thread.sessionId === memory.selectedSessionId)) {
            await get().selectThread(memory.selectedSessionId);
          }
        }
      } catch (error) {
        set({ error: `Startup failed: ${message(error)}. Open Settings to reconnect.` });
      } finally {
        applyTheme(get().theme, get().accentColor, get().accentSidebar);
        set({ ready: true });
      }
    })();
    return hydration;
  },

  save: async () => {
    if (!settingsPersistence || get().preview) return;
    try {
      await settingsPersistence.save(settingsFields(get()));
    } catch (error) {
      set({ error: `Could not save settings: ${message(error)}` });
    }
  },

  commitSettings: async (patch) => {
    const settings = settingsFields({ ...get(), ...patch });
    if (settingsPersistence && !get().preview) await settingsPersistence.save(settings);
    if (isTauri() && !get().preview) {
      try { await invoke("acp_isolation_consent_set", { consented: settings.acpUnisolatedConsent === true }); }
      catch { /* native gate stays at its last durable value */ }
    }
    set({ ...patch, enabledAgents: settings.enabledAgents, acpUnisolatedConsent: settings.acpUnisolatedConsent === true });
    applyTheme(settings.theme, settings.accentColor, settings.accentSidebar);
    const next = get();
    if (next.defaultAgentId && !agentEnabled(next, next.defaultAgentId)) set({ defaultAgentId: undefined });
    const thread = currentThread(get());
    if (thread && !agentEnabled(get(), thread.agentId ?? "muse")) set(switchDraft(get(), get().selectedWorkspaceId, null));
    const projectKey = `project:${get().selectedWorkspaceId}`;
    const project = get().drafts[projectKey];
    if (project?.config?.agentId && !agentEnabled(get(), project.config.agentId)) {
      set({ drafts: { ...get().drafts, [projectKey]: { ...project, config: { ...project.config, agentId: undefined } } } });
    }
  },

  refreshDetection: async () => {
    const detection = await bridge<Detection>("detect", {
      museBin: get().museBin || undefined,
      museApiKey: get().museApiKey.trim() || undefined,
      museAuthMode: get().museAuthMode,
    });
    set({ detection, agents: detection.agents ?? get().agents });
    await get().refreshAgentIdentities();
  },

  signOut: async () => {
    try {
      set({ error: null });
      await cliLogout(get().museBin || undefined);
      if (settingsPersistence && !get().preview) {
        await settingsPersistence.save(settingsFields({ ...get(), museApiKey: "" }));
      }
      set({ museApiKey: "", hostInfo: null, hostTrust: null });
      settleHostRestart(get, set, "Signed out. Sessions are closed; sign back in to continue.");
      await get().refreshDetection();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  refreshAgentIdentities: async () => {
    try {
      set({ agentIdentities: await agentIdentities() });
    } catch {
      // Display-only: a failed lookup leaves the last known identities.
    }
  },

  confirmAgentBin: async (agentId) => {
    const identity = await confirmAgentBin(agentId);
    set({ agentIdentities: [...get().agentIdentities.filter((item) => item.agentId !== agentId), identity] });
  },

  chooseProject: async () => {
    try {
      set({ error: null });
      const picked = await pickFolder();
      if (!picked) return;
      await get().addWorkspace(picked.path, picked.grantId);
      // A grant that never reached the keyring dies with the process; say so
      // now rather than letting the folder go ungranted at the next launch.
      if (picked.warning) set({ error: `Access to this folder could not be saved: ${picked.warning}` });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) });
    }
  },

  startHost: async (restart = false) => {
    if (!hostStart) hostStart = (async () => {
      const museApiKey = get().museApiKey.trim() || undefined;
      const museAuthMode = get().museAuthMode;
      const trustWorkspace = currentWorkspace(get())?.trusted === true;
      const posture = { ephemeralSessions: get().ephemeralSessions, disableWrite: get().disableWrite, disableShell: get().disableShell, sandboxNetwork: get().sandboxNetwork };
      const result = await bridge<{ running?: boolean; compat?: HostCompat; trustWorkspace?: boolean; posture?: HostPosture | null }>("status", { museApiKey, museAuthMode });
      // A running host of the wrong trust class restarts: skills and rules
      // must never mix classes on one host.
      const wrongTrust = result.running && result.trustWorkspace !== undefined && result.trustWorkspace !== trustWorkspace;
      // Posture is also host-construction: a running host built with
      // different flags restarts so the settings always describe the host.
      const runningPosture = result.posture ?? get().hostInfo?.posture ?? null;
      const wrongPosture = result.running && runningPosture !== null && (
        runningPosture.ephemeralSessions !== posture.ephemeralSessions ||
        runningPosture.disableWrite !== posture.disableWrite ||
        runningPosture.disableShell !== posture.disableShell ||
        runningPosture.sandboxNetwork !== posture.sandboxNetwork
      );
      if (restart || wrongTrust || wrongPosture || !result.running) {
        if (wrongTrust) settleHostRestart(get, set, "The host restarted: workspace trust changed.");
        if (wrongPosture) settleHostRestart(get, set, "The host restarted: sandbox posture changed.");
        const started = await bridge<HostInfo>("startHost", {
          museBin: get().museBin || get().detection?.path || undefined,
          museApiKey,
          museAuthMode,
          trustWorkspace,
          noSessionLog: posture.ephemeralSessions,
          disableWrite: posture.disableWrite,
          disableShell: posture.disableShell,
          sandboxNetwork: posture.sandboxNetwork,
        });
        set({ hostInfo: started, hostTrust: started.trustWorkspace ?? trustWorkspace });
      } else if (result.compat && !get().hostInfo?.compat) {
        set({ hostInfo: { ...get().hostInfo, compat: result.compat }, hostTrust: result.trustWorkspace ?? get().hostTrust });
      } else if (get().hostTrust === null && result.trustWorkspace !== undefined) {
        set({ hostTrust: result.trustWorkspace });
      }
    })().finally(() => { hostStart = null; });
    await hostStart;
    await get().refreshModels();
  },

  refreshModels: async () => {
    if (get().preview) {
      const agentId = activeAgentId(get());
      set({ models: agentId === "muse" ? MOCK_MODELS : MOCK_AGENT_MODELS[agentId] ?? [], modelsError: null, modelsLoading: false, modelsAgentId: agentId });
      return;
    }
    const version = ++modelVersion;
    const agentId = activeAgentId(get());
    const thread = currentThread(get());
    const sessionId = thread && (thread.agentId ?? "muse") === agentId ? thread.sessionId : undefined;
    set({ modelsLoading: true, modelsError: null, ...(get().modelsAgentId !== agentId ? { models: [], modelsAgentId: agentId } : {}) });
    try {
      const result = await bridge<{ models: Model[] }>("listModels", { agentId, sessionId });
      if (version === modelVersion) set({ models: result.models ?? [], modelsAgentId: agentId });
    } catch (error) {
      if (version === modelVersion) set({ models: [], modelsError: message(error) });
    } finally {
      if (version === modelVersion) set({ modelsLoading: false });
    }
  },

  refreshSubscriptionUsage: async (force) => {
    const state = get();
    if (state.subscriptionUsageLoading) return;
    if (!force && state.subscriptionUsageAt && Date.now() - state.subscriptionUsageAt < 60_000) return;
    set({ subscriptionUsageLoading: true, subscriptionUsageError: null });
    try {
      // Usage is read from the Muse host. A cold app has never started one, so
      // without this the read fails until some other action happens to boot it.
      if (!state.preview && readyAgents(get()).some((agent) => agent.id === "muse")) await get().startHost();
      const result = await bridge<{ usage?: unknown }>("usage", {});
      set({ subscriptionUsage: asSubscriptionUsage(result?.usage ?? null), subscriptionUsageAt: Date.now() });
      scheduleMemory(get);
    } catch (error) {
      set({ subscriptionUsageError: message(error) });
    } finally {
      set({ subscriptionUsageLoading: false });
    }
  },

  setSessionConfig: async (patch) => {
    const state = get();
    const thread = currentThread(state);
    if (state.starting || state.submitting || thread?.status === "running" || thread?.opening) return;
    if (!thread) {
      const key = draftKey(state);
      const previous = state.drafts[key]?.config ?? defaults(state);
      const switching = patch.agentId && patch.agentId !== (previous.agentId ?? preferredAgent(state));
      // A new agent brings its own models and effort tiers; drop the old agent's picks.
      const next = switching ? { ...previous, agentId: patch.agentId, modelId: undefined, providerId: undefined, effort: undefined, mode: undefined } : fitEffort({ ...previous, ...patch }, state.models);
      set({ drafts: { ...state.drafts, [key]: { text: state.composer, images: state.images, refs: state.contextRefs, config: next } } });
      if (switching) void get().refreshModels();
      return;
    }
    if (thread.agentId) {
      const sessionId = thread.sessionId;
      const agentId = thread.agentId;
      const update = (changes: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...changes } : item) });
      // ACP applies are a serialized round-trip (~2s on Grok). Changes made
      // while one is in flight merge into a trailing call instead of being
      // dropped, so a scrubbed value is never silently lost.
      if (thread.configPending) { update({ pendingConfig: { ...thread.pendingConfig, ...patch } }); return; }
      update({ configPending: true, configNotice: undefined, error: null });
      try {
        let applied: AgentSessionConfig | undefined;
        if (patch.modelId !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setModel", { agentId, sessionId, modelId: patch.modelId })).agentConfig;
        if (patch.effort !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setSessionOption", { agentId, sessionId, option: "effort", value: patch.effort })).agentConfig ?? applied;
        if (patch.mode !== undefined) applied = (await bridge<{ agentConfig?: AgentSessionConfig }>("setSessionOption", { agentId, sessionId, option: "mode", value: patch.mode })).agentConfig ?? applied;
        const latest = get().threads.find((item) => item.sessionId === sessionId);
        update({ config: { ...latest?.config, ...patch, ...agentConfigPatch(applied), agentId }, ...(applied?.modes ? { modes: applied.modes } : {}) });
        if (patch.modelId !== undefined) void get().refreshModels();
      } catch (error) {
        update({ error: `Settings unchanged: ${message(error)}` });
      } finally {
        update({ configPending: false });
        const stashed = get().threads.find((item) => item.sessionId === sessionId)?.pendingConfig;
        if (stashed) { update({ pendingConfig: undefined }); void get().setSessionConfig(stashed); }
      }
      return;
    }
    if (thread.configPending) return;
    const sessionId = thread.sessionId;
    const config = fitEffort({ ...(thread.config ?? defaults(state)), ...patch }, state.models);
    const update = (changes: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...changes } : item) });
    update({ configPending: true, configNotice: undefined, error: null });
    try {
      if (!state.preview) {
        if (!thread.opened) throw new Error("Open this thread successfully before changing its settings.");
        if (patch.modelId !== undefined) {
          const result = await bridge<{ status: string }>("setModel", { sessionId, modelId: config.modelId, providerId: config.providerId });
          if (result.status !== "accepted") throw new Error("Model change was not accepted.");
        }
        if (patch.approvalMode !== undefined) {
          const result = await bridge<{ status: string; effectiveMode: { mode: SessionConfig["approvalMode"] } }>("setApprovalMode", { sessionId, mode: config.approvalMode });
          if (result.status !== "accepted") throw new Error("Approval change was not accepted.");
          config.approvalMode = result.effectiveMode.mode;
        }
        if (patch.effort !== undefined && config.effort) {
          const result = await bridge<{ status: string }>("setReasoningEffort", { sessionId, reasoningEffort: config.effort });
          if (result.status !== "accepted") throw new Error("Effort change was not accepted.");
        }
      }
      update({ config });
    } catch (error) {
      update({ error: `Settings unchanged: ${message(error)}` });
    } finally {
      update({ configPending: false });
    }
  },

  addWorkspace: async (path, grantId = null) => {
    const norm = (value: string) => value.replace(/[/\\]+$/, "");
    const existing = get().workspaces.find((item) => norm(item.path) === norm(path));
    // Re-opening an ungranted folder re-attaches its native grant in place.
    if (existing) {
      if (grantId && (existing.grantId !== grantId || existing.path !== path)) {
        set({ workspaces: get().workspaces.map((item) => item.id === existing.id ? { ...item, path, name: workspaceName(path), grantId } : item) });
        await get().save();
      }
      await get().selectWorkspace(existing.id);
      return;
    }
    // Stored path may be non-canonical where the picked one is canonical
    // (symlinked parents, /tmp aliases): ask native whether the picked grant
    // covers an existing ungranted entry, and merge instead of duplicating.
    if (grantId && isTauri()) {
      const candidates = get().workspaces.filter((item) => !item.grantId);
      if (candidates.length) {
        try {
          const verdicts = await verifyGrants(candidates.map((item) => ({ id: grantId, path: item.path })));
          const hit = candidates[verdicts.findIndex((verdict) => verdict.ok)];
          if (hit) {
            set({ workspaces: get().workspaces.map((item) => item.id === hit.id ? { ...item, path, name: workspaceName(path), grantId } : item) });
            await get().save();
            await get().selectWorkspace(hit.id);
            return;
          }
        } catch { /* fall through to a fresh entry */ }
      }
    }
    const workspace: Workspace = { id: uid(), path, name: workspaceName(path), grantId };
    set({ workspaces: [...get().workspaces, workspace] });
    await get().save();
    await get().selectWorkspace(workspace.id);
  },

  removeWorkspace: (id) => {
    const removed = get().workspaces.find((workspace) => workspace.id === id);
    const leaving = get().threads.filter((thread) => removed?.path === thread.workspacePath && thread.status === "running" && thread.activeTurnId);
    for (const thread of leaving) void cancelSession(thread.sessionId, thread.activeTurnId!);
    if (removed?.grantId) void removeGrant(removed.grantId).catch(() => {});
    const workspaces = get().workspaces.filter((workspace) => workspace.id !== id);
    ++selectionVersion;
    set({ workspaces, ...(get().selectedWorkspaceId === id ? switchDraft(get(), workspaces[0]?.id ?? null, null) : {}), threads: get().threads.filter((thread) => workspaces.some((workspace) => workspace.path === thread.workspacePath)) });
    void get().save();
    void persistMemory(get());
    void get().refreshGit();
  },

  renameThread: (sessionId, title) => {
    const next = title.replace(/\s+/g, " ").trim();
    if (!next) return;
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    // ACP agents and preview drafts have no durable name: the local title is the truth.
    if (!thread || thread.agentId || get().preview) {
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: next, customTitle: true } : item) });
      scheduleMemory(get);
      return;
    }
    const previous = { title: thread.title, customTitle: thread.customTitle };
    const generation = (renameGeneration.get(sessionId) ?? 0) + 1;
    renameGeneration.set(sessionId, generation);
    renameInflight.add(sessionId);
    const current = () => renameGeneration.get(sessionId) === generation;
    set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: next, customTitle: true, notice: null } : item) });
    scheduleMemory(get);
    void bridge<{ name?: string; status?: string }>("renameSession", { sessionId, name: next }).then(
      (result) => {
        if (!current()) return;
        renameInflight.delete(sessionId);
        // The host normalizes; the canonical name wins and the local override
        // clears so later host-side renames (other clients, first-naming) flow in.
        // Without a settled name (RecoveryPending arm) the optimistic text stays
        // until the deferred `session/nameChanged` lands — now unblocked.
        const canonical = result.name?.trim() || next;
        set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: titleFromText(canonical), customTitle: false, notice: null } : item) });
        scheduleMemory(get);
      },
      (error) => {
        if (!current()) return;
        renameInflight.delete(sessionId);
        set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, title: previous.title, customTitle: previous.customTitle, notice: { level: "warning", message: `Rename failed: ${message(error)}` } } : item) });
        scheduleMemory(get);
      },
    );
  },

  pinThread: (sessionId) => {
    set({ threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, pinned: !thread.pinned } : thread) });
    scheduleMemory(get);
  },

  swapThreadOrder: (sessionId, otherId) => {
    const threads = get().threads;
    const a = threads.find((thread) => thread.sessionId === sessionId);
    const b = threads.find((thread) => thread.sessionId === otherId);
    if (!a || !b) return;
    const aOrder = a.order ?? 0;
    const bOrder = b.order ?? 0;
    // Equal keys can't be swapped; nudge the moved thread just past its neighbour instead.
    const nextA = aOrder === bOrder ? bOrder + (threads.indexOf(a) > threads.indexOf(b) ? 1 : -1) : bOrder;
    const nextB = aOrder === bOrder ? bOrder : aOrder;
    set({ threads: threads.map((thread) => thread.sessionId === sessionId ? { ...thread, order: nextA } : thread.sessionId === otherId ? { ...thread, order: nextB } : thread) });
    scheduleMemory(get);
  },

  reorderThreads: (sessionIds) => {
    // Order keys sort descending, so walking the dropped list downward and
    // handing out decreasing keys reproduces exactly what the user sees.
    const base = Date.now();
    const orders = new Map(sessionIds.map((sessionId, index) => [sessionId, base - index]));
    set({ threads: get().threads.map((thread) => orders.has(thread.sessionId) ? { ...thread, order: orders.get(thread.sessionId) } : thread) });
    scheduleMemory(get);
  },

  archiveThread: (sessionId, archived = true) => {
    const selected = get().selectedSessionId === sessionId;
    set({
      threads: get().threads.map((thread) => thread.sessionId === sessionId ? { ...thread, archived } : thread),
      ...(selected && archived ? { selectedSessionId: null, composer: "", images: [], contextRefs: [] } : {}),
    });
    scheduleMemory(get);
  },

  deleteThread: (sessionId) => {
    const selected = get().selectedSessionId === sessionId;
    const drafts = { ...get().drafts };
    delete drafts[`thread:${sessionId}`];
    set({
      threads: get().threads.filter((thread) => thread.sessionId !== sessionId),
      drafts,
      threadMeta: { ...get().threadMeta, [sessionId]: { ...get().threadMeta[sessionId], deleted: true, archived: true } },
      ...(selected ? { selectedSessionId: null, composer: "", images: [], contextRefs: [] } : {}),
    });
    scheduleMemory(get);
  },

  forkThread: async (sessionId, lastTurnId) => {
    const state = get();
    const source = state.threads.find((item) => item.sessionId === (sessionId ?? state.selectedSessionId));
    if (!source || source.agentId) return;
    // Single-flight: `session/fork` is not idempotent, so a double-click on Fork
    // would otherwise create one duplicate fork session per click.
    if (forking.has(source.sessionId)) return;
    forking.add(source.sessionId);
    try {
    // Cut points must be real server turn ids: local/history groupings fork whole.
    const cut = lastTurnId && !lastTurnId.startsWith("local:") && lastTurnId !== "history" ? lastTurnId : undefined;
    if (state.preview) {
      // Demo data forks locally: duplicate the transcript under a fresh id.
      const forkId = `preview-${uid()}`;
      const now = new Date().toISOString();
      const title = `${source.title} (fork)`;
      set({ threads: [...get().threads, { ...source, sessionId: forkId, title, order: Date.now(), updatedAt: now, status: "idle", unread: false, items: source.items.map((item) => ({ ...item })), activeTurnId: null, lastTurnId: undefined, lastOutcome: undefined, error: null, forkedFrom: { sessionId: source.sessionId, title: source.title }, notice: { level: "info", message: `Forked from ${source.title}.` } }] });
      scheduleMemory(get);
      await get().selectThread(forkId);
      return;
    }
    set({ threads: get().threads.map((item) => item.sessionId === source.sessionId ? { ...item, error: null } : item) });
    try {
      const forked = await bridge<{ sessionId: string; forkedFrom?: { cutExplicit?: boolean } }>("forkSession", { sessionId: source.sessionId, ...(cut ? { lastTurnId: cut } : {}) });
      const now = new Date().toISOString();
      const title = `${source.title} (fork)`;
      const thread: Thread = { sessionId: forked.sessionId, workspacePath: source.workspacePath, title, order: Date.now(), updatedAt: now, status: "idle", unread: false, items: [], opened: false, config: { ...source.config }, forkedFrom: { sessionId: source.sessionId, title: source.title }, notice: { level: "info", message: `Forked from ${source.title}.` } };
      set({ threads: [...get().threads, thread] });
      scheduleMemory(get);
      await get().selectThread(forked.sessionId);
    } catch (error) {
      set({ threads: get().threads.map((item) => item.sessionId === source.sessionId ? { ...item, error: `Could not fork thread: ${message(error)}` } : item) });
    }
    } finally {
      forking.delete(source.sessionId);
    }
  },

  compactThread: async () => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || get().preview || thread.status === "running") return;
    try {
      const result = await bridge<{ status: string; reason?: string }>("compactSession", { sessionId: thread.sessionId });
      if (result.status === "noop") {
        const reason = result.reason === "no_compactable_history" ? "no compactable history yet" : result.reason ?? "nothing to do";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: `Already compact: ${reason}.` } } : item) });
        return;
      }
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "info", message: "Compacting context…", key: "compacting" } } : item) });
    } catch (error) {
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, error: `Could not compact: ${message(error)}` } : item) });
    }
  },

  previewSession: null,

  openPreview: async (sessionId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread || thread.agentId || get().preview) return;
    set({ previewSession: { sessionId, title: thread.title, loading: true, error: null, snapshot: null } });
    try {
      const snapshot = await bridge<SessionPreview>("readSession", { sessionId, excludeItems: false });
      if (get().previewSession?.sessionId !== sessionId) return;
      set({ previewSession: { sessionId, title: thread.title, loading: false, error: null, snapshot } });
    } catch (error) {
      if (get().previewSession?.sessionId !== sessionId) return;
      set({ previewSession: { sessionId, title: thread.title, loading: false, error: `Could not preview thread: ${message(error)}`, snapshot: null } });
    }
  },

  closePreview: () => set({ previewSession: null }),

  outputViewer: null,

  openOutput: async (sessionId, itemId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    const item = thread?.items.find((entry) => entry.itemId === itemId);
    const ref = item?.outputRef;
    if (!thread || !item || !ref || ref.availability !== "available") return;
    const title = item.commandText || item.tool || "Tool output";
    set({ outputViewer: { sessionId, itemId, title, loading: true, error: null, encoding: "utf8", mediaType: ref.mediaType ?? "text/plain", content: "", byteLen: ref.byteLen, complete: true } });
    try {
      type Page = { offsetBytes: number; byteLen: number; eof: boolean; encoding: "utf8" | "base64"; mediaType: string; content: string };
      const chunks: string[] = [];
      let offset = 0;
      let encoding: "utf8" | "base64" = "utf8";
      let mediaType = ref.mediaType ?? "text/plain";
      let complete = true;
      // Server pages top out at 6 MiB; four pages (24 MiB) bound one viewing.
      for (let page = 0; page < 4; page += 1) {
        const result = await bridge<Page>("readOutput", { sessionId, itemId, outputRef: ref.id, offsetBytes: offset });
        encoding = result.encoding;
        mediaType = result.mediaType;
        chunks.push(result.content);
        offset = result.offsetBytes + result.byteLen;
        if (result.eof) break;
        if (page === 3) complete = false;
      }
      if (get().outputViewer?.itemId !== itemId) return;
      set({ outputViewer: { sessionId, itemId, title, loading: false, error: null, encoding, mediaType, content: chunks.join(""), byteLen: ref.byteLen, complete } });
    } catch (error) {
      if (get().outputViewer?.itemId !== itemId) return;
      set({ outputViewer: { sessionId, itemId, title, loading: false, error: `Could not read full output: ${message(error)}`, encoding: "utf8", mediaType: ref.mediaType ?? "text/plain", content: "", byteLen: ref.byteLen, complete: true } });
    }
  },

  closeOutput: () => set({ outputViewer: null }),

  controlSubagent: async (sessionId, subagentId, action, extra) => {
    const result = await bridge<{ status: string }>("subagentControl", { sessionId, subagentId, action, ...(extra?.body !== undefined ? { body: extra.body } : {}), ...(extra?.reason !== undefined ? { reason: extra.reason } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
  },

  controlTask: async (sessionId, action, taskId) => {
    const result = await bridge<{ status: string }>("taskControl", { sessionId, action, ...(taskId !== undefined ? { taskId } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
  },

  controlWorkflow: async (sessionId, workflowRunId, action, child) => {
    const result = await bridge<{ status: string }>("workflowControl", { sessionId, workflowRunId, action, ...(child ? { childId: child.childId, attempt: child.attempt } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
  },

  controlGoal: async (sessionId, action, objective) => {
    const result = await bridge<{ status: string; turnId?: string }>("goalControl", { sessionId, action, ...(objective !== undefined ? { objective } : {}) });
    if (result.status !== "accepted") throw new Error("The host did not accept that control.");
    return { ...(result.turnId ? { turnId: result.turnId } : {}) };
  },

  childSession: null,

  openChild: async (sessionId, itemId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    const item = thread?.items.find((entry) => entry.itemId === itemId);
    if (!thread || !item || item.kind !== "subagent" || !item.childSessionId) return;
    const title = item.objective || "Subagent";
    set({ childSession: { sessionId, itemId, title, loading: true, error: null, result: item.result ?? null, items: [], consumed: false } });
    try {
      const snapshot = await bridge<SessionPreview>("readSession", { sessionId: item.childSessionId, excludeItems: false });
      if (get().childSession?.itemId !== itemId) return;
      set({ childSession: { sessionId, itemId, title, loading: false, error: null, result: item.result ?? null, items: snapshot?.history?.items ?? [], consumed: false } });
    } catch (error) {
      if (get().childSession?.itemId !== itemId) return;
      set({ childSession: { sessionId, itemId, title, loading: false, error: `Could not read the child transcript: ${message(error)}`, result: item.result ?? null, items: [], consumed: false } });
    }
  },

  consumeChild: async () => {
    const viewing = get().childSession;
    const thread = get().threads.find((item) => item.sessionId === viewing?.sessionId);
    const subagentId = thread?.items.find((entry) => entry.itemId === viewing?.itemId)?.subagentId;
    if (!viewing || !subagentId) return;
    await get().controlSubagent(viewing.sessionId, subagentId, "readResult");
    if (get().childSession?.itemId === viewing.itemId) set({ childSession: { ...viewing, consumed: true } });
  },

  closeChild: () => set({ childSession: null }),

  setListSince: (value) => set({ listSince: value }),
  setShowAllWorkspaces: (value) => set({ showAllWorkspaces: value }),

  trustDialog: null,
  confirmDialog: null,
  fileIndex: null,
  confirm: (options) => new Promise<boolean>((resolve) => {
    // A second request replaces the first — treat it as cancelled.
    get().confirmDialog?.resolve(false);
    set({ confirmDialog: { title: options.title, body: options.body, confirmLabel: options.confirmLabel ?? "Confirm", danger: options.danger ?? false, resolve } });
  }),
  resolveConfirm: (ok) => {
    const dialog = get().confirmDialog;
    if (!dialog) return;
    set({ confirmDialog: null });
    dialog.resolve(ok);
  },
  initDialog: null,

  openInitDialog: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !workspace.grantId) return;
    set({ initDialog: { workspaceId, loading: true, error: null, preview: null, conflict: false, done: false } });
    try {
      const preview = await projectInit(workspace.grantId, get().museBin || get().detection?.path || undefined, true, false);
      if (get().initDialog?.workspaceId !== workspaceId) return;
      set({ initDialog: { workspaceId, loading: false, error: null, preview, conflict: false, done: false } });
    } catch (error) {
      if (get().initDialog?.workspaceId !== workspaceId) return;
      set({ initDialog: { workspaceId, loading: false, error: `Could not preview agent config: ${message(error)}`, preview: null, conflict: false, done: false } });
    }
  },

  closeInitDialog: () => set({ initDialog: null }),

  runInit: async (force) => {
    const dialog = get().initDialog;
    if (!dialog || !dialog.preview || dialog.loading || dialog.done) return;
    const workspace = get().workspaces.find((item) => item.id === dialog.workspaceId);
    if (!workspace?.grantId) return;
    set({ initDialog: { ...dialog, loading: true, error: null } });
    try {
      // The CLI reports conflicts on stdout with exit 0, so the conflict
      // is parsed from the message rather than the status.
      const output = await projectInit(workspace.grantId, get().museBin || get().detection?.path || undefined, false, force);
      if (get().initDialog?.workspaceId !== dialog.workspaceId) return;
      if (/already exists/i.test(output)) {
        set({ initDialog: { ...dialog, loading: false, error: null, conflict: true } });
      } else {
        set({ initDialog: { ...dialog, loading: false, error: null, conflict: false, done: true } });
      }
    } catch (error) {
      if (get().initDialog?.workspaceId !== dialog.workspaceId) return;
      set({ initDialog: { ...dialog, loading: false, error: `Project setup failed: ${message(error)}` } });
    }
  },

  openTrustDialog: async (workspaceId, prefetched) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !workspace.grantId) return;
    if (prefetched) {
      set({ trustDialog: { workspaceId, loading: false, error: null, preview: prefetched } });
      return;
    }
    set({ trustDialog: { workspaceId, loading: true, error: null, preview: null } });
    try {
      const preview = await trustPreview(workspace.grantId, get().museBin || get().detection?.path || undefined);
      if (get().trustDialog?.workspaceId !== workspaceId) return;
      set({ trustDialog: { workspaceId, loading: false, error: null, preview } });
    } catch (error) {
      if (get().trustDialog?.workspaceId !== workspaceId) return;
      set({ trustDialog: { workspaceId, loading: false, error: `Could not preview trusted content: ${message(error)}`, preview: null } });
    }
  },

  closeTrustDialog: () => set({ trustDialog: null }),

  // First-open trust prompt: preview the workspace's skills/rules once. If
  // there's anything to trust, open the dialog with the fetched preview;
  // either way trustPrompted is persisted so cancel never re-asks.
  promptWorkspaceTrust: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.trusted === true || workspace.trustPrompted === true || !workspace.grantId || get().preview) return;
    const markPrompted = () => {
      set({ workspaces: get().workspaces.map((item) => item.id === workspaceId ? { ...item, trustPrompted: true } : item) });
      void get().save();
    };
    try {
      const preview = await trustPreview(workspace.grantId, get().museBin || get().detection?.path || undefined);
      markPrompted();
      if (preview.skills.length > 0 || preview.rules) await get().openTrustDialog(workspaceId, preview);
    } catch {
      markPrompted();
    }
  },

  refreshFileIndex: (workspaceId) => {
    const id = workspaceId ?? get().selectedWorkspaceId;
    if (!id || get().preview) return;
    const workspace = get().workspaces.find((item) => item.id === id);
    if (!workspace?.grantId) return;
    const grantId = workspace.grantId;
    if (fileIndexTimer) clearTimeout(fileIndexTimer);
    const wait = Math.max(FILE_INDEX_DEBOUNCE_MS, FILE_INDEX_MIN_GAP_MS - (Date.now() - fileIndexLastFetch));
    fileIndexTimer = setTimeout(() => {
      fileIndexTimer = null;
      fileIndexLastFetch = Date.now();
      void listWorkspaceFiles(grantId).then((paths) => {
        if (get().selectedWorkspaceId === id) set({ fileIndex: { workspaceId: id, paths, loadedAt: Date.now() } });
      }, (error) => log.warn("files.index.failed", { error: message(error) }));
    }, wait);
  },

  confirmTrust: async () => {
    const dialog = get().trustDialog;
    if (!dialog || !dialog.preview) return;
    const workspace = get().workspaces.find((item) => item.id === dialog.workspaceId);
    if (!workspace) return;
    set({ workspaces: get().workspaces.map((item) => item.id === workspace.id ? { ...item, trusted: true } : item), trustDialog: null });
    scheduleMemory(get);
    // Trusting the selected workspace restarts a running untrusted host.
    if (workspace.id === get().selectedWorkspaceId && get().hostInfo) await get().startHost();
  },

  untrustWorkspace: async (workspaceId) => {
    const workspace = get().workspaces.find((item) => item.id === workspaceId);
    if (!workspace?.trusted) return;
    set({ workspaces: get().workspaces.map((item) => item.id === workspaceId ? { ...item, trusted: false } : item) });
    scheduleMemory(get);
    if (workspaceId === get().selectedWorkspaceId && get().hostInfo) await get().startHost();
  },

  refreshSkills: async (sessionId?: string) => {
    const id = sessionId ?? currentThread(get())?.sessionId;
    const thread = get().threads.find((item) => item.sessionId === id);
    if (!id || !thread || thread.agentId || get().preview) return;
    try {
      const catalog = await bridge<{ skills?: SkillRow[] }>("listSkills", { sessionId: id });
      set({ threads: get().threads.map((item) => item.sessionId === id ? { ...item, skills: catalog.skills ?? [] } : item) });
    } catch (error) {
      log.warn("skills.refresh.failed", { error: message(error) });
    }
  },

  refreshMcpServers: async () => {
    if (get().mcpLoading) return;
    set({ mcpLoading: true, mcpError: null });
    try {
      const catalog = await bridge<{ servers?: McpServer[] }>("mcpServers", {});
      set({ mcpServers: catalog.servers ?? [] });
    } catch (error) {
      set({ mcpError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ mcpLoading: false });
    }
  },

  refreshPlugins: async (available = false) => {
    if (get().pluginsLoading) return;
    set({ pluginsLoading: true, pluginsError: null, pluginsAvailableShown: available });
    try {
      set({ pluginEntries: await pluginList(get().museBin || undefined, available) });
    } catch (error) {
      set({ pluginsError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ pluginsLoading: false });
    }
  },

  refreshManagedSkills: async () => {
    if (get().skillsLoading) return;
    set({ skillsLoading: true, skillsError: null });
    try {
      set({ skillEntries: await skillList(currentWorkspace(get())?.grantId ?? undefined, get().museBin || undefined) });
    } catch (error) {
      set({ skillsError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ skillsLoading: false });
    }
  },

  installSkill: async () => {
    if (get().skillsLoading) return;
    set({ skillsLoading: true, skillsError: null });
    try {
      const picked = await pickSkillSource();
      if (!picked) return;
      await skillInstall(picked, get().museBin || undefined);
      set({ skillEntries: await skillList(currentWorkspace(get())?.grantId ?? undefined, get().museBin || undefined) });
    } catch (error) {
      set({ skillsError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ skillsLoading: false });
    }
  },

  importSkills: async (from, dryRun) => {
    const output = await skillImport(from, dryRun, get().museBin || undefined);
    if (!dryRun) await get().refreshManagedSkills();
    return output;
  },

  uninstallSkill: async (id) => {
    if (get().skillsLoading) return;
    set({ skillsLoading: true, skillsError: null });
    try {
      await skillUninstall(id, get().museBin || undefined);
      set({ skillEntries: await skillList(currentWorkspace(get())?.grantId ?? undefined, get().museBin || undefined) });
    } catch (error) {
      set({ skillsError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ skillsLoading: false });
    }
  },

  installPlugin: async () => {
    if (get().pluginsLoading) return;
    set({ pluginsLoading: true, pluginsError: null });
    try {
      const picked = await pickPluginBundle();
      if (!picked) return;
      await pluginInstall(picked, get().museBin || undefined);
      set({ pluginEntries: await pluginList(get().museBin || undefined, false), pluginsAvailableShown: false });
    } catch (error) {
      set({ pluginsError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ pluginsLoading: false });
    }
  },

  refreshEnterprise: async () => {
    if (get().enterpriseLoading) return;
    set({ enterpriseLoading: true, enterpriseError: null });
    try {
      set({ enterprise: await enterpriseStatus(get().museBin || undefined) });
    } catch (error) {
      set({ enterpriseError: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ enterpriseLoading: false });
    }
  },

  openLastThread: async () => {
    const state = get();
    const pool = state.showAllWorkspaces ? state.threads : state.threads.filter((thread) => thread.workspacePath === currentWorkspace(state)?.path);
    const last = pool.filter((thread) => !thread.archived).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (last) await get().selectThread(last.sessionId);
  },

  loadOlderHistory: async () => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || thread.historyLoading || thread.historyExhausted || !thread.historyCursor || get().preview) return;
    const sessionId = thread.sessionId;
    const cursor = thread.historyCursor;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ historyLoading: true });
    try {
      const chunk = await bridge<{ items: TranscriptItem[]; nextCursor: string | null; exhausted: boolean }>("pageHistory", { sessionId, cursor });
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      if (!latest || latest.historyCursor !== cursor) return;
      update({ items: mergeHistoryItems(latest.items, chunk.items), historyCursor: chunk.nextCursor, historyExhausted: chunk.exhausted });
    } catch (error) {
      update({ error: `Could not load older history: ${message(error)}` });
    } finally {
      update({ historyLoading: false });
    }
  },

  rebuildThread: async () => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || thread.opening || get().preview) return;
    const sessionId = thread.sessionId;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ opening: true, error: null, historyFailed: false });
    try {
      // The live stream never detached, so the rebuild is a backfill: the
      // newest chunk replays the durable log and the merge keeps held items
      // winning, so only the missing ones land.
      const chunk = await bridge<{ items: TranscriptItem[]; nextCursor: string | null; exhausted: boolean }>("pageHistory", { sessionId });
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      if (latest) update({ items: mergeHistoryItems(latest.items, chunk.items), historyCursor: chunk.nextCursor, historyExhausted: chunk.exhausted, viewGap: null, status: "idle" });
    } catch (error) {
      update({ error: `Could not rebuild the thread: ${message(error)}` });
    } finally {
      update({ opening: false });
    }
  },

  setThreadSearch: (value) => set({ threadSearch: value }),
  setSidebarCollapsed: (collapsed) => { set({ sidebarCollapsed: collapsed }); scheduleMemory(get); },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setOffline: (offline) => set({ offline }),
  setShowArchived: (show) => set({ showArchived: show }),
  setInspectorTab: (tab) => set({ inspectorTab: tab, dockTab: tab }),

  selectWorkspace: async (id) => {
    const workspace = get().workspaces.find((item) => item.id === id);
    if (!workspace) return;
    const version = ++selectionVersion;
    set({ ...switchDraft(get(), id, null), error: null, git: null, diffTabs: null, diffActive: null });
    void get().refreshGit();
    void get().refreshFileIndex(id);
    if (get().preview) { await get().refreshModels(); return; }
    await listWorkspaceThreads(get, set, workspace, () => version === selectionVersion, false);
    void get().promptWorkspaceTrust(id);
  },

  // Expanding a workspace in the tree fills its thread list without stealing
  // the selection, so several workspaces can stay open side by side.
  loadWorkspaceThreads: async (id) => {
    const workspace = get().workspaces.find((item) => item.id === id);
    if (!workspace || get().preview || !workspace.grantId) return;
    const version = selectionVersion;
    await listWorkspaceThreads(get, set, workspace, () => version === selectionVersion, true);
  },

  selectThread: async (sessionId) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread) return;
    const workspace = get().workspaces.find((item) => item.path === thread.workspacePath);
    if (!workspace) return;
    const workspaceChanged = get().selectedWorkspaceId !== workspace.id;
    ++selectionVersion;
    set({ ...switchDraft(get(), workspace.id, sessionId), error: null, ...(workspaceChanged ? { git: null, gitError: null } : {}), threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, unread: false } : item) });
    scheduleMemory(get);
    if (workspaceChanged) void get().refreshGit();
    if (get().preview || thread.opened || thread.opening) return;
    // Same fail-closed rule as every other session entry point: a stale
    // native binding must not let an ungranted workspace keep opening threads.
    if (!workspace.grantId && isTauri()) {
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, error: "This folder is not granted. Re-open it to restore access." } : item) });
      return;
    }
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ opening: true, error: null });
    if (thread.agentId) {
      try {
        const opened = await bridge<{ agentConfig?: AgentSessionConfig; alreadyOpen?: boolean }>("resumeSession", { agentId: thread.agentId, sessionId });
        update({ opened: true, config: { ...thread.config, ...agentConfigPatch(opened.agentConfig), agentId: thread.agentId }, modes: opened.agentConfig?.modes ?? thread.modes });
        if (get().selectedSessionId === sessionId) await get().refreshModels();
      } catch (error) {
        update({ error: `Could not open thread: ${message(error)}`, opened: false });
      } finally { update({ opening: false }); }
      return;
    }
    try {
      await get().startHost();
      const resume = (cursor?: string | null) => bridge<SessionOpening & { facts?: { plan?: PlanItem[]; goal?: GoalState | null; context?: ContextUsage | null; usage?: TokenUsage | null; branch?: string | null }; historyCursor?: string | null; historyExhausted?: boolean; historyFailed?: boolean; viewCursor?: string }>("resumeSession", { sessionId, ...(cursor ? { cursor } : {}) });
      let opened: Awaited<ReturnType<typeof resume>>;
      try {
        opened = await resume(get().threads.find((item) => item.sessionId === sessionId)?.resumeCursor);
      } catch (error) {
        // All-workspace rows bind to no grant; a grant-scoped listing binds
        // this one, then the open retries exactly once.
        if (!/not connected to an open workspace/.test(message(error))) throw error;
        await listWorkspaceSessions(workspace, undefined, 10, (all) => all.some((session) => session.sessionId === sessionId));
        opened = await resume();
      }
      const session = opened.opening?.result.session;
      const latest = get().threads.find((item) => item.sessionId === sessionId);
      const unchanged = latest?.status === thread.status && latest?.activeTurnId === thread.activeTurnId && latest?.lastTurnId === thread.lastTurnId;
      if (latest?.userInputVersion === thread.userInputVersion) update({ userInputs: opened.userInputs ?? [] });
      update({
        opened: true,
        ...(opened.viewCursor ? { resumeCursor: opened.viewCursor } : {}),
        ...(opened.facts ? { plan: opened.facts.plan, goal: opened.facts.goal, context: opened.facts.context, usage: opened.facts.usage, hostBranch: opened.facts.branch } : {}),
        ...(session && !opened.alreadyOpen ? { config: metadataConfig(session, thread.config?.effort ?? get().defaultEffort), ...(unchanged ? { status: session.status === "running" ? "running" : session.status === "idle" ? "idle" : latest.status, activeTurnId: session.activeTurnId ?? null, lastOutcome: session.status === "running" ? latest?.lastOutcome : latest?.lastOutcome === "interrupted" ? undefined : latest?.lastOutcome } : {}) } : {}),
        ...(!opened.alreadyOpen ? { historyCursor: opened.historyCursor ?? null, historyExhausted: opened.historyExhausted ?? true, historyFailed: opened.historyFailed ?? false, viewGap: null } : {}),
      });
      if (get().selectedSessionId === sessionId) await get().refreshModels();
      void get().refreshSkills(sessionId).catch(() => {});
    } catch (error) {
      update({ error: `Could not open thread: ${message(error)}`, opened: false });
    } finally { update({ opening: false }); }
  },

  newThread: async () => {
    if (get().starting) return;
    const workspace = currentWorkspace(get());
    if (!workspace) { set({ error: "Add a project folder first." }); return; }
    if (!workspace.grantId && isTauri() && !get().preview) { set({ error: UNGRANTED_ERROR }); return; }
    const version = ++selectionVersion;
    const sourceKey = draftKey(get());
    const fromProject = !get().selectedSessionId;
    const config = fromProject ? get().drafts[sourceKey]?.config ?? defaults(get()) : defaults(get());
    set({ starting: true, error: null });
    const agentId = (config.agentId && agentEnabled(get(), config.agentId) ? config.agentId : undefined) ?? preferredAgent(get());
    try {
      let thread: Thread;
      const existingCount = get().threads.filter((t) => t.workspacePath === workspace.path && /^(New thread|Untitled thread)/.test(t.title)).length;
      const title = existingCount === 0 ? "New thread" : `New thread ${existingCount + 1}`;
      if (agentId !== "muse" && get().preview) {
        const modes = agentId === "opencode" ? OPENCODE_MODES : undefined;
        thread = { sessionId: `preview-${uid()}`, agentId, workspacePath: workspace.path, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: { ...config, agentId, ...(modes ? { mode: "build" } : {}) }, modes };
      } else if (agentId !== "muse") {
        // Only hand over a model the agent itself listed; a Muse default means nothing to OpenCode.
        // Gated OpenCode `*-free` rows fail on this account — let the bridge pick a usable default.
        const ownModel = get().modelsAgentId === agentId && get().models.some((model) => model.modelId === config.modelId);
        const gated = agentId === "opencode" && /(?:^|[/:])[^/]*-free$/i.test(config.modelId ?? "");
        const opened = await bridge<{ sessionId: string; agentConfig?: AgentSessionConfig }>("startSession", { agentId, grantId: workspace.grantId ?? undefined, modelId: ownModel && !gated ? config.modelId : undefined, reasoningEffort: config.effort });
        thread = { sessionId: opened.sessionId, agentId, workspacePath: workspace.path, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: { ...config, ...agentConfigPatch(opened.agentConfig), agentId }, modes: opened.agentConfig?.modes };
      } else {
        if (!get().preview) await get().startHost();
        const opened = get().preview ? { sessionId: `preview-${uid()}` } : await bridge<SessionOpening>("startSession", { grantId: workspace.grantId ?? undefined, approvalMode: config.approvalMode, modelId: config.modelId || undefined, providerId: config.providerId || undefined });
        const metadata = "opening" in opened ? opened.opening?.result.session : undefined;
        thread = { sessionId: opened.sessionId, workspacePath: workspace.path, title, order: Date.now(), updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true, config: metadata ? metadataConfig(metadata, config.effort) : config };
      }
      const opened = { sessionId: thread.sessionId };
      set({ threads: [thread, ...get().threads] });
      scheduleMemory(get);
      if (version === selectionVersion) {
        const draft = { text: get().composer, images: get().images, refs: get().contextRefs, config };
        set(switchDraft(get(), workspace.id, opened.sessionId));
        if (fromProject) set({ composer: draft.text, images: draft.images, contextRefs: draft.refs ?? [], drafts: { ...get().drafts, [sourceKey]: { text: "", images: [], refs: [], config }, [`thread:${opened.sessionId}`]: draft } });
      }
    } catch (error) {
      set({ error: `Could not start thread: ${message(error)}. Your draft is unchanged.` });
    } finally { set({ starting: false }); }
  },

  switchThreadAgent: async (agentId) => {
    const state = get();
    if (state.starting || state.submitting) return;
    if (!agentEnabled(state, agentId)) return;
    const thread = currentThread(state);
    if (thread && (thread.status === "running" || thread.configPending || thread.opening)) return;
    await get().commitSettings({ defaultAgentId: agentId });
    if (!thread) {
      await get().setSessionConfig({ agentId });
      return;
    }
    if ((thread.agentId ?? "muse") === agentId) return;
    const workspace = currentWorkspace(get());
    if (!workspace) return;
    const previousId = thread.sessionId;
    const previousName = state.agents.find((agent) => agent.id === (thread.agentId ?? "muse"))?.name ?? thread.agentId ?? "Muse";
    const nextName = state.agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    set({ starting: true, error: null });
    try {
      let next: Thread;
      if (agentId !== "muse" && get().preview) {
        const modes = agentId === "opencode" ? OPENCODE_MODES : undefined;
        next = { ...thread, agentId, opened: true, modes, config: { agentId, ...(modes ? { mode: "build" } : {}) }, error: null, notice: null, status: "idle", configPending: false, pendingConfig: undefined, configNotice: `Now using ${nextName}` };
      } else if (agentId !== "muse") {
        const opened = await bridge<{ sessionId: string; agentConfig?: AgentSessionConfig }>("startSession", { agentId, grantId: workspace.grantId ?? undefined });
        next = {
          ...thread,
          sessionId: opened.sessionId,
          agentId,
          opened: true,
          opening: false,
          config: { ...agentConfigPatch(opened.agentConfig), agentId },
          modes: opened.agentConfig?.modes,
          error: null,
          notice: null,
          status: "idle",
          configPending: false,
          pendingConfig: undefined,
          configNotice: `Now using ${nextName}`,
        };
      } else if (get().preview) {
        next = { ...thread, agentId: undefined, modes: undefined, config: { approvalMode: thread.config?.approvalMode, effort: thread.config?.effort }, error: null, notice: null, status: "idle", opened: true, configPending: false, pendingConfig: undefined, configNotice: `Now using ${nextName}` };
      } else {
        await get().startHost();
        const opened = await bridge<SessionOpening>("startSession", { grantId: workspace.grantId ?? undefined, approvalMode: thread.config?.approvalMode });
        next = {
          ...thread,
          sessionId: opened.sessionId,
          agentId: undefined,
          opened: true,
          opening: false,
          config: { approvalMode: thread.config?.approvalMode },
          modes: undefined,
          error: null,
          notice: null,
          status: "idle",
          configPending: false,
          pendingConfig: undefined,
          configNotice: `Now using ${nextName}`,
        };
      }
      if (thread.items.length) {
        next = { ...next, notice: { level: "info", message: `Switched to ${nextName}. Earlier messages stay visible; ${nextName} does not have the ${previousName} history.` } };
      }
      set(rekeyThreadState(get(), previousId, next));
      if (next.configNotice) scheduleConfigNoticeClear(next.sessionId, next.configNotice);
      scheduleMemory(get);
      await get().refreshModels();
    } catch (error) {
      set({ error: `Could not switch to ${nextName}: ${message(error)}. This thread is still on ${previousName}.` });
    } finally {
      set({ starting: false });
    }
  },

  sendPrompt: async (options) => {
    const initial = get();
    const active = currentThread(initial);
    if (initial.starting || initial.submitting || active?.opening || active?.configPending) return;
    // Busy sends are a Muse/MSP feature: the composer unlocks while a turn
    // runs (ACP agents and preview keep the Stop-to-send lock).
    const busySend = active?.status === "running" && !active.agentId && !initial.preview;
    if (active?.status === "running" && !busySend) return;
    if (!currentWorkspace(initial)) { set({ error: "Open a project before sending." }); return; }
    const text = initial.composer.trim();
    const images = initial.images;
    const refs = initial.contextRefs;
    if (!text && !images.length && !refs.length) return;
    const payload = composePrompt(text, refs);
    // Persist the draft now: a pending debounce firing mid-send would be fine
    // (it reads get() at fire time), but this guarantees it lands before the
    // composer is cleared on success.
    flushDraft(get);
    set({ submitting: true, error: null });
    let sessionId = initial.selectedSessionId;
    try {
      if (!sessionId) {
        const version = selectionVersion;
        await get().newThread();
        if (selectionVersion !== version + 1 || get().selectedWorkspaceId !== initial.selectedWorkspaceId) return;
        sessionId = get().selectedSessionId;
      }
      if (!sessionId) return;
      const thread = get().threads.find((item) => item.sessionId === sessionId);
      if (!thread?.opened && !get().preview) throw new Error("Thread is not open. Select it again to reconnect before sending.");
      // A leading `!command` is the TUI shell escape: it runs in the session's
      // workspace via `session/userShell` and streams back as a `userShell`
      // transcript item. Shells are not turn-scoped, so the escape bypasses
      // the busy queue, skills, and optimistic turn state entirely.
      const shell = parseShellEscape(text);
      if (shell) {
        if (thread?.agentId) throw new Error(`Shell escape is a Muse feature; this thread runs on ${thread.agentId}.`);
        if (images.length || refs.length) throw new Error("Shell escape cannot carry images or references. Remove them, or send as a prompt.");
        if (!get().preview && !(get().hostInfo?.compat?.granted ?? []).includes("userShell")) {
          throw new Error("User shells are unavailable: the host did not grant the userShell capability. Reconnect from Settings.");
        }
        await bridge("userShell", { sessionId, commandText: shell.command });
        const live = get();
        const shellKey = `thread:${sessionId}`;
        if (live.selectedSessionId === sessionId && live.composer.trim() === text) {
          set({ composer: "", images: [], contextRefs: [], drafts: { ...live.drafts, [shellKey]: { ...live.drafts[shellKey], text: "", images: [], refs: [] } } });
        }
        return;
      }
      // A leading `/selector` invokes a session skill for real: the typed
      // spelling matches the catalog verbatim (unknown stays plain text),
      // and the invocation travels as a structured skill part.
      const invocation = parseSkillInvocation(text);
      const skill = thread && !thread.agentId && invocation
        ? (thread.skills ?? []).find((row) => row.selector.replace(/^\//, "").toLowerCase() === invocation.selector.replace(/^\//, "").toLowerCase())
        : undefined;
      const skillPart = skill ? { selector: skill.selector, ...(invocation!.args ? { arguments: invocation!.args } : {}) } : undefined;
      if (busySend && thread) {
        await sendBusyTurn(sessionId, options?.disposition ?? "queue", skillPart ? composePrompt("", refs) : payload, text, images, skillPart);
        return;
      }
      const key = `thread:${sessionId}`;
      const previousOutcome = thread?.lastOutcome;
      // Idempotency keys are a Muse/MSP feature (ACP agents reject overlapping sends themselves).
      const keyed = !thread?.agentId;
      // A retry of a send whose result was unknown reuses its key AND its optimistic bubble
      // (matched by text, so a reworded prompt still sends fresh instead of dropping words).
      const keptOptimistic = keyed && thread?.pendingTurnKey
        ? [...(thread?.items ?? [])].reverse().find((item) => item.kind === "userMessage" && item.optimistic && item.text === (text || payload))
        : undefined;
      const turnKey = keptOptimistic && thread?.pendingTurnKey ? thread.pendingTurnKey : uid();
      const userItem: TranscriptItem = keptOptimistic ?? { itemId: uid(), kind: "userMessage", status: "completed", text: text || payload, images, refs, optimistic: !get().preview };
      set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...applyItem(item, userItem), status: "running", error: null, activeTurnId: null, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: item.usage?.outputTokens ?? 0, turnStats: undefined, ...(options?.resetTaskState ? { plan: undefined, planAnchor: undefined, goal: null } : {}) } : item) });
      try {
        if (get().preview) {
          const id = sessionId;
          previewTimers.set(id, window.setTimeout(() => {
            previewTimers.delete(id);
            set({ threads: get().threads.map((item) => item.sessionId === id && item.status === "running" ? { ...applyItem(item, { itemId: uid(), kind: "agentMessage", status: "completed", text: "Preview response — connect the Muse CLI to work in a real project." }), status: "idle", unread: get().selectedSessionId !== id, activity: undefined } : item) });
          }, 1600));
        } else {
          const result = await bridge<{ turnId: string; deduped?: boolean }>("sendTurn", { agentId: thread?.agentId, sessionId, text: skillPart ? composePrompt("", refs) : payload, reasoningEffort: thread?.config?.effort ?? (thread?.agentId ? undefined : initial.defaultEffort), images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), ...(keyed ? { clientTurnId: turnKey } : {}), ...(skillPart ? { skill: skillPart } : {}) });
          const latest = get().threads.find((item) => item.sessionId === sessionId);
          if (latest?.status === "running" && latest.lastTurnId !== result.turnId) {
            set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, activeTurnId: result.turnId, pendingTurnKey: null, notice: result.deduped ? { level: "info", message: "Resumed the pending turn instead of sending a duplicate." } : item.notice } : item) });
            if (latest.cancelRequested) await cancelSession(sessionId, result.turnId);
          } else {
            set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, pendingTurnKey: null } : item) });
          }
        }
        const live = get();
        const selected = live.selectedSessionId === sessionId;
        const draft = selected ? { text: live.composer, images: live.images, refs: live.contextRefs } : live.drafts[key];
        if (draft?.text.trim() === text && draft.images === images) {
          set({ ...(selected ? { composer: "", images: [], contextRefs: [] } : {}), drafts: { ...live.drafts, [key]: { ...live.drafts[key], text: "", images: [], refs: [] } } });
        }
      } catch (error) {
        if (keyed && timeoutUnknown(error)) {
          // The turn may have started without the acknowledgement reaching us: stay running so
          // its streamed events still land, keep the key so a later retry dedupes, and let Stop work.
          set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, pendingTurnKey: turnKey, notice: { level: "warning", message: "No acknowledgement yet — the turn may still be running. Stop, then retry safely." } } : item) });
        } else {
          const classified = classifyError(error, "Send failed");
          set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, items: item.items.filter((entry) => entry.itemId !== userItem.itemId), status: "error", activeTurnId: null, pendingTurnKey: null, cancelRequested: false, activity: undefined, error: `${classified.title}. ${classified.lost}`, lastOutcome: previousOutcome } : item) });
          // The catalog moved under us: refresh it so the next pick is real.
          if ((error as Error & { code?: string })?.code === "skillNotFound") void get().refreshSkills(sessionId).catch(() => {});
        }
      }
    } catch (error) { set({ error: message(error) }); }
    finally { set({ submitting: false }); }
  },

  stopTurn: async () => {
    const thread = currentThread(get());
    if (!thread || thread.status !== "running" || thread.cancelRequested) return;
    set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, cancelRequested: true, error: null } : item) });
    if (get().preview) {
      window.clearTimeout(previewTimers.get(thread.sessionId));
      previewTimers.delete(thread.sessionId);
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? {
        ...item,
        ...finishTurn(item, item.activeTurnId ?? item.lastTurnId),
        status: "idle",
        lastOutcome: "cancelled",
        activeTurnId: null,
        lastTurnId: item.activeTurnId ?? item.lastTurnId,
        pendingApproval: null,
        queuedApprovals: [],
        cancelRequested: false,
        activity: undefined,
        plan: settlePlan(item.plan, "cancelled"),
        items: settleItems(item.items, "cancelled", true),
      } : item) });
    } else {
      // Stop drains the queue too: queued turns would otherwise launch the
      // moment the active turn dies, contradicting the user's stop.
      const queued = thread.queuedTurns ?? [];
      if (queued.length && !thread.agentId) {
        await Promise.allSettled(queued.map((entry) => bridge("unqueueTurn", { sessionId: thread.sessionId, turnId: entry.turnId })));
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, queuedTurns: [] } : item) });
      }
      await cancelSession(thread.sessionId, thread.activeTurnId ?? undefined);
      // If the stop never reached the host (cancel delivery failed, no terminal event coming),
      // don't strand the thread: park it idle with the key retained so the next send dedupes.
      const stuck = get().threads.find((item) => item.sessionId === thread.sessionId);
      if (stuck?.status === "running" && !stuck.cancelRequested) {
        const parked = stuck.pendingTurnKey
          ? "Stop may not have reached Muse. Retry is safe — it resumes the pending turn."
          : "Stop may not have reached Muse. Check the thread before retrying.";
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, status: "idle", activity: undefined, error: parked, notice: null } : item) });
      }
    }
  },

  unqueueTurn: async (turnId) => {
    const thread = currentThread(get());
    if (!thread || thread.agentId || get().preview) return;
    if (!(thread.queuedTurns ?? []).some((entry) => entry.turnId === turnId)) return;
    try {
      await bridge("unqueueTurn", { sessionId: thread.sessionId, turnId });
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, queuedTurns: (item.queuedTurns ?? []).filter((entry) => entry.turnId !== turnId) } : item) });
    } catch (error) {
      // A failed reclaim usually means the turn already launched: its
      // turnStarted event promotes it, so the entry is left to reconcile.
      set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, notice: { level: "warning", message: `Could not reclaim the queued turn: ${message(error)}` } } : item) });
    }
  },

  decide: async (approvalId, choiceId) => {
    const thread = get().threads.find((item) => item.pendingApproval?.approvalId === approvalId || item.queuedApprovals?.some((queued) => queued.approvalId === approvalId));
    if (!thread || thread.approvalPending) return;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...item, ...patch } : item) });
    const settle = () => set({ threads: get().threads.map((item) => {
      if (item.sessionId !== thread.sessionId) return item;
      return item.pendingApproval?.approvalId === approvalId ? advanceApprovals(item) : dropApproval(item, approvalId).thread;
    }) });
    update({ approvalPending: true, error: null });
    try {
      if (!get().preview) await bridge("decideApproval", { approvalId, choiceId, sessionId: thread.sessionId });
      settle();
    } catch (error) {
      if (/no (longer )?pending approval/i.test(message(error))) {
        // Decided elsewhere (or already settled): drop it and surface the next waiter.
        set({ threads: get().threads.map((item) => item.sessionId === thread.sessionId ? { ...dropApproval(item, approvalId).thread, notice: { level: "info", message: "That approval was already resolved." } } : item) });
      } else update({ error: `Approval failed: ${message(error)}. Try again or stop the turn.` });
    }
    finally { update({ approvalPending: false }); }
  },

  respondUserInput: async (sessionId, userInputId, response) => {
    const thread = get().threads.find((item) => item.sessionId === sessionId);
    if (!thread || thread.userInputPending || !thread.userInputs?.some((request) => request.userInputId === userInputId)) return;
    const update = (patch: Partial<Thread>) => set({ threads: get().threads.map((item) => item.sessionId === sessionId ? { ...item, ...patch } : item) });
    update({ userInputPending: userInputId, error: null });
    try {
      if (!get().preview) await bridge("respondUserInput", { sessionId, userInputId, response });
      update({ userInputs: get().threads.find((item) => item.sessionId === sessionId)?.userInputs?.filter((request) => request.userInputId !== userInputId) });
    } catch (error) { update({ error: `Could not respond: ${message(error)}. Your answer is retained; retry or cancel the question.` }); }
    finally { update({ userInputPending: undefined }); }
  },

  refreshGit: async () => {
    if (get().preview) { set({ git: MOCK_GIT, gitError: null, gitLoading: false }); return; }
    const version = ++gitVersion;
    const workspace = currentWorkspace(get());
    if (!workspace) { set({ git: null, gitError: null, gitLoading: false }); return; }
    if (!workspace.grantId && isTauri()) { set({ git: null, gitError: "This folder is not granted. Re-open it to restore access.", gitLoading: false }); return; }
    set({ gitLoading: true, gitError: null });
    try {
      const git = await gitSnapshot(workspace.grantId ?? "preview");
      if (version === gitVersion && get().selectedWorkspaceId === workspace.id) set({ git });
    } catch (error) {
      if (version === gitVersion && get().selectedWorkspaceId === workspace.id) set({ git: null, gitError: message(error) });
    } finally {
      if (version === gitVersion) set({ gitLoading: false });
    }
  },

  discardGitFiles: async (paths) => {
    const state = get();
    const workspace = currentWorkspace(state);
    if (!paths.length) return;
    // Preview discards demo rows locally; the dock re-renders from state.
    if (state.preview && state.git) {
      const dropped = new Set(paths);
      const files = state.git.files.filter((file) => !dropped.has(file.path));
      set({ git: { ...state.git, files, dirty: files.length > 0 } });
      pruneDiffTabs(dropped);
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error("This folder is not granted. Re-open it to restore access.");
    // Invalidate in-flight reads first: a snapshot requested before this
    // mutation must not land afterwards and resurrect pre-mutation state.
    ++gitVersion;
    const git = await gitDiscardFiles(workspace.grantId ?? "preview", paths);
    if (get().selectedWorkspaceId !== workspace.id) return;
    set({ git, gitError: null, gitLoading: false });
    pruneDiffTabs(new Set(paths));
  },

  discardGitHunk: async (path, hunk) => {
    const state = get();
    const workspace = currentWorkspace(state);
    if (state.preview && state.git) {
      set({ git: { ...state.git, diff: dropHunk(state.git.diff, path, hunk) } });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error("This folder is not granted. Re-open it to restore access.");
    ++gitVersion;
    const git = await gitDiscardHunk(workspace.grantId ?? "preview", path, hunk);
    if (get().selectedWorkspaceId !== workspace.id) return;
    set({ git, gitError: null, gitLoading: false });
  },

  stageGitFiles: async (paths, stage) => {
    const state = get();
    const workspace = currentWorkspace(state);
    if (!paths.length) return;
    if (state.preview && state.git) {
      const picked = new Set(paths);
      const files = state.git.files.map((file) => {
        if (!picked.has(file.path)) return file;
        const index = stage ? (file.status === "??" ? "A" : "M") : " ";
        return { ...file, status: `${index}${file.status.slice(1)}` };
      });
      set({ git: { ...state.git, files } });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error("This folder is not granted. Re-open it to restore access.");
    ++gitVersion;
    const git = await gitStage(workspace.grantId ?? "preview", paths, stage);
    if (get().selectedWorkspaceId !== workspace.id) return;
    set({ git, gitError: null, gitLoading: false });
  },

  commitGit: async (message) => {
    const state = get();
    const workspace = currentWorkspace(state);
    if (state.preview && state.git) {
      const files = state.git.files.filter((file) => file.status[0] === " " || file.status[0] === "?");
      set({ git: { ...state.git, files, dirty: files.length > 0 } });
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error("This folder is not granted. Re-open it to restore access.");
    ++gitVersion;
    const git = await gitCommit(workspace.grantId ?? "preview", message);
    if (get().selectedWorkspaceId !== workspace.id) return;
    set({ git, gitError: null, gitLoading: false });
  },

  discardAllGit: async () => {
    const state = get();
    const workspace = currentWorkspace(state);
    if (state.preview) {
      if (state.git) set({ git: { ...state.git, files: [], dirty: false, diff: "", truncated: false } });
      pruneDiffTabs(null);
      return;
    }
    if (!workspace || (!workspace.grantId && isTauri())) throw new Error("This folder is not granted. Re-open it to restore access.");
    ++gitVersion;
    const git = await gitDiscardAll(workspace.grantId ?? "preview");
    if (get().selectedWorkspaceId !== workspace.id) return;
    set({ git, gitError: null, gitLoading: false });
    pruneDiffTabs(null);
  },

  attachImages: async (files) => {
    const key = draftKey(get());
    try {
      const selected = Array.from(files);
      if (selected.some((file) => !file.type.startsWith("image/") || file.size === 0)) throw new Error("Choose non-empty image files.");
      if (selected.some((file) => file.size > 10 * 1024 * 1024)) throw new Error("Images must be 10 MB or smaller in this client.");
      const images = await Promise.all(selected.map((file) => new Promise<ComposerImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64Data = String(reader.result ?? "").split(",")[1];
          if (!base64Data) { reject(new Error(`Could not read ${file.name}`)); return; }
          resolve({ mediaType: file.type, base64Data, name: file.name });
        };
        reader.onerror = () => reject(reader.error);
        reader.onabort = () => reject(new Error("Image loading cancelled"));
        reader.readAsDataURL(file);
      })));
      const state = get();
      if (draftKey(state) === key) set({ images: [...state.images, ...images] });
      else {
        const draft = state.drafts[key] ?? { text: "", images: [] };
        set({ drafts: { ...state.drafts, [key]: { ...draft, images: [...draft.images, ...images] } } });
      }
    } catch (error) { set({ error: `Attachment failed: ${message(error)}` }); }
  },

  attachDroppedPaths: async (paths) => {
    const key = draftKey(get());
    const root = currentWorkspace(get())?.path;
    try {
      const candidates = [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
      if (!candidates.length) return;
      const inspected = await readDroppedPaths(candidates);
      const inlined = inspected.filter((file) => file.mediaType && file.base64Data);
      // Missing files (error, no media type, not a dir) are skipped; image
      // failures keep their media type and land as references instead.
      const referenced = inspected.filter((file) => !(file.mediaType && file.base64Data) && (!file.error || file.mediaType || file.isDir));
      const images: ComposerImage[] = inlined.map((file) => ({ mediaType: file.mediaType!, base64Data: file.base64Data!, name: file.name }));
      const refs: ContextRef[] = referenced.map((file) => ({ id: uid(), kind: file.isDir ? "folder" : "file", path: refPathForDrop(file.path, root) }));
      const state = get();
      if (draftKey(state) === key) {
        const seen = new Set(state.contextRefs.map((ref) => ref.path));
        set({ images: [...state.images, ...images], contextRefs: [...state.contextRefs, ...refs.filter((ref) => ref.path && !seen.has(ref.path))] });
      } else {
        const draft = state.drafts[key] ?? { text: "", images: [] };
        const seen = new Set(draft.refs?.map((ref) => ref.path) ?? []);
        set({ drafts: { ...state.drafts, [key]: { ...draft, images: [...draft.images, ...images], refs: [...(draft.refs ?? []), ...refs.filter((ref) => ref.path && !seen.has(ref.path))] } } });
      }
      const notices = inspected.filter((file) => file.error).map((file) => `${file.name}: ${file.error}`);
      if (candidates.length > MAX_DROP_FILES) notices.push(`Only the first ${MAX_DROP_FILES} files were attached.`);
      if (notices.length) set({ error: notices.slice(0, 3).join(" ") + (notices.length > 3 ? ` (+${notices.length - 3} more)` : "") });
      scheduleMemory(get);
    } catch (error) { set({ error: `Attachment failed: ${message(error)}` }); }
  },

  clearImages: () => set({ images: [] }),
  addContextRefs: (refs) => {
    const seen = new Set(get().contextRefs.map((ref) => ref.path));
    const next = refs.filter((ref) => ref.path && !seen.has(ref.path));
    if (!next.length) return;
    set({ contextRefs: [...get().contextRefs, ...next] });
    scheduleMemory(get);
  },
  removeContextRef: (id) => {
    set({ contextRefs: get().contextRefs.filter((ref) => ref.id !== id) });
    scheduleMemory(get);
  },
  retryLast: async () => {
    const thread = currentThread(get());
    if (!thread || thread.status === "running" || get().submitting) return;
    const last = [...thread.items].reverse().find((item) => item.kind === "userMessage");
    if (!last?.text && !last?.images?.length && !last?.refs?.length) return;
    set({ composer: last.text ?? "", images: last.images ?? [], contextRefs: last.refs ?? [] });
    await get().sendPrompt({ resetTaskState: true });
  },
  continueThread: async () => {
    const thread = currentThread(get());
    if (!thread || thread.status === "running" || get().submitting) return;
    set({ composer: "Continue from the last interruption. Finish remaining work.", images: [], contextRefs: [] });
    await get().sendPrompt();
  },
  setComposer: (value) => { set({ composer: value }); scheduleDraft(get); },
  viewer: null,
  openViewer: (images, index = 0) => set({ viewer: images.length ? { images, index: Math.min(Math.max(index, 0), images.length - 1) } : null }),
  closeViewer: () => set({ viewer: null }),
  stepViewer: (delta) => set((state) => state.viewer ? { viewer: { images: state.viewer.images, index: (state.viewer.index + delta + state.viewer.images.length) % state.viewer.images.length } } : {}),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setDockOpen: (open) => { set({ dockOpen: open }); scheduleMemory(get); },
  setDockTab: (tab) => set({ dockTab: tab, inspectorTab: tab }),
  openFileDiff: (path) => {
    const state = get();
    const first = state.git?.diff ? parseUnifiedDiff(state.git.diff).files[0]?.path : undefined;
    const base = state.diffTabs ?? (first ? [first] : []);
    set({
      diffTabs: base.includes(path) ? base : [...base, path],
      diffActive: path,
      dockOpen: true,
      inspectorTab: "diff",
      dockTab: "diff",
    });
  },
  closeFileDiff: (path) => {
    const state = get();
    const first = state.git?.diff ? parseUnifiedDiff(state.git.diff).files[0]?.path : undefined;
    const base = state.diffTabs ?? (first ? [first] : []);
    const remaining = base.filter((entry) => entry !== path);
    const active = state.diffActive === path
      ? remaining[Math.min(Math.max(base.indexOf(path), 0), remaining.length - 1)] ?? null
      : state.diffActive;
    set({ diffTabs: remaining, diffActive: active });
  },
  setActiveDiff: (path) => set({ diffActive: path }),

  exitPreview: async () => {
    if (!get().preview) return;
    for (const timer of previewTimers.values()) window.clearTimeout(timer);
    previewTimers.clear();
    const snapshot = previewSnapshot;
    previewSnapshot = null;
    ++selectionVersion;
    ++gitVersion;
    ++modelVersion;
    set({ preview: false, error: null, models: [], ...(snapshot ?? { workspaces: [], selectedWorkspaceId: null, selectedSessionId: null, threads: [], drafts: {}, composer: "", images: [], contextRefs: [], git: null }) });
    try {
      await get().refreshDetection();
      if (get().detection?.found && get().detection?.authenticated && currentWorkspace(get())) await get().startHost();
    } catch (error) {
      set({ error: `Could not reconnect: ${message(error)}. Open Settings to try again.` });
    }
  },

  enterPreview: () => {
    if (!get().preview) {
      const { workspaces, selectedWorkspaceId, selectedSessionId, threads, drafts, composer, images, contextRefs, git } = get();
      previewSnapshot = { workspaces, selectedWorkspaceId, selectedSessionId, threads, drafts, composer, images, contextRefs, git };
    }
    const workspace: Workspace = {
      id: "preview",
      path: "/Users/you/Muse Code",
      name: "Muse Code",
    };
    // The last demo thread shows how a thread from another installed agent looks.
    const threads = mockThreads().map((thread, index, all) => index === all.length - 1 && all.length > 1
      ? { ...thread, agentId: "grok" as const, config: { agentId: "grok" as const, modelId: "grok-4.6", effort: "high" as const }, opened: true }
      : { ...thread, config: defaults(get()), opened: true });
    set({
      preview: true,
      agents: MOCK_AGENTS,
      workspaces: [workspace],
      selectedWorkspaceId: workspace.id,
      threads,
      selectedSessionId: threads[0]?.sessionId ?? null,
      composer: "",
      images: [],
      contextRefs: [],
      error: null,
      git: MOCK_GIT,
    });
    void get().refreshGit();
    void get().refreshModels();
  },
}));

export function applyTheme(theme: Settings["theme"], accentColor: Settings["accentColor"] = "blue", accentSidebar = false) {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.accent = accentColor;
  document.documentElement.dataset.sidebarAccent = String(accentSidebar);
}

/**
 * The host already ended this turn, but its end never reached the app (e.g. across a reconnect),
 * so the thread still looks busy. Settle it locally instead of reporting an error.
 */
/**
 * ARCH-003: one definition of "this thread lost its host". The connection-loss
 * path and the per-agent-exit path must clear exactly the same pending
 * interaction state. They had drifted: `agentExit` forgot `pendingTurnKey` and
 * `approvalPending`, so an agent dying mid-approval left a phantom approval on
 * screen with nothing to resolve it.
 */
const ABANDONED: Partial<Thread> = {
  opened: false,
  opening: false,
  activeTurnId: null,
  pendingTurnKey: null,
  pendingApproval: null,
  queuedApprovals: [],
  userInputs: [],
  userInputPending: undefined,
  approvalPending: false,
  cancelRequested: false,
  activity: undefined,
  configPending: false,
  pendingConfig: undefined,
};

function abandonThread(thread: Thread, extra: Partial<Thread> = {}): Thread {
  if (thread.status !== "running") return { ...thread, ...ABANDONED, ...extra };
  return {
    ...thread,
    ...finishTurn(thread, thread.activeTurnId ?? undefined),
    ...ABANDONED,
    status: "error",
    lastOutcome: "interrupted" as const,
    lastTurnId: thread.activeTurnId ?? thread.lastTurnId,
    plan: settlePlan(thread.plan, "interrupted"),
    items: settleItems(thread.items, "interrupted", true),
    ...extra,
  };
}

function settleEndedTurn(sessionId: string, turnId?: string | null) {
  useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId !== sessionId || thread.status !== "running" ? thread : {
    ...thread,
    ...finishTurn(thread, turnId ?? thread.activeTurnId ?? undefined),
    status: "idle",
    activeTurnId: null,
    lastTurnId: turnId ?? thread.activeTurnId ?? thread.lastTurnId,
    lastOutcome: thread.cancelRequested ? "cancelled" : thread.lastOutcome,
    cancelRequested: false,
    activity: undefined,
    pendingApproval: null,
    queuedApprovals: [],
    userInputs: [],
    error: null,
    plan: thread.cancelRequested ? settlePlan(thread.plan, "cancelled") : thread.plan,
    items: thread.cancelRequested ? settleItems(thread.items, "cancelled") : settleItems(thread.items, "interrupted"),
  }) }));
  scheduleMemory(useAppStore.getState);
}

/**
 * Safety net for a missed turn end: while a Muse thread looks busy but has been quiet for a
 * while, ask the host whether its session is actually idle.
 */
export async function reconcileRunningThreads() {
  const state = useAppStore.getState();
  if (state.preview) return;
  const quiet = state.threads.filter((thread) => !thread.agentId && thread.status === "running" && !thread.opening && !thread.pendingApproval && !thread.queuedApprovals?.length && !thread.userInputs?.length && Date.now() - Date.parse(thread.updatedAt) > 20000);
  for (const workspaceRoot of new Set(quiet.map((thread) => thread.workspacePath))) {
    const workspace = state.workspaces.find((item) => item.path === workspaceRoot);
    if (isTauri() && !workspace?.grantId) continue;
    try {
      const wanted = new Set(quiet.filter((thread) => thread.workspacePath === workspaceRoot).map((thread) => thread.sessionId));
      const { sessions } = await listWorkspaceSessions({ path: workspaceRoot, grantId: workspace?.grantId }, undefined, 5, (all) => [...wanted].every((id) => all.some((session) => session.sessionId === id)));
      for (const session of sessions) {
        const thread = quiet.find((item) => item.sessionId === session.sessionId);
        if (thread && session.status === "idle" && !session.activeTurnId) settleEndedTurn(thread.sessionId, thread.activeTurnId);
      }
    } catch { /* host busy or restarting; the next pass retries */ }
  }
}

/**
 * Send while a turn runs (Muse only). Queue parks the input for launch,
 * steer folds it into the running turn, replace interrupts and starts over.
 * Runs under sendPrompt's submitting guard; clears the draft on success.
 */
async function sendBusyTurn(sessionId: string, disposition: "queue" | "steer" | "replace", payload: string, text: string, images: ComposerImage[], skill?: { selector: string; arguments?: string }) {
  const state = useAppStore.getState();
  const thread = state.threads.find((item) => item.sessionId === sessionId);
  if (!thread) return;
  const key = `thread:${sessionId}`;
  // Retries reuse the unsettled key (and the replace bubble) so the host dedupes.
  const keptOptimistic = thread.pendingTurnKey
    ? [...(thread.items ?? [])].reverse().find((item) => item.kind === "userMessage" && item.optimistic && item.text === (text || payload))
    : undefined;
  // Queue/steer retries reuse the unsettled key outright (no bubble to match);
  // replace requires the matching bubble so a reworded prompt sends fresh.
  const turnKey = thread.pendingTurnKey && (disposition !== "replace" || keptOptimistic) ? thread.pendingTurnKey : uid();
  const patch = (part: Partial<Thread>) => useAppStore.setState({ threads: useAppStore.getState().threads.map((item) => item.sessionId === sessionId ? { ...item, ...part } : item) });
  // Pre-replace turn state, so a failed `replace` can roll back exactly what it
  // changed instead of leaving a thread stuck "running" with no active turn.
  const before = { status: thread.status, activeTurnId: thread.activeTurnId, lastOutcome: thread.lastOutcome, turnStartedAt: thread.turnStartedAt, activity: thread.activity, turnStats: thread.turnStats };
  let replaceItem: TranscriptItem | undefined;
  const clearDraft = () => {
    const live = useAppStore.getState();
    const selected = live.selectedSessionId === sessionId;
    const draft = selected ? { text: live.composer, images: live.images, refs: live.contextRefs } : live.drafts[key];
    if (draft?.text.trim() === text && draft.images === images) {
      useAppStore.setState({ ...(selected ? { composer: "", images: [], contextRefs: [] } : {}), drafts: { ...live.drafts, [key]: { ...live.drafts[key], text: "", images: [], refs: [] } } });
    }
  };
  const fail = (error: unknown, fallback: string) => {
    if (timeoutUnknown(error)) {
      // The submit may have landed without its acknowledgement: keep the key
      // so a retry dedupes instead of doubling (queue/replace only — a steer
      // has no idempotency key, so it only warns).
      patch(disposition === "steer"
        ? { notice: { level: "warning", message: "No acknowledgement yet — the steer may still have landed." } }
        : { pendingTurnKey: turnKey, notice: { level: "warning", message: "No acknowledgement yet — retry safely; a duplicate will not send." } });
      return;
    }
    const classified = classifyError(error, fallback);
    if (disposition === "replace" && replaceItem) {
      // A definitive failure means the replace never reached the host: drop the
      // optimistic bubble and restore the prior turn state (mirrors the
      // non-busy send path's rollback) rather than showing a message as sent.
      const dropId = replaceItem.itemId;
      useAppStore.setState((current) => ({
        threads: current.threads.map((item) => item.sessionId === sessionId ? {
          ...item,
          items: item.items.filter((entry) => entry.itemId !== dropId),
          ...before,
          pendingTurnKey: null,
          cancelRequested: false,
          error: `${classified.title}. ${classified.lost}`,
        } : item),
      }));
      return;
    }
    patch({ error: `${classified.title}. ${classified.lost}` });
  };
  try {
    if (disposition === "steer") {
      await bridge<{ turnId: string }>("steerTurn", { sessionId, text: payload, reasoningEffort: thread.config?.effort ?? state.defaultEffort, images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })) });
      patch({ notice: { level: "info", message: "Steered into the running turn." }, error: null });
      clearDraft();
      return;
    }
    if (disposition === "replace") {
      const userItem: TranscriptItem = keptOptimistic ?? { itemId: uid(), kind: "userMessage", status: "completed", text: text || payload, images, refs: state.contextRefs, optimistic: true };
      replaceItem = userItem;
      patch({ ...applyItem(thread, userItem), error: null, activeTurnId: null, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: thread.usage?.outputTokens ?? 0, turnStats: undefined });
    }
    const result = await bridge<{ turnId: string; disposition?: string; deduped?: boolean }>("sendTurn", { sessionId, text: payload, reasoningEffort: thread.config?.effort ?? state.defaultEffort, images: images.map(({ mediaType, base64Data }) => ({ mediaType, base64Data })), clientTurnId: turnKey, ifBusy: disposition, ...(skill ? { skill } : {}) });
    const latest = useAppStore.getState().threads.find((item) => item.sessionId === sessionId);
    if (disposition === "replace" || result.disposition === "started") {
      // Running treatment: the fresh turn owns the thread now. A completion
      // for the superseded turn is ignored via the activeTurnId guard.
      patch({ activeTurnId: result.turnId, pendingTurnKey: null, notice: result.deduped ? { level: "info", message: "Resumed the pending turn instead of sending a duplicate." } : null });
      if (latest?.cancelRequested) await cancelSession(sessionId, result.turnId);
    } else if (result.deduped && latest?.activeTurnId === result.turnId) {
      // Retry dedupe against the already-running turn: nothing to track.
      patch({ pendingTurnKey: null });
    } else {
      patch({ queuedTurns: [...(latest?.queuedTurns ?? []), { turnId: result.turnId, text: text || payload }], pendingTurnKey: null, notice: { level: "info", message: "Queued — runs when the current turn finishes." } });
    }
    clearDraft();
  } catch (error) {
    fail(error, "Send failed");
  }
}

async function cancelSession(sessionId: string, turnId?: string) {
  try { await bridge("cancelTurn", { agentId: useAppStore.getState().threads.find((thread) => thread.sessionId === sessionId)?.agentId, sessionId, ...(turnId ? { turnId } : {}) }); }
  catch (error) {
    if (/already_terminal|already (?:ended|completed|finished)|not running|no active turn/i.test(message(error))) { settleEndedTurn(sessionId, turnId); return; }
    useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId === sessionId ? { ...thread, cancelRequested: false, error: `Stop failed: ${message(error)}. Try Stop again.` } : thread) }));
  }
}

/**
 * Token-speed `delta` streams are buffered per session/item and applied once per
 * frame instead of one `setState` (and transcript re-render) per token. Any
 * other event flushes the buffer synchronously first, so it never observes a
 * stale item.
 */
const deltaBuffer = new Map<string, Map<string, { text: string; output: string }>>();
let deltaFlushScheduled = false;

function bufferDelta(data: { sessionId: string; itemId: string; delta: string; field?: string }) {
  const field = !data.field || data.field === "text" ? "text" as const : data.field === "output" ? "output" as const : null;
  if (!field) return;
  let session = deltaBuffer.get(data.sessionId);
  if (!session) deltaBuffer.set(data.sessionId, session = new Map());
  const entry = session.get(data.itemId) ?? { text: "", output: "" };
  entry[field] += data.delta;
  session.set(data.itemId, entry);
  if (deltaFlushScheduled) return;
  deltaFlushScheduled = true;
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => flushDeltas());
  else setTimeout(flushDeltas, 16);
}

function flushDeltas() {
  deltaFlushScheduled = false;
  if (!deltaBuffer.size) return;
  const buffered = [...deltaBuffer];
  deltaBuffer.clear();
  const selected = useAppStore.getState().selectedSessionId;
  for (const [sessionId, deltas] of buffered) {
    useAppStore.setState((state) => {
      const thread = state.threads.find((item) => item.sessionId === sessionId);
      if (!thread) return state;
      let items = thread.items;
      let touched = false;
      for (const [itemId, delta] of deltas) {
        const index = items.findIndex((item) => item.itemId === itemId);
        if (index < 0) {
          // The `item` event has not landed yet; hold the text for applyItem.
          const pending = pendingDeltas.get(itemId) ?? {};
          if (delta.text) pending.text = `${pending.text ?? ""}${delta.text}`;
          if (delta.output) pending.output = `${pending.output ?? ""}${delta.output}`;
          pendingDeltas.set(itemId, pending);
          continue;
        }
        touched = true;
        items = items.map((item, at) => at !== index ? item : {
          ...item,
          ...(delta.text ? { text: `${item.text ?? ""}${delta.text}` } : {}),
          ...(delta.output ? { visibleOutput: `${item.visibleOutput ?? ""}${delta.output}` } : {}),
        });
      }
      if (!touched) return state;
      return { threads: state.threads.map((item) => item.sessionId === sessionId ? { ...item, unread: selected !== sessionId, items } : item) };
    });
  }
}

/** Test hook: apply buffered stream deltas without waiting a frame. */
export function flushDeltasForTest() {
  flushDeltas();
}

export function bindBridgeEvents() {
  return onBridgeEvent((event, payload) => {
    if (event === "delta") {
      bufferDelta(payload as { sessionId: string; itemId: string; delta: string; field?: string });
      return;
    }
    // Non-delta events observe the stream as of now: apply any buffered deltas first.
    flushDeltas();
    const store = useAppStore.getState();
    const update = (sessionId: string, transform: (thread: Thread) => Thread) => useAppStore.setState((state) => ({ threads: state.threads.map((thread) => thread.sessionId === sessionId ? transform(thread) : thread) }));
    // OS notifications never carry prompt text, output, or args — Notification
    // Center persists them. Title is the thread title, body a fixed phrase.
    const maybeNotify = (sessionId: string, body: string) => {
      const state = useAppStore.getState();
      const title = state.threads.find((thread) => thread.sessionId === sessionId)?.title || "Muse";
      const focused = typeof document !== "undefined" && typeof document.hasFocus === "function" ? document.hasFocus() : true;
      if (shouldNotify({ enabled: state.notifications !== false, focused, selected: sessionId === state.selectedSessionId, preview: state.preview })) void notify(title, body);
    };
    if (event === "hostExit" || event === "bridgeExit" || event === "connectionError" || event === "hostStopping") {
      ++modelVersion;
      const payloadInfo = payload as { kind?: string; exitCode?: number } | undefined;
      const closed = event === "hostStopping" ? null : payloadInfo?.kind === "crash"
        ? `Muse exited unexpectedly${payloadInfo.exitCode != null ? ` (${payloadInfo.exitCode})` : ""}. Open Settings to reconnect; drafts are retained.`
        : "Muse connection closed. Open Settings to reconnect; drafts are retained.";
      useAppStore.setState({ error: closed, ...(event === "hostStopping" ? {} : { hostInfo: null }), ...(store.modelsAgentId === "muse" ? { models: [], modelsLoading: false } : {}), threads: store.threads.map((thread) => thread.agentId ? thread : abandonThread(thread)) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "agentExit") {
      const data = payload as { agentId: AgentId; error?: string | null };
      const name = store.agents.find((agent) => agent.id === data.agentId)?.name ?? data.agentId;
      useAppStore.setState({ threads: store.threads.map((thread) => thread.agentId !== data.agentId ? thread : abandonThread(thread, { notice: null, ...(thread.sessionId === store.selectedSessionId ? { error: `${name} stopped${data.error ? `: ${data.error}` : ""}. Select the thread again to reconnect.` } : {}) })) });
    }
    if (event === "agentNotice") {
      const data = payload as { sessionId: string; level?: "info" | "warning"; message: string | null };
      update(data.sessionId, (thread) => ({ ...thread, notice: data.message ? { level: data.level ?? "info", message: data.message } : null }));
    }
    if (event === "loginDone") {
      useAppStore.setState({ loginPrompt: null, loginError: null });
      void useAppStore.getState().refreshDetection();
    }
    if (event === "loginError") {
      const data = payload as { error?: string };
      useAppStore.setState({ loginPrompt: null, loginError: data?.error ?? "Sign-in failed." });
    }
    if (event === "sessionTitle") {
      const data = payload as { sessionId: string; title: string };
      update(data.sessionId, (thread) => thread.customTitle ? thread : { ...thread, title: titleFromText(data.title) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "sessionName") {
      const data = payload as { sessionId: string; name: string };
      // In-flight renames accept the host name (the deferred RecoveryPending
      // name would otherwise be dropped by the optimistic customTitle).
      update(data.sessionId, (thread) => thread.customTitle && !renameInflight.has(data.sessionId) ? thread : { ...thread, title: titleFromText(data.name) });
      scheduleMemory(useAppStore.getState);
    }
    if (event === "sessionRow") {
      const data = payload as { session: SessionMetadata };
      const row = data.session;
      if (row?.sessionId) {
        const known = store.threads.some((thread) => thread.sessionId === row.sessionId);
        const workspacePath = store.workspaces.find((workspace) => workspace.path === row.workspaceRoot)?.path;
        if (!known && workspacePath && !store.threadMeta[row.sessionId]?.deleted) {
          // A session this renderer never listed (created by another client):
          // insert a lightweight unopened thread so the stream actually surfaces it.
          useAppStore.setState((state) => state.threads.some((thread) => thread.sessionId === row.sessionId) ? state : ({
            threads: [...state.threads, {
              sessionId: row.sessionId, workspacePath, title: listedTitle(row), order: Date.now(),
              updatedAt: row.updatedAt ?? new Date().toISOString(),
              status: row.status === "running" ? "running" : "idle",
              unread: state.selectedSessionId !== row.sessionId, items: [],
              activeTurnId: row.activeTurnId ?? null, config: metadataConfig(row, state.defaultEffort),
            }],
          }));
          scheduleMemory(useAppStore.getState);
          // Bind the streamed row natively so an immediate open succeeds: the
          // trust boundary only resumes sessions learned from an authorized list.
          const grantId = useAppStore.getState().workspaces.find((workspace) => workspace.path === workspacePath)?.grantId;
          if (grantId) void listWorkspaceSessions({ path: workspacePath, grantId }, undefined, 1).catch(() => {});
        } else {
          update(row.sessionId, (thread) => ({
            ...thread,
            ...(thread.customTitle || !row.name?.trim() ? {} : { title: titleFromText(row.name) }),
            ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
            ...(typeof row.activeTurnId !== "undefined" ? { activeTurnId: row.activeTurnId } : {}),
          }));
          scheduleMemory(useAppStore.getState);
        }
      }
    }
    if (event === "sessionStatus") {
      const data = payload as { sessionId: string; status: string };
      update(data.sessionId, (thread) => {
        // `error` threads need explicit recovery (retry/reselect): a delayed or
        // duplicate `running` event must not revive a settled failure.
        if (data.status === "running") return thread.status === "error" ? thread : { ...thread, status: "running" };
        // Never downgrade local optimism: a send awaiting its turn id looks
        // idle to the host for a beat. Unknown states (notLoaded, future) stay local.
        if (data.status === "idle" && !thread.activeTurnId && !thread.pendingTurnKey && thread.status !== "error") return { ...thread, status: "idle" };
        return thread;
      });
    }
    if (event === "sessionModel") {
      const data = payload as { sessionId: string; modelId: string; providerId?: string };
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, modelId: data.modelId, providerId: data.providerId ?? thread.config?.providerId } }));
      if (store.selectedSessionId === data.sessionId) void useAppStore.getState().refreshModels();
    }
    if (event === "sessionApprovalMode") {
      const data = payload as { sessionId: string; mode: SessionConfig["approvalMode"] };
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, approvalMode: data.mode } }));
    }
    if (event === "sessionEffort") {
      const data = payload as { sessionId: string; effort: SessionConfig["effort"] };
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, effort: data.effort } }));
    }
    if (event === "approvalUpdated") {
      const data = payload as { sessionId?: string; approvalId: string; availableChoices: ApprovalRequest["availableChoices"] };
      const sessionId = data.sessionId ?? store.threads.find((thread) => thread.pendingApproval?.approvalId === data.approvalId || thread.queuedApprovals?.some((queued) => queued.approvalId === data.approvalId))?.sessionId;
      if (sessionId) update(sessionId, (thread) => thread.pendingApproval?.approvalId === data.approvalId
        ? { ...thread, pendingApproval: { ...thread.pendingApproval, availableChoices: data.availableChoices } }
        : { ...thread, queuedApprovals: (thread.queuedApprovals ?? []).map((queued) => queued.approvalId === data.approvalId ? { ...queued, availableChoices: data.availableChoices } : queued) });
    }
    if (event === "approvalResolved") {
      const data = payload as { sessionId?: string; approvalId: string };
      const sessionId = data.sessionId ?? store.threads.find((thread) => thread.pendingApproval?.approvalId === data.approvalId || thread.queuedApprovals?.some((queued) => queued.approvalId === data.approvalId))?.sessionId;
      if (sessionId) update(sessionId, (thread) => {
        const dropped = dropApproval(thread, data.approvalId);
        return dropped.slotted ? { ...dropped.thread, approvalPending: false, notice: { level: "info", message: "That approval was resolved elsewhere." } } : dropped.thread;
      });
    }
    if (event === "agentConfig") {
      const data = payload as { sessionId: string; config: AgentSessionConfig };
      const prior = store.threads.find((thread) => thread.sessionId === data.sessionId)?.config;
      update(data.sessionId, (thread) => ({ ...thread, config: { ...thread.config, ...agentConfigPatch(data.config), agentId: thread.agentId }, modes: data.config.modes ?? thread.modes }));
      // listModels is a serialized bridge round-trip on ACP agents (~1s on
      // Grok). An effort echo changes nothing the catalog offers, so only a
      // model or mode move justifies the refresh.
      const shifted = (data.config.modelId !== undefined && data.config.modelId !== prior?.modelId) || (data.config.mode !== undefined && data.config.mode !== prior?.mode);
      if (store.selectedSessionId === data.sessionId && shifted) void useAppStore.getState().refreshModels();
    }
    if (event === "sessionFacts") {
      const data = payload as { sessionId: string; plan?: PlanItem[]; goal?: GoalState | null; context?: ContextUsage | null; usage?: TokenUsage | null; branch?: string | null };
      update(data.sessionId, (thread) => withLateUsage({ ...thread, plan: data.plan ?? thread.plan, planAnchor: data.plan ? planAnchorFor(thread, data.plan) : thread.planAnchor, goal: data.goal ?? thread.goal, context: data.context ?? thread.context, usage: data.usage ?? thread.usage, hostBranch: data.branch ?? thread.hostBranch }));
    }
    if (event === "usageChanged") {
      const usage = asSubscriptionUsage(payload);
      if (usage) {
        useAppStore.setState({ subscriptionUsage: usage, subscriptionUsageAt: Date.now(), subscriptionUsageError: null });
        scheduleMemory(useAppStore.getState);
      }
    }
    if (event === "userInputs") {
      const data = payload as { sessionId: string; requests: UserInputRequest[] };
      update(data.sessionId, (thread) => ({ ...thread, userInputs: data.requests, userInputVersion: (thread.userInputVersion ?? 0) + 1, unread: store.selectedSessionId !== data.sessionId, ...(data.requests.length ? { status: "running", activeTurnId: data.requests[0].turnId } : {}) }));
    }
    if (event === "item") {
      const data = payload as { sessionId: string; item: TranscriptItem };
      update(data.sessionId, (thread) => {
        let incoming = data.item;
        if (incoming.kind === "userMessage") {
          const optimistic = [...thread.items].reverse().find((item) => item.optimistic && item.kind === "userMessage" && item.text === incoming.text)
            ?? [...thread.items].reverse().find((item) => item.optimistic && item.kind === "userMessage");
          if (optimistic) {
            thread = { ...thread, items: thread.items.filter((item) => item !== optimistic) };
            incoming = { ...incoming, images: optimistic.images };
          }
        }
        const next = applyItem(thread, incoming);
        // A terminal compaction item settles a manual compact gesture.
        const compacted = incoming.kind === "compaction" && incoming.status !== "inProgress" && thread.notice?.key === "compacting";
        return { ...next, ...(compacted ? { notice: null } : {}), unread: store.selectedSessionId !== data.sessionId && !thread.opening, activity: thread.status === "running" ? incoming.kind === "agentMessage" ? "composing" : "working" : undefined };
      });
    }
    if (event === "approval") {
      const request = payload as ApprovalRequest;
      update(request.sessionId, (thread) => ({ ...parkApproval(thread, request), activeTurnId: request.turnId, status: "running", unread: store.selectedSessionId !== request.sessionId }));
      maybeNotify(request.sessionId, `Approval needed: ${humanizeToolName(request.toolName)}`);
    }
    if (event === "approvalError") {
      const data = payload as { sessionId?: string; approvalId: string; kind: string; error?: string };
      const sessionId = data.sessionId ?? store.threads.find((thread) => thread.pendingApproval?.approvalId === data.approvalId || thread.queuedApprovals?.some((queued) => queued.approvalId === data.approvalId))?.sessionId;
      if (sessionId) update(sessionId, (thread) => {
        const settled = thread.pendingApproval?.approvalId === data.approvalId ? advanceApprovals(thread) : dropApproval(thread, data.approvalId).thread;
        return { ...settled, approvalPending: false, error: `Approval ${data.kind}: ${data.error ?? "decision could not be delivered"}.${data.kind === "submitFailed" ? " The approval will reappear if it is still needed." : " Stop or reconnect to recover."}` };
      });
    }
    if (event === "turnRetry") {
      const data = payload as { sessionId: string; turnId: string; attempt?: number; maxAttempts?: number; reason?: string; retryDelayMs?: number };
      update(data.sessionId, (thread) => thread.activeTurnId && thread.activeTurnId !== data.turnId ? thread : ({
        ...thread,
        retry: { turnId: data.turnId, attempt: data.attempt ?? 1, maxAttempts: data.maxAttempts ?? 1, reason: data.reason ?? "retrying", retryAt: Date.now() + Math.max(0, data.retryDelayMs ?? 0) },
      }));
    }
    if (event === "viewHealth") {
      const data = payload as { sessionId: string; health: string; noneReason?: string };
      // v1 emits only `Unavailable`; anything else clears the degraded flag.
      update(data.sessionId, (thread) => ({ ...thread, viewHealth: data.health === "Unavailable" ? { health: data.health, ...(data.noneReason ? { noneReason: data.noneReason } : {}) } : null }));
    }
    if (event === "viewGap") {
      const data = payload as { sessionId: string; after: string; next: string };
      update(data.sessionId, (thread) => ({ ...thread, viewGap: { after: data.after, next: data.next, state: "filling" as const } }));
    }
    if (event === "viewGapHealed") {
      const data = payload as { sessionId: string; after: string; next: string };
      update(data.sessionId, (thread) => thread.viewGap?.after === data.after && thread.viewGap?.next === data.next ? { ...thread, viewGap: null } : thread);
    }
    if (event === "skillChanged") {
      const data = payload as { sessionId: string };
      void useAppStore.getState().refreshSkills(data.sessionId).catch(() => {});
    }
    if (event === "accountChanged") {
      void useAppStore.getState().refreshDetection().catch(() => {});
    }
    if (event === "turnError") {
      const data = payload as { sessionId: string; turnId?: string; error?: string; code?: string };
      const stopped = data.code === "interrupted" || data.code === "cancelled";
      if (!stopped) maybeNotify(data.sessionId, "Turn failed");
      update(data.sessionId, (thread) => ({ ...thread, ...finishTurn(thread, data.turnId), status: stopped ? "idle" : "error", error: stopped ? null : data.error ?? "Turn stream failed", retry: null, activeTurnId: null, pendingTurnKey: null, plan: stopped ? settlePlan(thread.plan, "cancelled") : settlePlan(thread.plan, "failed"), items: stopped ? settleItems(thread.items, "cancelled", true) : settleItems(thread.items, "failed"), pendingApproval: null, queuedApprovals: [], userInputs: [], userInputPending: undefined, cancelRequested: false, activity: undefined, lastTurnId: data.turnId, ...(stopped ? { lastOutcome: "cancelled" as const } : {}) }));
    }
    if (event === "gapError") {
      const data = payload as { sessionId: string; turnId?: string; error?: string; reason?: string; after?: string; next?: string };
      const guidance = data.reason === "noConnection"
        ? "Live updates cannot reach this thread. Reconnect to restore them."
        : data.reason === "pageStalled"
          ? "History replay stalled while recovering dropped events. Retry the rebuild."
          : "Some live events were dropped and recovery failed. Retry the rebuild.";
      update(data.sessionId, (thread) => ({
        ...thread,
        ...finishTurn(thread, data.turnId),
        status: "error",
        error: guidance,
        retry: null,
        viewGap: data.after && data.next ? { after: data.after, next: data.next, state: "failed" as const, ...(data.reason ? { reason: data.reason } : {}) } : thread.viewGap && { ...thread.viewGap, state: "failed" as const, ...(data.reason ? { reason: data.reason } : {}) },
        activeTurnId: null,
        pendingTurnKey: null,
        plan: settlePlan(thread.plan, "failed"),
        items: settleItems(thread.items, "failed"),
        pendingApproval: null,
        queuedApprovals: [],
        userInputs: [],
        userInputPending: undefined,
        cancelRequested: false,
        activity: undefined,
        lastTurnId: data.turnId,
      }));
    }
    if (event === "turnStarted") {
      const data = payload as { sessionId: string; turnId: string };
      update(data.sessionId, (thread) => {
        if (!(thread.queuedTurns ?? []).some((entry) => entry.turnId === data.turnId)) return thread;
        return { ...thread, status: "running", activeTurnId: data.turnId, cancelRequested: false, activity: "working", lastOutcome: undefined, turnStartedAt: Date.now(), turnStartOutput: thread.usage?.outputTokens ?? 0, turnStats: undefined, queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId), notice: null };
      });
    }
    if (event === "turnCompleted") {
      const data = payload as { sessionId: string; turnId: string; outcome: { kind: string; params?: { terminal?: string; reason?: string; error?: { kind?: string; message: string } } }; viewCursor?: string };
      if (data.outcome.kind === "unqueued") {
        // Authoritative removal of a reclaimed queued turn: no status change.
        update(data.sessionId, (thread) => ({ ...thread, queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId) }));
        return;
      }
      // A finished turn may have touched files — re-index @-mentions for the
      // selected workspace (debounced and rate-limited inside refreshFileIndex).
      const completedThread = store.threads.find((thread) => thread.sessionId === data.sessionId);
      const selectedWorkspace = store.workspaces.find((item) => item.id === store.selectedWorkspaceId);
      if (completedThread && selectedWorkspace && completedThread.workspacePath === selectedWorkspace.path) useAppStore.getState().refreshFileIndex();
      const terminal = data.outcome.params?.terminal;
      const auth = !store.threads.find((thread) => thread.sessionId === data.sessionId)?.agentId && authRequired(data.outcome);
      const cancelled = terminal === "cancelled";
      const failed = !cancelled && (data.outcome.kind !== "completed" || terminal !== "completed");
      if (!cancelled) maybeNotify(data.sessionId, failed || auth ? "Turn failed" : "Turn finished");
      update(data.sessionId, (thread) => thread.activeTurnId && thread.activeTurnId !== data.turnId ? { ...thread, items: settleTurnItems(thread.items, data.turnId, terminal), queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId), ...(thread.retry?.turnId === data.turnId ? { retry: null } : {}), ...(data.viewCursor ? { resumeCursor: data.viewCursor } : {}) } : ({
        ...thread,
        ...finishTurn(thread, data.turnId),
        retry: null,
        ...(data.viewCursor ? { resumeCursor: data.viewCursor } : {}),
        status: failed || auth ? "error" : "idle",
        queuedTurns: (thread.queuedTurns ?? []).filter((entry) => entry.turnId !== data.turnId),
        error: auth ? "Muse needs a sign-in. Add an API key in Settings. The draft is kept." : failed ? data.outcome.params?.error?.message ?? data.outcome.params?.reason ?? `Turn ended: ${data.outcome.kind} (${terminal ?? "outcome unknown"})` : cancelled ? null : thread.error,
        lastOutcome: auth ? "failed" : cancelled ? "cancelled" : failed ? "failed" : "completed",
        plan: cancelled ? settlePlan(thread.plan, "cancelled") : failed ? settlePlan(thread.plan, "failed") : thread.plan,
        items: cancelled ? settleItems(thread.items, "cancelled", true) : failed ? settleItems(thread.items, "failed") : thread.items,
        activeTurnId: null,
        pendingTurnKey: null,
        lastTurnId: data.turnId,
        pendingApproval: null,
        queuedApprovals: [],
        userInputs: [],
        userInputPending: undefined,
        approvalPending: false,
        cancelRequested: false,
        activity: undefined,
        unread: store.selectedSessionId !== data.sessionId,
      }));
      scheduleMemory(useAppStore.getState);
      if (store.threads.find((thread) => thread.sessionId === data.sessionId)?.workspacePath === currentWorkspace(store)?.path) void store.refreshGit();
      if (failed && /model access is disabled/i.test(data.outcome.params?.error?.message ?? "")) void useAppStore.getState().refreshModels();
    }
  });
}

export function currentWorkspace(state: Pick<AppStore, "workspaces" | "selectedWorkspaceId">): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
}

/** Drop discarded paths from the open diff tabs (null clears all). */
function pruneDiffTabs(dropped: Set<string> | null) {
  const state = useAppStore.getState();
  if (!state.diffTabs && !state.diffActive) return;
  const remaining = dropped ? (state.diffTabs ?? []).filter((entry) => !dropped.has(entry)) : [];
  const active = state.diffActive && (dropped === null || dropped.has(state.diffActive))
    ? (remaining[0] ?? null)
    : state.diffActive;
  useAppStore.setState({ diffTabs: state.diffTabs ? remaining : state.diffTabs, diffActive: active });
}

/**
 * One bounded `session/list` walk shared by workspace opens and the quiet-turn
 * reconcile. Follows `nextCursor` up to `maxPages`, optionally stopping early
 * once `stopWhen` is satisfied. Reports truncation so callers can warn instead
 * of silently dropping sessions past the bound.
 */
async function listWorkspaceSessions(workspace: Pick<Workspace, "path" | "grantId"> | null, agentId: string | undefined, maxPages: number, stopWhen?: (all: SessionMetadata[]) => boolean, options?: { updatedAfter?: string }) {
  const sessions: SessionMetadata[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < maxPages; page += 1) {
    // The grant id authorizes the call; the native side injects the canonical
    // root. A null workspace lists every workspace grantlessly (metadata
    // only); those rows bind to no grant until a scoped listing binds them.
    const listed = await bridge<{ sessions?: SessionMetadata[]; nextCursor?: string | null }>("listSessions", {
      agentId,
      limit: 200,
      ...(workspace?.grantId ? { grantId: workspace.grantId } : {}),
      ...(cursor ? { cursor } : {}),
      ...(options?.updatedAfter ? { updatedAfter: options.updatedAfter } : {}),
    });
    sessions.push(...(listed.sessions ?? []));
    cursor = listed.nextCursor ?? undefined;
    if (!cursor || stopWhen?.(sessions)) break;
    if (page === maxPages - 1) truncated = true;
  }
  return { sessions, truncated };
}

/** Agents that can take work right now (Muse also needs its API key; disabled providers are skipped). */
export function readyAgents(state: Pick<AppStore, "agents" | "detection" | "enabledAgents">): AgentInfo[] {
  const agents = state.agents.length ? state.agents : state.detection ? [{ id: "muse", name: "Muse", protocol: "msp", found: state.detection.found, path: state.detection.path, version: state.detection.version, verified: true, signIn: "", authenticated: state.detection.authenticated } as AgentInfo] : [];
  return agents.filter((agent) => agent.found && agentEnabled(state, agent.id) && (agent.id !== "muse" || agent.authenticated));
}

/** The agent new threads use: the saved default when ready, else Muse, else the first ready agent. */
export function preferredAgent(state: Pick<AppStore, "agents" | "detection" | "enabledAgents" | "defaultAgentId">): AgentId {
  const ready = readyAgents(state);
  if (state.defaultAgentId && ready.some((agent) => agent.id === state.defaultAgentId)) return state.defaultAgentId;
  return ready.find((agent) => agent.id === "muse")?.id ?? ready[0]?.id ?? "muse";
}

/** The agent behind the composer: the open thread's, else the draft's choice. */
export function activeAgentId(state: Pick<AppStore, "threads" | "selectedSessionId" | "drafts" | "selectedWorkspaceId" | "enabledAgents" | "agents" | "detection" | "defaultAgentId">): AgentId {
  const thread = currentThread(state);
  if (thread) return thread.agentId ?? "muse";
  const draftId = state.drafts[`project:${state.selectedWorkspaceId}`]?.config?.agentId;
  if (draftId && agentEnabled(state, draftId)) return draftId;
  return preferredAgent(state);
}

function agentConfigPatch(config?: AgentSessionConfig): Partial<SessionConfig> {
  if (!config) return {};
  return { ...(config.modelId ? { modelId: config.modelId, providerId: config.modelId.includes("/") ? config.modelId.split("/")[0] : undefined } : {}), ...(config.effort ? { effort: config.effort } : {}), ...(config.mode ? { mode: config.mode } : {}) };
}

/** Keeps the effort inside the tiers the selected model supports. */
function fitEffort(config: SessionConfig, models: Model[]): SessionConfig {
  if (!config.effort) return config;
  return { ...config, effort: clampTier(config.effort, tiersFor(modelFor(models, config), config.agentId)) };
}

/** The config the composer shows: the thread's, else this workspace's draft, else defaults. */
export function activeConfig(state: Pick<AppStore, "threads" | "selectedSessionId" | "drafts" | "selectedWorkspaceId" | "defaultAgentId" | "defaultModel" | "defaultProviderId" | "defaultApprovalMode" | "defaultEffort" | "enabledAgents">): SessionConfig {
  return currentThread(state)?.config ?? state.drafts[`project:${state.selectedWorkspaceId}`]?.config ?? defaults(state);
}

export function currentThread(state: Pick<AppStore, "threads" | "selectedSessionId">): Thread | undefined {
  return state.threads.find((thread) => thread.sessionId === state.selectedSessionId);
}
