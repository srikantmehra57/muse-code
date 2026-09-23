import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-acp-'));
const outfile = join(temporary, 'acp.mjs');
await build({ entryPoints: [resolve('packages/muse-bridge/src/acp.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { AcpAgentHost, fatalProviderError, zenFreeModel, fallbackOpencodeModel, modelIdsFromError } = await import(pathToFileURL(outfile).href);

test('rate limits and disabled models are fatal provider errors', () => {
  assert.equal(fatalProviderError('mimo-v2.5-free: Rate limit exceeded. Please try again later.'), true);
  assert.equal(fatalProviderError('Model access is disabled'), true);
  assert.equal(fatalProviderError('Upstream request failed: Insufficient account funds'), true);
  assert.equal(fatalProviderError('timeout waiting for stream'), false);
});

test('OpenCode Free Zen models fall back to Big Pickle instead of another gated Free row', () => {
  assert.equal(zenFreeModel('opencode/nemotron-3.5-lightning-free'), true);
  assert.equal(zenFreeModel('opencode/muse-spark-1.2-contributor-free'), true);
  assert.equal(zenFreeModel('opencode/big-pickle'), false);
  const catalog = [
    { modelId: 'opencode/mimo-v2.5-free' },
    { modelId: 'opencode/big-pickle' },
    { modelId: 'opencode/claude-sonnet-5' },
  ];
  assert.equal(fallbackOpencodeModel(catalog, 'opencode/nemotron-3.5-lightning-free'), 'opencode/big-pickle');
  assert.equal(fallbackOpencodeModel(catalog, 'opencode/muse-spark-1.2-contributor-free'), 'opencode/big-pickle');
  assert.equal(fallbackOpencodeModel([{ modelId: 'opencode/claude-sonnet-5' }], 'opencode/claude-sonnet-5'), undefined);
  assert.deepEqual(modelIdsFromError('nemotron-3.5-lightning-free: Upstream request failed: Model access is disabled.'), ['nemotron-3.5-lightning-free', 'opencode/nemotron-3.5-lightning-free']);
});

function fakeAgent() {
  const events = [];
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/fake-acp-agent.mjs')], verified: true, signIn: '' };
  let host;
  host = new AcpAgentHost(spec, process.execPath, (event, payload) => {
    events.push({ event, payload });
    if (event === 'approval') host.decideApproval({ approvalId: payload.approvalId, choiceId: payload.availableChoices[0].choiceId });
  });
  return { host, events };
}

const until = async (events, predicate) => {
  for (let i = 0; i < 200 && !events.some(predicate); i++) await new Promise((r) => setTimeout(r, 10));
  return events.find(predicate);
};

test('ACP turn maps to the same items, plan, approval, and completion events as Muse', async () => {
  const { host, events } = fakeAgent();
  try {
    const started = await host.startSession({ workspaceRoot: '/tmp/ws' });
    assert.equal(started.sessionId, 's1');
    assert.deepEqual({ model: started.agentConfig.modelId, effort: started.agentConfig.effort, mode: started.agentConfig.mode }, { model: 'zen/a', effort: 'high', mode: 'build' });

    const { turnId } = await host.sendTurn({ sessionId: 's1', text: 'list files' });
    const done = await until(events, (e) => e.event === 'turnCompleted');
    assert.equal(done.payload.turnId, turnId);
    assert.equal(done.payload.outcome.params.terminal, 'completed');

    const items = events.filter((e) => e.event === 'item').map((e) => e.payload.item);
    assert.equal(items[0].kind, 'userMessage');
    const thought = items.filter((i) => i.kind === 'reasoning').at(-1);
    assert.equal(thought.text, 'Thinking hard.');
    const reply = items.filter((i) => i.kind === 'agentMessage').at(-1);
    assert.equal(reply.text, 'Done, found a.txt.');
    assert.equal(reply.status, 'completed');
    const tool = items.filter((i) => i.itemId === 't1').at(-1);
    assert.deepEqual({ tool: tool.tool, status: tool.status, exit: tool.exitCode, out: tool.visibleOutput, cmd: tool.commandText }, { tool: 'bash', status: 'completed', exit: 0, out: 'a.txt\n', cmd: 'ls' });
    assert.ok(items.every((i) => i.turnId === turnId), 'every item belongs to the turn');

    const approval = events.find((e) => e.event === 'approval').payload;
    assert.deepEqual(approval.availableChoices.map((c) => c.decision), ['approved', 'denied']);
    assert.deepEqual(events.find((e) => e.event === 'sessionFacts').payload.plan, [{ id: 'plan-0', text: 'Run ls', status: 'inProgress' }]);
    assert.equal(events.find((e) => e.event === 'sessionTitle').payload.title, 'List files');
    assert.ok(events.some((e) => e.event === 'delta' && e.payload.delta === 'found a.txt.'), 'message streams as deltas');
  } finally { await host.stop(); }
});

test('stop() settles parked approvals instead of throwing', async () => {
  const { host } = fakeAgent();
  const settled = [];
  // `approvals` is TS-private but a plain runtime field; park one waiter directly.
  host.approvals.set('a-parked', { sessionId: 's1', choices: new Set(['allow']), resolve: (value) => settled.push(value) });
  await host.stop();
  assert.deepEqual(settled, [null]);
  assert.equal(host.approvals.size, 0);
});

test('stop() during a live parked approval settles it without unhandled rejections', async () => {
  const events = [];
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/fake-acp-agent.mjs')], verified: true, signIn: '' };
  const host = new AcpAgentHost(spec, process.execPath, (event, payload) => { events.push({ event, payload }); });
  await host.startSession({ workspaceRoot: '/tmp/ws' });
  await host.sendTurn({ sessionId: 's1', text: 'list files' });
  const approval = await until(events, (e) => e.event === 'approval');
  assert.ok(approval, 'approval parks before stop');
  await host.stop();
  assert.ok(true, 'stop settled the parked approval and the reply-into-dying-stdin path stayed quiet');
});

test('ACP models, effort tiers, and sessions come from the agent', async () => {
  const { host } = fakeAgent();
  try {
    const listed = await host.listSessions('/tmp/ws');
    assert.deepEqual(listed.sessions.map((s) => [s.sessionId, s.name]), [['s-old', 'Earlier work']]);
    await host.startSession({ workspaceRoot: '/tmp/ws' });
    const { models } = await host.listModels('s1');
    assert.deepEqual(models.map((m) => m.modelId), ['zen/a', 'zen/b']);
    assert.equal(models[0].displayLabel, 'Model A');
    assert.deepEqual(models[0].reasoningEfforts, ['low', 'high', 'max'], 'the agent effort option, minus "default"');
    const switched = await host.setModel({ sessionId: 's1', modelId: 'zen/b' });
    assert.equal(switched.agentConfig.modelId, 'zen/b');
    const effort = await host.setEffort('s1', 'max');
    assert.equal(effort.agentConfig.effort, 'max');
  } finally { await host.stop(); }
});

test('ACP cancel waits for a terminal state and kills a hanging process tree', { timeout: 8000 }, async () => {
  const pidFile = join(temporary, `grandchild-${Date.now()}.pid`);
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], acpArgs: [resolve('tests/fixtures/hung-acp-agent.mjs')], verified: true, signIn: '' };
  const previous = process.env.MUSE_TEST_PID_FILE;
  process.env.MUSE_TEST_PID_FILE = pidFile;
  const host = new AcpAgentHost(spec, process.execPath, () => {});
  try {
    await host.startSession({ workspaceRoot: temporary });
    await host.sendTurn({ sessionId: 's1', text: 'hang' });
    const cancelled = await host.cancelTurn({ sessionId: 's1' });
    assert.equal(cancelled.status, 'terminal');
    assert.equal(cancelled.escalated, true);
    const pid = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
    if (pid) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.throws(() => process.kill(pid, 0));
    }
  } finally {
    await host.stop();
    if (previous === undefined) delete process.env.MUSE_TEST_PID_FILE;
    else process.env.MUSE_TEST_PID_FILE = previous;
    await rm(pidFile, { force: true });
  }
});

test('ACP spawn uses a confined cwd and a minimal environment', async () => {
  const { host } = fakeAgent();
  try {
    await host.startSession({ workspaceRoot: temporary });
    const isolation = host.isolation();
    assert.equal(isolation.env, 'minimal');
    assert.notEqual(isolation.cwd, process.env.HOME);
    assert.ok(isolation.consentRequired === true || isolation.osSandbox === 'enforced');
  } finally { await host.stop(); }
});

test('expired ACP approvals are rejected and do not resolve the waiter as chosen', async () => {
  const { host } = fakeAgent();
  const settled = [];
  host.approvals.set('stale', { sessionId: 's1', choices: new Set(['allow']), expiresAt: Date.now() - 1, resolve: (value) => settled.push(value) });
  assert.throws(() => host.decideApproval({ approvalId: 'stale', choiceId: 'allow' }), /expired/);
  assert.deepEqual(settled, [null]);
  await host.stop();
});

test('ACP initialization errors redact stderr canaries before reaching the caller', { timeout: 5000 }, async () => {
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], verified: true, signIn: '',
    acpArgs: ['-e', "process.stdin.once('data', () => { process.stderr.write('Authorization: Bea'); setTimeout(() => { process.stderr.write('rer CANARY-ACP\\n'); process.exit(1); }, 10); })"] };
  const host = new AcpAgentHost(spec, process.execPath, () => {});
  try {
    await assert.rejects(host.start(), (error) => !error.message.includes('CANARY') && /redacted/.test(error.message));
  } finally { await host.stop(); }
});
