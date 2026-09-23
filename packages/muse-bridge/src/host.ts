import { diagnostics, DiagnosticLines, diagnosticEvent } from "./redaction.js";
import {
  MuseClient,
  spawnMspConnection,
  readSessionDurability,
  EXPECTED_SCHEMA_FINGERPRINT,
  type Session,
} from "@muse-code/sdk";
import type { SpawnedMspConnection } from "@muse-code/sdk";
import { detectMuse, museEnv, resolveMuseBin } from "./detect.js";
import { MAX_FRAME_BYTES } from "./framing.js";
import type { ApprovalMode, ReasoningEffort, UserInputResponse, UserInputRequest } from "./protocol.js";
import { observeNotifications, UserInputRelay } from "./user-input.js";
import { factsFromSession, isSessionFactNotification } from "./session-facts.js";
import { annotateEfforts, TIER_ORDER, vocabularyTiers } from "./efforts.js";
import { approvalAlive, approvalExpiry, describeIsolation, confinedCwd, wrapSandboxedCommand, type IsolationReport } from "./isolation.js";

type ApprovalWaiter = {
  resolve: (choiceId: string) => void;
  reject: (error: Error) => void;
  choices: Set<string>;
  sessionId: string;
  turnId?: string;
  expiresAt: number;
  /**
   * Restored from `approval/listPending` rather than a live `approval/requested`
   * round trip: no handler promise is parked, so deciding sends
   * `approval/decide` directly with the pulled `currentRequirementId`.
   */
  restored?: { sessionId: string; requirementId: string };
};

type HostState = {
  client: MuseClient;
  spawned: SpawnedMspConnection;
  sessions: Map<string, Session>;
  approvals: Map<string, ApprovalWaiter>;
  stopping: boolean;
  userInputs: UserInputRelay;
  env: NodeJS.ProcessEnv;
  /** Whether this host was constructed with `--trust-workspace`. */
  trusted: boolean;
  /** Sandbox posture this host was constructed with (`serve` flags). */
  posture: { ephemeralSessions: boolean; disableWrite: boolean; disableShell: boolean; sandboxNetwork: string };
};

const VERSION = "0.1.0";
/** Pinned `@muse-code/sdk` this bridge was written against; a test pins it to the installed package. */
export const BRIDGE_SDK_VERSION = "1.3.0";
/**
 * Grantable capabilities requested at `initialize`. `sessionListStream` feeds
 * live `session/listChanged` rows; `sessionMcp` marks the host MCP-ready for
 * the CLI-configured servers the Extensions view manages (per-session
 * injection waits on the SDK exposing `session/start` config). `userShell`
 * is the TUI's `!` escape hatch behind the composer's Terminal boundary.
 */
const REQUESTED_CAPABILITIES = ["sessionListStream", "sessionMcp", "userShell"];

function emit(event: string, payload: unknown) {
  process.stdout.write(
    `${JSON.stringify({ type: "event", event, payload: diagnosticEvent(event, payload) })}\n`,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function itemPayload(sessionId: string, item: unknown) {
  return { sessionId, item };
}

/** Walk an error's cause chain for an SDK `MspError` kind to branch on. */
function mspKind(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof (current as Record<string, unknown>).kind === "string" && (current as { kind: string }).kind) {
      return (current as { kind: string }).kind;
    }
    current = current instanceof Error ? current.cause : (current as Record<string, unknown>).cause;
  }
  return null;
}

/** Friendly names for fork failures: stale cut points and old CLIs. */
function forkError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/forkBoundaryInvalid/i.test(text)) {
    return new Error("That turn is still running or unknown — forks cut at completed turns only.", { cause: error });
  }
  if (/unknown method|method not found|not supported/i.test(text)) {
    return new Error("This Muse version does not support fork. Update the CLI and retry.", { cause: error });
  }
  return error instanceof Error ? error : new Error(text);
}

/** Friendly names for full-output reads: evicted output and old CLIs. */
function readOutputError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/unknown method|method not found|not supported/i.test(text)) {
    return new Error("This Muse version does not serve full tool output. Update the CLI and retry.", { cause: error });
  }
  if (/notFound|missing|noBoundary|unusable/i.test(text)) {
    return new Error("That output is no longer stored — retention may have evicted it.", { cause: error });
  }
  return error instanceof Error ? error : new Error(text);
}

/** Friendly names for standing-effort writes: bad tiers and old CLIs. */
function effortError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/unknown method|method not found|not supported/i.test(text)) {
    return new Error("This Muse version does not support a standing effort default. Update the CLI and retry.", { cause: error });
  }
  return error instanceof Error ? error : new Error(text);
}

/** Friendly names for oversight failures: stale workflow attempts and old CLIs. */
function oversightError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/unknown method|method not found|not supported/i.test(text)) {
    return new Error("This Muse version does not support agent oversight. Update the CLI and retry.", { cause: error });
  }
  if (/stale_attempt/i.test(text)) {
    return new Error("That workflow child already moved on — the timeline shows its current attempt.", { cause: error });
  }
  return error instanceof Error ? error : new Error(text);
}

/** Friendly names for compact failures: nothing to do and old CLIs. */
function compactError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/missing_run/i.test(text)) {
    return new Error("Nothing to compact yet — send a turn first.", { cause: error });
  }
  if (/unknown method|method not found|not supported/i.test(text)) {
    return new Error("This Muse version does not support manual compact. Update the CLI and retry.", { cause: error });
  }
  return error instanceof Error ? error : new Error(text);
}

/** Friendly names for submit failures: a skill that vanished since listing. */
function sendTurnError(error: unknown, selector?: string): Error {
  const text = error instanceof Error ? error.message : String(error);
  if (/skillNotFound/i.test(text) && selector) {
    return new Error(`/${selector} is no longer available — the skill list changed. Pick the skill again.`, { cause: error });
  }
  return error instanceof Error ? error : new Error(text);
}

/** Shared `turn/start` + `turn/steer` content parts; rejects empty prompts. */
function turnInputParts(text: string, images?: Array<{ mediaType: string; base64Data: string }>, skill?: { selector: string; arguments?: string }) {
  const input: Array<Record<string, unknown>> = [];
  // A skill invocation leads: the host resolves the selector and expands it,
  // with the remaining text and images riding along as context.
  if (skill) {
    if (!skill.selector.trim()) throw new Error("A skill selector is required to invoke a skill.");
    const args = (skill.arguments ?? "").trim();
    if (args.length > 100_000) throw new Error("Skill arguments are limited to 100,000 characters.");
    input.push({ type: "skill", selector: skill.selector.trim(), ...(args ? { arguments: args } : {}) });
  }
  if (text.trim()) {
    input.push({ type: "text", text });
  }
  for (const image of images ?? []) {
    input.push({
      type: "image",
      mediaType: image.mediaType,
      base64Data: image.base64Data,
    });
  }
  if (!input.length) throw new Error("Prompt is empty.");
  return input;
}

export type HostCompat = {
  sdk: string;
  pinned: string;
  served: string | null;
  state: "match" | "mismatch" | "unknown";
  granted: string[];
};

/**
 * Protocol-compatibility snapshot from the handshake. Defensive reads: older
 * or minimal hosts may omit `schema`/`grantedCapabilities`, in which case the
 * fingerprint is unknown rather than mismatched.
 */
export function compatFrom(spawned: {
  initializeResult?: unknown;
  fingerprintWarning?: unknown;
}): HostCompat {
  const result = asRecord(spawned.initializeResult);
  const schema = asRecord(result.schema);
  const served = typeof schema.fingerprint === "string" ? schema.fingerprint : null;
  const granted = Array.isArray(result.grantedCapabilities)
    ? result.grantedCapabilities.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    sdk: BRIDGE_SDK_VERSION,
    pinned: EXPECTED_SCHEMA_FINGERPRINT,
    served,
    state: spawned.fingerprintWarning || (served && served !== EXPECTED_SCHEMA_FINGERPRINT)
      ? "mismatch"
      : !served
        ? "unknown"
        : "match",
    granted,
  };
}

export class MuseHost {
  private state: HostState | null = null;
  /**
   * Idempotency keys (`sessionId + clientTurnId`) → turn creation. A retried
   * send with the same key awaits the same turn instead of starting a second
   * one; entries are dropped when the turn fails, is cancelled, or the host
   * stops, so a later retry can start a fresh turn.
   */
  private turnKeys = new Map<string, Promise<string>>();
  /**
   * `sessionId + turnId` of submits the server queued (admitted, not
   * launched). A `turn/started` for a member emits `turnStarted` so the UI
   * can promote it; `turn/unqueue` and completion settle it.
   */
  private queuedTurns = new Set<string>();
  /**
   * Outstanding `view/gap` brackets per session. The SDK splice-fills each
   * hole itself; the first later frame that finds `fold.pendingGap` cleared
   * emits `viewGapHealed`, while a fill failure arrives via `onGapError`.
   */
  private openGaps = new Map<string, { after: string; next: string }>();
  /**
   * Last `viewCursor` observed per session. View cursors are opaque relay
   * tokens; the renderer stores the latest as its resume cursor so a reopen
   * resubscribes from where its view ended instead of from scratch.
   */
  private lastCursors = new Map<string, string>();
  /** True while the running `muse serve` was launched under an OS write sandbox. */
  private hostSandboxed = false;

  private requireState(): HostState {
    if (!this.state) throw new Error("Muse host is not running. Start it from Settings or add a workspace.");
    return this.state;
  }

  async start(museBin?: string | null, museApiKey?: string | null, museAuthMode?: string | null, trustWorkspace?: boolean, posture?: { noSessionLog?: boolean; disableWrite?: boolean; disableShell?: boolean; sandboxNetwork?: string }) {
    if (this.state) {
      await this.stop();
    }
    const bin = resolveMuseBin(museBin);
    if (!bin) {
      throw new Error("Could not find the muse CLI. Install Muse Code and try again.");
    }
    const sandboxNetwork = posture?.sandboxNetwork === "restricted" || posture?.sandboxNetwork === "enabled" || posture?.sandboxNetwork === "proxy-only"
      ? posture.sandboxNetwork
      : "proxy-only";
    const effective = {
      ephemeralSessions: posture?.noSessionLog === true,
      disableWrite: posture?.disableWrite === true,
      disableShell: posture?.disableShell === true,
      sandboxNetwork,
    };

    const env = museEnv(process.env, museApiKey, museAuthMode);
    diagnostics.remember(env);
    const stderr = new DiagnosticLines((chunk) => emit("stderr", { chunk }));

    // Workspace trust is a host-construction decision (`serve
    // --trust-workspace` loads every session workspace's skills and rules),
    // so the renderer restarts the host when the selected workspace crosses
    // the trust boundary instead of mixing classes on one host.
    const trusted = trustWorkspace === true;
    const args = ["serve"];
    if (trusted) args.push("--trust-workspace");
    if (effective.ephemeralSessions) args.push("--no-session-log");
    if (effective.disableWrite) args.push("--disable-write");
    if (effective.disableShell) args.push("--disable-shell");
    if (effective.sandboxNetwork !== "proxy-only") args.push("--sandbox-network", effective.sandboxNetwork);
    const wrapped = wrapSandboxedCommand(bin, args, { kind: "muse", agentId: "muse" });
    this.hostSandboxed = wrapped.sandboxed;
    const handshake = spawnMspConnection({
      command: wrapped.command,
      args: wrapped.args,
      env,
      // Pin the SDK transport budget to this bridge's frame contract instead of
      // relying on the SDK's implicit default: an oversized inbound frame is a
      // protocol error on the same 64 MiB ceiling the stdin/ACP readers enforce.
      connection: { frameLimitBytes: MAX_FRAME_BYTES },
      onStderr: (chunk) => stderr.push(chunk),
    });

    const spawned = await handshake.initialize({
      clientInfo: {
        name: "muse_code_desktop",
        title: "Muse Code Desktop",
        version: VERSION,
      },
      capabilities: { requestedCapabilities: [...REQUESTED_CAPABILITIES] },
    });

    const userInputs = new UserInputRelay((sessionId, requests) => {
      if (this.state?.spawned === spawned) emit("userInputs", { sessionId, requests });
    });
    const onNotification = (notification: { method: string; jsonrpc?: string; params?: { sessionId?: string; viewCursor?: string } }) => {
      userInputs.notify(notification as never);
      const cursorSession = notification.params?.sessionId;
      const cursor = notification.params?.viewCursor;
      if (this.state?.spawned === spawned && typeof cursorSession === "string" && typeof cursor === "string" && cursor) {
        this.lastCursors.set(cursorSession, cursor);
      }
      // Gap healing: this observer runs after the SDK routes the frame, so
      // `fold.pendingGap` is current — the first frame past a marked hole
      // whose fold shows no pending gap proves the splice-fill landed.
      if (notification.method !== "view/gap" && this.state?.spawned === spawned) {
        const sid = notification.params?.sessionId;
        const bracket = typeof sid === "string" ? this.openGaps.get(sid) : undefined;
        if (sid && bracket && !this.state.sessions.get(sid)?.fold?.pendingGap) {
          this.openGaps.delete(sid);
          emit("viewGapHealed", { sessionId: sid, ...bracket });
        }
      }
      if (notification.method === "turn/retryScheduled") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.turnId === "string" && this.state?.spawned === spawned) {
          emit("turnRetry", {
            sessionId: params.sessionId,
            turnId: params.turnId,
            ...(typeof params.attempt === "number" ? { attempt: params.attempt } : {}),
            ...(typeof params.maxAttempts === "number" ? { maxAttempts: params.maxAttempts } : {}),
            ...(typeof params.nextAttempt === "number" ? { nextAttempt: params.nextAttempt } : {}),
            ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
            ...(typeof params.retryDelayMs === "number" ? { retryDelayMs: params.retryDelayMs } : {}),
          });
        }
        return;
      }
      if (notification.method === "session/viewHealthChanged") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.health === "string" && this.state?.spawned === spawned) {
          emit("viewHealth", {
            sessionId: params.sessionId,
            health: params.health,
            ...(typeof params.noneReason === "string" ? { noneReason: params.noneReason } : {}),
          });
        }
        return;
      }
      if (notification.method === "view/gap") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.after === "string" && typeof params.next === "string" && this.state?.spawned === spawned) {
          this.openGaps.set(params.sessionId, { after: params.after, next: params.next });
          emit("viewGap", { sessionId: params.sessionId, after: params.after, next: params.next });
        }
        return;
      }
      if (notification.method === "skill/changed") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && this.state?.spawned === spawned) {
          emit("skillChanged", { sessionId: params.sessionId });
        }
        return;
      }
      if (notification.method === "usage/changed") {
        if (this.state?.spawned === spawned) emit("usageChanged", notification.params ?? {});
        return;
      }
      // Host-side credential changes (a TUI login/logout beside us): the
      // renderer re-detects auth instead of trusting stale state.
      if (notification.method === "account/changed" || notification.method === "account/loginCompleted") {
        if (this.state?.spawned === spawned) emit("accountChanged", {});
        return;
      }
      // Session-truth stream: replace-wholesale row/name/status/model facts the
      // renderer applies to its threads (tdd SS2.4/SS4.6). `session/listChanged`
      // only arrives because we negotiate `sessionListStream` at initialize.
      if (notification.method === "session/nameChanged") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.name === "string" && this.state?.spawned === spawned) {
          emit("sessionName", { sessionId: params.sessionId, name: params.name });
        }
        return;
      }
      if (notification.method === "session/listChanged") {
        const session = asRecord(asRecord(notification.params).session);
        if (typeof session.sessionId === "string" && this.state?.spawned === spawned) {
          emit("sessionRow", { session });
        }
        return;
      }
      if (notification.method === "session/statusChanged") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.status === "string" && this.state?.spawned === spawned) {
          emit("sessionStatus", { sessionId: params.sessionId, status: params.status });
        }
        return;
      }
      if (notification.method === "session/modelChanged") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.modelId === "string" && this.state?.spawned === spawned) {
          emit("sessionModel", { sessionId: params.sessionId, modelId: params.modelId, ...(typeof params.providerId === "string" ? { providerId: params.providerId } : {}) });
        }
        // Intentional fall-through: modelChanged is also a folded fact, so the
        // sessionFacts refresh below fires for it like every SS4.6 sibling.
      }
      if (notification.method === "session/approvalModeChanged") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.mode === "string" && this.state?.spawned === spawned) {
          emit("sessionApprovalMode", { sessionId: params.sessionId, mode: params.mode });
        }
        return;
      }
      if (notification.method === "session/reasoningEffortChanged") {
        const params = asRecord(notification.params);
        if (typeof params.sessionId === "string" && typeof params.reasoningEffort === "string" && this.state?.spawned === spawned) {
          emit("sessionEffort", { sessionId: params.sessionId, effort: params.reasoningEffort });
        }
        return;
      }
      if (notification.method === "turn/started") {
        // Launch boundary for a previously queued submit: fresh turns are
        // already running in the UI, so only queued launches are emitted.
        const params = asRecord(notification.params);
        const sid = params.sessionId;
        const tid = params.turnId;
        if (typeof sid === "string" && typeof tid === "string" && this.state?.spawned === spawned) {
          if (this.queuedTurns.delete(`${sid} ${tid}`)) emit("turnStarted", { sessionId: sid, turnId: tid });
        }
        return;
      }
      if (notification.method === "approval/updated") {
        const params = asRecord(notification.params);
        const waiter = typeof params.approvalId === "string" ? this.state?.approvals.get(params.approvalId) : undefined;
        if (waiter && typeof params.currentRequirementId === "string") {
          // Choice rotation applies to live waiters too (their pre-validation
          // set would otherwise go stale); only restored waiters carry a
          // requirement guard to refresh.
          if (Array.isArray(params.availableChoices)) {
            waiter.choices = new Set(params.availableChoices.map((choice) => String(asRecord(choice).choiceId)));
          }
          if (waiter.restored) waiter.restored.requirementId = params.currentRequirementId;
          if (this.state?.spawned === spawned) emit("approvalUpdated", { approvalId: params.approvalId, sessionId: params.sessionId, availableChoices: params.availableChoices ?? [] });
        }
        return;
      }
      // Workflows and subagents outlive the turn that launched them, and the per-turn item stream
      // stops at turn end, so forward their updates straight from the session notifications.
      if (notification.method === "item/started" || notification.method === "item/updated" || notification.method === "item/completed") {
        const params = notification.params as { sessionId?: string; item?: { kind?: string } } | undefined;
        if (params?.sessionId && (params.item?.kind === "workflow" || params.item?.kind === "subagent") && this.state?.spawned === spawned) {
          emit("item", itemPayload(params.sessionId, params.item));
        }
        return;
      }
      if (!isSessionFactNotification(notification.method)) return;
      const sessionId = notification.params?.sessionId;
      const session = sessionId ? this.state?.sessions.get(sessionId) : undefined;
      if (session && this.state?.spawned === spawned) emit("sessionFacts", factsFromSession(session));
    };
    const client = new MuseClient(observeNotifications(spawned.connection, onNotification), {
      durability: readSessionDurability(spawned.initializeResult),
      host: spawned,
    });

    const state: HostState = {
      client,
      spawned,
      sessions: new Map(),
      approvals: new Map(),
      stopping: false,
      userInputs,
      env,
      trusted,
      posture: effective,
    };
    this.state = state;
    void spawned.child.exit.then((exit) => {
      stderr.end();
      if (!state.stopping && this.state === state) {
        this.state = null;
        emit("hostExit", exit);
      }
    });

    return {
      server: spawned.initializeResult.serverInfo,
      museHome: spawned.initializeResult.museHome,
      durability: spawned.initializeResult.sessionDurability ?? "durable",
      bin,
      activeAuth: env.META_API_KEY ? "apiKey" : "subscription",
      trustWorkspace: trusted,
      posture: effective,
      compat: compatFrom(spawned),
      isolation: this.isolation(),
    };
  }

  isolation(): IsolationReport {
    return describeIsolation(confinedCwd(), Boolean(this.state) && this.hostSandboxed);
  }

  async stop() {
    const current = this.state;
    this.state = null;
    this.turnKeys.clear();
    this.openGaps.clear();
    this.lastCursors.clear();
    if (!current) return { stopped: true };
    current.stopping = true;
    emit("hostStopping", {});
    for (const waiter of current.approvals.values()) {
      waiter.reject(new Error("Host stopped"));
    }
    current.approvals.clear();
    current.sessions.clear();
    await current.client.close();
    return { stopped: true };
  }

  private wireSession(session: Session) {
    const state = this.requireState();
    state.sessions.set(session.sessionId, session);

    session.onApproval(async (request) => {
      if (state.stopping || this.state !== state) throw new Error("Host stopped");
      // The renderer shows the same deadline the waiter enforces.
      const expiresAt = approvalExpiry();
      emit("approval", { ...request, expiresAt });
      const sessionId = String((request as { sessionId?: string }).sessionId ?? session.sessionId);
      const turnId = typeof (request as { turnId?: string }).turnId === "string" ? (request as { turnId: string }).turnId : undefined;
      const choiceId = await new Promise<string>((resolve, reject) => {
        const choices = new Set((request.availableChoices ?? []).map((choice: { choiceId: string }) => String(choice.choiceId)));
        state.approvals.set(request.approvalId, { resolve, reject, choices, sessionId, turnId, expiresAt });
      });
      return { choiceId };
    });

    session.onApprovalError((failure) => {
      const waiter = state.approvals.get(failure.approvalId);
      state.approvals.delete(failure.approvalId);
      waiter?.reject(new Error("error" in failure ? String(failure.error) : "Approval could not be delivered"));
      if (state.stopping || this.state !== state) return;
      emit("approvalError", { ...failure, sessionId: session.sessionId, ...("error" in failure ? { error: String(failure.error) } : {}) });
      // A failed decide may never have landed on the host, and the SDK latches
      // the stage permanently — a re-issued request is never re-answered. The
      // restored decide path bypasses that latch, so re-pull pending: still
      // pending comes back as a restorable approval, resolved stays cleared.
      void this.refreshPending(state, session.sessionId).catch(() => {});
    });

    session.onGapError((failure) => {
      if (state.stopping || this.state !== state) return;
      this.openGaps.delete(session.sessionId);
      // `MuseGapFillError` names the failed hole exactly (reason + opaque
      // bounds); anything else degrades to the message alone.
      const record = failure && typeof failure === "object" ? (failure as unknown as Record<string, unknown>) : {};
      emit("gapError", {
        sessionId: session.sessionId,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
        ...(typeof record.after === "string" ? { after: record.after } : {}),
        ...(typeof record.next === "string" ? { next: record.next } : {}),
        error: failure instanceof Error ? failure.message : String(failure),
      });
    });

    return session;
  }

  private async consumeTurn(session: Session, turnId: string) {
    const state = this.requireState();
    // Retired hosts must not overwrite state belonging to a reconnected session.
    const send = (event: string, payload: unknown) => {
      if (this.state === state && !state.stopping) emit(event, payload);
    };
    const turn = session.turn(turnId);
    void (async () => {
      try {
        for await (const item of turn.items()) {
          send("item", itemPayload(session.sessionId, item));
        }
      } catch (error) {
        const kind = mspKind(error);
        send("turnError", { sessionId: session.sessionId, turnId, error: error instanceof Error ? error.message : String(error), ...(kind ? { code: kind } : {}) });
      }
    })();
    void (async () => {
      try {
        for await (const delta of turn.deltas()) {
          send("delta", { sessionId: session.sessionId, itemId: delta.itemId, field: delta.field, delta: delta.delta });
        }
      } catch {
        /* iterator ends with the turn */
      }
    })();
    void turn.completed
      .then((outcome) => {
        const viewCursor = this.lastCursors.get(session.sessionId);
        send("turnCompleted", { sessionId: session.sessionId, turnId, outcome, ...(viewCursor ? { viewCursor } : {}) });
      })
      .catch((error) => {
        send("turnError", { sessionId: session.sessionId, turnId, error: String(error) });
      });
  }

  async listSessions(options: { workspaceRoot?: string; cursor?: string | null; limit?: number; updatedAfter?: string } = {}) {
    const { spawned } = this.requireState();
    // Schema default 50, max 200 (#22785 E6c); the desktop pages with 200.
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100) || 100));
    const params: Record<string, unknown> = { limit };
    if (options.workspaceRoot) params.workspaceRoot = options.workspaceRoot;
    if (options.updatedAfter) params.updatedAfter = options.updatedAfter;
    if (options.cursor) params.cursor = options.cursor;
    return spawned.connection.request("session/list", params);
  }

  /**
   * Durable rename via `session/rename` (SS2.14.2). Returns the host result;
   * `name` is the canonical settled name (absent on the `RecoveryPending` arm,
   * which delivers it later via `session/nameChanged`).
   */
  async renameSession(options: { sessionId: string; name: string }) {
    const { spawned } = this.requireState();
    const name = options.name.replace(/\s+/g, " ").trim();
    if (!options.sessionId) throw new Error("A session id is required to rename.");
    if (!name) throw new Error("A new name is required to rename.");
    if (name.length > 120) throw new Error("Names are limited to 120 characters.");
    const commandId = spawned.connection.mintCommandId();
    try {
      return await spawned.connection.command(
        "session/rename",
        { commandId, sessionId: options.sessionId, name },
        { commandId },
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/unknown method|method not found|not supported/i.test(text)) {
        throw new Error("This Muse version does not support durable rename. Update the CLI and retry.");
      }
      throw error instanceof Error ? error : new Error(text);
    }
  }

  /**
   * Ad-hoc shell command in the session's workspace (`session/userShell`,
   * SS3.9): the TUI's `!` escape hatch. Admission is immediate; the command
   * runs off the command worker and its output arrives as the `userShell`
   * item's terminal view event (not turn-scoped).
   */
  async userShell(options: { sessionId: string; commandText: string }) {
    const { spawned } = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to run a shell command.");
    const commandText = options.commandText.trim();
    if (!commandText) throw new Error("A command is required to run a shell command.");
    if (commandText.length > 100_000) throw new Error("Shell commands are limited to 100,000 characters.");
    const commandId = spawned.connection.mintCommandId();
    try {
      return await spawned.connection.command(
        "session/userShell",
        { commandId, sessionId: options.sessionId, commandText },
        { commandId },
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/unknown method|method not found|not supported/i.test(text)) {
        throw new Error("This Muse version does not run user shells. Update the CLI and retry.");
      }
      throw error instanceof Error ? error : new Error(text);
    }
  }

  async listModels(sessionId?: string) {
    const { spawned, env } = this.requireState();
    const params: Record<string, unknown> = {};
    if (sessionId) params.sessionId = sessionId;
    const result = await spawned.connection.request("model/list", params) as { models?: unknown[] };
    return annotateEfforts(result, env);
  }

  async startSession(options: {
    workspaceRoot: string;
    approvalMode?: ApprovalMode;
    modelId?: string;
    providerId?: string;
  }) {
    const { client } = this.requireState();
    const session = await client.startSession({
      workspaceRoot: options.workspaceRoot,
      approvalMode: options.approvalMode,
      modelId: options.modelId,
      providerId: options.providerId,
    });
    this.wireSession(session);
    emit("sessionFacts", factsFromSession(session));
    const opening = session.opening;
    return {
      sessionId: session.sessionId,
      opening,
      facts: factsFromSession(session),
    };
  }

  /**
   * Fold one newest-first history chunk (`view/page` backward, up to 5 ×
   * 1000 events) into latest-revision items, oldest first. Newer chunks
   * always win: the fold keeps the highest numeric revision, so a stale
   * re-emission inside a page can never clobber a newer copy, and the
   * renderer merges older chunks with existing items winning.
   */
  private async pageHistory(state: HostState, sessionId: string, cursor?: string | null): Promise<{ items: unknown[]; nextCursor: string | null; exhausted: boolean } | null> {
    const items = new Map<string, { revision: number; item: unknown }>();
    let at: string | null = cursor ?? null;
    try {
      for (let page = 0; page < 5; page += 1) {
        const result = await state.spawned.connection.request("view/page", { sessionId, limit: 1000, direction: "backward", ...(at ? { cursor: at } : {}) }) as { events?: Array<{ method?: string; params?: { item?: { itemId?: string; revision?: number } } }>; nextCursor?: string | null };
        for (const event of result.events ?? []) {
          const item = event.params?.item;
          if ((event.method === "item/started" || event.method === "item/updated" || event.method === "item/completed") && item?.itemId) {
            const revision = typeof item.revision === "number" ? item.revision : 0;
            if ((items.get(item.itemId)?.revision ?? -1) < revision || !items.has(item.itemId)) items.set(item.itemId, { revision, item });
          }
        }
        at = result.nextCursor ?? null;
        if (!at) break;
      }
    } catch (error) {
      emit("stderr", { chunk: `history page failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}\n` });
      if (!items.size) return null;
    }
    return { items: [...items.values()].reverse().map((entry) => entry.item), nextCursor: at, exhausted: !at };
  }

  /**
   * The session's user-invocable skill rows (`skill/list`, SS3.22.1), one
   * per typed-invocable shortcut spelling. Per-session because skill scope
   * follows the session's workspace and plugin state.
   */
  async listSkills(options: { sessionId: string }) {
    const { spawned } = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to list skills.");
    try {
      const result = await spawned.connection.request("skill/list", { sessionId: options.sessionId }) as { skills?: unknown[] };
      return { skills: Array.isArray(result.skills) ? result.skills : [] };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (/unknown method|method not found|not supported/i.test(text)) {
        throw new Error("This Muse version does not list skills. Update the CLI and retry.", { cause: error });
      }
      throw error instanceof Error ? error : new Error(text);
    }
  }

  /**
   * CLI-configured MCP servers from the host's own settings file: names,
   * transports, and whether each needs OAuth. Read from `museHome`, never
   * from a renderer-nominated path; a missing or unreadable file yields no
   * servers rather than guesses.
   */
  async mcpServers() {
    const { spawned } = this.requireState();
    const home = asRecord(spawned.initializeResult).museHome;
    if (typeof home !== "string" || !home) return { servers: [] };
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as Record<string, unknown>;
    } catch {
      return { servers: [] };
    }
    const configured = asRecord(parsed.mcpServers);
    const servers = Object.entries(configured).map(([name, entry]) => {
      const record = asRecord(entry);
      const transport = typeof record.transport === "string" ? record.transport : typeof record.url === "string" || typeof record.endpoint === "string" ? "streamableHttp" : "stdio";
      // OAuth applies to streamable-HTTP servers; the CLI is the source of
      // truth for whether one is currently authorized.
      return { name, transport, oauth: transport === "streamableHttp" };
    });
    return { servers };
  }

  /**
   * On-demand history: one more backward chunk past the renderer's held
   * cursor, or the newest chunk when no cursor is held (gap backfill). The
   * renderer prepends with its own items winning, so the walk can never
   * regress an item the live stream already advanced.
   */
  async pageOlderHistory(options: { sessionId: string; cursor?: string }) {
    const state = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to page history.");
    const chunk = await this.pageHistory(state, options.sessionId, options.cursor || null);
    if (!chunk) throw new Error("Older history is unreachable right now. Retry in a bit.");
    return chunk;
  }

  async resumeSession(options: { sessionId: string; cursor?: string | null }) {
    const state = this.requireState();
    const existing = state.sessions.get(options.sessionId);
    if (existing) {
      await this.refreshPending(state, existing.sessionId);
      emit("sessionFacts", factsFromSession(existing));
      const viewCursor = this.lastCursors.get(existing.sessionId);
      return { sessionId: existing.sessionId, opening: existing.opening, alreadyOpen: true, userInputs: state.userInputs.requests(existing.sessionId), facts: factsFromSession(existing), ...(viewCursor ? { viewCursor } : {}) };
    }
    const session = await state.client.resumeSession({
      sessionId: options.sessionId,
      cursor: options.cursor ?? undefined,
    });
    this.wireSession(session);
    await this.refreshPending(state, session.sessionId);
    const history =
      session.opening?.verb === "session/resume" ? session.opening.result.history : null;
    // Large or older sessions can come back with `history.mode: "none"` (e.g. `projectionUnavailable`),
    // which used to show only the newest prompt. Rebuild the transcript from the durable event log instead,
    // newest first; anything older stays pageable on demand.
    const opened = history?.items ?? history?.snapshot?.state?.items;
    const chunk = opened ? null : await this.pageHistory(state, session.sessionId);
    const items = opened ?? chunk?.items;
    if (items) {
      for (const item of items) {
        emit("item", itemPayload(session.sessionId, item));
      }
    }
    const activeTurnId =
      session.opening?.verb === "session/resume"
        ? session.opening.result.session.activeTurnId
        : null;
    if (activeTurnId) {
      await this.consumeTurn(session, activeTurnId);
    }
    emit("sessionFacts", factsFromSession(session));
    const resumeCursor = session.opening?.verb === "session/resume"
      ? (session.opening.result as { viewCursor?: string }).viewCursor ?? this.lastCursors.get(session.sessionId)
      : this.lastCursors.get(session.sessionId);
    return {
      sessionId: session.sessionId,
      opening: session.opening,
      alreadyOpen: false,
      userInputs: state.userInputs.requests(session.sessionId),
      facts: factsFromSession(session),
      historyCursor: chunk?.nextCursor ?? null,
      historyExhausted: chunk ? chunk.exhausted : opened ? true : false,
      ...(chunk || opened ? {} : { historyFailed: true as const }),
      ...(resumeCursor ? { viewCursor: resumeCursor } : {}),
    };
  }

  /**
   * Rebuild both pending queues after a (re)open from `approval/listPending`
   * (SS5.7, a log-fold read — no lease, no subscription). Restored approvals
   * are re-emitted like live ones; a waiter already parked by a re-issued
   * `approval/requested` notification wins over the pulled copy, but still
   * gets its visible choices refreshed. Restored waiters the pull no longer
   * reports were decided elsewhere and are pruned with an `approvalResolved`
   * event so the UI can clear their card.
   */
  private async refreshPending(state: HostState, sessionId: string) {
    const version = state.userInputs.version(sessionId);
    const result = await state.spawned.connection.request("approval/listPending", { sessionId });
    state.userInputs.restore(sessionId, (result.userInputs ?? []) as UserInputRequest[], version);
    const pulled = new Map<string, Record<string, unknown>>();
    for (const raw of (result.approvals ?? []) as Array<Record<string, unknown>>) {
      const approval = asRecord(raw);
      if (typeof approval.approvalId === "string") pulled.set(approval.approvalId, approval);
    }
    for (const [approvalId, waiter] of state.approvals) {
      if (waiter.restored && waiter.restored.sessionId === sessionId && !pulled.has(approvalId)) {
        state.approvals.delete(approvalId);
        emit("approvalResolved", { approvalId, sessionId });
      }
    }
    for (const [approvalId, approval] of pulled) {
      const requirementId = typeof approval.currentRequirementId === "string" ? approval.currentRequirementId : "";
      if (!requirementId) continue;
      const existing = state.approvals.get(approvalId);
      if (existing) {
        if (Array.isArray(approval.availableChoices)) {
          existing.choices = new Set(approval.availableChoices.map((choice) => String(asRecord(choice).choiceId)));
        }
        if (existing.restored) {
          existing.restored.requirementId = requirementId;
          emit("approvalUpdated", { approvalId, sessionId, availableChoices: approval.availableChoices ?? [] });
        }
        continue;
      }
      const choices = new Set(
        (Array.isArray(approval.availableChoices) ? approval.availableChoices : [])
          .map((choice) => String(asRecord(choice).choiceId)),
      );
      const expiresAt = approvalExpiry();
      state.approvals.set(approvalId, {
        resolve: () => {},
        reject: () => {},
        choices,
        sessionId,
        expiresAt,
        restored: { sessionId, requirementId },
      });
      emit("approval", { ...approval, expiresAt });
    }
  }

  async respondUserInput(options: { sessionId: string; userInputId: string; response: UserInputResponse }) {
    const { spawned, userInputs } = this.requireState();
    if (!userInputs.requests(options.sessionId).some((request) => request.userInputId === options.userInputId)) {
      throw new Error("This question is no longer pending. Reopen the thread to refresh it.");
    }
    const { response } = options;
    const params: Record<string, unknown> = { sessionId: options.sessionId, userInputId: options.userInputId };
    if (response.action === "answer") params.answers = response.answers;
    else if (response.action === "clarify") {
      if (!response.text.trim() || response.text.length > 500) throw new Error("Clarification must contain 1–500 characters.");
      params.clarification = { format: "text", content: response.text };
    } else if (response.action !== "cancel") throw new Error("Unknown question response.");
    const result = await spawned.connection.command(`userInput/${response.action}`, params);
    if (result.status !== "accepted") throw new Error("Question response was not accepted. Refresh the thread before retrying.");
    return result;
  }

  async sendTurn(options: {
    sessionId: string;
    text: string;
    reasoningEffort?: ReasoningEffort;
    images?: Array<{ mediaType: string; base64Data: string }>;
    clientTurnId?: string;
    ifBusy?: "queue" | "steer" | "replace";
    skill?: { selector: string; arguments?: string };
  }) {
    const key = options.clientTurnId?.trim() ? `${options.sessionId} ${options.clientTurnId.trim()}` : null;
    const prior = key ? this.turnKeys.get(key) : undefined;
    if (prior) {
      return { turnId: await prior, deduped: true as const };
    }
    const session = this.requireState().sessions.get(options.sessionId);
    if (!session) throw new Error("Session is not open. Resume or start it first.");
    const input = turnInputParts(options.text, options.images, options.skill);
    const wasActive = session.fold.activeTurnId ?? null;
    const started = (async () => {
      let turn;
      try {
        turn = await session.sendUserTurn({
          input: input as never,
          // SDK 0.1.1 types predate the host's `max` tier; the SDK forwards the value verbatim.
          reasoningEffort: options.reasoningEffort as never,
          ...(options.ifBusy ? { ifBusy: options.ifBusy } : {}),
        });
      } catch (error) {
        throw sendTurnError(error, options.skill?.selector);
      }
      await this.consumeTurn(session, turn.turnId);
      return turn.turnId;
    })();
    if (key) {
      // A turn that never started must not pin its key: the retry starts fresh.
      void started.catch(() => {
        if (this.turnKeys.get(key) === started) this.turnKeys.delete(key);
      });
      this.turnKeys.set(key, started);
      while (this.turnKeys.size > 200) {
        const oldest = this.turnKeys.keys().next();
        if (oldest.done) break;
        this.turnKeys.delete(oldest.value);
      }
    }
    const turnId = await started;
    // The facade swallows the ack's disposition, so it is derived from fold
    // truth instead: an idle submit always starts; a busy one whose id is not
    // the active turn was queued (a busy turn that finished first promotes it
    // to started, which the comparison also reports). `replace` always starts
    // by definition; an explicit steer that absorbed reports steered.
    let disposition: "started" | "queued" | "steered" = "started";
    if (wasActive) {
      const nowActive = session.fold.activeTurnId ?? null;
      if (options.ifBusy === "steer" && turnId === wasActive) disposition = "steered";
      else if (options.ifBusy !== "replace" && turnId !== nowActive) disposition = "queued";
    }
    if (disposition === "queued") {
      this.queuedTurns.add(`${options.sessionId} ${turnId}`);
      while (this.queuedTurns.size > 200) {
        const oldest = this.queuedTurns.values().next();
        if (oldest.done) break;
        this.queuedTurns.delete(oldest.value);
      }
    }
    return { turnId, disposition };
  }

  /**
   * Exact-target steering into the running turn. The expected id is resolved
   * here at call time so input can never leak into a successor turn (tdd
   * SS3.3): if the turn finished first the server rejects the stale id and
   * the caller retries as a normal send.
   */
  async steerTurn(options: {
    sessionId: string;
    text: string;
    reasoningEffort?: ReasoningEffort;
    images?: Array<{ mediaType: string; base64Data: string }>;
  }) {
    const { spawned } = this.requireState();
    const session = this.requireState().sessions.get(options.sessionId);
    if (!session) throw new Error("Session is not open. Resume or start it first.");
    const expectedTurnId = session.fold.activeTurnId;
    if (!expectedTurnId) throw new Error("There is no running turn to steer into. Send normally to start one.");
    const input = turnInputParts(options.text, options.images);
    const commandId = spawned.connection.mintCommandId();
    const params: Record<string, unknown> = { sessionId: options.sessionId, expectedTurnId, input };
    if (options.reasoningEffort) params.reasoningEffort = options.reasoningEffort;
    await spawned.connection.command("turn/steer", params, { commandId });
    return { turnId: expectedTurnId, disposition: "steered" as const };
  }

  /**
   * Branch a session into a new one, then attach it like a resume so the
   * transcript streams in. History is excluded from the fork call itself and
   * served by the attach; the cut point names the last completed turn to
   * copy (omitted copies all completed turns).
   */
  async forkSession(options: { sessionId: string; lastTurnId?: string }) {
    const { spawned } = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to fork.");
    const commandId = spawned.connection.mintCommandId();
    const params: Record<string, unknown> = { sessionId: options.sessionId, excludeItems: true };
    if (options.lastTurnId) params.cutPoint = { lastTurnId: options.lastTurnId };
    let forked: { session?: { sessionId?: string; forkedFrom?: { cutExplicit?: boolean; cutCursor?: string } } };
    try {
      forked = await spawned.connection.command("session/fork", params, { commandId });
    } catch (error) {
      throw forkError(error);
    }
    const forkId = forked.session?.sessionId;
    if (!forkId) throw new Error("Fork did not return a session.");
    const opened = await this.resumeSession({ sessionId: forkId });
    return { ...opened, forkedFrom: { sourceSessionId: options.sessionId, cutExplicit: forked.session?.forkedFrom?.cutExplicit ?? false, cutCursor: forked.session?.forkedFrom?.cutCursor ?? null } };
  }

  /** Manual `/compact` gesture: admission-only ack; progress and terminal state arrive as compaction items. */
  async compactSession(options: { sessionId: string }) {
    const { spawned } = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to compact.");
    const commandId = spawned.connection.mintCommandId();
    try {
      const result = (await spawned.connection.command("session/compact", { sessionId: options.sessionId }, { commandId })) as { status?: string; reason?: string };
      return { status: result.status ?? "admitted", ...(result.reason ? { reason: result.reason } : {}) };
    } catch (error) {
      throw compactError(error);
    }
  }

  /** Point-in-time read without attaching: no lease, no subscription, no resume record. */
  async readSession(options: { sessionId: string; excludeItems?: boolean }) {
    const state = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to read.");
    try {
      return await state.spawned.connection.request("session/read", {
        sessionId: options.sessionId,
        excludeItems: options.excludeItems ?? true,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/unknown method|method not found|not supported/i.test(msg)) {
        const chunk = options.excludeItems === true ? null : await this.pageHistory(state, options.sessionId);
        const items = chunk?.items ?? [];
        return {
          session: { sessionId: options.sessionId, items },
          history: { items },
          items,
          pendingRequests: [],
          viewCursor: chunk?.nextCursor ?? null,
        };
      }
      throw error;
    }
  }

  /** Reclaim a queued turn before it launches (admission is the race). */
  async unqueueTurn(options: { sessionId: string; turnId: string }) {
    const { spawned } = this.requireState();
    const commandId = spawned.connection.mintCommandId();
    await spawned.connection.command("turn/unqueue", { sessionId: options.sessionId, turnId: options.turnId }, { commandId });
    this.queuedTurns.delete(`${options.sessionId} ${options.turnId}`);
    return { turnId: options.turnId, unqueued: true as const };
  }

  async cancelTurn(options: { sessionId: string; turnId?: string }) {
    const { spawned } = this.requireState();
    const commandId = spawned.connection.mintCommandId();
    const params: Record<string, unknown> = {
      commandId,
      sessionId: options.sessionId,
      retract: true,
    };
    if (options.turnId) params.turnId = options.turnId;
    const result = await spawned.connection.command("turn/interrupt", params, { commandId });
    // The interrupted turn is dead (including one still being created): release the
    // session's keys so a retry starts a new turn instead of reattaching to it.
    const prefix = `${options.sessionId} `;
    for (const key of [...this.turnKeys.keys()]) {
      if (key.startsWith(prefix)) this.turnKeys.delete(key);
    }
    return result;
  }

  async decideApproval(options: { approvalId: string; choiceId: string }) {
    const state = this.requireState();
    const waiter = state.approvals.get(options.approvalId);
    if (!waiter) throw new Error("No pending approval with that id.");
    if (!approvalAlive(waiter.expiresAt)) {
      state.approvals.delete(options.approvalId);
      waiter.reject(new Error("This approval expired. Re-run the turn to request it again."));
      emit("approvalAudit", { approvalId: options.approvalId, sessionId: waiter.sessionId, turnId: waiter.turnId ?? null, choiceId: options.choiceId, outcome: "expired" });
      throw new Error("This approval expired. Re-run the turn to request it again.");
    }
    if (!waiter.choices.has(options.choiceId)) throw new Error("That approval choice is not available.");
    if (!waiter.restored) {
      state.approvals.delete(options.approvalId);
      waiter.resolve(options.choiceId);
      emit("approvalAudit", { approvalId: options.approvalId, sessionId: waiter.sessionId, turnId: waiter.turnId ?? null, choiceId: options.choiceId, outcome: "decided" });
      return { decided: true };
    }
    // Restored approvals have no parked handler promise: decide directly
    // (SS5.4), guarded by the pulled `currentRequirementId`. Delete-before-send
    // so a concurrent decide sees "no pending approval" instead of sending a
    // second command; on failure the waiter is restored (unless a live
    // re-issue re-parked the id) and a fresh pull either heals the requirement
    // guard or prunes an approval that resolved elsewhere.
    const commandId = state.spawned.connection.mintCommandId();
    state.approvals.delete(options.approvalId);
    try {
      const result = await state.spawned.connection.command(
        "approval/decide",
        {
          commandId,
          sessionId: waiter.restored.sessionId,
          approvalId: options.approvalId,
          choiceId: options.choiceId,
          requirementId: waiter.restored.requirementId,
        },
        { commandId },
      );
      emit("approvalAudit", { approvalId: options.approvalId, sessionId: waiter.sessionId, turnId: waiter.turnId ?? null, choiceId: options.choiceId, outcome: "decided" });
      return { decided: true, status: result.status ?? "accepted" };
    } catch (error) {
      if (!state.approvals.has(options.approvalId)) state.approvals.set(options.approvalId, waiter);
      await this.refreshPending(state, waiter.restored.sessionId).catch(() => {});
      if (!state.approvals.has(options.approvalId)) {
        throw new Error("This approval is no longer pending. It may have been decided elsewhere.");
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  async setApprovalMode(options: { sessionId: string; mode: ApprovalMode }) {
    const { spawned } = this.requireState();
    const commandId = spawned.connection.mintCommandId();
    return spawned.connection.command(
      "session/setApprovalMode",
      { commandId, sessionId: options.sessionId, mode: options.mode },
      { commandId },
    );
  }

  async setModel(options: { sessionId: string; modelId: string; providerId?: string }) {
    const { spawned } = this.requireState();
    const commandId = spawned.connection.mintCommandId();
    return spawned.connection.command(
      "session/setModel",
      {
        commandId,
        sessionId: options.sessionId,
        model: { modelId: options.modelId, providerId: options.providerId },
      },
      { commandId },
    );
  }

  /**
   * Byte-ranged fetch of a tool/userShell item's stored full output
   * (`item/readOutput`, SS4.7.4). Read-only: works on loaded and unloaded
   * sessions, no lease. `outputRef` is the ref id from the item, never the
   * uri. The server default and max page is 6 MiB.
   */
  async readOutput(options: {
    sessionId: string;
    itemId: string;
    outputRef: string;
    offsetBytes?: number;
    lengthBytes?: number;
  }) {
    const { spawned } = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to read output.");
    if (!options.itemId) throw new Error("An item id is required to read output.");
    if (!options.outputRef) throw new Error("An output reference is required to read output.");
    const params: Record<string, unknown> = {
      sessionId: options.sessionId,
      itemId: options.itemId,
      outputRef: options.outputRef,
    };
    if (options.offsetBytes !== undefined) {
      const offset = Math.floor(options.offsetBytes);
      if (!Number.isFinite(offset) || offset < 0) throw new Error("The output offset must be zero or more.");
      params.offsetBytes = offset;
    }
    if (options.lengthBytes !== undefined) {
      const length = Math.floor(options.lengthBytes);
      if (!Number.isFinite(length) || length < 1) throw new Error("The output length must be at least one byte.");
      params.lengthBytes = Math.min(length, 6 * 1024 * 1024);
    }
    try {
      return await spawned.connection.request("item/readOutput", params);
    } catch (error) {
      throw readOutputError(error);
    }
  }

  /**
   * Write the session's standing reasoning-effort default
   * (`session/setReasoningEffort`, SS3.21). Durable on ack; turns carrying
   * their own effort override it for that turn only. Tier vocabulary matches
   * `turn/start`, with `ultra` environment-gated as elsewhere in the bridge.
   */
  async setReasoningEffort(options: { sessionId: string; reasoningEffort: string }) {
    const { spawned, env } = this.requireState();
    if (!options.sessionId) throw new Error("A session id is required to set the effort default.");
    const tier = options.reasoningEffort;
    if (!(TIER_ORDER as string[]).includes(tier)) {
      throw new Error(`Unknown effort tier ${JSON.stringify(tier)} — expected one of ${TIER_ORDER.join(", ")}.`);
    }
    if (!vocabularyTiers(env).includes(tier as ReasoningEffort)) {
      throw new Error("The ultra tier needs MUSE_EXPERIMENTAL_ULTRA_REASONING_EFFORT on the host.");
    }
    const commandId = spawned.connection.mintCommandId();
    try {
      return await spawned.connection.command(
        "session/setReasoningEffort",
        { commandId, sessionId: options.sessionId, reasoningEffort: tier },
        { commandId },
      );
    } catch (error) {
      throw effortError(error);
    }
  }

  /** One idempotent command send for the oversight families (SS3.13–SS3.20). */
  private async agentCommand(method: string, params: Record<string, unknown>) {
    const { spawned } = this.requireState();
    const commandId = spawned.connection.mintCommandId();
    try {
      return await spawned.connection.command(method, { commandId, ...params }, { commandId });
    } catch (error) {
      throw oversightError(error);
    }
  }

  /**
   * Child lifecycle and messaging (`subagent/*`, SS3.16). `body` carries the
   * note for `sendMessage`/`followupTask`; `reason` annotates
   * `interrupt`/`stop`/`close`. Outcomes fold to the parent's subagent item.
   */
  async subagentControl(options: { sessionId: string; subagentId: string; action: string; body?: string; reason?: string }) {
    if (!options.sessionId) throw new Error("A session id is required to control a subagent.");
    if (!options.subagentId) throw new Error("A subagent id is required to control a subagent.");
    const base = { sessionId: options.sessionId, subagentId: options.subagentId };
    switch (options.action) {
      case "sendMessage":
      case "followupTask": {
        const body = (options.body ?? "").trim();
        if (!body) throw new Error("A message body is required.");
        if (body.length > 100_000) throw new Error("Messages are limited to 100,000 characters.");
        return this.agentCommand(`subagent/${options.action}`, { ...base, body });
      }
      case "interrupt":
      case "stop":
      case "close": {
        const reason = (options.reason ?? "").trim();
        if (reason.length > 1_000) throw new Error("Reasons are limited to 1,000 characters.");
        return this.agentCommand(`subagent/${options.action}`, reason ? { ...base, reason } : base);
      }
      case "resume":
      case "reopen":
      case "readResult":
        return this.agentCommand(`subagent/${options.action}`, base);
      default:
        throw new Error(`Unknown subagent action: ${options.action}.`);
    }
  }

  /**
   * Foreground/background tool-task control (`task/*`, SS3.13–SS3.15).
   * `taskId` is the toolCall item's id; `stopAll` needs none and is
   * always accepted, including over an empty set.
   */
  async taskControl(options: { sessionId: string; action: string; taskId?: string }) {
    if (!options.sessionId) throw new Error("A session id is required to control a task.");
    switch (options.action) {
      case "background":
      case "stop": {
        if (!options.taskId) throw new Error("A task id is required.");
        return this.agentCommand(`task/${options.action}`, { sessionId: options.sessionId, taskId: options.taskId });
      }
      case "stopAll":
        return this.agentCommand("task/stopAll", { sessionId: options.sessionId });
      default:
        throw new Error(`Unknown task action: ${options.action}.`);
    }
  }

  /**
   * Workflow-run control (`workflow/*`, SS3.19–SS3.20). Child actions re-key
   * on the `(childId, attempt)` pair the workflow item carries; a stale
   * attempt rejects and the caller re-reads the item instead of guessing.
   */
  async workflowControl(options: { sessionId: string; workflowRunId: string; action: string; childId?: string; attempt?: number }) {
    if (!options.sessionId) throw new Error("A session id is required to control a workflow.");
    if (!options.workflowRunId) throw new Error("A workflow run id is required to control a workflow.");
    const base = { sessionId: options.sessionId, workflowRunId: options.workflowRunId };
    switch (options.action) {
      case "cancel":
        return this.agentCommand("workflow/cancel", base);
      case "skip":
      case "retry": {
        if (!options.childId) throw new Error("A child id is required.");
        const attempt = Math.floor(options.attempt ?? NaN);
        if (!Number.isFinite(attempt) || attempt < 1) throw new Error("The child's current attempt (1 or more) is required.");
        return this.agentCommand("workflow/childControl", { ...base, action: options.action, childId: options.childId, attempt });
      }
      default:
        throw new Error(`Unknown workflow action: ${options.action}.`);
    }
  }

  /**
   * Session-goal control (`goal/*`, SS3.18). Admission-only acks; a
   * `set`/`edit`/`resume` may wake a goal-driving turn (the ack's `turnId`),
   * and the settled block arrives via `session/goalChanged`.
   */
  async goalControl(options: { sessionId: string; action: string; objective?: string }) {
    if (!options.sessionId) throw new Error("A session id is required to control the goal.");
    switch (options.action) {
      case "set":
      case "edit": {
        const objective = (options.objective ?? "").trim();
        if (!objective) throw new Error("A goal objective is required.");
        if (objective.length > 100_000) throw new Error("Objectives are limited to 100,000 characters.");
        return this.agentCommand(`goal/${options.action}`, { sessionId: options.sessionId, objective });
      }
      case "clear":
      case "pause":
      case "resume":
        return this.agentCommand(`goal/${options.action}`, { sessionId: options.sessionId });
      default:
        throw new Error(`Unknown goal action: ${options.action}.`);
    }
  }

  /** Last-observed subscription usage without a model call; `{}` when nothing observed yet. */
  async readUsage() {
    const { spawned } = this.requireState();
    return spawned.connection.request("usage/read", {});
  }

  detect(museBin?: string | null, museApiKey?: string | null, museAuthMode?: string | null) {
    return detectMuse(museBin, museApiKey, museAuthMode);
  }

  status(museBin?: string | null, museApiKey?: string | null, museAuthMode?: string | null) {
    const detection = detectMuse(museBin, museApiKey, museAuthMode);
    return {
      running: Boolean(this.state),
      ...detection,
      ...(this.state ? { compat: compatFrom(this.state.spawned), trustWorkspace: this.state.trusted, posture: this.state.posture, isolation: this.isolation() } : {}),
    };
  }
}

export { asRecord };
