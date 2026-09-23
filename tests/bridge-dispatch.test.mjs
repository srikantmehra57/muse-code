import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Wire-protocol tests for the bridge entrypoint (`packages/muse-bridge/src/index.ts`):
 * JSON-line framing, method routing between the Muse host and ACP agents, and
 * session-ownership tracking. The entrypoint is bundled with stubbed hosts and
 * driven over stdio like the Tauri backend drives the real bridge.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-dispatch-'));
after(() => rm(temporary, { recursive: true, force: true }));

const hostStub = `
export class MuseHost {
  detect() { return { found: true, via: 'muse' }; }
  status() { return { running: true, via: 'muse' }; }
  async readUsage() { return { usage: 'muse-usage' }; }
  async start() { return { server: 'muse-server' }; }
  async stop() { return { stopped: 'muse' }; }
  async listSessions() { return { sessions: [{ sessionId: 'muse-listed' }] }; }
  async listModels() { return { models: 'muse-models' }; }
  async startSession() { return { sessionId: 'muse-owned' }; }
  async resumeSession(options) { return { sessionId: options.sessionId, resumed: 'muse' }; }
  async sendTurn(options) {
    if (options.text === 'throw-credential') throw new Error('Authorization: Bearer CANARY-DISPATCH');
    if (options.text === 'throw-known-key') throw new Error('rejected CANARY-KNOWN-KEY');
    if (options.text === 'throw-string') throw 'plain-string-boom';
    if (options.text === 'crash-async') setTimeout(() => { throw new Error('Authorization: Bearer CANARY-CRASH'); }, 10);
    if (options.text === 'throw-msp') {
      const msp = new Error('server says overloaded');
      msp.kind = 'overloaded';
      msp.retryable = true;
      throw new Error('friendly wrapper', { cause: msp });
    }
    return { turnId: 'muse-turn', via: 'muse', ...(options.ifBusy ? { ifBusy: options.ifBusy } : {}) };
  }
  async steerTurn(options) { return { turnId: 'muse-steered', via: 'muse', text: options.text }; }
  async unqueueTurn(options) { return { turnId: options.turnId, unqueued: true, via: 'muse' }; }
  async forkSession(options) { return { sessionId: 'fork-1', via: 'muse', cut: options.lastTurnId ?? null }; }
  async compactSession() { return { status: 'admitted', via: 'muse' }; }
  async readSession(options) { return { session: { sessionId: options.sessionId }, via: 'muse' }; }
  async pageOlderHistory(options) { return { items: [], via: 'muse', cursor: options.cursor }; }
  async listSkills(options) { return { skills: [], via: 'muse', session: options.sessionId }; }
  async mcpServers() { return { servers: [], via: 'muse' }; }
  async userShell(options) { return { commandId: 'cmd-1', status: 'accepted', via: 'muse', command: options.commandText }; }
  async readOutput(options) { return { content: 'full', via: 'muse', offset: options.offsetBytes ?? 0 }; }
  async setReasoningEffort(options) { return { status: 'accepted', via: 'muse', tier: options.reasoningEffort }; }
  async subagentControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async taskControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async workflowControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async goalControl(options) { return { status: 'accepted', via: 'muse', action: options.action }; }
  async cancelTurn() { return { cancelled: 'muse' }; }
  async respondUserInput() { return { status: 'accepted', via: 'muse' }; }
  decideApproval() { return { decided: 'muse' }; }
  async setApprovalMode() { return { mode: 'muse-mode' }; }
  async setModel() { return { model: 'muse-model' }; }
  async renameSession(options) { return { name: options.name, via: 'muse' }; }
}`;

const acpStub = `
export class AcpAgentHost {
  constructor(spec, bin, emit) { this.spec = spec; this.bin = bin; }
  ownsApproval(approvalId) { return approvalId.indexOf('acp-') === 0; }
  decideApproval() { return { decided: 'acp' }; }
  async start() {}
  isolation() { return { env: 'minimal', osSandbox: 'unavailable', platform: 'test', cwd: '/tmp', consentRequired: true }; }
  async stop() { return { stopped: 'acp' }; }
  async listSessions() { return { sessions: [{ sessionId: 'acp-listed' }] }; }
  async listModels() { return { models: 'acp-models' }; }
  async startSession() { return { sessionId: 'acp-owned' }; }
  async resumeSession(options) { return { sessionId: options.sessionId, resumed: 'acp' }; }
  async sendTurn() { return { turnId: 'acp-turn', via: 'acp' }; }
  async cancelTurn() { return { cancelled: 'acp' }; }
  async setModel() { return { model: 'acp-model' }; }
  async setEffort(sessionId, value) { return { effort: value, via: 'acp' }; }
  async setMode(sessionId, value) { return { mode: value, via: 'acp' }; }
  async setOption(sessionId, option, value) { return { option, value, via: 'acp' }; }
}`;

const agentsStub = `
const SPECS = {
  muse: { id: 'muse', name: 'Muse', protocol: 'msp' },
  opencode: { id: 'opencode', name: 'OpenCode', protocol: 'acp' },
  gemini: { id: 'gemini', name: 'Gemini CLI', protocol: 'acp' },
  weird: { id: 'weird', name: 'Weird', protocol: 'msp' },
};
export function agentSpec(id) {
  const spec = SPECS[id];
  if (!spec) throw new Error('Unknown agent: ' + id);
  return spec;
}
export function resolveAgentBin(spec) { return spec.id === 'opencode' ? '/fake/opencode' : null; }
export function detectAgents() { return [{ id: 'muse' }, { id: 'opencode' }]; }`;

const loginStub = `
export class LoginFlow {
  async start() { return { url: 'https://stub.invalid', code: 'STUB-CODE' }; }
  cancel() { return { cancelled: false }; }
}`;
const replacements = { './host.js': hostStub, './acp.js': acpStub, './agents.js': agentsStub, './login.js': loginStub };
const outfile = join(temporary, 'bridge.mjs');
await build({
  entryPoints: [resolve('packages/muse-bridge/src/index.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  plugins: [{ name: 'test-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/muse-bridge/src') }));
  } }],
});

function link(child) {
  let buffer = '';
  const waiters = new Map();
  const stderr = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id ?? null);
      if (waiter) { waiters.delete(message.id ?? null); waiter(message); }
    }
  });
  const pending = (id, write) => new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`timed out waiting for response ${String(id)}${stderr.length ? `: ${stderr.join('')}` : ''}`));
    }, 5000);
    waiters.set(id, (message) => { clearTimeout(timer); resolvePromise(message); });
    write();
  });
  let sequence = 0;
  return {
    request: (method, params, extra = {}) => {
      const id = `t${sequence++}`;
      const line = params === undefined ? { id, method, ...extra } : { id, method, params, ...extra };
      return pending(id, () => child.stdin.write(`${JSON.stringify(line)}\n`));
    },
    raw: (line) => pending(null, () => child.stdin.write(`${line}\n`)),
    send: (line) => child.stdin.write(`${line}\n`),
    stderr,
  };
}

async function withBridge(body) {
  const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await body(link(child));
  } finally {
    child.stdin.end();
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 2000))]);
    if (child.exitCode === null) child.kill();
  }
}

test('an expired deadline fails before dispatch', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('ping', undefined, { deadlineMs: 1 });
    assert.equal(response.ok, false);
    assert.match(response.error, /deadline/);
  });
});

test('startSession replays an idempotency key', async () => {
  await withBridge(async (bridge) => {
    const first = await bridge.request('startSession', { workspaceRoot: '/repo', clientRequestId: 'create-1' });
    const second = await bridge.request('startSession', { workspaceRoot: '/other', clientRequestId: 'create-1' });
    assert.deepEqual(first.result, second.result);
    assert.equal(first.result.sessionId, 'muse-owned');
  });
});

test('ping answers without params', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('ping');
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { pong: true });
  });
});

test('blank lines are ignored', async () => {
  await withBridge(async (bridge) => {
    bridge.send('');
    bridge.send('   ');
    const response = await bridge.request('ping');
    assert.deepEqual(response.result, { pong: true });
  });
});

test('invalid JSON reports id null and the bridge keeps serving', async () => {
  await withBridge(async (bridge) => {
    const bad = await bridge.raw('{not json');
    assert.equal(bad.id, null);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Invalid JSON/);
    const response = await bridge.request('ping');
    assert.deepEqual(response.result, { pong: true });
  });
});

test('unknown methods fail closed', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('bogus');
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Unknown method: bogus');
  });
});

test('non-Error failures serialize through String()', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('sendTurn', { sessionId: 'muse-owned', text: 'throw-string' });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'plain-string-boom');
  });
});

test('detect merges host detection with the agent list', async () => {
  await withBridge(async (bridge) => {
    const response = await bridge.request('detect', {});
    assert.equal(response.ok, true);
    assert.equal(response.result.found, true);
    assert.deepEqual(response.result.agents, [{ id: 'muse' }, { id: 'opencode' }]);
    const agents = await bridge.request('listAgents', {});
    assert.deepEqual(agents.result, { agents: [{ id: 'muse' }, { id: 'opencode' }] });
  });
});

test('requests default to the Muse host', async () => {
  await withBridge(async (bridge) => {
    assert.deepEqual((await bridge.request('startHost', {})).result, { server: 'muse-server' });
    assert.deepEqual((await bridge.request('status', {})).result, { running: true, via: 'muse' });
    assert.deepEqual((await bridge.request('usage', {})).result, { usage: 'muse-usage' });
    assert.deepEqual((await bridge.request('listModels', {})).result, { models: 'muse-models' });
    assert.deepEqual((await bridge.request('stopHost', {})).result, { stopped: 'muse' });
  });
});

test('an explicit agent id starts an ACP session and claims it', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/repo' });
    assert.equal(started.ok, true);
    assert.equal(started.result.sessionId, 'acp-owned');
    // The claimed session routes back to its owner without an explicit agent id.
    const turn = await bridge.request('sendTurn', { sessionId: 'acp-owned', text: 'hi' });
    assert.deepEqual(turn.result, { turnId: 'acp-turn', via: 'acp' });
    const resumed = await bridge.request('resumeSession', { sessionId: 'acp-owned', workspaceRoot: '/repo' });
    assert.deepEqual(resumed.result, { sessionId: 'acp-owned', resumed: 'acp' });
  });
});

test('listed sessions are claimed for their agent', async () => {
  await withBridge(async (bridge) => {
    const listed = await bridge.request('listSessions', { agentId: 'opencode' });
    assert.deepEqual(listed.result, { sessions: [{ sessionId: 'acp-listed' }] });
    const turn = await bridge.request('sendTurn', { sessionId: 'acp-listed', text: 'hi' });
    assert.deepEqual(turn.result, { turnId: 'acp-turn', via: 'acp' });
    await bridge.request('listSessions', {});
    const museTurn = await bridge.request('sendTurn', { sessionId: 'muse-listed', text: 'hi' });
    assert.deepEqual(museTurn.result, { turnId: 'muse-turn', via: 'muse' });
  });
});

test('session ownership beats an explicit agent id', async () => {
  await withBridge(async (bridge) => {
    await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/repo' });
    const turn = await bridge.request('sendTurn', { sessionId: 'acp-owned', agentId: 'muse', text: 'hi' });
    assert.deepEqual(turn.result, { turnId: 'acp-turn', via: 'acp' });
  });
});

test('approvals route to the agent that owns them', async () => {
  await withBridge(async (bridge) => {
    // Touch the ACP host first so it exists for the ownership search.
    await bridge.request('startHost', { agentId: 'opencode' });
    const acp = await bridge.request('decideApproval', { approvalId: 'acp-9', choiceId: 'c' });
    assert.deepEqual(acp.result, { decided: 'acp' });
    const muse = await bridge.request('decideApproval', { approvalId: 'muse-9', choiceId: 'c' });
    assert.deepEqual(muse.result, { decided: 'muse' });
  });
});

test('question responses require a response object', async () => {
  await withBridge(async (bridge) => {
    const missing = await bridge.request('respondUserInput', { sessionId: 'muse-owned', userInputId: 'q' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'Question response is required.');
    const accepted = await bridge.request('respondUserInput', { sessionId: 'muse-owned', userInputId: 'q', response: { action: 'cancel' } });
    assert.deepEqual(accepted.result, { status: 'accepted', via: 'muse' });
  });
});

test('setSessionOption routes by protocol', async () => {
  await withBridge(async (bridge) => {
    const muse = await bridge.request('setSessionOption', { sessionId: 'muse-owned', option: 'effort', value: 'high' });
    assert.equal(muse.ok, false);
    assert.equal(muse.error, 'Muse sessions use setModel/setApprovalMode.');
    const effort = await bridge.request('setSessionOption', { agentId: 'opencode', sessionId: 's', option: 'effort', value: 'high' });
    assert.deepEqual(effort.result, { effort: 'high', via: 'acp' });
    const mode = await bridge.request('setSessionOption', { agentId: 'opencode', sessionId: 's', option: 'mode', value: 'plan' });
    assert.deepEqual(mode.result, { mode: 'plan', via: 'acp' });
    const option = await bridge.request('setSessionOption', { agentId: 'opencode', sessionId: 's', option: 'temperature', value: '0.2' });
    assert.deepEqual(option.result, { option: 'temperature', value: '0.2', via: 'acp' });
  });
});

test('ACP hosts start, stop, and reject unsupported methods', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startHost', { agentId: 'opencode' });
    assert.equal(started.result.started, true);
    assert.equal(started.result.agentId, 'opencode');
    assert.equal(started.result.isolation.env, 'minimal');
    const stopped = await bridge.request('stopHost', { agentId: 'opencode' });
    assert.deepEqual(stopped.result, { stopped: 'acp' });
    const usage = await bridge.request('usage', { agentId: 'opencode' });
    assert.equal(usage.ok, false);
    assert.equal(usage.error, 'OpenCode does not support usage.');
  });
});

test('unknown, missing, and non-ACP agents fail with guidance', async () => {
  await withBridge(async (bridge) => {
    const unknown = await bridge.request('listSessions', { agentId: 'nopez' });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, 'Unknown agent: nopez');
    const missing = await bridge.request('listSessions', { agentId: 'gemini' });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, 'Gemini CLI is not installed. Install it, then choose Rescan.');
    const protocol = await bridge.request('listSessions', { agentId: 'weird' });
    assert.equal(protocol.ok, false);
    assert.equal(protocol.error, 'Weird is not an ACP agent.');
  });
});

test('a native-injected agent binary bypasses self-resolution', async () => {
  await withBridge(async (bridge) => {
    // Gemini self-resolution returns null in the stub, so this only starts
    // when the injected canonical path is honored.
    const started = await bridge.request('startHost', { agentId: 'gemini', agentBin: '/native/gemini' });
    assert.equal(started.result.started, true);
    assert.equal(started.result.agentId, 'gemini');
  });
});

test('steerTurn and unqueueTurn route to the Muse host', async () => {
  await withBridge(async (bridge) => {
    const steered = await bridge.request('steerTurn', { sessionId: 's', text: 'more tests' });
    assert.deepEqual(steered.result, { turnId: 'muse-steered', via: 'muse', text: 'more tests' });
    const reclaimed = await bridge.request('unqueueTurn', { sessionId: 's', turnId: 't-1' });
    assert.deepEqual(reclaimed.result, { turnId: 't-1', unqueued: true, via: 'muse' });
  });
});

test('sendTurn validates the busy disposition and ACP rejects queue verbs', async () => {
  await withBridge(async (bridge) => {
    const queued = await bridge.request('sendTurn', { sessionId: 's', text: 'later', ifBusy: 'queue' });
    assert.equal(queued.result.ifBusy, 'queue');
    const bad = await bridge.request('sendTurn', { sessionId: 's', text: 'x', ifBusy: 'wait' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /Busy disposition/);
    const acp = await bridge.request('steerTurn', { agentId: 'opencode', sessionId: 's', text: 'x' });
    assert.equal(acp.ok, false);
    assert.match(acp.error, /does not support queued turns/);
    const acpUnqueue = await bridge.request('unqueueTurn', { agentId: 'opencode', sessionId: 's', turnId: 't' });
    assert.equal(acpUnqueue.ok, false);
    assert.match(acpUnqueue.error, /does not support queued turns/);
  });
});

test('fork/compact/read route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const forked = await bridge.request('forkSession', { sessionId: 's', lastTurnId: 't-3' });
    assert.deepEqual(forked.result, { sessionId: 'fork-1', via: 'muse', cut: 't-3' });
    const compacted = await bridge.request('compactSession', { sessionId: 's' });
    assert.deepEqual(compacted.result, { status: 'admitted', via: 'muse' });
    const read = await bridge.request('readSession', { sessionId: 's', excludeItems: false });
    assert.deepEqual(read.result, { session: { sessionId: 's' }, via: 'muse' });
    for (const method of ['forkSession', 'compactSession', 'readSession']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('readOutput/setReasoningEffort route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const output = await bridge.request('readOutput', { sessionId: 's', itemId: 'i', outputRef: 'r', offsetBytes: 8 });
    assert.deepEqual(output.result, { content: 'full', via: 'muse', offset: 8 });
    const effort = await bridge.request('setReasoningEffort', { sessionId: 's', reasoningEffort: 'low' });
    assert.deepEqual(effort.result, { status: 'accepted', via: 'muse', tier: 'low' });
    for (const method of ['readOutput', 'setReasoningEffort']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('pageHistory routes to the Muse host and ACP rejects it', async () => {
  await withBridge(async (bridge) => {
    const chunk = await bridge.request('pageHistory', { sessionId: 's', cursor: 'c-old' });
    assert.deepEqual(chunk.result, { items: [], via: 'muse', cursor: 'c-old' });
    const acp = await bridge.request('pageHistory', { agentId: 'opencode', sessionId: 's', cursor: 'c-old' });
    assert.equal(acp.ok, false);
    assert.match(acp.error, /does not support this session operation/);
  });
});

test('failures keep the MSP kind and retryability beside the message', async () => {
  await withBridge(async (bridge) => {
    const failed = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-msp' });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'friendly wrapper');
    assert.equal(failed.code, 'overloaded');
    assert.equal(failed.retryable, true);
    const plain = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-string' });
    assert.equal(plain.ok, false);
    assert.equal(plain.code, undefined);
  });
});

test('ecosystem verbs route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const skills = await bridge.request('listSkills', { sessionId: 's' });
    assert.deepEqual(skills.result, { skills: [], via: 'muse', session: 's' });
    const servers = await bridge.request('mcpServers', {});
    assert.deepEqual(servers.result, { servers: [], via: 'muse' });
    const shell = await bridge.request('userShell', { sessionId: 's', commandText: 'git status --short' });
    assert.deepEqual(shell.result, { commandId: 'cmd-1', status: 'accepted', via: 'muse', command: 'git status --short' });
    for (const method of ['listSkills', 'mcpServers', 'userShell']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('oversight verbs route to the Muse host and ACP rejects them', async () => {
  await withBridge(async (bridge) => {
    const subagent = await bridge.request('subagentControl', { sessionId: 's', subagentId: 'k', action: 'stop' });
    assert.deepEqual(subagent.result, { status: 'accepted', via: 'muse', action: 'stop' });
    const task = await bridge.request('taskControl', { sessionId: 's', action: 'stopAll' });
    assert.deepEqual(task.result, { status: 'accepted', via: 'muse', action: 'stopAll' });
    const workflow = await bridge.request('workflowControl', { sessionId: 's', workflowRunId: 'r', action: 'cancel' });
    assert.deepEqual(workflow.result, { status: 'accepted', via: 'muse', action: 'cancel' });
    const goal = await bridge.request('goalControl', { sessionId: 's', action: 'pause' });
    assert.deepEqual(goal.result, { status: 'accepted', via: 'muse', action: 'pause' });
    for (const method of ['subagentControl', 'taskControl', 'workflowControl', 'goalControl']) {
      const acp = await bridge.request(method, { agentId: 'opencode', sessionId: 's' });
      assert.equal(acp.ok, false);
      assert.match(acp.error, /does not support this session operation/);
    }
  });
});

test('renameSession routes to the Muse host', async () => {
  await withBridge(async (bridge) => {
    const renamed = await bridge.request('renameSession', { sessionId: 'muse-owned', name: 'New name' });
    assert.equal(renamed.ok, true);
    assert.deepEqual(renamed.result, { name: 'New name', via: 'muse' });
    // Claimed ACP sessions do not reach the Muse rename path.
    await bridge.request('startSession', { agentId: 'opencode', workspaceRoot: '/repo' });
    const acp = await bridge.request('renameSession', { sessionId: 'acp-owned', name: 'Nope' });
    assert.equal(acp.ok, false);
    assert.equal(acp.error, 'OpenCode does not support renameSession.');
  });
});

test('login verbs route to the login flow', async () => {
  await withBridge(async (bridge) => {
    const started = await bridge.request('startLogin', { museBin: '/fake/muse' });
    assert.equal(started.ok, true);
    assert.deepEqual(started.result, { url: 'https://stub.invalid', code: 'STUB-CODE' });
    const cancelled = await bridge.request('cancelLogin');
    assert.deepEqual(cancelled.result, { cancelled: false });
  });
});


test('dispatch failures redact labelled and natively supplied credential canaries', async () => {
  await withBridge(async (bridge) => {
    const labelled = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-credential' });
    assert.equal(labelled.ok, false);
    assert.ok(!JSON.stringify(labelled).includes('CANARY'));
    await bridge.request('startHost', { museApiKey: 'CANARY-KNOWN-KEY' });
    const known = await bridge.request('sendTurn', { sessionId: 's', text: 'throw-known-key' });
    assert.equal(known.ok, false);
    assert.ok(!JSON.stringify(known).includes('CANARY'));
  });
});

test('an uncaught async crash reports a redacted bridgeExit, not a raw stack', async () => {
  const child = spawn(process.execPath, [outfile], { stdio: ['pipe', 'pipe', 'pipe'] });
  const bridge = link(child);
  try {
    const turn = await bridge.request('sendTurn', { sessionId: 's', text: 'crash-async' });
    assert.equal(turn.ok, true);
    // `raw('')` parks a waiter on the next id-less message: the crash event.
    const event = await bridge.raw('');
    assert.equal(event.type, 'event');
    assert.equal(event.event, 'bridgeExit');
    assert.ok(!JSON.stringify(event).includes('CANARY'));
    await Promise.race([new Promise((r) => child.on('exit', r)), new Promise((r) => setTimeout(r, 3000))]);
    assert.ok(!bridge.stderr.join('').includes('CANARY'), bridge.stderr.join(''));
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
});
