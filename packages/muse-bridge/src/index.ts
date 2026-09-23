import { diagnostics, diagnosticEvent } from "./redaction.js";
import { LineFrames, encodeFrame } from "./framing.js";
import { MuseHost } from "./host.js";
import { LoginFlow } from "./login.js";
import { AcpAgentHost } from "./acp.js";
import { agentSpec, detectAgents, resolveAgentBin } from "./agents.js";
import type { BridgeRequest, UserInputResponse } from "./protocol.js";
import { CREATE_CACHE_TTL_MS, HOST_QUEUE_LIMIT } from "./isolation.js";

diagnostics.remember(process.env);
const host = new MuseHost();
const loginFlow = new LoginFlow((event, payload) => emit(event, payload));
const acpHosts = new Map<string, AcpAgentHost>();
/** sessionId → agentId, so session-scoped calls reach the agent that owns them. */
const owners = new Map<string, string>();

function write(value: unknown) {
  try {
    process.stdout.write(encodeFrame(value));
  } catch {
    const id = (value as { id?: string })?.id;
    if (id) {
      process.stdout.write(encodeFrame({ id, ok: false, error: "Response exceeds the protocol byte limit. Request a smaller page." }));
    } else {
      process.stdout.write(encodeFrame({ type: "event", event: "bridgeExit", payload: { error: "Agent output exceeds the protocol byte limit. Reconnect to continue." } }));
      shutdown();
    }
  }
}

function emit(event: string, payload: unknown) {
  write({ type: "event", event, payload: diagnosticEvent(event, payload) });
}

function acp(agentId: string, providedBin?: string | null) {
  let agent = acpHosts.get(agentId);
  if (!agent) {
    const spec = agentSpec(agentId);
    if (spec.protocol !== "acp") throw new Error(`${spec.name} is not an ACP agent.`);
    // The native side resolves, validates, and identity-checks the binary and
    // injects its canonical path; only direct (non-Tauri) invocations fall
    // back to self-resolution here.
    const bin = providedBin || resolveAgentBin(spec);
    if (!bin) throw new Error(`${spec.name} is not installed. Install it, then choose Rescan.`);
    agent = new AcpAgentHost(spec, bin, emit);
    acpHosts.set(agentId, agent);
  }
  return agent;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Serialize a dispatch failure without flattening its structure: the
 * message stays human-readable, while an SDK `MspError` kind (found on the
 * error or its cause chain, which the host mappers preserve) and its
 * retryability ride along so the renderer can branch recovery on them.
 */
function failureOf(error: unknown): { error: string; code?: string; retryable?: boolean } {
  const message = diagnostics.text(error instanceof Error ? error.message : String(error));
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.kind === "string" && record.kind) {
      return {
        error: message,
        code: diagnostics.text(record.kind),
        ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
      };
    }
    if (typeof record.code === "string" && record.code) {
      return { error: message, code: diagnostics.text(record.code) };
    }
    current = current instanceof Error ? current.cause : record.cause;
  }
  return { error: message };
}

const queues = new Map<string, { tail: Promise<unknown>; pending: number }>();
const createCache = new Map<string, { expires: number; result: unknown }>();

function queueKey(method: string, params: Record<string, unknown>) {
  const agent = agentOf(params);
  if (["ping", "detect", "status", "listAgents", "startHost", "stopHost", "startLogin", "cancelLogin", "usage", "mcpServers"].includes(method)) {
    return `${agent}:lifecycle`;
  }
  const session = typeof params.sessionId === "string" ? params.sessionId : "";
  return session ? `${agent}:${session}` : `${agent}:lifecycle`;
}

async function enqueue<T>(key: string, deadlineMs: number | undefined, work: () => Promise<T>): Promise<T> {
  const slot = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  if (slot.pending >= HOST_QUEUE_LIMIT) {
    throw new Error("Too many requests are already in flight for this agent. Wait and retry.");
  }
  slot.pending += 1;
  const run = slot.tail.then(async () => {
    if (deadlineMs != null && Date.now() > deadlineMs) throw new Error("Request deadline expired.");
    return work();
  }) as Promise<T>;
  slot.tail = run.then(() => undefined, () => undefined);
  queues.set(key, slot);
  try {
    return await run;
  } finally {
    slot.pending -= 1;
  }
}

function replayCreate(method: string, agentId: string, params: Record<string, unknown>): unknown | undefined {
  const id = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";
  if (!id) return undefined;
  const key = `${method}:${agentId}:${id}`;
  const hit = createCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    createCache.delete(key);
    return undefined;
  }
  return hit.result;
}

function rememberCreate(method: string, agentId: string, params: Record<string, unknown>, result: unknown) {
  const id = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";
  if (!id) return;
  if (createCache.size >= 64) {
    const now = Date.now();
    for (const [key, entry] of createCache) {
      if (entry.expires < now) createCache.delete(key);
    }
    if (createCache.size >= 64) createCache.delete(createCache.keys().next().value!);
  }
  createCache.set(`${method}:${agentId}:${id}`, { expires: Date.now() + CREATE_CACHE_TTL_MS, result });
}

function agentOf(params: Record<string, unknown>) {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  const explicit = typeof params.agentId === "string" && params.agentId ? params.agentId : undefined;
  return (sessionId && owners.get(sessionId)) || explicit || "muse";
}

function claim<T extends { sessionId?: string; sessions?: Array<{ sessionId: string }> }>(agentId: string, result: T): T {
  if (result.sessionId) owners.set(result.sessionId, agentId);
  for (const session of result.sessions ?? []) owners.set(session.sessionId, agentId);
  return result;
}

async function dispatch(method: string, params: Record<string, unknown>) {
  if (typeof params.museApiKey === "string") diagnostics.remember({ museApiKey: params.museApiKey });
  const agentId = agentOf(params);
  if (agentId !== "muse") return dispatchAcp(acp(agentId, text(params.agentBin)), agentId, method, params);
  switch (method) {
    case "ping":
      return { pong: true };
    case "detect":
      return {
        ...host.detect(text(params.museBin), text(params.museApiKey), text(params.museAuthMode)),
        agents: detectAgents(text(params.museBin), text(params.museApiKey), text(params.museAuthMode)),
      };
    case "listAgents":
      return { agents: detectAgents(text(params.museBin), text(params.museApiKey), text(params.museAuthMode)) };
    case "status":
      return host.status(text(params.museBin), text(params.museApiKey), text(params.museAuthMode));
    case "startLogin":
      return loginFlow.start(text(params.museBin));
    case "cancelLogin":
      return loginFlow.cancel();
    case "usage":
      return host.readUsage();
    case "startHost":
      return host.start(text(params.museBin), text(params.museApiKey), text(params.museAuthMode), params.trustWorkspace === true, {
        noSessionLog: params.noSessionLog === true,
        disableWrite: params.disableWrite === true,
        disableShell: params.disableShell === true,
        sandboxNetwork: typeof params.sandboxNetwork === "string" ? params.sandboxNetwork : undefined,
      });
    case "stopHost":
      return host.stop();
    case "listSessions":
      return claim("muse", await host.listSessions({
        workspaceRoot: typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        updatedAfter: typeof params.updatedAfter === "string" ? params.updatedAfter : undefined,
      }) as { sessions?: Array<{ sessionId: string }> });
    case "renameSession":
      return host.renameSession({
        sessionId: String(params.sessionId ?? ""),
        name: String(params.name ?? ""),
      });
    case "listModels":
      return host.listModels(typeof params.sessionId === "string" ? params.sessionId : undefined);
    case "startSession": {
      const replayed = replayCreate("startSession", "muse", params);
      if (replayed) return replayed;
      const started = claim("muse", await host.startSession({
        workspaceRoot: String(params.workspaceRoot ?? ""),
        approvalMode: params.approvalMode as never,
        modelId: typeof params.modelId === "string" ? params.modelId : undefined,
        providerId: typeof params.providerId === "string" ? params.providerId : undefined,
      }));
      rememberCreate("startSession", "muse", params, started);
      return started;
    }
    case "resumeSession": {
      const replayed = replayCreate("resumeSession", "muse", params);
      if (replayed) return replayed;
      const resumed = claim("muse", await host.resumeSession({
        sessionId: String(params.sessionId ?? ""),
        cursor: typeof params.cursor === "string" ? params.cursor : null,
      }));
      rememberCreate("resumeSession", "muse", params, resumed);
      return resumed;
    }
    case "forkSession": {
      const replayed = replayCreate("forkSession", "muse", params);
      if (replayed) return replayed;
      const forked = claim("muse", await host.forkSession({
        sessionId: String(params.sessionId ?? ""),
        lastTurnId: typeof params.lastTurnId === "string" ? params.lastTurnId : undefined,
      }));
      rememberCreate("forkSession", "muse", params, forked);
      return forked;
    }
    case "compactSession":
      return host.compactSession({ sessionId: String(params.sessionId ?? "") });
    case "readSession":
      return host.readSession({
        sessionId: String(params.sessionId ?? ""),
        excludeItems: typeof params.excludeItems === "boolean" ? params.excludeItems : undefined,
      });
    case "pageHistory":
      return host.pageOlderHistory({
        sessionId: String(params.sessionId ?? ""),
        cursor: typeof params.cursor === "string" && params.cursor ? params.cursor : undefined,
      });
    case "listSkills":
      return host.listSkills({ sessionId: String(params.sessionId ?? "") });
    case "mcpServers":
      return host.mcpServers();
    case "userShell":
      return host.userShell({ sessionId: String(params.sessionId ?? ""), commandText: String(params.commandText ?? "") });
    case "sendTurn": {
      const ifBusy = params.ifBusy;
      if (ifBusy !== undefined && ifBusy !== "queue" && ifBusy !== "steer" && ifBusy !== "replace") {
        throw new Error("Busy disposition must be queue, steer, or replace.");
      }
      const skill = params.skill as { selector?: unknown; arguments?: unknown } | undefined;
      return host.sendTurn({
        sessionId: String(params.sessionId ?? ""),
        text: String(params.text ?? ""),
        reasoningEffort: params.reasoningEffort as never,
        images: Array.isArray(params.images) ? (params.images as never) : undefined,
        clientTurnId: typeof params.clientTurnId === "string" ? params.clientTurnId : undefined,
        ifBusy: ifBusy as "queue" | "steer" | "replace" | undefined,
        skill: skill && typeof skill.selector === "string" ? { selector: skill.selector, ...(typeof skill.arguments === "string" ? { arguments: skill.arguments } : {}) } : undefined,
      });
    }
    case "steerTurn":
      return host.steerTurn({
        sessionId: String(params.sessionId ?? ""),
        text: String(params.text ?? ""),
        reasoningEffort: params.reasoningEffort as never,
        images: Array.isArray(params.images) ? (params.images as never) : undefined,
      });
    case "unqueueTurn":
      return host.unqueueTurn({
        sessionId: String(params.sessionId ?? ""),
        turnId: String(params.turnId ?? ""),
      });
    case "cancelTurn":
      return host.cancelTurn({
        sessionId: String(params.sessionId ?? ""),
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      });
    case "respondUserInput":
      if (!params.response || typeof params.response !== "object") throw new Error("Question response is required.");
      return host.respondUserInput({
        sessionId: String(params.sessionId ?? ""),
        userInputId: String(params.userInputId ?? ""),
        response: params.response as UserInputResponse,
      });
    case "decideApproval": {
      const approvalId = String(params.approvalId ?? "");
      const owner = [...acpHosts.values()].find((agent) => agent.ownsApproval(approvalId));
      if (owner) return owner.decideApproval({ approvalId, choiceId: String(params.choiceId ?? "") });
      return host.decideApproval({ approvalId, choiceId: String(params.choiceId ?? "") });
    }
    case "setApprovalMode":
      return host.setApprovalMode({
        sessionId: String(params.sessionId ?? ""),
        mode: params.mode as never,
      });
    case "setModel":
      return host.setModel({
        sessionId: String(params.sessionId ?? ""),
        modelId: String(params.modelId ?? ""),
        providerId: typeof params.providerId === "string" ? params.providerId : undefined,
      });
    case "setReasoningEffort":
      return host.setReasoningEffort({
        sessionId: String(params.sessionId ?? ""),
        reasoningEffort: String(params.reasoningEffort ?? params.effort ?? ""),
      });
    case "subagentControl":
      return host.subagentControl({
        sessionId: String(params.sessionId ?? ""),
        subagentId: String(params.subagentId ?? ""),
        action: String(params.action ?? ""),
        body: typeof params.body === "string" ? params.body : undefined,
        reason: typeof params.reason === "string" ? params.reason : undefined,
      });
    case "taskControl":
      return host.taskControl({
        sessionId: String(params.sessionId ?? ""),
        action: String(params.action ?? ""),
        taskId: typeof params.taskId === "string" ? params.taskId : undefined,
      });
    case "workflowControl":
      return host.workflowControl({
        sessionId: String(params.sessionId ?? ""),
        workflowRunId: String(params.workflowRunId ?? ""),
        action: String(params.action ?? ""),
        childId: typeof params.childId === "string" ? params.childId : undefined,
        attempt: typeof params.attempt === "number" ? params.attempt : undefined,
      });
    case "goalControl":
      return host.goalControl({
        sessionId: String(params.sessionId ?? ""),
        action: String(params.action ?? ""),
        objective: typeof params.objective === "string" ? params.objective : undefined,
      });
    case "readOutput":
      return host.readOutput({
        sessionId: String(params.sessionId ?? ""),
        itemId: String(params.itemId ?? ""),
        outputRef: String(params.outputRef ?? ""),
        offsetBytes: typeof params.offsetBytes === "number" ? params.offsetBytes : undefined,
        lengthBytes: typeof params.lengthBytes === "number" ? params.lengthBytes : undefined,
      });
    case "setSessionOption":
      throw new Error("Muse sessions use setModel/setApprovalMode.");
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function dispatchAcp(agent: AcpAgentHost, agentId: string, method: string, params: Record<string, unknown>) {
  const sessionId = String(params.sessionId ?? "");
  switch (method) {
    case "startHost":
      await agent.start(typeof params.workspaceRoot === "string" ? { workspaceRoot: params.workspaceRoot } : undefined);
      return { started: true, agentId, isolation: agent.isolation() };
    case "stopHost":
      return agent.stop();
    case "listSessions":
      return claim(agentId, await agent.listSessions(typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined));
    case "listModels":
      return agent.listModels(sessionId || undefined);
    case "startSession": {
      const replayed = replayCreate("startSession", agentId, params);
      if (replayed) return replayed;
      const started = claim(agentId, await agent.startSession({
        workspaceRoot: String(params.workspaceRoot ?? ""),
        modelId: typeof params.modelId === "string" ? params.modelId : undefined,
        effort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
      }));
      rememberCreate("startSession", agentId, params, started);
      return started;
    }
    case "resumeSession": {
      const replayed = replayCreate("resumeSession", agentId, params);
      if (replayed) return replayed;
      const resumed = claim(agentId, await agent.resumeSession({ sessionId, workspaceRoot: String(params.workspaceRoot ?? "") }));
      rememberCreate("resumeSession", agentId, params, resumed);
      return resumed;
    }
    case "sendTurn":
      return agent.sendTurn({
        sessionId,
        text: String(params.text ?? ""),
        reasoningEffort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        images: Array.isArray(params.images) ? (params.images as never) : undefined,
      });
    case "cancelTurn":
      return agent.cancelTurn({ sessionId });
    case "steerTurn":
    case "unqueueTurn":
      throw new Error(`${agent.spec.name} does not support queued turns.`);
    case "forkSession":
    case "compactSession":
    case "readSession":
    case "pageHistory":
    case "listSkills":
    case "mcpServers":
    case "userShell":
    case "readOutput":
    case "setReasoningEffort":
    case "subagentControl":
    case "taskControl":
    case "workflowControl":
    case "goalControl":
      throw new Error(`${agent.spec.name} does not support this session operation.`);
    case "decideApproval":
      return agent.decideApproval({ approvalId: String(params.approvalId ?? ""), choiceId: String(params.choiceId ?? "") });
    case "setModel":
      return agent.setModel({ sessionId, modelId: String(params.modelId ?? "") });
    case "setSessionOption": {
      const option = String(params.option ?? "");
      const value = String(params.value ?? "");
      if (option === "effort") return agent.setEffort(sessionId, value);
      if (option === "mode") return agent.setMode(sessionId, value);
      return agent.setOption(sessionId, option, value);
    }
    case "setApprovalMode":
      throw new Error(`${agent.spec.name} controls permissions in its own configuration; Muse Desktop cannot change them for this agent.`);
    default:
      throw new Error(`${agent.spec.name} does not support ${method}.`);
  }
}

const frames = new LineFrames();
let shuttingDown = false;
process.stdin.on("data", (chunk: Buffer) => {
  if (shuttingDown) return;
  try {
    frames.push(chunk, (raw) => {
      const line = raw.trim();
      if (!line) return;
      let request: BridgeRequest;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 128
          || typeof parsed.method !== "string" || !parsed.method || parsed.method.length > 128
          || (parsed.params !== undefined && (!parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params)))) {
          throw new Error("Invalid request");
        }
        request = parsed;
      } catch {
        // Parse errors may contain credentials from the input; never echo them.
        write({ id: null, ok: false, error: "Invalid JSON request." });
        return;
      }
      const deadlineMs = typeof request.deadlineMs === "number" ? request.deadlineMs : undefined;
      const params = request.params ?? {};
      void enqueue(queueKey(request.method, params), deadlineMs, () => dispatch(request.method, params))
        .then((result) => write({ id: request.id, ok: true, result }))
        .catch((error: unknown) => write({ id: request.id, ok: false, ...failureOf(error) }));
    });
  } catch {
    write({ type: "event", event: "bridgeExit", payload: { error: "Bridge protocol frame exceeded the byte limit. Reconnect to continue." } });
    shutdown();
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdin.pause();
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref();
  void Promise.allSettled([host.stop(), ...[...acpHosts.values()].map((agent) => agent.stop())]).finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

/**
 * Last-resort crash sink: an uncaught frame reaches the host as a redacted
 * `bridgeExit` event instead of Node's raw stderr dump — which matters when
 * the bridge runs without the native stderr tap (dev, smoke scripts).
 * Node's default already crashes on unhandled rejections; this keeps that
 * semantics while routing the report through the diagnostic redactor.
 */
function crash(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  try {
    emit("bridgeExit", { error: `Bridge crashed: ${message}` });
    shutdown();
  } catch {
    // stdout or stdin is already gone; nothing safe left to do but exit.
    process.exit(1);
  }
}

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
