import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Session-truth tests for `packages/muse-bridge/src/host.ts`: handshake
 * capability negotiation + compat reporting, paged `session/list`, durable
 * `session/rename`, pending-approval reconstruction on resume, and the
 * session/event notification forwards. The host is bundled with a fake
 * `@muse-code/sdk` driven per test through `globalThis.fakeTruth`.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-session-truth-'));
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

function serveTail(args = []) {
  const at = args.lastIndexOf('serve');
  assert.ok(at >= 0, `serve missing from ${args.join(' ')}`);
  return args.slice(at);
}

const PIN = 'sha256:bridge-pin';
const { MuseHost, compatFrom, BRIDGE_SDK_VERSION } = await bundle('packages/muse-bridge/src/host.ts', {
  '@muse-code/sdk': `export const spawnMspConnection=(...args)=>globalThis.fakeTruth.spawn(...args);
    export class MuseClient { constructor(connection, options) { return globalThis.fakeTruth.makeClient(connection, options); } }
    export const readSessionDurability=()=>({kind:'durable'});
    export const EXPECTED_SCHEMA_FINGERPRINT=${JSON.stringify(PIN)};`,
  './detect.js': `export * from ${JSON.stringify(resolve('packages/muse-bridge/src/detect.ts'))}; export const resolveMuseBin=()=>"/fake/muse";`,
});

function makeWorld() {
  const world = {
    notifications: null,
    requests: [],
    commands: [],
    requestHandlers: {},
    commandHandlers: {},
    initParams: null,
    initResult: { serverInfo: { name: 'fake' }, museHome: '/fake/home', sessionDurability: 'durable' },
    fpWarning: undefined,
    sessions: new Map(),
    closed: false,
    notify(notification) { world.notifications?.(notification); },
    spawn() {
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
          const handler = world.commandHandlers[method];
          if (handler) return handler(params);
          return { status: 'accepted', commandId: params.commandId };
        },
      };
      return {
        initialize: async (params) => {
          world.initParams = params;
          return { child: { exit: new Promise(() => {}) }, connection, initializeResult: world.initResult, fingerprintWarning: world.fpWarning };
        },
      };
    },
    makeClient(connection) {
      // Like the real MuseClient, register a router so notifications flow.
      connection.onNotification(() => {});
      return {
        async close() { world.closed = true; },
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
        gapHandler: null,
        onApproval(handler) { session.approvalHandler = handler; },
        onApprovalError() {},
        onGapError(handler) { session.gapHandler = handler; },
      };
      world.sessions.set(sessionId, session);
      return session;
    },
  };
  return world;
}

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

async function startedHost(world, initResult) {
  globalThis.fakeTruth = world;
  if (initResult) world.initResult = initResult;
  const host = new MuseHost();
  const started = await host.start(null, null, 'auto');
  return { host, started };
}

test('handshake requests sessionListStream and reports compat on match', async () => {
  const world = makeWorld();
  world.initResult = { serverInfo: { name: 'muse' }, museHome: '/h', sessionDurability: 'durable', schema: { fingerprint: PIN }, grantedCapabilities: ['sessionListStream', 'sessionMcp', 'userShell'] };
  const { host, started } = await startedHost(world);
  try {
    assert.deepEqual(world.initParams.capabilities, { requestedCapabilities: ['sessionListStream', 'sessionMcp', 'userShell'] });
    assert.deepEqual(started.compat, { sdk: BRIDGE_SDK_VERSION, pinned: PIN, served: PIN, state: 'match', granted: ['sessionListStream', 'sessionMcp', 'userShell'] });
    const status = host.status(null, 'auto');
    assert.equal(status.running, true);
    assert.deepEqual(status.compat, started.compat);
  } finally { await host.stop(); }
});

test('startHost forwards posture flags and echoes the effective posture', async () => {
  const world = makeWorld();
  const spawns = [];
  const inner = world.spawn.bind(world);
  world.spawn = (...args) => { spawns.push(args[0]); return inner(); };
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  const started = await host.start(null, null, 'auto', false, { noSessionLog: true, disableWrite: true, disableShell: false, sandboxNetwork: 'restricted' });
  try {
    assert.deepEqual(serveTail(spawns[0].args), ['serve', '--no-session-log', '--disable-write', '--sandbox-network', 'restricted']);
    assert.deepEqual(started.posture, { ephemeralSessions: true, disableWrite: true, disableShell: false, sandboxNetwork: 'restricted' });
    assert.deepEqual(host.status().posture, started.posture);
  } finally { await host.stop(); }
  const plain = await host.start(null, null, 'auto');
  try {
    assert.deepEqual(serveTail(spawns[1].args), ['serve']);
    assert.deepEqual(plain.posture, { ephemeralSessions: false, disableWrite: false, disableShell: false, sandboxNetwork: 'proxy-only' });
  } finally { await host.stop(); }
});

test('compat reports mismatch from the served fingerprint and warning', async () => {
  const world = makeWorld();
  world.initResult = { serverInfo: {}, sessionDurability: 'durable', schema: { fingerprint: 'sha256:newer' }, grantedCapabilities: [] };
  world.fpWarning = { kind: 'schemaFingerprintMismatch', pinned: PIN, served: 'sha256:newer' };
  const { host, started } = await startedHost(world);
  try {
    assert.equal(started.compat.state, 'mismatch');
    assert.equal(started.compat.served, 'sha256:newer');
  } finally { await host.stop(); }
  assert.deepEqual(compatFrom({}), { sdk: BRIDGE_SDK_VERSION, pinned: PIN, served: null, state: 'unknown', granted: [] });
});

test('bridge SDK pin tracks the installed SDK package', async () => {
  const pkg = JSON.parse(await readFile(resolve('node_modules/@muse-code/sdk/package.json'), 'utf8'));
  assert.equal(BRIDGE_SDK_VERSION, pkg.version);
});

test('listSessions pages with cursor and clamps limit to 1..200', async () => {
  const world = makeWorld();
  world.requestHandlers['session/list'] = (params) => ({ sessions: [], nextCursor: null, echo: params });
  const { host } = await startedHost(world);
  try {
    await host.listSessions({ workspaceRoot: '/repo' });
    assert.deepEqual(world.requests.at(-1).params, { limit: 100, workspaceRoot: '/repo' });
    await host.listSessions({ workspaceRoot: '/repo', cursor: 'c1', limit: 500 });
    assert.deepEqual(world.requests.at(-1).params, { limit: 200, workspaceRoot: '/repo', cursor: 'c1' });
    await host.listSessions({ limit: 0 });
    assert.deepEqual(world.requests.at(-1).params, { limit: 100 });
  } finally { await host.stop(); }
});

test('renameSession validates, mints one command id, and passes the result through', async () => {
  const world = makeWorld();
  world.commandHandlers['session/rename'] = (params) => ({ commandId: params.commandId, status: 'accepted', name: 'Canonical Name' });
  const { host } = await startedHost(world);
  try {
    await assert.rejects(() => host.renameSession({ sessionId: '', name: 'x' }), /session id/);
    await assert.rejects(() => host.renameSession({ sessionId: 's', name: '   ' }), /new name/);
    await assert.rejects(() => host.renameSession({ sessionId: 's', name: 'n'.repeat(121) }), /120/);
    const result = await host.renameSession({ sessionId: 's', name: '  spaced   out ' });
    assert.deepEqual(result, { commandId: 'cmd-1', status: 'accepted', name: 'Canonical Name' });
    assert.deepEqual(world.commands.at(-1), { method: 'session/rename', params: { commandId: 'cmd-1', sessionId: 's', name: 'spaced out' } });
  } finally { await host.stop(); }
});

test('renameSession maps unknown-method hosts to an update-the-CLI error', async () => {
  const world = makeWorld();
  world.commandHandlers['session/rename'] = () => { throw new Error('Method not found: session/rename'); };
  const { host } = await startedHost(world);
  try {
    await assert.rejects(() => host.renameSession({ sessionId: 's', name: 'x' }), /does not support durable rename/);
  } finally { await host.stop(); }
});

const PENDING_APPROVAL = {
  approvalId: 'a-restored', sessionId: 's1', turnId: 't1', toolName: 'shell', rawArgs: '{}',
  availableChoices: [{ choiceId: 'allow' }, { choiceId: 'deny' }],
  currentRequirementId: 'req-7',
};

test('resume re-emits pulled approvals and decides them via approval/decide', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({ approvals: [PENDING_APPROVAL], userInputs: [] });
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    const emitted = cap.events.find((event) => event.event === 'approval' && event.payload.approvalId === 'a-restored');
    assert.ok(emitted, 'restored approval is re-emitted');
    await assert.rejects(() => host.decideApproval({ approvalId: 'a-restored', choiceId: 'invented' }), /not available/);
    const decided = await host.decideApproval({ approvalId: 'a-restored', choiceId: 'deny' });
    assert.deepEqual(decided, { decided: true, status: 'accepted' });
    assert.deepEqual(world.commands.at(-1), { method: 'approval/decide', params: { commandId: 'cmd-1', sessionId: 's1', approvalId: 'a-restored', choiceId: 'deny', requirementId: 'req-7' } });
  } finally { cap.restore(); await host.stop(); }
});

test('a live waiter wins over the pulled copy of the same approval', async () => {
  const world = makeWorld();
  const session = world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({ approvals: [PENDING_APPROVAL], userInputs: [] });
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    // The pulled copy parked a restored waiter; a re-issued live notification replaces it.
    const pending = session.approvalHandler({ ...PENDING_APPROVAL, availableChoices: [{ choiceId: 'allow' }, { choiceId: 'deny' }] });
    const emissions = cap.events.filter((event) => event.event === 'approval' && event.payload.approvalId === 'a-restored');
    assert.equal(emissions.length, 2);
    await host.decideApproval({ approvalId: 'a-restored', choiceId: 'allow' });
    assert.deepEqual(await pending, { choiceId: 'allow' });
    assert.ok(!world.commands.some((cmd) => cmd.method === 'approval/decide'), 'live path resolves the handler, not a command');
  } finally { cap.restore(); await host.stop(); }
});

test('a failed restored decision heals its requirement guard via re-pull, then retries clean', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  let pulls = 0;
  world.requestHandlers['approval/listPending'] = () => {
    pulls += 1;
    const currentRequirementId = pulls === 1 ? 'req-7' : 'req-8';
    return { approvals: [{ ...PENDING_APPROVAL, currentRequirementId }], userInputs: [] };
  };
  let decides = 0;
  world.commandHandlers['approval/decide'] = (params) => {
    decides += 1;
    if (params.requirementId !== 'req-8') throw new Error('stale requirement');
    return { status: 'accepted', commandId: params.commandId };
  };
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    await assert.rejects(() => host.decideApproval({ approvalId: 'a-restored', choiceId: 'allow' }), /stale requirement/);
    assert.equal(pulls, 2);
    const retry = await host.decideApproval({ approvalId: 'a-restored', choiceId: 'allow' });
    assert.deepEqual(retry, { decided: true, status: 'accepted' });
    assert.equal(decides, 2);
    assert.equal(world.commands.at(-1).params.requirementId, 'req-8');
  } finally { await host.stop(); }
});

test('concurrent restored decides send exactly one command', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({ approvals: [PENDING_APPROVAL], userInputs: [] });
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    const [first, second] = await Promise.allSettled([
      host.decideApproval({ approvalId: 'a-restored', choiceId: 'allow' }),
      host.decideApproval({ approvalId: 'a-restored', choiceId: 'deny' }),
    ]);
    assert.equal(first.status, 'fulfilled');
    assert.equal(second.status, 'rejected');
    assert.match(String(second.reason), /No pending approval/);
    assert.equal(world.commands.filter((cmd) => cmd.method === 'approval/decide').length, 1);
  } finally { await host.stop(); }
});

test('a re-pull that omits a restored approval prunes it with approvalResolved', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  let pulls = 0;
  world.requestHandlers['approval/listPending'] = () => {
    pulls += 1;
    return { approvals: pulls === 1 ? [PENDING_APPROVAL] : [], userInputs: [] };
  };
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    await host.resumeSession({ sessionId: 's1' });
    const resolved = cap.events.find((event) => event.event === 'approvalResolved');
    assert.deepEqual(resolved?.payload, { approvalId: 'a-restored', sessionId: 's1' });
    await assert.rejects(() => host.decideApproval({ approvalId: 'a-restored', choiceId: 'allow' }), /No pending approval/);
  } finally { cap.restore(); await host.stop(); }
});

test('approval/updated rotates choices for live waiters too', async () => {
  const world = makeWorld();
  const session = world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({ approvals: [], userInputs: [] });
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    const pending = session.approvalHandler({ ...PENDING_APPROVAL, availableChoices: [{ choiceId: 'allow' }, { choiceId: 'deny' }] });
    world.notify({ method: 'approval/updated', params: { approvalId: 'a-restored', sessionId: 's1', currentRequirementId: 'req-9', availableChoices: [{ choiceId: 'allow' }, { choiceId: 'escalate' }] } });
    await assert.rejects(() => host.decideApproval({ approvalId: 'a-restored', choiceId: 'deny' }), /not available/);
    await host.decideApproval({ approvalId: 'a-restored', choiceId: 'escalate' });
    assert.deepEqual(await pending, { choiceId: 'escalate' });
  } finally { await host.stop(); }
});

test('session-truth notifications forward as renderer events; malformed ones are ignored', async () => {
  const world = makeWorld();
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    world.notify({ method: 'session/nameChanged', params: { sessionId: 's', name: 'New' } });
    world.notify({ method: 'session/listChanged', params: { session: { sessionId: 's', name: 'Row' } } });
    world.notify({ method: 'session/statusChanged', params: { sessionId: 's', status: 'running' } });
    world.notify({ method: 'session/modelChanged', params: { sessionId: 's', modelId: 'm', providerId: 'meta' } });
    world.notify({ method: 'session/approvalModeChanged', params: { sessionId: 's', mode: 'denyUnmatched' } });
    world.notify({ method: 'session/reasoningEffortChanged', params: { sessionId: 's', reasoningEffort: 'max' } });
    world.notify({ method: 'account/changed', params: {} });
    world.notify({ method: 'account/loginCompleted', params: {} });
    world.notify({ method: 'session/nameChanged', params: { sessionId: 's' } });
    world.notify({ method: 'session/listChanged', params: {} });
    world.notify({ method: 'session/statusChanged', params: { sessionId: 's', status: 42 } });
    const names = cap.events.filter((event) => event.event === 'sessionName');
    assert.deepEqual(names, [{ type: 'event', event: 'sessionName', payload: { sessionId: 's', name: 'New' } }]);
    assert.deepEqual(cap.events.find((event) => event.event === 'sessionRow')?.payload, { session: { sessionId: 's', name: 'Row' } });
    assert.deepEqual(cap.events.find((event) => event.event === 'sessionStatus')?.payload, { sessionId: 's', status: 'running' });
    assert.deepEqual(cap.events.find((event) => event.event === 'sessionModel')?.payload, { sessionId: 's', modelId: 'm', providerId: 'meta' });
    assert.deepEqual(cap.events.find((event) => event.event === 'sessionApprovalMode')?.payload, { sessionId: 's', mode: 'denyUnmatched' });
    assert.deepEqual(cap.events.find((event) => event.event === 'sessionEffort')?.payload, { sessionId: 's', effort: 'max' });
    assert.equal(cap.events.filter((event) => event.event === 'accountChanged').length, 2);
  } finally { cap.restore(); await host.stop(); }
});

test('recovery notifications forward; healed gaps emit once the fold clears', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({});
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    world.notify({ method: 'turn/retryScheduled', params: { sessionId: 's1', turnId: 't1', attempt: 2, maxAttempts: 5, nextAttempt: 3, reason: 'overloaded', retryDelayMs: 4000 } });
    world.notify({ method: 'session/viewHealthChanged', params: { sessionId: 's1', health: 'Unavailable', noneReason: 'projectionUnavailable' } });
    world.notify({ method: 'session/viewHealthChanged', params: { sessionId: 's1' } });
    assert.deepEqual(cap.events.find((event) => event.event === 'turnRetry')?.payload, { sessionId: 's1', turnId: 't1', attempt: 2, maxAttempts: 5, nextAttempt: 3, reason: 'overloaded', retryDelayMs: 4000 });
    assert.deepEqual(cap.events.find((event) => event.event === 'viewHealth')?.payload, { sessionId: 's1', health: 'Unavailable', noneReason: 'projectionUnavailable' });
    // The gap marker opens a bracket; while the fold still shows the hole,
    // later frames emit nothing; once it clears, one healed event lands.
    world.notify({ method: 'view/gap', params: { sessionId: 's1', after: 'a-cur', next: 'n-cur' } });
    assert.deepEqual(cap.events.find((event) => event.event === 'viewGap')?.payload, { sessionId: 's1', after: 'a-cur', next: 'n-cur' });
    const session = world.sessions.get('s1');
    session.fold.pendingGap = { after: 'a-cur', next: 'n-cur' };
    world.notify({ method: 'session/statusChanged', params: { sessionId: 's1', status: 'running' } });
    assert.equal(cap.events.filter((event) => event.event === 'viewGapHealed').length, 0);
    delete session.fold.pendingGap;
    world.notify({ method: 'session/statusChanged', params: { sessionId: 's1', status: 'running' } });
    assert.deepEqual(cap.events.find((event) => event.event === 'viewGapHealed')?.payload, { sessionId: 's1', after: 'a-cur', next: 'n-cur' });
    // A failed fill reports its reason and exact bounds instead of a bare string.
    const failure = new Error('walk stalled');
    Object.assign(failure, { reason: 'pageStalled', after: 'a-cur', next: 'n-cur' });
    session.gapHandler(failure);
    assert.deepEqual(cap.events.find((event) => event.event === 'gapError')?.payload, { sessionId: 's1', reason: 'pageStalled', after: 'a-cur', next: 'n-cur', error: 'walk stalled' });
  } finally { cap.restore(); await host.stop(); }
});

test('skill/changed forwards a re-list advisory', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({});
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    world.notify({ method: 'skill/changed', params: { sessionId: 's1' } });
    world.notify({ method: 'skill/changed', params: {} });
    const advisories = cap.events.filter((event) => event.event === 'skillChanged');
    assert.deepEqual(advisories, [{ type: 'event', event: 'skillChanged', payload: { sessionId: 's1' } }]);
  } finally { cap.restore(); await host.stop(); }
});

test('approval/updated refreshes a restored waiter and re-emits choices', async () => {
  const world = makeWorld();
  world.makeSession('s1', { verb: 'session/resume', result: { history: { items: [] }, session: { activeTurnId: null } } });
  world.requestHandlers['approval/listPending'] = () => ({ approvals: [PENDING_APPROVAL], userInputs: [] });
  world.commandHandlers['approval/decide'] = (params) => ({ status: 'accepted', commandId: params.commandId });
  const cap = captureEvents();
  globalThis.fakeTruth = world;
  const host = new MuseHost();
  try {
    await host.start(null, null, 'auto');
    await host.resumeSession({ sessionId: 's1' });
    world.notify({ method: 'approval/updated', params: { approvalId: 'a-restored', sessionId: 's1', currentRequirementId: 'req-8', availableChoices: [{ choiceId: 'allow' }] } });
    const updated = cap.events.find((event) => event.event === 'approvalUpdated');
    assert.deepEqual(updated?.payload, { approvalId: 'a-restored', sessionId: 's1', availableChoices: [{ choiceId: 'allow' }] });
    await assert.rejects(() => host.decideApproval({ approvalId: 'a-restored', choiceId: 'deny' }), /not available/);
    await host.decideApproval({ approvalId: 'a-restored', choiceId: 'allow' });
    assert.equal(world.commands.at(-1).params.requirementId, 'req-8');
  } finally { cap.restore(); await host.stop(); }
});

test('status omits compat while the host is stopped', async () => {
  globalThis.fakeTruth = makeWorld();
  const host = new MuseHost();
  const status = host.status(null, 'auto');
  assert.equal(status.running, false);
  assert.ok(!('compat' in status));
});
