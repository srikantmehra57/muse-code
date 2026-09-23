import { diagnostics } from "../../../../packages/muse-bridge/src/redaction";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./format";
import { log } from "./logger";
import { MOCK_GIT, MOCK_MODELS, MOCK_THREADS, mockThreads } from "./mock";
import type { AgentIdentity, Detection, DroppedFile, EnterpriseStatus, GitSnapshot, PluginDetail, PluginEntry, SkillDetail, SkillEntry } from "./types";

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const pending = new Map<string, Pending>();
let listener: Promise<void> | null = null;
const eventHandlers = new Set<(event: string, payload: unknown) => void>();

function isEvent(value: unknown): value is { type: "event"; event: string; payload: unknown } {
  return Boolean(value && typeof value === "object" && (value as { type?: string }).type === "event");
}

function isResponse(value: unknown): value is { id: string; ok: boolean; result?: unknown; error?: string; code?: string; retryable?: boolean } {
  return Boolean(value && typeof value === "object" && "id" in (value as object) && "ok" in (value as object));
}

/** A bridge failure that kept the host's structure: message plus MSP kind and retryability. */
export type BridgeError = Error & { code?: string; retryable?: boolean };

export function bridgeError(message: string, code?: string, retryable?: boolean): BridgeError {
  const error = new Error(message) as BridgeError;
  if (code) error.code = code;
  if (retryable !== undefined) error.retryable = retryable;
  return error;
}

async function ensureListener() {
  if (!isTauri()) return;
  if (!listener) {
    listener = listen<unknown>("bridge-line", (event) => {
      const value = event.payload;
      if (isEvent(value)) {
        if (["hostExit", "bridgeExit", "hostStopping", "connectionError", "turnCompleted", "turnError", "approvalError", "gapError", "loginDone", "loginError"].includes(value.event)) {
          log[value.event.toLowerCase().includes("error") || value.event === "hostExit" || value.event === "bridgeExit" ? "warn" : "info"](`bridge.event.${value.event}`);
        }
        if (value.event === "hostExit" || value.event === "bridgeExit" || value.event === "hostStopping") {
          for (const [id, waiter] of pending) {
            if (value.event === "hostStopping" && ["startHost", "stopHost"].includes(waiter.method)) continue;
            waiter.reject(new Error("Muse connection closed. Reconnect from Settings."));
            pending.delete(id);
          }
        }
        for (const handler of eventHandlers) handler(value.event, value.payload);
      } else if (isResponse(value) && value.id) {
        const waiter = pending.get(value.id);
        if (!waiter) return;
        pending.delete(value.id);
        if (value.ok) waiter.resolve(value.result);
        else waiter.reject(bridgeError(value.error || "Bridge error", typeof value.code === "string" ? value.code : undefined, typeof value.retryable === "boolean" ? value.retryable : undefined));
      }
    }).then(() => {}).catch((error) => {
      listener = null;
      throw error;
    });
  }
  await listener;
}

export function onBridgeEvent(handler: (event: string, payload: unknown) => void): () => void {
  eventHandlers.add(handler);
  void ensureListener().catch((error) => handler("connectionError", { error: String(error) }));
  return () => { eventHandlers.delete(handler); };
}

export async function bridge<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) return mockBridge(method, params) as T;
  await ensureListener();
  const id = crypto.randomUUID();
  log.debug("bridge.request", { method });
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      const timeout = new Error(`${method} timed out. Its result is unknown; check before retrying.`) as Error & { code?: string };
      timeout.code = "timeout-unknown";
      log.warn("bridge.timeout", { method });
      reject(timeout);
    }, 120_000);
    pending.set(id, {
      method,
      resolve: (value) => { window.clearTimeout(timer); log.debug("bridge.response", { method }); resolve(value as T); },
      reject: (error) => { window.clearTimeout(timer); log.warn("bridge.failure", { method, error: String(error) }); reject(error); },
    });
    void invoke("bridge_request", { id, method, params }).catch((error) => {
      pending.get(id)?.reject(new Error(diagnostics.text(String(error))));
      pending.delete(id);
    });
  });
}

function mockBridge(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "detect":
    case "status": {
      const apiKeyAvailable = Boolean(typeof params.museApiKey === "string" && params.museApiKey.trim());
      const activeAuth = params.museAuthMode === "subscription" ? null : apiKeyAvailable ? "apiKey" : null;
      return {
        found: false,
        path: null,
        version: null,
        authenticated: activeAuth !== null,
        method: activeAuth === "apiKey" ? "META_API_KEY" : null,
        activeAuth,
        subscriptionAvailable: false,
        apiKeyAvailable,
        running: false,
      } satisfies Detection;
    }
    case "listSessions":
      return {
        sessions: MOCK_THREADS.map((thread) => ({
          sessionId: thread.sessionId,
          workspaceRoot: params.workspaceRoot ?? thread.workspacePath,
          updatedAt: thread.updatedAt,
          status: thread.status === "running" ? "running" : "idle",
          turnCount: thread.items.length,
          modelId: "muse-spark-1.2",
          activeTurnId: thread.activeTurnId ?? null,
        })),
        nextCursor: null,
      };
    case "listModels":
      return { models: MOCK_MODELS, providerId: "meta", profileId: null, source: "preview" };
    case "usage":
      return {};
    case "startHost":
      return {
        server: { name: "preview", version: "0.0.0" },
        durability: params.noSessionLog === true ? "ephemeral" : "durable",
        trustWorkspace: params.trustWorkspace === true,
        posture: {
          ephemeralSessions: params.noSessionLog === true,
          disableWrite: params.disableWrite === true,
          disableShell: params.disableShell === true,
          sandboxNetwork: typeof params.sandboxNetwork === "string" ? params.sandboxNetwork : "proxy-only",
        },
      };
    case "startSession":
      return { sessionId: `preview-${Date.now()}` };
    case "sendTurn":
      return { turnId: `turn-${Date.now()}` };
    case "decideApproval":
    case "cancelTurn":
    case "stopHost":
      return { ok: true };
    case "readOutput": {
      const line = "✓ preview spec passes\n";
      const content = line.repeat(64).slice(0, 2048);
      return { offsetBytes: 0, byteLen: content.length, eof: true, encoding: "utf8", mediaType: "text/plain", content };
    }
    case "readSession":
      return {
        session: { sessionId: params.sessionId },
        history: { items: [
          { itemId: "mock-child-u1", kind: "userMessage", status: "completed", text: "Audit the composer for focus traps." },
          { itemId: "mock-child-a1", kind: "agentMessage", status: "completed", text: "Checked every dialog: focus stays inside while open." },
        ] },
        pendingRequests: [],
        viewCursor: "mock-cursor",
      };
    case "subagentControl":
    case "taskControl":
    case "workflowControl":
    case "goalControl":
    case "userShell":
      return { commandId: "mock-cmd", status: "accepted" };
    case "listSkills":
      return { skills: [{ selector: "review", displayName: "Review", description: "Review the working tree", source: "user" }] };
    case "mcpServers":
      return { servers: [{ name: "preview-docs", transport: "streamableHttp", oauth: true }] };
    default:
      return {};
  }
}

export async function gitSnapshot(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) return MOCK_GIT;
  return invoke<GitSnapshot>("git_snapshot", { grantId });
}

/** Repo-relative paths for @-mentions: `git ls-files` in repos, bounded walk elsewhere. */
export async function listWorkspaceFiles(grantId: string): Promise<string[]> {
  if (!isTauri()) return ["src/App.tsx", "src/main.ts", "src/lib/store.ts", "package.json", "README.md"];
  return invoke<string[]>("list_workspace_files", { grantId });
}

/** Discard working-tree changes for repo-relative paths; returns a fresh snapshot. */
export async function gitDiscardFiles(grantId: string, paths: string[]): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Discarding changes needs the desktop app.");
  return invoke<GitSnapshot>("git_discard_files", { grantId, paths });
}

/** Discard one hunk of a tracked file (the file is unstaged first); returns a fresh snapshot. */
export async function gitDiscardHunk(grantId: string, path: string, hunk: number): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Discarding changes needs the desktop app.");
  return invoke<GitSnapshot>("git_discard_hunk", { grantId, path, hunk });
}

/** Stage or unstage paths; returns a fresh snapshot. */
export async function gitStage(grantId: string, paths: string[], stage: boolean): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Staging changes needs the desktop app.");
  return invoke<GitSnapshot>("git_stage", { grantId, paths, stage });
}

/** Commit staged changes; returns a fresh snapshot. */
export async function gitCommit(grantId: string, message: string): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Committing needs the desktop app.");
  return invoke<GitSnapshot>("git_commit", { grantId, message });
}

/** Discard every uncommitted change (tracked restores, untracked removals, ignored kept). */
export async function gitDiscardAll(grantId: string): Promise<GitSnapshot> {
  if (!isTauri()) throw new Error("Discarding changes needs the desktop app.");
  return invoke<GitSnapshot>("git_discard_all", { grantId });
}

/** Inspect native OS drop paths (images come back with base64 bytes). */
export async function readDroppedPaths(paths: string[]): Promise<DroppedFile[]> {
  if (!isTauri()) return [];
  return invoke<DroppedFile[]>("read_dropped_files", { paths });
}

/** What `repairStoreDocument` found when it inspected the settings file. */
export type StoreRepair = {
  status: "ok" | "restored" | "quarantined" | "empty";
  restoredFrom?: string | null;
  quarantinedTo?: string | null;
};

/**
 * Persist the settings document atomically (temp file + rename, previous copy
 * kept as `.bak`). `tauri-plugin-store`'s own `save()` truncates in place, so a
 * crash mid-write can destroy every draft and thread title.
 */
export async function persistStoreDocument(json: string): Promise<void> {
  if (!isTauri()) return;
  await invoke<void>("persist_store_atomic", { json });
}

/**
 * Make the settings file safe to read before hydration. An unreadable file is
 * quarantined and the newest complete backup restored. Preview is a no-op.
 */
export async function repairStoreDocument(): Promise<StoreRepair> {
  if (!isTauri()) return { status: "ok" };
  return invoke<StoreRepair>("repair_store_document");
}

export type PickedFolder = { path: string; grantId: string; warning?: string };

export async function pickFolder(): Promise<PickedFolder | null> {
  if (!isTauri()) return { path: "/Users/you/Muse Code", grantId: "preview" };
  try {
    const picked = await invoke<{ path?: string; grantId?: string; warning?: string }>("pick_folder");
    if (!picked?.path || !picked.grantId) return null;
    return { path: picked.path, grantId: picked.grantId, warning: picked.warning };
  } catch {
    // The plugin-dialog fallback cannot mint a native grant, so it fails
    // closed: without a grant id the folder authorizes nothing.
    return null;
  }
}

export type GrantVerdict = { id: string; ok: boolean; path?: string | null };

/**
 * Verify-only reconciliation: submit the (id, path) pairs this renderer
 * holds; the native side confirms each without ever listing the grant set.
 */
export async function verifyGrants(entries: Array<{ id: string; path: string }>): Promise<GrantVerdict[]> {
  if (!isTauri()) return [];
  return invoke<GrantVerdict[]>("verify_grants", { entries });
}

export async function removeGrant(grantId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("remove_grant", { grantId });
}

export async function agentIdentities(): Promise<AgentIdentity[]> {
  if (!isTauri()) return [];
  return invoke<AgentIdentity[]>("agent_identities");
}

/** Trust the binary currently on disk for an agent (resolves natively; never nominates a path). */
export async function confirmAgentBin(agentId: string): Promise<AgentIdentity> {
  if (!isTauri()) throw new Error("Agent confirmation needs the desktop app.");
  return invoke<AgentIdentity>("confirm_agent_bin", { agentId });
}

export async function openPath(path: string, grantId: string) {
  if (!isTauri()) return;
  await invoke("open_path", { path, grantId });
}

export async function openUrl(url: string) {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await invoke("open_url", { url });
}

/**
 * Save fetched full output through a native save dialog. In preview mode
 * (no Tauri) the browser downloads the file instead.
 */
export async function saveOutputText(fileName: string, content: string, base64: boolean): Promise<string | null> {
  if (!isTauri()) {
    const bytes = base64 ? Uint8Array.from(atob(content), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(content);
    const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return fileName;
  }
  return invoke<string | null>("save_output_text", { fileName, content, base64 });
}

export async function mcpLogin(server: string, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_login", { server, museBin: museBin ?? "" });
}

export async function mcpLogout(server: string, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("mcp_logout", { server, museBin: museBin ?? "" });
}

export async function cliLogout(museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("cli_logout", { museBin: museBin ?? "" });
}

export async function projectInit(grantId: string, museBin: string | undefined, dryRun: boolean, force: boolean): Promise<string> {
  if (!isTauri()) return "# Preview AGENTS.md\n\nProject setup runs in the desktop app.";
  return invoke<string>("project_init", { grantId, museBin: museBin ?? "", dryRun, force });
}

export async function enterpriseStatus(museBin?: string): Promise<EnterpriseStatus> {
  if (!isTauri()) return { generation: null, sources: [] };
  return invoke<EnterpriseStatus>("enterprise_status", { museBin: museBin ?? "" });
}

export async function skillList(grantId: string | undefined, museBin?: string): Promise<SkillEntry[]> {
  if (!isTauri()) return [{ id: "preview-skill", name: "preview-skill", description: "Preview placeholder skill.", scope: "bundled", activation: "on" }];
  return invoke<SkillEntry[]>("skill_list", { grantId: grantId ?? "", museBin: museBin ?? "" });
}

export async function skillInstall(path: string, museBin?: string): Promise<string> {
  if (!isTauri()) return "Preview install — use the desktop app to install skills.";
  return invoke<string>("skill_install", { path, museBin: museBin ?? "" });
}

export async function skillImport(from: "claude" | "codex", dryRun: boolean, museBin?: string): Promise<string> {
  if (!isTauri()) return "Preview import — use the desktop app to import skills.";
  return invoke<string>("skill_import", { from, dryRun, museBin: museBin ?? "" });
}

export async function pickSkillSource(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_skill_source", {});
}

export async function skillInspect(skill: string, museBin?: string): Promise<SkillDetail> {
  if (!isTauri()) return { id: skill, name: skill, description: "Preview placeholder skill.", scope: "bundled", activation: "on", path: null };
  return invoke<SkillDetail>("skill_inspect", { skill, museBin: museBin ?? "" });
}

export async function skillUninstall(skill: string, museBin?: string): Promise<string> {
  if (!isTauri()) return "Preview uninstall — use the desktop app to uninstall skills.";
  return invoke<string>("skill_uninstall", { skill, museBin: museBin ?? "" });
}

export async function skillSet(skill: string, scope: string, enabled: boolean, grantId: string | undefined, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("skill_set", { skill, scope, enabled, grantId: grantId ?? "", museBin: museBin ?? "" });
}

export async function pluginList(museBin?: string, available = false): Promise<PluginEntry[]> {
  if (!isTauri()) return [{ id: "preview-plugin", version: "0.1", description: "Preview placeholder plugin.", enabled: true }];
  return invoke<PluginEntry[]>("plugin_list", { museBin: museBin ?? "", available });
}

export async function pluginInspect(id: string, museBin?: string): Promise<PluginDetail> {
  if (!isTauri()) return { id, version: "0.1", description: "Preview placeholder plugin.", capabilities: [{ id: "preview-cap", kind: "tool", description: "Preview capability.", enabled: true }] };
  return invoke<PluginDetail>("plugin_inspect", { id, museBin: museBin ?? "" });
}

export async function pluginReview(id: string, approve: boolean, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("plugin_review", { id, approve, museBin: museBin ?? "" });
}

export async function pluginInstall(path: string, museBin?: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("plugin_install", { path, museBin: museBin ?? "" });
}

export async function pickPluginBundle(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("pick_plugin_bundle", {});
}

export async function trustPreview(grantId: string, museBin?: string): Promise<import("./types").TrustPreview> {
  if (!isTauri()) {
    return {
      skills: [{ name: "/preview-skill", description: "Preview placeholder: real project skills appear in the desktop app." }],
      rules: { path: "AGENTS.md", excerpt: "# Preview rules\n\nThe desktop app shows this workspace's AGENTS.md here.", truncated: false },
    };
  }
  return invoke<import("./types").TrustPreview>("trust_preview", { grantId, museBin: museBin ?? "" });
}

export async function exportSession(options: { sessionId: string; title: string; museBin?: string; redacted: boolean }): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("export_session", {
    sessionId: options.sessionId,
    title: options.title,
    museBin: options.museBin ?? "",
    redacted: options.redacted,
  });
}

export { mockThreads };
