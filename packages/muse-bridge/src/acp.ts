import { diagnostics, DiagnosticLines, diagnosticEvent } from "./redaction.js";
import { LineFrames, encodeFrame } from "./framing.js";
import { spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "./agents.js";
import {
  approvalAlive,
  approvalExpiry,
  CANCEL_WAIT_MS,
  confinedCwd,
  filterChildEnv,
  spawnIsolated,
  terminateTree,
  type IsolationReport,
} from "./isolation.js";

/**
 * Drives any ACP (Agent Client Protocol) agent over stdio and translates its
 * `session/update` stream into the bridge events the desktop app already renders
 * for Muse: `item`, `delta`, `sessionFacts`, `approval`, `turnCompleted`, `turnError`.
 */

type Emit = (event: string, payload: unknown) => void;
type Json = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type AcpConfigOption = { id: string; name?: string; category?: string; type?: string; currentValue?: string; options?: Array<{ value: string; name?: string; description?: string }> };

const TOOL_NAMES: Record<string, string> = { read: "read_file", edit: "edit_file", delete: "edit_file", move: "edit_file", search: "grep", execute: "bash", fetch: "web_fetch" };
const TIERS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const STALL_MS = 15000;
const STALL_FAIL_MS = 25000;

class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** One ACP child process with line-delimited JSON-RPC in both directions. */
class AcpConnection {
  private frames = new LineFrames();
  private protocolError: Error | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private stderrTail = "";
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<unknown> = async (method) => { throw new RpcError(`Method not found: ${method}`, -32601); };

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    diagnostics.remember(process.env);
    const stderr = new DiagnosticLines((line) => { this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    this.exited = new Promise((resolve) => child.on("exit", (code, signal) => {
      stderr.end();
      const error = new Error(this.lastError() || `Agent exited${code != null ? ` (${code})` : ""}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      resolve({ code, signal });
    }));
    child.on("error", () => {});
  }

  lastError() {
    return this.stderrTail.split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 400);
  }

  private write(message: Json) {
    if (this.protocolError) throw this.protocolError;
    if (!this.child.stdin.writable) throw new Error("Agent is not running.");
    this.child.stdin.write(encodeFrame({ jsonrpc: "2.0", ...message }));
  }

  private read(chunk: Buffer) {
    if (this.protocolError) return;
    try {
      this.frames.push(chunk, (raw) => {
        const line = raw.trim();
        if (!line.startsWith("{")) return;
        let message: Json;
        try { message = JSON.parse(line) as Json; } catch { return; }
        const id = message.id as number | string | undefined;
        const method = str(message.method);
        if (method && id != null) {
          // Replies race `kill()`: a parked approval settled by `stop()` answers
          // into a dying stdin, so both arms swallow write failures instead of
          // surfacing unhandled rejections.
          this.onRequest(method, asRecord(message.params)).then(
            (result) => { try { this.write({ id, result: result ?? null }); } catch { /* stopping */ } },
            (error: unknown) => { try { this.write({ id, error: { code: error instanceof RpcError && error.code ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } }); } catch { /* stopping */ } },
          );
        } else if (method) {
          this.onNotification(method, asRecord(message.params));
        } else if (typeof id === "number" && this.pending.has(id)) {
          const waiter = this.pending.get(id)!;
          this.pending.delete(id);
          if (message.error) {
            const error = asRecord(message.error);
            const data = asRecord(error.data);
            waiter.reject(new RpcError(diagnostics.text(str(data.message) ?? str(error.message) ?? "Agent request failed"), typeof error.code === "number" ? error.code : undefined, error.data));
          } else waiter.resolve(message.result);
        }
      });
    } catch {
      this.protocolError = new Error("Agent protocol frame exceeded the byte limit. Reconnect to continue.");
      for (const waiter of this.pending.values()) waiter.reject(this.protocolError);
      this.pending.clear();
      this.child.stdout.destroy();
      this.kill();
    }
  }

  request<T = Json>(method: string, params: Json, timeoutMs?: number): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value as T); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); if (timer) clearTimeout(timer); reject(error as Error); }
    });
  }

  notify(method: string, params: Json) {
    this.write({ method, params });
  }

  kill() {
    return terminateTree(this.child);
  }
}

type Stream = { kind: "agentMessage" | "reasoning" | "userMessage"; itemId: string; text: string };
type Tool = { item: Json; hidden: boolean };
type SessionState = {
  cwd: string;
  turnId: string;
  counter: number;
  stream: Stream | null;
  tools: Map<string, Tool>;
  config: AcpConfigOption[];
  prompting: boolean;
  lastActivity: number;
  watchdog?: NodeJS.Timeout;
  failTimer?: NodeJS.Timeout;
  logCursor?: { file: string; offset: number };
  /** Set when the provider cannot complete this turn (rate limit, disabled model). */
  fatal?: string;
};

export type AcpModel = {
  modelId: string;
  displayLabel?: string;
  providerId?: string;
  description?: string | null;
  contextLimit?: number | null;
  cost?: { input: string; output: string; currency?: string | null } | null;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  effortSource?: "host" | "vocabulary";
  isDefault?: boolean;
  isActive?: boolean;
  unavailable?: boolean;
};

/** OpenCode Zen promo models (`mimo-v2.5-free`, `*:free`) that often reject with "Model access is disabled". */
export function zenFreeModel(modelId: string) {
  return /(?:^|[/:])[^/]*-free$/i.test(modelId);
}

function modelBare(modelId: string) {
  return modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
}

function modelOk(modelId: string, blocked: Set<string>) {
  const bare = modelBare(modelId);
  return !zenFreeModel(modelId) && !blocked.has(modelId) && !blocked.has(bare);
}

/** Replace a gated/blocked OpenCode model with Big Pickle or the first usable catalog row. */
export function fallbackOpencodeModel(catalog: Array<{ modelId: string }>, current?: string | null, blocked: Iterable<string> = []) {
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked);
  if (current && modelOk(current, blockedSet)) return undefined;
  return catalog.find((model) => /\/big-pickle$/i.test(model.modelId) && modelOk(model.modelId, blockedSet))?.modelId
    ?? catalog.find((model) => modelOk(model.modelId, blockedSet))?.modelId;
}

export function modelIdsFromError(message: string) {
  const match = message.match(/^([a-z0-9._/:+-]+)\s*:/i);
  if (!match) return [];
  const id = match[1];
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return [...new Set([id, bare, `opencode/${bare}`])];
}

/** Provider errors that will not recover if OpenCode keeps retrying. */
export function fatalProviderError(message: string) {
  return /model access is disabled|rate limit|quota(?: exceeded)?|insufficient (?:account )?funds|insufficient (?:credit|quota)|payment required|unauthori[sz]ed|forbidden|\b403\b|\b401\b/i.test(message);
}

export function zenAccountError(message: string) {
  return /model access is disabled|rate limit|insufficient (?:account )?funds|insufficient (?:credit|quota)|didn't respond/i.test(message);
}

/** Normalizes agent effort ids (`xhigh`, `x-high`, `default`, …) onto the app's tier vocabulary. */
function tierOf(value: string): string | null {
  const id = value.toLowerCase().replace(/[^a-z]/g, "");
  if (id === "extrahigh") return "xhigh";
  return TIERS.includes(id) ? id : null;
}

export class AcpAgentHost {
  private conn: AcpConnection | null = null;
  private starting: Promise<void> | null = null;
  private init: Json = {};
  private sessions = new Map<string, SessionState>();
  private approvals = new Map<string, { sessionId: string; turnId?: string; choices: Set<string>; expiresAt: number; resolve: (optionId: string | null) => void }>();
  private catalog: AcpModel[] | null = null;
  private blocked = new Set<string>();
  private turnSeq = 0;
  private isolationReport: IsolationReport | null = null;

  private readonly emit: Emit;
  constructor(readonly spec: AgentSpec, readonly bin: string, emit: Emit) {
    this.emit = (event, payload) => emit(event, diagnosticEvent(event, payload));
  }

  isolation() {
    return this.isolationReport;
  }

  get running() { return Boolean(this.conn); }
  owns(sessionId: string) { return this.sessions.has(sessionId); }

  async start(options?: { workspaceRoot?: string }) {
    if (this.conn) return;
    this.starting ??= (async () => {
      const spawned = spawnIsolated(this.bin, this.spec.acpArgs ?? [], { agentId: this.spec.id, workspace: options?.workspaceRoot });
      this.isolationReport = spawned.isolation;
      const child = spawned.child;
      const conn = new AcpConnection(child);
      conn.onNotification = (method, params) => this.onNotification(method, params);
      conn.onRequest = (method, params) => this.onRequest(method, params);
      void conn.exited.then(() => {
        if (this.conn !== conn) return;
        this.conn = null;
        for (const [sessionId, session] of this.sessions) {
          if (session.watchdog) clearInterval(session.watchdog);
          if (session.prompting) this.emit("turnCompleted", { sessionId, turnId: session.turnId, outcome: { kind: "failed", params: { terminal: "failed", error: { message: `${this.spec.name} stopped unexpectedly. ${conn.lastError()}`.trim() } } } });
        }
        this.sessions.clear();
        this.emit("agentExit", { agentId: this.spec.id, error: conn.lastError() || null });
      });
      try {
        this.init = await conn.request<Json>("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "muse_code_desktop", title: "Muse Code Desktop", version: "0.1.0" },
        }, 30000);
      } catch (error) {
        await conn.kill();
        throw new Error(`${this.spec.name} did not start its ACP server: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.conn = conn;
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  async stop() {
    for (const approval of this.approvals.values()) approval.resolve(null);
    this.approvals.clear();
    for (const session of this.sessions.values()) {
      if (session.watchdog) clearInterval(session.watchdog);
      if (session.failTimer) clearTimeout(session.failTimer);
    }
    this.sessions.clear();
    const conn = this.conn;
    this.conn = null;
    this.isolationReport = null;
    if (conn) await conn.kill();
  }

  private requireConn() {
    if (!this.conn) throw new Error(`${this.spec.name} is not running.`);
    return this.conn;
  }

  private capability(path: string[]) {
    let node: unknown = asRecord(this.init.agentCapabilities);
    for (const key of path) node = asRecord(node)[key];
    return node === true || (node != null && typeof node === "object");
  }

  /** Friendlier text for auth and model-access failures. */
  private explain(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RpcError ? error.code : undefined;
    if (code === -32000 || /auth|sign.?in|log.?in|unauthori[sz]ed|401/i.test(message)) return `${this.spec.name} needs a sign-in. ${this.spec.signIn}`;
    if (/insufficient (?:account )?funds|insufficient (?:credit|quota)/i.test(message)) {
      return `${message.replace(/\.+$/, "")}. OpenCode Zen has no credits. Add funds in OpenCode, or switch the agent to Grok.`;
    }
    if (/model access is disabled|rate limit/i.test(message)) {
      this.blockFrom(message);
      return `${message.replace(/\.+$/, "")}. OpenCode Zen free models aren't available on this account. Switch the agent to Grok, or add Zen credits and pick a paid model.`;
    }
    return message;
  }

  private blockFrom(message: string) {
    for (const id of modelIdsFromError(message)) this.blocked.add(id);
  }

  private markUnavailable(models: AcpModel[]): AcpModel[] {
    if (!this.blocked.size) return models;
    return models.map((model) => {
      const bare = model.modelId.includes("/") ? model.modelId.slice(model.modelId.indexOf("/") + 1) : model.modelId;
      if (!this.blocked.has(model.modelId) && !this.blocked.has(bare)) return model;
      return { ...model, unavailable: true, description: model.description && model.description !== "Free" ? model.description : "Unavailable on this account" };
    });
  }

  // ─── Models ───────────────────────────────────────────────────────────────

  async listModels(sessionId?: string): Promise<{ models: AcpModel[]; source: string }> {
    await this.start();
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const fromSession = session ? this.modelsFromConfig(session.config) : [];
    const catalog = await this.loadCatalog();
    if (!fromSession.length) return { models: this.markUnavailable(catalog), source: "catalog" };
    // Session options are authoritative for availability; the catalog adds metadata.
    const byId = new Map(catalog.map((model) => [model.modelId, model]));
    return { models: this.markUnavailable(fromSession.map((model) => ({ ...byId.get(model.modelId), ...model, ...(byId.get(model.modelId)?.reasoningEfforts && !model.reasoningEfforts ? { reasoningEfforts: byId.get(model.modelId)!.reasoningEfforts } : {}) }))), source: "session" };
  }

  private modelsFromConfig(config: AcpConfigOption[]): AcpModel[] {
    const option = config.find((item) => item.category === "model" || item.id === "model");
    const effort = config.find((item) => item.category === "thought_level");
    const efforts = effort?.options?.map((item) => tierOf(item.value)).filter((tier): tier is string => Boolean(tier));
    return (option?.options ?? []).map((item) => {
      const [provider, ...rest] = item.value.split("/");
      const active = item.value === option?.currentValue;
      return {
        modelId: item.value,
        displayLabel: item.name?.includes("/") ? item.name.split("/").slice(1).join("/") : item.name,
        providerId: rest.length ? provider : this.spec.id,
        description: item.description ?? null,
        isActive: active,
        ...(active && efforts?.length ? { reasoningEfforts: TIERS.filter((tier) => efforts.includes(tier)), defaultReasoningEffort: tierOf(effort?.currentValue ?? "") ?? undefined, effortSource: "host" as const } : {}),
      };
    });
  }

  private async loadCatalog(): Promise<AcpModel[]> {
    if (this.catalog) return this.catalog;
    const meta = asRecord(asRecord(this.init._meta).modelState);
    if (Array.isArray(meta.availableModels)) {
      // grok: the initialize handshake carries the catalog with per-model effort tiers.
      this.catalog = (meta.availableModels as Json[]).map((row) => {
        const info = asRecord(row._meta);
        const efforts = Array.isArray(info.reasoningEfforts) ? (info.reasoningEfforts as Json[]) : [];
        const tiers = efforts.map((entry) => tierOf(String(entry.value ?? entry.id ?? ""))).filter((tier): tier is string => Boolean(tier));
        const fallback = efforts.find((entry) => entry.default === true);
        return {
          modelId: String(row.modelId),
          displayLabel: str(row.name),
          providerId: this.spec.id,
          description: str(row.description) ?? null,
          contextLimit: typeof info.totalContextTokens === "number" ? info.totalContextTokens : null,
          isDefault: row.modelId === meta.currentModelId,
          ...(tiers.length ? { reasoningEfforts: TIERS.filter((tier) => tiers.includes(tier)), defaultReasoningEffort: tierOf(String(fallback?.value ?? info.reasoningEffort ?? "")) ?? undefined, effortSource: "host" as const } : {}),
        };
      });
      return this.catalog;
    }
    if (this.spec.id === "opencode") {
      this.catalog = opencodeCatalog(this.bin);
      return this.catalog;
    }
    this.catalog = [];
    return this.catalog;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async listSessions(cwd?: string) {
    await this.start({ workspaceRoot: cwd });
    if (!this.capability(["sessionCapabilities", "list"])) return { sessions: [] };
    const result = await this.requireConn().request<Json>("session/list", cwd ? { cwd } : {}, 20000);
    const rows = Array.isArray(result.sessions) ? result.sessions as Json[] : [];
    return {
      sessions: rows
        .filter((row) => !cwd || !row.cwd || row.cwd === cwd)
        .map((row) => ({ sessionId: String(row.sessionId), name: str(row.title) ?? null, workspaceRoot: str(row.cwd) ?? cwd ?? null, updatedAt: str(row.updatedAt) ?? (typeof row.lastChangeUnixMs === "number" ? new Date(row.lastChangeUnixMs).toISOString() : undefined), status: "idle" })),
    };
  }

  private track(sessionId: string, cwd: string, config: AcpConfigOption[]) {
    const session: SessionState = { cwd, turnId: "history", counter: 0, stream: null, tools: new Map(), config, prompting: false, lastActivity: Date.now() };
    this.sessions.set(sessionId, session);
    return session;
  }

  private configFrom(result: Json): AcpConfigOption[] {
    if (Array.isArray(result.configOptions)) return result.configOptions as AcpConfigOption[];
    // Older ACP agents report `models`/`modes` instead of config options.
    const config: AcpConfigOption[] = [];
    const models = asRecord(result.models);
    if (Array.isArray(models.availableModels)) config.push({ id: "model", category: "model", currentValue: str(models.currentModelId), options: (models.availableModels as Json[]).map((row) => ({ value: String(row.modelId), name: str(row.name) })) });
    const modes = asRecord(result.modes);
    if (Array.isArray(modes.availableModes)) config.push({ id: "mode", category: "mode", currentValue: str(modes.currentModeId), options: (modes.availableModes as Json[]).map((row) => ({ value: String(row.id), name: str(row.name), description: str(row.description) })) });
    return config;
  }

  private sessionConfig(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const pick = (category: string) => session?.config.find((item) => item.category === category);
    return {
      modelId: pick("model")?.currentValue,
      effort: tierOf(pick("thought_level")?.currentValue ?? "") ?? undefined,
      mode: pick("mode")?.currentValue,
      modes: pick("mode")?.options ?? [],
    };
  }

  async startSession(options: { workspaceRoot: string; modelId?: string; effort?: string }) {
    await this.start({ workspaceRoot: options.workspaceRoot });
    let result: Json;
    try {
      result = await this.requireConn().request<Json>("session/new", { cwd: options.workspaceRoot, mcpServers: [] }, 60000);
    } catch (error) {
      throw new Error(this.explain(error));
    }
    const sessionId = String(result.sessionId);
    this.track(sessionId, options.workspaceRoot, this.configFrom(result));
    const current = this.sessionConfig(sessionId).modelId;
    const fallback = this.spec.id === "opencode" ? fallbackOpencodeModel(await this.loadCatalog(), options.modelId ?? current, this.blocked) : undefined;
    const target = fallback ?? options.modelId;
    if (target && target !== current) {
      try { await this.setModel({ sessionId, modelId: target }); }
      catch (error) {
        this.emit("agentNotice", { sessionId, level: "warning", message: `Couldn't switch to ${target}: ${this.explain(error)} Using ${this.sessionConfig(sessionId).modelId ?? "the agent default"}.` });
      }
    }
    if (options.effort) await this.setEffort(sessionId, options.effort).catch(() => {});
    const config = this.sessionConfig(sessionId);
    return { sessionId, opening: { result: { session: { sessionId, workspaceRoot: options.workspaceRoot, modelId: config.modelId ?? null, providerId: config.modelId?.includes("/") ? config.modelId.split("/")[0] : this.spec.id } } }, agentConfig: config };
  }

  async resumeSession(options: { sessionId: string; workspaceRoot: string }) {
    await this.start({ workspaceRoot: options.workspaceRoot });
    if (this.sessions.has(options.sessionId)) return { sessionId: options.sessionId, alreadyOpen: true, agentConfig: this.sessionConfig(options.sessionId) };
    const session = this.track(options.sessionId, options.workspaceRoot, []);
    let result: Json;
    try {
      if (this.capability(["loadSession"])) {
        result = await this.requireConn().request<Json>("session/load", { sessionId: options.sessionId, cwd: options.workspaceRoot, mcpServers: [] }, 120000);
      } else if (this.capability(["sessionCapabilities", "resume"])) {
        result = await this.requireConn().request<Json>("session/resume", { sessionId: options.sessionId, cwd: options.workspaceRoot, mcpServers: [] }, 60000);
      } else throw new Error(`${this.spec.name} can't reopen past sessions.`);
    } catch (error) {
      this.sessions.delete(options.sessionId);
      throw new Error(this.explain(error));
    }
    this.closeStream(options.sessionId, session);
    session.config = this.configFrom(asRecord(result));
    session.turnId = "idle";
    const config = this.sessionConfig(options.sessionId);
    return { sessionId: options.sessionId, alreadyOpen: false, opening: { result: { session: { sessionId: options.sessionId, workspaceRoot: options.workspaceRoot, modelId: config.modelId ?? null } } }, agentConfig: config };
  }

  async setOption(sessionId: string, configId: string, value: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session is not open.");
    const result = await this.requireConn().request<Json>("session/set_config_option", { sessionId, configId, value }, 30000);
    if (Array.isArray(result?.configOptions)) session.config = result.configOptions as AcpConfigOption[];
    else session.config = session.config.map((item) => item.id === configId ? { ...item, currentValue: value } : item);
    this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
    return { status: "accepted", agentConfig: this.sessionConfig(sessionId) };
  }

  async setModel(options: { sessionId: string; modelId: string }) {
    const session = this.sessions.get(options.sessionId);
    const option = session?.config.find((item) => item.category === "model");
    if (option) return this.setOption(options.sessionId, option.id, options.modelId);
    await this.requireConn().request("session/set_model", { sessionId: options.sessionId, modelId: options.modelId }, 30000);
    return { status: "accepted" };
  }

  async setEffort(sessionId: string, effort: string) {
    const option = this.sessions.get(sessionId)?.config.find((item) => item.category === "thought_level");
    if (!option) return { status: "unsupported" };
    const match = option.options?.find((item) => tierOf(item.value) === effort);
    if (!match || match.value === option.currentValue) return { status: "accepted" };
    return this.setOption(sessionId, option.id, match.value);
  }

  async setMode(sessionId: string, mode: string) {
    const option = this.sessions.get(sessionId)?.config.find((item) => item.category === "mode");
    if (option) return this.setOption(sessionId, option.id, mode);
    await this.requireConn().request("session/set_mode", { sessionId, modeId: mode }, 30000);
    return { status: "accepted" };
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  async sendTurn(options: { sessionId: string; text: string; reasoningEffort?: string; images?: Array<{ mediaType: string; base64Data: string }> }) {
    const session = this.sessions.get(options.sessionId);
    if (!session) throw new Error("Session is not open. Reopen the thread.");
    if (session.prompting) throw new Error(`${this.spec.name} is still working on the previous message.`);
    if (this.spec.id === "opencode") {
      const current = this.sessionConfig(options.sessionId).modelId;
      const fallback = fallbackOpencodeModel(await this.loadCatalog(), current, this.blocked);
      if (fallback && fallback !== current) {
        this.emit("agentNotice", { sessionId: options.sessionId, level: "info", message: `${current ?? "This Free model"} isn't usable on this OpenCode account. Switching to ${fallback}.` });
        try { await this.setModel({ sessionId: options.sessionId, modelId: fallback }); }
        catch { /* send on the current model */ }
      }
    }
    if (options.reasoningEffort) await this.setEffort(options.sessionId, options.reasoningEffort).catch(() => {});
    const turnId = `turn-${Date.now().toString(36)}-${++this.turnSeq}`;
    this.closeStream(options.sessionId, session);
    session.turnId = turnId;
    session.prompting = true;
    session.lastActivity = Date.now();
    this.emit("item", { sessionId: options.sessionId, item: { itemId: `${turnId}:user`, kind: "userMessage", status: "completed", text: options.text, turnId } });
    const prompt: Json[] = [];
    if (options.text.trim()) prompt.push({ type: "text", text: options.text });
    const images = asRecord(asRecord(this.init.agentCapabilities).promptCapabilities).image === true;
    for (const image of options.images ?? []) if (images) prompt.push({ type: "image", mimeType: image.mediaType, data: image.base64Data });
    this.watch(options.sessionId, session);
    this.requireConn().request<Json>("session/prompt", { sessionId: options.sessionId, prompt })
      .then((result) => {
        if (session.fatal) {
          this.completeTurn(options.sessionId, { kind: "failed", params: { terminal: "failed", error: { message: session.fatal } } });
          return;
        }
        const stop = str(result?.stopReason) ?? "end_turn";
        if (stop === "cancelled") this.completeTurn(options.sessionId, { kind: "completed", params: { terminal: "cancelled" } });
        else if (stop === "refusal") this.completeTurn(options.sessionId, { kind: "failed", params: { terminal: "failed", error: { message: `${this.spec.name} declined this request.` } } });
        else this.completeTurn(options.sessionId, { kind: "completed", params: { terminal: "completed", reason: stop } });
      })
      .catch((error) => this.completeTurn(options.sessionId, { kind: "failed", params: { terminal: "failed", error: { message: session.fatal ?? this.explain(error) } } }));
    return { turnId };
  }

  private completeTurn(sessionId: string, outcome: Json) {
    const session = this.sessions.get(sessionId);
    if (!session?.prompting) return;
    if (session.watchdog) clearInterval(session.watchdog);
    if (session.failTimer) clearTimeout(session.failTimer);
    session.watchdog = undefined;
    session.failTimer = undefined;
    session.prompting = false;
    this.closeStream(sessionId, session);
    for (const tool of session.tools.values()) {
      if (tool.item.status === "inProgress") this.emitTool(sessionId, tool, { status: outcome.kind === "completed" ? "completed" : "cancelled" });
    }
    this.emit("agentNotice", { sessionId, message: null });
    this.emit("turnCompleted", { sessionId, turnId: session.turnId, outcome });
  }

  /** Cancel a hanging prompt and fail the turn when the provider will not recover. */
  private failTurn(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.prompting || session.fatal) return;
    session.fatal = message;
    try { this.requireConn().notify("session/cancel", { sessionId }); } catch { /* agent already gone */ }
    if (session.failTimer) clearTimeout(session.failTimer);
    session.failTimer = setTimeout(() => {
      session.failTimer = undefined;
      if (this.sessions.get(sessionId)?.fatal === message) {
        this.completeTurn(sessionId, { kind: "failed", params: { terminal: "failed", error: { message } } });
      }
    }, 1500);
    session.failTimer.unref?.();
  }

  async cancelTurn(options: { sessionId: string }) {
    for (const [id, approval] of this.approvals) {
      if (approval.sessionId !== options.sessionId) continue;
      approval.resolve(null);
      this.approvals.delete(id);
    }
    const session = this.sessions.get(options.sessionId);
    try { this.requireConn().notify("session/cancel", { sessionId: options.sessionId }); }
    catch { return { status: "requested" as const }; }
    const deadline = Date.now() + CANCEL_WAIT_MS;
    while (session?.prompting && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!session?.prompting) return { status: "terminal" as const };
    await this.stop();
    return { status: "terminal" as const, escalated: true };
  }

  decideApproval(options: { approvalId: string; choiceId: string }) {
    const approval = this.approvals.get(options.approvalId);
    if (!approval) throw new Error("No pending approval with that id.");
    if (!approvalAlive(approval.expiresAt)) {
      this.approvals.delete(options.approvalId);
      approval.resolve(null);
      this.emit("approvalAudit", { approvalId: options.approvalId, sessionId: approval.sessionId, turnId: approval.turnId ?? null, choiceId: options.choiceId, outcome: "expired" });
      throw new Error("This approval expired. Re-run the turn to request it again.");
    }
    if (!approval.choices.has(options.choiceId)) throw new Error("That approval choice is not available.");
    this.approvals.delete(options.approvalId);
    approval.resolve(options.choiceId);
    this.emit("approvalAudit", { approvalId: options.approvalId, sessionId: approval.sessionId, turnId: approval.turnId ?? null, choiceId: options.choiceId, outcome: "decided" });
    return { decided: true };
  }

  ownsApproval(approvalId: string) { return this.approvals.has(approvalId); }

  /** Surfaces silent retries: no update for a while, plus opencode's own error log. */
  private watch(sessionId: string, session: SessionState) {
    if (session.watchdog) clearInterval(session.watchdog);
    session.logCursor = this.spec.id === "opencode" ? openLogCursor() : undefined;
    session.fatal = undefined;
    let noticed = false;
    let last = "";
    session.watchdog = setInterval(() => {
      if (session.fatal || !session.prompting) return;
      const logged = session.logCursor ? readOpencodeErrors(session.logCursor, sessionId) : null;
      if (logged) {
        noticed = true;
        if (logged === last) return;
        last = logged;
        const detail = this.explain(new Error(logged));
        if (fatalProviderError(logged)) {
          this.emit("agentNotice", { sessionId, level: "warning", message: detail });
          this.failTurn(sessionId, detail);
          return;
        }
        this.emit("agentNotice", { sessionId, level: "warning", message: `${detail} ${this.spec.name} is retrying automatically; Stop to cancel.` });
        return;
      }
      const idle = Date.now() - session.lastActivity;
      if (!noticed && idle > STALL_MS) {
        noticed = true;
        this.emit("agentNotice", { sessionId, level: "info", message: `Waiting on ${this.spec.name}… the provider may be busy or retrying.` });
      }
      if (this.spec.id === "opencode" && idle > STALL_FAIL_MS) {
        this.failTurn(sessionId, "OpenCode didn't respond. Zen free models are often rate-limited and paid models need credits. Switch the agent to Grok.");
      }
    }, 2000);
  }

  // ─── Agent → client ───────────────────────────────────────────────────────

  private async onRequest(method: string, params: Json): Promise<unknown> {
    if (method === "session/request_permission") {
      const sessionId = String(params.sessionId ?? "");
      const session = this.sessions.get(sessionId);
      const toolCall = asRecord(params.toolCall);
      const options = Array.isArray(params.options) ? params.options as Json[] : [];
      const choices = new Set(options.map((option) => String(option.optionId ?? "")).filter(Boolean));
      const approvalId = randomUUID();
      const choice = await new Promise<string | null>((resolve) => {
        this.approvals.set(approvalId, { sessionId, turnId: session?.turnId, choices, expiresAt: approvalExpiry(), resolve });
        this.emit("approval", {
          approvalId,
          sessionId,
          turnId: session?.turnId ?? "",
          toolName: str(toolCall.title) ?? str(toolCall.kind) ?? "Tool",
          rawArgs: JSON.stringify(toolCall.rawInput ?? {}),
          subject: { kind: str(toolCall.kind) ?? "tool" },
          availableChoices: options.map((option) => {
            const kind = String(option.kind ?? "");
            return { choiceId: String(option.optionId), label: str(option.name) ?? kind, decision: kind.startsWith("allow") ? "approved" : "denied", scope: kind.endsWith("always") ? "session" : "once" };
          }),
        });
      });
      return choice ? { outcome: { outcome: "selected", optionId: choice } } : { outcome: { outcome: "cancelled" } };
    }
    throw new RpcError(`Method not found: ${method}`, -32601);
  }

  private onNotification(method: string, params: Json) {
    if (method !== "session/update") return;
    const sessionId = String(params.sessionId ?? "");
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivity = Date.now();
    const update = asRecord(params.update);
    const kind = String(update.sessionUpdate ?? "");
    switch (kind) {
      case "user_message_chunk": return this.chunk(sessionId, session, "userMessage", update);
      case "agent_message_chunk": return this.chunk(sessionId, session, "agentMessage", update);
      case "agent_thought_chunk": return this.chunk(sessionId, session, "reasoning", update);
      case "tool_call":
      case "tool_call_update": return this.tool(sessionId, session, update);
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries as Json[] : [];
        const plan = entries.map((entry, index) => ({ id: `plan-${index}`, text: String(entry.content ?? ""), status: entry.status === "in_progress" ? "inProgress" : entry.status === "completed" ? "completed" : "pending" }));
        this.emit("sessionFacts", { sessionId, plan });
        return;
      }
      case "session_info_update":
        if (str(update.title)) this.emit("sessionTitle", { sessionId, title: update.title });
        return;
      case "usage_update": {
        const used = typeof update.used === "number" ? update.used : undefined;
        const size = typeof update.size === "number" ? update.size : undefined;
        if (used != null && size) this.emit("sessionFacts", { sessionId, context: { usedTokens: used, windowTokens: size } });
        return;
      }
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          session.config = update.configOptions as AcpConfigOption[];
          this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
        }
        return;
      case "current_mode_update":
        session.config = session.config.map((item) => item.category === "mode" ? { ...item, currentValue: str(update.currentModeId) ?? item.currentValue } : item);
        this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
        return;
      default:
        return;
    }
  }

  private chunk(sessionId: string, session: SessionState, kind: Stream["kind"], update: Json) {
    const content = asRecord(update.content);
    const text = content.type === "text" ? String(content.text ?? "") : "";
    if (!text) return;
    if (kind === "userMessage" && !session.prompting && session.stream?.kind !== "userMessage") {
      // Replayed history: every user message opens a new run.
      session.turnId = `history-${++session.counter}`;
    }
    if (session.stream?.kind !== kind) {
      this.closeStream(sessionId, session);
      const itemId = `${sessionId}:${session.turnId}:${kind}:${++session.counter}`;
      session.stream = { kind, itemId, text };
      this.emit("item", { sessionId, item: { itemId, kind, status: session.prompting ? "inProgress" : "completed", text, turnId: session.turnId } });
      return;
    }
    session.stream.text += text;
    this.emit("delta", { sessionId, itemId: session.stream.itemId, field: "text", delta: text });
  }

  private closeStream(sessionId: string, session: SessionState) {
    const stream = session.stream;
    if (!stream) return;
    session.stream = null;
    this.emit("item", { sessionId, item: { itemId: stream.itemId, kind: stream.kind, status: "completed", text: stream.text, turnId: session.turnId } });
  }

  private tool(sessionId: string, session: SessionState, update: Json) {
    this.closeStream(sessionId, session);
    const id = String(update.toolCallId ?? "");
    const existing = session.tools.get(id);
    const merged: Json = { ...(existing?.item.raw as Json ?? {}), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) };
    const input = asRecord(merged.rawInput);
    const kind = String(merged.kind ?? "other").toLowerCase();
    // Plan bookkeeping tools are shown through the plan card instead.
    const hidden = kind === "think" && (Array.isArray(input.todos) || /plan|todo/i.test(String(merged.title ?? "")));
    const locations = Array.isArray(merged.locations) ? merged.locations as Json[] : [];
    const path = str(locations[0]?.path) ?? str(input.path) ?? str(input.filePath) ?? str(input.file_path) ?? str(input.target_file);
    const command = str(input.command) ?? str(input.cmd);
    const output = toolOutput(merged);
    const raw = asRecord(merged.rawOutput);
    const exit = typeof raw.exit_code === "number" ? raw.exit_code : typeof raw.exitCode === "number" ? raw.exitCode : typeof asRecord(raw.metadata).exit === "number" ? asRecord(raw.metadata).exit as number : undefined;
    const status = merged.status === "completed" ? "completed" : merged.status === "failed" ? "failed" : "inProgress";
    const tool = TOOL_NAMES[kind] ?? (str(merged.title)?.split(/[\s`]/)[0] || "tool");
    const item: Json = {
      raw: merged,
      itemId: id,
      kind: "toolCall",
      status,
      tool,
      turnId: session.turnId,
      args: JSON.stringify({ ...input, ...(path ? { path } : {}), ...(command ? { command } : {}), title: merged.title }),
      ...(command ? { commandText: command } : {}),
      ...(output ? { visibleOutput: output } : {}),
      ...(exit != null ? { exitCode: exit } : {}),
      ...(status === "failed" ? { failureReason: output || "Tool failed" } : {}),
    };
    const entry = { item, hidden };
    session.tools.set(id, entry);
    if (!hidden) this.emitTool(sessionId, entry);
  }

  private emitTool(sessionId: string, tool: Tool, patch: Json = {}) {
    Object.assign(tool.item, patch);
    if (tool.hidden) return;
    const { raw: _raw, ...item } = tool.item;
    this.emit("item", { sessionId, item });
  }
}

function toolOutput(merged: Json) {
  const content = Array.isArray(merged.content) ? merged.content as Json[] : [];
  const parts = content.map((entry) => {
    if (entry.type === "diff") return `--- ${String(entry.path ?? "")}\n${String(entry.newText ?? "")}`.slice(0, 4000);
    const inner = asRecord(entry.content);
    return inner.type === "text" ? String(inner.text ?? "") : "";
  }).filter(Boolean);
  if (parts.length) return parts.join("\n").slice(0, 20000);
  const raw = asRecord(merged.rawOutput);
  const text = str(raw.output_for_prompt) ?? str(raw.output) ?? str(raw.stdout);
  return text?.slice(0, 20000);
}

// ─── opencode helpers ───────────────────────────────────────────────────────

const OPENCODE_LOG_DIR = join(homedir(), ".local", "share", "opencode", "log");

function newestLog(): string | null {
  try {
    const files = readdirSync(OPENCODE_LOG_DIR).filter((name) => name.endsWith(".log")).map((name) => join(OPENCODE_LOG_DIR, name));
    return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch {
    return null;
  }
}

function openLogCursor() {
  const file = newestLog();
  if (!file) return undefined;
  try { return { file, offset: statSync(file).size }; } catch { return undefined; }
}

/** Reads new lines of opencode's log and returns the latest provider error for this session. */
function readOpencodeErrors(cursor: { file: string; offset: number }, sessionId: string): string | null {
  let size: number;
  try { size = statSync(cursor.file).size; } catch { return null; }
  if (size < cursor.offset) cursor.offset = 0;
  if (size === cursor.offset) return null;
  const length = Math.min(size - cursor.offset, 512 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(cursor.file, "r");
  try { readSync(fd, buffer, 0, length, cursor.offset); } finally { closeSync(fd); }
  cursor.offset += length;
  let found: string | null = null;
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.includes(`session.id=${sessionId}`) || !line.includes("level=ERROR") || line.includes("agent=title")) continue;
    const error = line.match(/error\.error="([^"]+)"/)?.[1] ?? line.match(/message="([^"]+)"/)?.[1];
    const model = line.match(/modelID=(\S+)/)?.[1];
    if (error) found = `${model ? `${model}: ` : ""}${error.replace(/^AI_APICallError:\s*/, "")}`;
  }
  return found;
}

/** `opencode models --verbose`: the catalog with prices, limits, and effort variants. */
function opencodeCatalog(bin: string): AcpModel[] {
  let text = "";
  try {
    text = spawnSync(bin, ["models", "--verbose"], { encoding: "utf8", timeout: 20000, cwd: confinedCwd(), env: filterChildEnv(process.env, "opencode"), maxBuffer: 64 * 1024 * 1024 }).stdout ?? "";
  } catch {
    return [];
  }
  const models: AcpModel[] = [];
  for (const block of text.split(/\n(?=[a-z0-9._-]+\/\S+\n\{)/i)) {
    const brace = block.indexOf("{");
    if (brace < 0) continue;
    let row: Json;
    try { row = JSON.parse(block.slice(brace)) as Json; } catch { continue; }
    const provider = String(row.providerID ?? "");
    const cost = asRecord(row.cost);
    const limit = asRecord(row.limit);
    const variants = Object.keys(asRecord(row.variants)).map(tierOf).filter((tier): tier is string => Boolean(tier));
    const free = /-free$|:free$/.test(String(row.id)) || (cost.input === 0 && cost.output === 0);
    models.push({
      modelId: `${provider}/${String(row.id)}`,
      displayLabel: str(row.name),
      providerId: provider,
      description: free ? "Free" : null,
      contextLimit: typeof limit.context === "number" ? limit.context : null,
      cost: typeof cost.input === "number" ? { input: String(cost.input), output: String(cost.output ?? 0), currency: "USD" } : null,
      ...(variants.length ? { reasoningEfforts: TIERS.filter((tier) => variants.includes(tier)), effortSource: "host" as const } : { reasoningEfforts: [] }),
    });
  }
  return models;
}
