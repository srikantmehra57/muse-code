import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * In-app `muse login` device-code flow (`packages/muse-bridge/src/login.ts`):
 * prompt parsing plus start/cancel/completion against a stubbed child process.
 * The Muse binary itself is stubbed out, so no real sign-in is attempted.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-login-'));
after(() => rm(temporary, { recursive: true, force: true }));

const outfile = join(temporary, 'login.mjs');
await build({
  entryPoints: [resolve('packages/muse-bridge/src/login.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  plugins: [{ name: 'test-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => path === './detect.js' ? { path, namespace: 'test-boundary' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, () => ({ contents: `export const resolveMuseBin=()=>"/fake/muse";`, loader: 'ts' }));
  } }],
});
const { LoginFlow, parseLoginPrompt } = await import(pathToFileURL(outfile).href);

const REAL_PROMPT = 'Open this page to sign in:\n  https://auth.meta.com/oauth/device/?code=VSFM-XQQQ\nconfirm this code matches:\n  VSFM-XQQQ\n\nWaiting for approval…\n';

/** A controllable `muse login` child: call `emitOutput`/`exit` to drive the flow. */
function stubSpawn(driven) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.emitOutput = (chunk) => child.stdout.emit('data', Buffer.from(chunk));
    child.exit = (code) => child.emit('close', code);
    driven.push(child);
    return child;
  };
}

test('parseLoginPrompt reads the CLI device-code prompt', () => {
  assert.deepEqual(parseLoginPrompt(REAL_PROMPT), {
    url: 'https://auth.meta.com/oauth/device/?code=VSFM-XQQQ',
    code: 'VSFM-XQQQ',
  });
});

test('parseLoginPrompt waits for both halves', () => {
  assert.equal(parseLoginPrompt('Open this page to sign in:\n'), null);
  assert.equal(parseLoginPrompt('confirm this code matches:\n  VSFM-XQQQ\n'), null);
  assert.equal(parseLoginPrompt(''), null);
});

test('parseLoginPrompt falls back to a bare code pattern', () => {
  assert.deepEqual(parseLoginPrompt('go to https://example.invalid/x and enter ABCD-1234'), {
    url: 'https://example.invalid/x',
    code: 'ABCD-1234',
  });
});

test('start resolves the prompt, then loginDone arrives on approval', async () => {
  const events = [];
  const driven = [];
  const flow = new LoginFlow((event, payload) => events.push([event, payload]));
  const started = flow.start(null, stubSpawn(driven));
  driven[0].emitOutput(REAL_PROMPT);
  assert.deepEqual(await started, {
    url: 'https://auth.meta.com/oauth/device/?code=VSFM-XQQQ',
    code: 'VSFM-XQQQ',
  });
  assert.equal(flow.running, true);
  driven[0].exit(0);
  assert.deepEqual(events, [['loginDone', {}]]);
  assert.equal(flow.running, false);
});

test('stderr warnings cannot inject a decoy prompt', async () => {
  const driven = [];
  const flow = new LoginFlow(() => {});
  const started = flow.start(null, stubSpawn(driven));
  driven[0].stderr.emit('data', Buffer.from('warning: see https://example.invalid/decoy ABCD-0000\n'));
  driven[0].emitOutput(REAL_PROMPT);
  assert.deepEqual(await started, {
    url: 'https://auth.meta.com/oauth/device/?code=VSFM-XQQQ',
    code: 'VSFM-XQQQ',
  });
  flow.cancel();
});

test('start rejects when the CLI exits before showing a code', async () => {
  const events = [];
  const driven = [];
  const flow = new LoginFlow((event, payload) => events.push([event, payload]));
  const started = flow.start(null, stubSpawn(driven));
  driven[0].exit(1);
  await assert.rejects(started, /exited before showing a code/);
  // no completion event for a flow that never produced a prompt
  assert.deepEqual(events, []);
  assert.equal(flow.running, false);
});

test('a second sign-in is refused while one runs', async () => {
  const driven = [];
  const flow = new LoginFlow(() => {});
  const started = flow.start(null, stubSpawn(driven));
  driven[0].emitOutput(REAL_PROMPT);
  await started;
  await assert.rejects(flow.start(null, stubSpawn(driven)), /already in progress/);
  flow.cancel();
});

test('cancel kills the child and reports once', async () => {
  const events = [];
  const driven = [];
  const flow = new LoginFlow((event, payload) => events.push([event, payload]));
  const started = flow.start(null, stubSpawn(driven));
  driven[0].emitOutput(REAL_PROMPT);
  await started;
  assert.deepEqual(flow.cancel(), { cancelled: true });
  assert.equal(driven[0].killed, true);
  driven[0].exit(143);
  assert.deepEqual(events, [['loginError', { error: 'Sign-in was cancelled.' }]]);
  assert.deepEqual(flow.cancel(), { cancelled: false });
});

test('a denied approval surfaces loginError', async () => {
  const events = [];
  const driven = [];
  const flow = new LoginFlow((event, payload) => events.push([event, payload]));
  const started = flow.start(null, stubSpawn(driven));
  driven[0].emitOutput(REAL_PROMPT);
  await started;
  driven[0].exit(1);
  assert.equal(events[0][0], 'loginError');
  assert.match(events[0][1].error, /exited/);
});

test('failed login redacts fragmented stderr before returning its diagnostic', async () => {
  const driven = [];
  const flow = new LoginFlow();
  const started = flow.start(null, stubSpawn(driven));
  driven[0].stderr.emit('data', Buffer.from('Authorization: Bea'));
  driven[0].stderr.emit('data', Buffer.from('rer CANARY-LOGIN\n'));
  driven[0].exit(1);
  await assert.rejects(started, (error) => !error.message.includes('CANARY') && /redacted/.test(error.message));
});

test('login bounds pre-prompt stdout instead of retaining unlimited output', async () => {
  const driven = [];
  const flow = new LoginFlow();
  const started = flow.start(null, stubSpawn(driven));
  driven[0].emitOutput('x'.repeat(32769));
  await assert.rejects(started, /exceeded the diagnostic limit/);
  assert.equal(driven[0].killed, true);
});
