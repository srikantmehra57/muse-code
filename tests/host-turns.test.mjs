import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Turn/session lifecycle tests for `packages/muse-bridge/src/host.ts` plus
 * `session-facts.ts`: prompt validation, input building, question responses,
 * approval round-trips, resume/history rebuilds, and durable-fact mapping.
 * The host is bundled with a fake `@muse-code/sdk` driven per test through
 * `globalThis.fakeWorld`.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-host-turns-'));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function bundle(entry, replacements = {}) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/muse-bridge/src') }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}

const { MuseHost } = await bundle('packages/muse-bridge/src/host.ts', {
  '@muse-code/sdk': `export const spawnMspConnection=(...args)=>globalThis.fakeWorld.spawn(...args);
    export class MuseClient { constructor(connection, options) { return globalThis.fakeWorld.makeClient(connection, options); } }
    export const readSessionDurability=()=>({kind:'durable'});
    export const EXPECTED_SCHEMA_FINGERPRINT="sha256:fake-pin";`,
  './detect.js': `export * from ${JSON.stringify(resolve('packages/muse-bridge/src/detect.ts'))}; export const resolveMuseBin=()=>"/fake/muse";`,
});
const { factsFromSession, isSessionFactNotification } = await bundle('packages/muse-bridge/src/session-facts.ts');

/** A controllable stand-in for the MSP server behind `@muse-code/sdk`. */
function makeWorld() {
  const world = {
    notifications: null,
    requests: [],
    commands: [],
    requestHandlers: {},
    commandHandlers: {},
    sessions: new Map(),
    nextSession: 1,
    nextTurnConfig: null,
    closed: false,
    notify(notification) { world.notifications?.(notification); },
    spawnArgs: [],
    spawn(options = {}) {
      world.spawnArgs.push(options);
      const connection = {
        onNotification(handler) { world.notifications = handler; },
        mintCommandId: () => `cmd-${world.commands.length + 1}`,
        request: async (method, params) => {
          world.requests.push({ method, params });
          const handler = world.requestHandlers[method];
          if (!handler) throw new Error(`unexpected request: ${method}`);
          return handler(params);
        },
        command: async (method, params) => {
          world.commands.push({ method, params });
          return world.commandHandlers[method]?.(params) ?? { status: 'accepted' };
        },
      };
      return {
        initialize: async () => ({
          child: { exit: new Promise(() => {}) },
          connection,
          initializeResult: { serverInfo: { name: 'fake' }, museHome: '/fake/home', sessionDurability: 'durable' },
        }),
      };
    },
    makeClient(connection) {
      // The real client subscribes on construction; without this the
      // observeNotifications wrapper never sees test-driven notifications.
      connection?.onNotification?.(() => {});
      return {
        async close() { world.closed = true; },
        async startSession() { return world.makeSession(`s${world.nextSession++}`); },
        async resumeSession(options) {
          const session = world.sessions.get(options.sessionId);
          if (!session) throw new Error(`No such session: ${options.sessionId}`);
          return session;
        },
      };
    },
    makeSession(sessionId, opening = null) {
      const session = {
        sessionId,
        opening,
        fold: { sessionState: new Map() },
        approvalHandler: null,
        approvalErrorHandler: null,
        gapHandler: null,
        turns: new Map(),
        sentInputs: [],
        onApproval(handler) { session.approvalHandler = handler; },
        onApprovalError(handler) { session.approvalErrorHandler = handler; },
        onGapError(handler) { session.gapHandler = handler; },
        async sendUserTurn({ input, reasoningEffort, ifBusy }) {
          session.sentInputs.push({ input, reasoningEffort, ...(ifBusy === undefined ? {} : { ifBusy }) });
          if (session.failNextTurn) {
            const failure = session.failNextTurn;
            session.failNextTurn = null;
            throw failure;
          }
          const turnId = `turn-${session.turns.size + 1}`;
          session.turns.set(turnId, world.makeTurn(turnId));
          return { turnId };
        },
        turn(turnId) { return session.turns.get(turnId) ?? world.makeTurn(turnId); },
      };
      world.sessions.set(sessionId, session);
      return session;
    },
    makeTurn(turnId) {
      const config = world.nextTurnConfig;
      world.nextTurnConfig = null;
      const items = config?.items ?? [];
      const deltas = config?.deltas ?? [];
      return {
        turnId,
        async *items() {
          if (config?.itemsError) throw new Error(config.itemsError);
          yield* items;
        },
        async *deltas() { yield* deltas; },
        completed: config?.completedError
          ? Promise.reject(new Error(config.completedError))
          : Promise.resolve(config?.outcome ?? { status: 'completed' }),
      };
    },
  };
  return world;
}

/** Host events go straight to stdout; collect them without disturbing TAP output. */
function captureEvents() {
  const events = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = function (chunk, encoding, callback) {
    if (typeof chunk === 'string') {
      const trimmed = chunk.trim();
      if (trimmed.startsWith('{')) {
        try {
          const message = JSON.parse(trimmed);
          if (message?.type === 'event' && typeof message.event === 'string' && 'payload' in message) {
            events.push(message);
            if (typeof encoding === 'function') encoding();
            else if (typeof callback === 'function') callback();
            return true;
          }
        } catch { /* not an event line; forward below */ }
      }
    }
    return original(chunk, encoding, callback);
  };
  return { events, restore: () => { process.stdout.write = original; } };
}

function serveTail(args = []) {
  const at = args.lastIndexOf('serve');
  assert.ok(at >= 0, `serve missing from ${args.join(' ')}`);
  return args.slice(at);
}

const until = async (events, predicate, label) => {
  for (let i = 0; i < 200 && !events.some(predicate); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(events.some(predicate), `expected event: ${label}`);
  return events.find(predicate);
};

async function startedHost() {
  const world = makeWorld();
  globalThis.fakeWorld = world;
  const host = new MuseHost();
  await host.start(null, null, 'auto');
  return { host, world };
}

const question = (overrides = {}) => ({
  sessionId: 's1', userInputId: 'q1', turnId: 't1', questions: [{ id: 'choice' }], ...overrides,
});

/** Seeds one pending question through the resume path, like a reconnect would. */
async function withQuestion(host, world, request = question()) {
  world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [request] });
  await host.resumeSession({ sessionId: 's1' });
}

test('sendTurn builds text and image input and streams turn events', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    world.nextTurnConfig = {
      items: [{ itemId: 'i1', text: 'hello' }],
      deltas: [{ itemId: 'i1', field: 'text', delta: 'hello' }],
      outcome: { status: 'completed' },
    };
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const sent = await host.sendTurn({
      sessionId,
      text: ' hello ',
      reasoningEffort: 'low',
      images: [{ mediaType: 'image/png', base64Data: 'AAA' }],
    });
    assert.deepEqual(sent, { turnId: 'turn-1', disposition: 'started' });
    const session = world.sessions.get(sessionId);
    assert.deepEqual(session.sentInputs, [{
      input: [
        { type: 'text', text: ' hello ' },
        { type: 'image', mediaType: 'image/png', base64Data: 'AAA' },
      ],
      reasoningEffort: 'low',
    }]);
    await until(cap.events, (event) => event.event === 'item' && event.payload.item.itemId === 'i1', 'item i1');
    await until(cap.events, (event) => event.event === 'delta' && event.payload.delta === 'hello', 'delta');
    const done = await until(cap.events, (event) => event.event === 'turnCompleted', 'turnCompleted');
    assert.deepEqual(done.payload, { sessionId, turnId: 'turn-1', outcome: { status: 'completed' } });
    await host.stop();
  } finally { cap.restore(); }
});

test('sendTurn rejects empty prompts and unknown sessions', async () => {
  const cap = captureEvents();
  try {
    const { host } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    await assert.rejects(host.sendTurn({ sessionId, text: '   ' }), /Prompt is empty\./);
    await assert.rejects(host.sendTurn({ sessionId: 'missing', text: 'hi' }), /Session is not open/);
    await host.stop();
  } finally { cap.restore(); }
});

test('sendTurn allows image-only prompts', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    await host.sendTurn({ sessionId, text: '  ', images: [{ mediaType: 'image/png', base64Data: 'AAA' }] });
    assert.deepEqual(world.sessions.get(sessionId).sentInputs, [{
      input: [{ type: 'image', mediaType: 'image/png', base64Data: 'AAA' }],
      reasoningEffort: undefined,
    }]);
    await host.stop();
  } finally { cap.restore(); }
});

test('busy submits report queued and promote at the launch boundary', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    session.fold.activeTurnId = 'turn-0';
    const sent = await host.sendTurn({ sessionId, text: 'later', ifBusy: 'queue' });
    assert.deepEqual(sent, { turnId: 'turn-1', disposition: 'queued' });
    assert.equal(session.sentInputs[0].ifBusy, 'queue');
    world.notify({ method: 'turn/started', params: { sessionId, turnId: 'turn-1', commandId: 'cmd-1' } });
    const launched = await until(cap.events, (event) => event.event === 'turnStarted', 'turnStarted');
    assert.deepEqual(launched.payload, { sessionId, turnId: 'turn-1' });
    // A launch for an untracked turn stays silent (fresh turns already show running).
    world.notify({ method: 'turn/started', params: { sessionId, turnId: 'turn-2', commandId: 'cmd-2' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(cap.events.filter((event) => event.event === 'turnStarted').length, 1);
    await host.stop();
  } finally { cap.restore(); }
});

test('replace reports started even when busy; idle always starts', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    session.fold.activeTurnId = 'turn-0';
    const replaced = await host.sendTurn({ sessionId, text: 'instead', ifBusy: 'replace' });
    assert.deepEqual(replaced, { turnId: 'turn-1', disposition: 'started' });
    session.fold.activeTurnId = null;
    const fresh = await host.sendTurn({ sessionId, text: 'fresh' });
    assert.deepEqual(fresh, { turnId: 'turn-2', disposition: 'started' });
    await host.stop();
  } finally { cap.restore(); }
});

test('steerTurn targets the active turn and refuses when idle', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    session.fold.activeTurnId = 'turn-9';
    const steered = await host.steerTurn({ sessionId, text: 'more tests', reasoningEffort: 'high' });
    assert.deepEqual(steered, { turnId: 'turn-9', disposition: 'steered' });
    assert.deepEqual(world.commands, [{ method: 'turn/steer', params: { sessionId, expectedTurnId: 'turn-9', input: [{ type: 'text', text: 'more tests' }], reasoningEffort: 'high' } }]);
    session.fold.activeTurnId = null;
    await assert.rejects(host.steerTurn({ sessionId, text: 'x' }), /no running turn/);
    await assert.rejects(host.steerTurn({ sessionId, text: '   ' }), /Prompt is empty\.|no running turn/);
    await host.stop();
  } finally { cap.restore(); }
});

test('unqueueTurn reclaims a queued turn', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    session.fold.activeTurnId = 'turn-0';
    const sent = await host.sendTurn({ sessionId, text: 'later', ifBusy: 'queue' });
    const reclaimed = await host.unqueueTurn({ sessionId, turnId: sent.turnId });
    assert.deepEqual(reclaimed, { turnId: sent.turnId, unqueued: true });
    assert.deepEqual(world.commands, [{ method: 'turn/unqueue', params: { sessionId, turnId: sent.turnId } }]);
    // Reclaimed turns no longer promote: a late launch stays silent.
    world.notify({ method: 'turn/started', params: { sessionId, turnId: sent.turnId, commandId: 'cmd-9' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!cap.events.some((event) => event.event === 'turnStarted'));
    await host.stop();
  } finally { cap.restore(); }
});

test('forkSession branches, attaches the fork, and reports provenance', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['approval/listPending'] = async () => ({});
    world.commandHandlers['session/fork'] = async (params) => {
      assert.equal(params.sessionId, sessionId);
      world.makeSession('fork-1');
      return { session: { sessionId: 'fork-1', forkedFrom: { cutExplicit: Boolean(params.cutPoint), cutCursor: 'opaque-cursor' } } };
    };
    const forked = await host.forkSession({ sessionId, lastTurnId: 'turn-3' });
    assert.equal(forked.sessionId, 'fork-1');
    assert.deepEqual(forked.forkedFrom, { sourceSessionId: sessionId, cutExplicit: true, cutCursor: 'opaque-cursor' });
    assert.deepEqual(world.commands[0], { method: 'session/fork', params: { sessionId, excludeItems: true, cutPoint: { lastTurnId: 'turn-3' } } });
    // Omitted cut point copies all completed turns (no cutPoint key sent).
    world.commands.length = 0;
    await host.forkSession({ sessionId });
    assert.ok(!('cutPoint' in world.commands[0].params));
    await host.stop();
  } finally { cap.restore(); }
});

test('forkSession maps boundary and version failures', async () => {
  const cap = captureEvents();
  try {
    const { host } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const world = globalThis.fakeWorld;
    world.commandHandlers['session/fork'] = async () => { throw new Error('forkBoundaryInvalid: turn is live'); };
    await assert.rejects(host.forkSession({ sessionId, lastTurnId: 'turn-9' }), /completed turns only/);
    world.commandHandlers['session/fork'] = async () => { throw new Error('unknown method: session/fork'); };
    await assert.rejects(host.forkSession({ sessionId }), /does not support fork/);
    await host.stop();
  } finally { cap.restore(); }
});

test('compactSession returns admission status and maps old CLIs', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.commandHandlers['session/compact'] = async () => ({ commandId: 'c', status: 'noop', reason: 'no_compactable_history' });
    assert.deepEqual(await host.compactSession({ sessionId }), { status: 'noop', reason: 'no_compactable_history' });
    world.commandHandlers['session/compact'] = async () => ({ commandId: 'c', status: 'admitted' });
    assert.deepEqual(await host.compactSession({ sessionId }), { status: 'admitted' });
    world.commandHandlers['session/compact'] = async () => { throw new Error('method not found'); };
    await assert.rejects(host.compactSession({ sessionId }), /does not support manual compact/);
    await assert.rejects(host.compactSession({ sessionId: '' }), /required to compact/);
    await host.stop();
  } finally { cap.restore(); }
});

test('readSession reads without attaching', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['session/read'] = async (params) => ({ session: { sessionId: params.sessionId }, history: { items: [] }, pendingRequests: [], viewCursor: 'v' });
    const read = await host.readSession({ sessionId, excludeItems: false });
    assert.equal(read.session.sessionId, sessionId);
    assert.deepEqual(world.requests, [{ method: 'session/read', params: { sessionId, excludeItems: false } }]);
    await host.stop();
  } finally { cap.restore(); }
});

test('readSession falls back to view/page when session/read is unsupported', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['session/read'] = async () => {
      throw new Error('Method not found: session/read');
    };
    world.requestHandlers['view/page'] = async (params) => ({
      events: [
        {
          method: 'item/started',
          params: { item: { itemId: 'i-fallback', revision: 1, text: 'Hello' } },
        },
      ],
      nextCursor: null,
    });
    const read = await host.readSession({ sessionId, excludeItems: false });
    assert.equal(read.session.sessionId, sessionId);
    assert.equal(read.history.items.length, 1);
    assert.equal(read.history.items[0].itemId, 'i-fallback');
    await host.stop();
  } finally { cap.restore(); }
});

test('readOutput fetches a byte range and maps failures', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['item/readOutput'] = async (params) => ({
      offsetBytes: params.offsetBytes ?? 0, byteLen: 4, eof: true, encoding: 'utf8', mediaType: 'text/plain', content: 'full',
    });
    const page = await host.readOutput({ sessionId, itemId: 'i1', outputRef: 'ref-1', offsetBytes: 8, lengthBytes: 4 });
    assert.equal(page.content, 'full');
    assert.deepEqual(world.requests, [{ method: 'item/readOutput', params: { sessionId, itemId: 'i1', outputRef: 'ref-1', offsetBytes: 8, lengthBytes: 4 } }]);
    // Over-max lengths clamp to the 6 MiB server page; ranges stay validated.
    await host.readOutput({ sessionId, itemId: 'i1', outputRef: 'ref-1', lengthBytes: 99 * 1024 * 1024 });
    assert.equal(world.requests[1].params.lengthBytes, 6 * 1024 * 1024);
    await assert.rejects(host.readOutput({ sessionId, itemId: 'i1', outputRef: 'ref-1', offsetBytes: -1 }), /zero or more/);
    await assert.rejects(host.readOutput({ sessionId, itemId: '', outputRef: 'ref-1' }), /item id is required/);
    world.requestHandlers['item/readOutput'] = async () => { throw new Error('unknown method: item/readOutput'); };
    await assert.rejects(host.readOutput({ sessionId, itemId: 'i1', outputRef: 'ref-1' }), /does not serve full tool output/);
    world.requestHandlers['item/readOutput'] = async () => { throw new Error('notFound: output evicted'); };
    await assert.rejects(host.readOutput({ sessionId, itemId: 'i1', outputRef: 'ref-1' }), /no longer stored/);
    await host.stop();
  } finally { cap.restore(); }
});

test('setReasoningEffort writes the standing default and gates tiers', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.commandHandlers['session/setReasoningEffort'] = async (params) => ({ commandId: params.commandId, status: 'accepted' });
    const result = await host.setReasoningEffort({ sessionId, reasoningEffort: 'low' });
    assert.equal(result.status, 'accepted');
    assert.deepEqual(world.commands, [{ method: 'session/setReasoningEffort', params: { commandId: 'cmd-1', sessionId, reasoningEffort: 'low' } }]);
    await assert.rejects(host.setReasoningEffort({ sessionId, reasoningEffort: 'turbo' }), /Unknown effort tier/);
    await assert.rejects(host.setReasoningEffort({ sessionId, reasoningEffort: 'ultra' }), /MUSE_EXPERIMENTAL_ULTRA/);
    await assert.rejects(host.setReasoningEffort({ sessionId: '', reasoningEffort: 'low' }), /required to set the effort/);
    world.commandHandlers['session/setReasoningEffort'] = async () => { throw new Error('method not found'); };
    await assert.rejects(host.setReasoningEffort({ sessionId, reasoningEffort: 'low' }), /standing effort default/);
    await host.stop();
  } finally { cap.restore(); }
});

test('subagentControl maps child actions onto subagent/* commands', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    await host.subagentControl({ sessionId, subagentId: 'kid-1', action: 'sendMessage', body: '  use the cache ' });
    await host.subagentControl({ sessionId, subagentId: 'kid-1', action: 'stop', reason: 'stale' });
    await host.subagentControl({ sessionId, subagentId: 'kid-1', action: 'reopen' });
    assert.deepEqual(world.commands.map(({ method, params }) => [method, { ...params, commandId: 'cmd' }]), [
      ['subagent/sendMessage', { commandId: 'cmd', sessionId, subagentId: 'kid-1', body: 'use the cache' }],
      ['subagent/stop', { commandId: 'cmd', sessionId, subagentId: 'kid-1', reason: 'stale' }],
      ['subagent/reopen', { commandId: 'cmd', sessionId, subagentId: 'kid-1' }],
    ]);
    await assert.rejects(host.subagentControl({ sessionId, subagentId: 'kid-1', action: 'sendMessage', body: '  ' }), /message body is required/);
    await assert.rejects(host.subagentControl({ sessionId, subagentId: '', action: 'stop' }), /subagent id is required/);
    await assert.rejects(host.subagentControl({ sessionId, subagentId: 'kid-1', action: 'explode' }), /Unknown subagent action/);
    world.commandHandlers['subagent/stop'] = async () => { throw new Error('unknown method: subagent/stop'); };
    await assert.rejects(host.subagentControl({ sessionId, subagentId: 'kid-1', action: 'stop' }), /does not support agent oversight/);
    await host.stop();
  } finally { cap.restore(); }
});

test('taskControl backgrounds, stops, and stops all', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    await host.taskControl({ sessionId, action: 'background', taskId: 'tool-1' });
    await host.taskControl({ sessionId, action: 'stopAll' });
    assert.deepEqual(world.commands.map(({ method }) => method), ['task/background', 'task/stopAll']);
    assert.equal(world.commands[0].params.taskId, 'tool-1');
    assert.ok(!('taskId' in world.commands[1].params));
    await assert.rejects(host.taskControl({ sessionId, action: 'stop' }), /task id is required/);
    await assert.rejects(host.taskControl({ sessionId, action: 'pause', taskId: 'tool-1' }), /Unknown task action/);
    await host.stop();
  } finally { cap.restore(); }
});

test('workflowControl cancels runs and re-keys child attempts', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    await host.workflowControl({ sessionId, workflowRunId: 'run-1', action: 'cancel' });
    await host.workflowControl({ sessionId, workflowRunId: 'run-1', action: 'retry', childId: 'c-2', attempt: 2 });
    assert.deepEqual(world.commands.map(({ method, params }) => [method, { ...params, commandId: 'cmd' }]), [
      ['workflow/cancel', { commandId: 'cmd', sessionId, workflowRunId: 'run-1' }],
      ['workflow/childControl', { commandId: 'cmd', sessionId, workflowRunId: 'run-1', action: 'retry', childId: 'c-2', attempt: 2 }],
    ]);
    await assert.rejects(host.workflowControl({ sessionId, workflowRunId: 'run-1', action: 'skip', childId: 'c-1', attempt: 0 }), /current attempt/);
    await assert.rejects(host.workflowControl({ sessionId, workflowRunId: '', action: 'cancel' }), /run id is required/);
    world.commandHandlers['workflow/childControl'] = async () => { throw new Error('stale_attempt: child moved on'); };
    await assert.rejects(host.workflowControl({ sessionId, workflowRunId: 'run-1', action: 'skip', childId: 'c-1', attempt: 1 }), /already moved on/);
    await host.stop();
  } finally { cap.restore(); }
});

test('goalControl sets, edits, and pauses the session goal', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    await host.goalControl({ sessionId, action: 'set', objective: ' Ship it ' });
    await host.goalControl({ sessionId, action: 'pause' });
    assert.deepEqual(world.commands.map(({ method, params }) => [method, { ...params, commandId: 'cmd' }]), [
      ['goal/set', { commandId: 'cmd', sessionId, objective: 'Ship it' }],
      ['goal/pause', { commandId: 'cmd', sessionId }],
    ]);
    await assert.rejects(host.goalControl({ sessionId, action: 'edit', objective: '' }), /objective is required/);
    await assert.rejects(host.goalControl({ sessionId, action: 'archive' }), /Unknown goal action/);
    await host.stop();
  } finally { cap.restore(); }
});

test('start passes workspace trust to serve and reports it', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    assert.deepEqual(serveTail(world.spawnArgs[0]?.args), ['serve']);
    const started = await host.status();
    assert.equal(started.trustWorkspace, false);
    assert.equal(started.isolation.osSandbox, world.spawnArgs[0].command === '/fake/muse' ? 'unavailable' : 'enforced');
    await host.stop();
    await host.start(null, null, 'auto', true);
    assert.deepEqual(serveTail(world.spawnArgs[1]?.args), ['serve', '--trust-workspace']);
    const trusted = await host.status();
    assert.equal(trusted.trustWorkspace, true);
    await host.stop();
  } finally { cap.restore(); }
});

test('listSessions forwards the updated-after filter', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    world.requestHandlers['session/list'] = async () => ({ sessions: [], nextCursor: null });
    await host.listSessions({ limit: 200, updatedAfter: '2026-09-01T00:00:00Z' });
    assert.deepEqual(world.requests, [{ method: 'session/list', params: { limit: 200, updatedAfter: '2026-09-01T00:00:00Z' } }]);
    await host.stop();
  } finally { cap.restore(); }
});

test('resume carries the last observed view cursor', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [] });
    world.notify({ method: 'session/statusChanged', params: { sessionId: 's7', status: 'idle', viewCursor: 'v-7' } });
    world.makeSession('s7', { verb: 'session/resume', result: { history: { items: [] }, session: {} } });
    const resumed = await host.resumeSession({ sessionId: 's7' });
    assert.equal(resumed.viewCursor, 'v-7');
    await host.stop();
  } finally { cap.restore(); }
});

test('listSkills returns the session catalog and mcpServers tolerates a missing file', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['skill/list'] = async (params) => {
      assert.equal(params.sessionId, sessionId);
      return { skills: [{ selector: 'fix-bug', displayName: 'Fix bug', description: 'Fix it', source: 'user' }] };
    };
    const catalog = await host.listSkills({ sessionId });
    assert.deepEqual(catalog.skills.map((row) => row.selector), ['fix-bug']);
    await assert.rejects(host.listSkills({ sessionId: '' }), /required to list skills/);
    // The fake home has no settings file: no servers, no guesses.
    assert.deepEqual(await host.mcpServers(), { servers: [] });
    await host.stop();
  } finally { cap.restore(); }
});

test('sendTurn leads with a skill part and names a vanished skill', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [] });
    const session = world.sessions.get(sessionId);
    await host.sendTurn({ sessionId, text: '', skill: { selector: 'fix-bug', arguments: 'auth.ts' } });
    assert.deepEqual(session.sentInputs[0].input, [{ type: 'skill', selector: 'fix-bug', arguments: 'auth.ts' }]);
    await assert.rejects(host.sendTurn({ sessionId, text: '', skill: { selector: '  ' } }), /selector is required/);
    session.failNextTurn = new Error('-32032 skillNotFound: unknown selector');
    await assert.rejects(host.sendTurn({ sessionId, text: 'x', skill: { selector: 'gone' } }), /no longer available/);
    await host.stop();
  } finally { cap.restore(); }
});

test('turn failures surface as turnError events', async () => {
  const cap = captureEvents();
  try {
    const { host } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    globalThis.fakeWorld.nextTurnConfig = { itemsError: 'stream broke' };
    await host.sendTurn({ sessionId, text: 'hi' });
    const failure = await until(cap.events, (event) => event.event === 'turnError', 'turnError');
    assert.equal(failure.payload.sessionId, sessionId);
    assert.match(failure.payload.error, /stream broke/);
    await host.stop();
  } finally { cap.restore(); }
});

test('respondUserInput answers a pending question', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    await withQuestion(host, world);
    const answers = [{ id: 'choice', value: 'A' }];
    const result = await host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'answer', answers } });
    assert.deepEqual(result, { status: 'accepted' });
    assert.deepEqual(world.commands, [{ method: 'userInput/answer', params: { sessionId: 's1', userInputId: 'q1', answers } }]);
    await host.stop();
  } finally { cap.restore(); }
});

test('respondUserInput rejects stale questions', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    await withQuestion(host, world);
    await assert.rejects(
      host.respondUserInput({ sessionId: 's1', userInputId: 'gone', response: { action: 'cancel' } }),
      /no longer pending/,
    );
    assert.deepEqual(world.commands, []);
    await host.stop();
  } finally { cap.restore(); }
});

test('clarifications must contain 1-500 characters', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    await withQuestion(host, world);
    await assert.rejects(
      host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'clarify', text: '  ' } }),
      /Clarification must contain 1–500 characters\./,
    );
    await assert.rejects(
      host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'clarify', text: 'x'.repeat(501) } }),
      /Clarification must contain 1–500 characters\./,
    );
    await host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'clarify', text: 'use the cache' } });
    assert.deepEqual(world.commands, [{
      method: 'userInput/clarify',
      params: { sessionId: 's1', userInputId: 'q1', clarification: { format: 'text', content: 'use the cache' } },
    }]);
    await host.stop();
  } finally { cap.restore(); }
});

test('cancel sends no payload; unknown actions fail before the server call', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    await withQuestion(host, world);
    await host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'cancel' } });
    assert.deepEqual(world.commands, [{ method: 'userInput/cancel', params: { sessionId: 's1', userInputId: 'q1' } }]);
    await assert.rejects(
      host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'bogus' } }),
      /Unknown question response\./,
    );
    await host.stop();
  } finally { cap.restore(); }
});

test('unaccepted question responses raise', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    await withQuestion(host, world);
    world.commandHandlers['userInput/answer'] = async () => ({ status: 'rejected' });
    await assert.rejects(
      host.respondUserInput({ sessionId: 's1', userInputId: 'q1', response: { action: 'answer', answers: [] } }),
      /not accepted/,
    );
    await host.stop();
  } finally { cap.restore(); }
});

test('approvals round-trip through decideApproval', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    const pending = session.approvalHandler({ approvalId: 'a1', kind: 'run', availableChoices: [{ choiceId: 'allow' }, { choiceId: 'deny' }] });
    const emitted = await until(cap.events, (event) => event.event === 'approval' && event.payload.approvalId === 'a1', 'approval');
    assert.equal(typeof emitted.payload.expiresAt, 'number');
    assert.ok(emitted.payload.expiresAt > Date.now(), 'approval deadline is in the future');
    await assert.rejects(() => host.decideApproval({ approvalId: 'a1', choiceId: 'invented' }), /not available/);
    assert.deepEqual(await host.decideApproval({ approvalId: 'a1', choiceId: 'allow' }), { decided: true });
    assert.deepEqual(await pending, { choiceId: 'allow' });
    await assert.rejects(() => host.decideApproval({ approvalId: 'a1', choiceId: 'allow' }), /No pending approval/);
    await host.stop();
  } finally { cap.restore(); }
});

test('approval errors reject the waiter and emit approvalError', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    const pending = assert.rejects(session.approvalHandler({ approvalId: 'a1' }), /denied upstream/);
    await until(cap.events, (event) => event.event === 'approval', 'approval');
    session.approvalErrorHandler({ approvalId: 'a1', error: 'denied upstream' });
    await pending;
    const failure = await until(cap.events, (event) => event.event === 'approvalError', 'approvalError');
    assert.equal(failure.payload.sessionId, sessionId);
    assert.equal(failure.payload.error, 'denied upstream');
    await host.stop();
  } finally { cap.restore(); }
});

test('a failed decide re-pulls pending so a still-open approval re-appears', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    const pending = assert.rejects(
      session.approvalHandler({ approvalId: 'a1', currentRequirementId: 'r1', availableChoices: [{ choiceId: 'allow' }] }),
      /durability fence/,
    );
    await until(cap.events, (event) => event.event === 'approval' && event.payload.approvalId === 'a1', 'approval');
    // The decide did not land: the host still reports the approval pending.
    world.requestHandlers['approval/listPending'] = async () => ({
      userInputs: [],
      approvals: [{ approvalId: 'a1', sessionId, currentRequirementId: 'r1', availableChoices: [{ choiceId: 'allow' }] }],
    });
    session.approvalErrorHandler({ approvalId: 'a1', error: 'approval ledger durability fence', kind: 'submitFailed' });
    await pending;
    const restored = await until(cap.events, (event) => event.event === 'approval' && event.payload.approvalId === 'a1' && event.payload.currentRequirementId === 'r1', 'restored approval');
    assert.ok(restored.payload.expiresAt > Date.now(), 'restored approval carries a fresh deadline');
    await host.stop();
  } finally { cap.restore(); }
});

test('resumeSession reopens live sessions and refreshes their questions', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [question()] });
    const resumed = await host.resumeSession({ sessionId: 's1' });
    assert.equal(resumed.alreadyOpen, true);
    assert.equal(resumed.sessionId, 's1');
    assert.deepEqual(resumed.userInputs, [question()]);
    await until(cap.events, (event) => event.event === 'sessionFacts' && event.payload.sessionId === 's1', 'sessionFacts');
    await host.stop();
  } finally { cap.restore(); }
});

test('resumeSession replays history and resubscribes to live turns', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [] });
    world.makeSession('s9', {
      verb: 'session/resume',
      result: { history: { items: [{ itemId: 'h1' }] }, session: { activeTurnId: 'turn-9' } },
    });
    const resumed = await host.resumeSession({ sessionId: 's9' });
    assert.equal(resumed.alreadyOpen, false);
    const replayed = await until(cap.events, (event) => event.event === 'item' && event.payload.item.itemId === 'h1', 'history item');
    assert.equal(replayed.payload.sessionId, 's9');
    await until(cap.events, (event) => event.event === 'turnCompleted' && event.payload.turnId === 'turn-9', 'resubscribed turn');
    await host.stop();
  } finally { cap.restore(); }
});

test('resumeSession rebuilds transcripts newest-first when history is missing', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [] });
    world.requestHandlers['view/page'] = async (params) => (params.cursor
      ? {
        events: [
          { method: 'item/updated', params: { item: { itemId: 'i1', revision: 1 } } },
          { method: 'item/started', params: { item: { itemId: 'i3', revision: 1 } } },
        ],
        nextCursor: null,
      }
      : {
        events: [
          { method: 'item/started', params: { item: { itemId: 'i1', revision: 2 } } },
          { method: 'item/started', params: { item: { itemId: 'i2', revision: 1 } } },
          { method: 'item/started', params: {} },
        ],
        nextCursor: 'c2',
      });
    world.makeSession('s9', { verb: 'session/resume', result: { history: null, session: {} } });
    const resumed = await host.resumeSession({ sessionId: 's9' });
    assert.deepEqual(world.requests.filter((request) => request.method === 'view/page'), [
      { method: 'view/page', params: { sessionId: 's9', limit: 1000, direction: 'backward' } },
      { method: 'view/page', params: { sessionId: 's9', limit: 1000, direction: 'backward', cursor: 'c2' } },
    ]);
    // Newest seen first; a stale re-emission (i1 rev 1) never clobbers rev 2; emitted oldest-first.
    for (let i = 0; i < 200 && cap.events.filter((event) => event.event === 'item').length < 3; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(
      cap.events.filter((event) => event.event === 'item').map((event) => event.payload.item),
      [{ itemId: 'i3', revision: 1 }, { itemId: 'i2', revision: 1 }, { itemId: 'i1', revision: 2 }],
    );
    assert.equal(resumed.historyCursor, null);
    assert.equal(resumed.historyExhausted, true);
    await host.stop();
  } finally { cap.restore(); }
});

test('pageOlderHistory walks one more backward chunk past the held cursor', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    await host.startSession({ workspaceRoot: '/repo' });
    world.requestHandlers['view/page'] = async (params) => ({
      events: [{ method: 'item/completed', params: { item: { itemId: 'old', revision: 4 } } }],
      nextCursor: params.cursor === 'c-old' ? 'c-older' : null,
    });
    const chunk = await host.pageOlderHistory({ sessionId: 's1', cursor: 'c-old' });
    assert.deepEqual(chunk.items, [{ itemId: 'old', revision: 4 }]);
    // The walk continues past the first page until the view ends.
    assert.equal(chunk.exhausted, true);
    assert.equal(chunk.nextCursor, null);
    // No cursor pages the newest chunk (gap backfill).
    world.requests.length = 0;
    await host.pageOlderHistory({ sessionId: 's1' });
    assert.deepEqual(world.requests[0].params, { sessionId: 's1', limit: 1000, direction: 'backward' });
    world.requestHandlers['view/page'] = async () => { throw new Error('log gone'); };
    await assert.rejects(host.pageOlderHistory({ sessionId: 's1', cursor: 'c-old' }), /unreachable right now/);
    await host.stop();
  } finally { cap.restore(); }
});

test('history rebuild keeps partial transcripts and null when the log is unreachable', async () => {
  const cap = captureEvents();
  try {
    const { host, world } = await startedHost();
    world.requestHandlers['approval/listPending'] = async () => ({ userInputs: [] });
    world.requestHandlers['view/page'] = async () => { throw new Error('log gone'); };
    world.makeSession('empty', { verb: 'session/resume', result: { history: null, session: {} } });
    await host.resumeSession({ sessionId: 'empty' });
    const failure = await until(cap.events, (event) => event.event === 'stderr', 'stderr');
    assert.match(failure.payload.chunk, /history page failed for empty/);
    assert.equal(cap.events.filter((event) => event.event === 'item').length, 0);

    let calls = 0;
    world.requestHandlers['view/page'] = async () => {
      calls += 1;
      if (calls === 1) return { events: [{ method: 'item/started', params: { item: { itemId: 'kept' } } }], nextCursor: 'c2' };
      throw new Error('log cut off');
    };
    world.makeSession('partial', { verb: 'session/resume', result: { history: null, session: {} } });
    await host.resumeSession({ sessionId: 'partial' });
    await until(cap.events, (event) => event.event === 'item' && event.payload.item.itemId === 'kept', 'partial item');
    await host.stop();
  } finally { cap.restore(); }
});

test('factsFromSession maps the durable fold', () => {
  const state = new Map([
    ['session/todoListChanged', { items: [{ text: 'Do it', status: 'pending', activeForm: 'Doing it' }] }],
    ['session/goalChanged', { goal: { objective: 'Ship', currentWork: 'now', nextWork: 'later', percentComplete: 50, status: 'active' } }],
    ['session/contextUsage', { usedTokens: 10, windowTokens: 100, pressure: 'ok' }],
    ['session/tokenUsage', { promptTokens: 3, totalTokens: 4, cumulative: { outputTokens: 5 } }],
    ['session/branchChanged', { branch: 'main' }],
  ]);
  assert.deepEqual(factsFromSession({ sessionId: 's1', fold: { sessionState: state } }), {
    sessionId: 's1',
    plan: [{ id: 'Do it:0', text: 'Do it', status: 'pending', activeForm: 'Doing it' }],
    goal: { objective: 'Ship', currentWork: 'now', nextWork: 'later', percentComplete: 50, status: 'active' },
    context: { usedTokens: 10, windowTokens: 100, pressure: 'ok' },
    usage: { promptTokens: 3, totalTokens: 4, outputTokens: 5 },
    branch: 'main',
  });
});

test('factsFromSession tolerates missing state and cumulative usage', () => {
  assert.deepEqual(factsFromSession({ sessionId: 's1' }), {
    sessionId: 's1', plan: [], goal: null, context: null, usage: null, branch: null,
  });
  const state = new Map([
    ['session/tokenUsage', { cumulative: { promptTokens: 7, totalTokens: 8, outputTokens: 9 } }],
  ]);
  assert.deepEqual(factsFromSession({ sessionId: 's2', fold: { sessionState: state } }).usage, {
    promptTokens: 7, totalTokens: 8, outputTokens: 9,
  });
});

test('isSessionFactNotification recognizes the session fact set', () => {
  for (const method of ['session/todoListChanged', 'session/goalChanged', 'session/contextUsage', 'session/tokenUsage', 'session/branchChanged', 'session/modelChanged']) {
    assert.equal(isSessionFactNotification(method), true);
  }
  assert.equal(isSessionFactNotification('item/started'), false);
  assert.equal(isSessionFactNotification('usage/changed'), false);
});

test('sendTurn dedupes retries sharing a clientTurnId', async () => {
  const { host, world } = await startedHost();
  try {
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const [first, second] = await Promise.all([
      host.sendTurn({ sessionId, text: 'hello', clientTurnId: 'key-1' }),
      host.sendTurn({ sessionId, text: 'hello', clientTurnId: 'key-1' }),
    ]);
    assert.equal(first.turnId, second.turnId);
    assert.equal(second.deduped, true);
    assert.equal(world.sessions.get(sessionId).sentInputs.length, 1);
  } finally {
    await host.stop();
  }
});

test('a failed keyed send releases its key', async () => {
  const { host, world } = await startedHost();
  try {
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const session = world.sessions.get(sessionId);
    const working = session.sendUserTurn;
    session.sendUserTurn = async () => { throw new Error('turn creation blew up'); };
    await assert.rejects(host.sendTurn({ sessionId, text: 'x', clientTurnId: 'key-2' }), /blew up/);
    session.sendUserTurn = working;
    const retry = await host.sendTurn({ sessionId, text: 'x', clientTurnId: 'key-2' });
    assert.ok(retry.turnId);
    assert.equal(retry.deduped, undefined);
    assert.equal(session.sentInputs.length, 1);
  } finally {
    await host.stop();
  }
});

test('cancelTurn releases the session keys so a retry starts fresh', async () => {
  const { host, world } = await startedHost();
  try {
    const { sessionId } = await host.startSession({ workspaceRoot: '/repo' });
    const first = await host.sendTurn({ sessionId, text: 'x', clientTurnId: 'key-3' });
    await host.cancelTurn({ sessionId, turnId: first.turnId });
    const retry = await host.sendTurn({ sessionId, text: 'x', clientTurnId: 'key-3' });
    assert.notEqual(first.turnId, retry.turnId);
    assert.equal(retry.deduped, undefined);
    assert.equal(world.sessions.get(sessionId).sentInputs.length, 2);
  } finally {
    await host.stop();
  }
});

test('idempotency keys are scoped per session', async () => {
  const { host, world } = await startedHost();
  try {
    const a = await host.startSession({ workspaceRoot: '/repo' });
    const b = await host.startSession({ workspaceRoot: '/repo' });
    const [ra, rb] = await Promise.all([
      host.sendTurn({ sessionId: a.sessionId, text: 'x', clientTurnId: 'shared' }),
      host.sendTurn({ sessionId: b.sessionId, text: 'x', clientTurnId: 'shared' }),
    ]);
    assert.equal(ra.deduped, undefined);
    assert.equal(rb.deduped, undefined);
    assert.equal(world.sessions.get(a.sessionId).sentInputs.length, 1);
    assert.equal(world.sessions.get(b.sessionId).sentInputs.length, 1);
  } finally {
    await host.stop();
  }
});

test('Muse stderr and turn errors redact diagnostic canaries before stdout events', async () => {
  const cap = captureEvents();
  let host;
  try {
    const started = await startedHost();
    host = started.host;
    const { world } = started;
    const stderr = world.spawnArgs[0].onStderr;
    stderr('Authorization: Bea');
    assert.equal(cap.events.filter((event) => event.event === 'stderr').length, 0);
    stderr('rer CANARY-MUSE-STDERR\nconnected\n');
    const diagnostics = cap.events.filter((event) => event.event === 'stderr');
    assert.ok(!JSON.stringify(diagnostics).includes('CANARY'));
    assert.ok(diagnostics.some((event) => event.payload.chunk === 'connected'));
    await host.startSession({ workspaceRoot: '/fake/workspace' });
    const session = world.sessions.get('s1');
    session.approvalErrorHandler({ approvalId: 'a1', error: '{"token":"CANARY-APPROVAL"}' });
    assert.ok(!JSON.stringify(cap.events).includes('CANARY'));
  } finally { await host?.stop(); cap.restore(); }
});
