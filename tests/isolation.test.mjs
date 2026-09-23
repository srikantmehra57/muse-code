import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-isolation-'));
const outfile = join(temporary, 'isolation.mjs');
await build({ entryPoints: [resolve('packages/muse-bridge/src/isolation.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const {
  filterChildEnv, confinedCwd, approvalAlive, approvalExpiry, describeIsolation, HOST_QUEUE_LIMIT,
  buildSeatbeltProfile, buildBwrapArgs, withoutNested, wrapSandboxedCommand, sandboxBackend,
  terminateTree, WINDOWS_JOB_SUPERVISOR,
} = await import(pathToFileURL(outfile).href);

test('child env keeps PATH/HOME and strips unrelated secrets', () => {
  const env = filterChildEnv({
    PATH: '/usr/bin',
    HOME: '/Users/me',
    META_API_KEY: 'sk-muse',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    GITHUB_TOKEN: 'ghp_secret',
    NODE_OPTIONS: '--require ./evil.js',
    XAI_API_KEY: 'xai-key',
  }, 'grok');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/Users/me');
  assert.equal(env.XAI_API_KEY, 'xai-key');
  assert.equal('META_API_KEY' in env, false);
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
  assert.equal('GITHUB_TOKEN' in env, false);
  assert.equal('NODE_OPTIONS' in env, false);
});

test('Muse children may receive META_API_KEY and nothing else secret', () => {
  const env = filterChildEnv({ META_API_KEY: 'sk-muse', AWS_SECRET_ACCESS_KEY: 'aws', PATH: '/bin' }, 'muse');
  assert.equal(env.META_API_KEY, 'sk-muse');
  assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
});

test('confined cwd never falls back to the home directory', () => {
  const cwd = confinedCwd('/definitely-missing-workspace');
  assert.notEqual(cwd, process.env.HOME);
  assert.ok(cwd.length > 0);
});

test('approval expiry rejects stale decisions', () => {
  const expires = approvalExpiry(1_000, 10);
  assert.equal(approvalAlive(expires, 1_009), true);
  assert.equal(approvalAlive(expires, 1_011), false);
});

test('isolation report requires consent when the OS sandbox is unavailable', () => {
  const report = describeIsolation('/tmp', false);
  assert.equal(report.env, 'minimal');
  assert.equal(report.osSandbox, 'unavailable');
  assert.equal(report.consentRequired, true);
  assert.equal(HOST_QUEUE_LIMIT, 16);
  const enforced = describeIsolation('/tmp', true);
  assert.equal(enforced.osSandbox, 'enforced');
  assert.equal(enforced.consentRequired, false);
});

test('nested sandbox roots collapse so bubblewrap binds each path once', () => {
  assert.deepEqual(withoutNested(['/home/me/proj', '/home', '/tmp', '/home/me']), ['/tmp', '/home']);
});

test('agent seatbelt stays write-scoped to the workspace and the agent config', () => {
  const profile = buildSeatbeltProfile('agent', 'grok', ['/work/repo']);
  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /subpath "\/work\/repo"/);
  assert.match(profile, /\.grok/);
  assert.match(profile, /\(allow default\)/);
});

test('muse seatbelt denies system paths and still allows temp and /usr/local', () => {
  const profile = buildSeatbeltProfile('muse', 'muse');
  assert.match(profile, /subpath "\/usr"\)/);
  assert.match(profile, /subpath "\/System"\)/);
  assert.match(profile, /subpath "\/usr\/local"\)/);
  assert.match(profile, /subpath "\/tmp"\)/);
  assert.doesNotMatch(profile, /subpath "\/home\/secret"/);
});

test('bubblewrap argv is read-only at / and writable at the given roots', () => {
  const argv = buildBwrapArgs('/usr/bin/muse', ['serve'], [homedir(), tmpdir()]);
  assert.equal(argv[0], '--die-with-parent');
  assert.deepEqual(argv.slice(1, 4), ['--ro-bind', '/', '/']);
  assert.ok(argv.includes('--bind'));
  assert.ok(argv.includes('--dev'));
  assert.equal(argv.at(-2), '/usr/bin/muse');
  assert.equal(argv.at(-1), 'serve');
});

test('wrap uses the platform sandbox and leaves the muse arguments intact', () => {
  const wrapped = wrapSandboxedCommand('/fake/muse', ['serve', '--trust-workspace'], { kind: 'muse', agentId: 'muse', backend: sandboxBackend() });
  const at = wrapped.args.lastIndexOf('serve');
  assert.deepEqual(wrapped.args.slice(at), ['serve', '--trust-workspace']);
  if (sandboxBackend() === 'none') {
    assert.equal(wrapped.sandboxed, false);
    assert.equal(wrapped.command, '/fake/muse');
  } else {
    assert.equal(wrapped.sandboxed, true);
    assert.notEqual(wrapped.command, '/fake/muse');
    assert.ok(wrapped.args.includes('/fake/muse'));
  }
});

test('windows job supervisor terminates via TerminateJobObject', () => {
  assert.match(WINDOWS_JOB_SUPERVISOR, /CreateJobObject/);
  assert.match(WINDOWS_JOB_SUPERVISOR, /AssignProcessToJobObject/);
  assert.match(WINDOWS_JOB_SUPERVISOR, /TerminateJobObject/);
  assert.match(WINDOWS_JOB_SUPERVISOR, /0x2000/);
  assert.match(WINDOWS_JOB_SUPERVISOR, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
});

test('terminating an already-exited child settles immediately', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((resolve) => child.once('exit', resolve));
  const result = await Promise.race([
    terminateTree(child, 50),
    new Promise((_, reject) => setTimeout(() => reject(new Error('terminateTree stayed pending')), 250)),
  ]);
  assert.equal(result.code, 0);
});

test('a seatbelt profile parses and confines writes', () => {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) return;
  const root = join(tmpdir(), `muse-sb-${process.pid}`);
  const allowed = join(root, 'allowed');
  const blocked = join(root, 'blocked');
  mkdirSync(allowed, { recursive: true });
  mkdirSync(blocked, { recursive: true });
  // macOS seatbelt matches the canonical path; /var is a symlink to /private/var.
  const allowedReal = realpathSync(allowed);
  const blockedReal = realpathSync(blocked);
  const profile = `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write* (subpath "${allowedReal}"))\n`;
  const write = (path) => spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/sh', '-c', `echo ok > ${JSON.stringify(join(path, 'probe'))}`], { timeout: 8000, encoding: 'utf8' });
  try {
    const inside = write(allowed);
    if (inside.status !== 0 && /sandbox_apply: Operation not permitted/.test(inside.stderr ?? '')) return;
    assert.equal(inside.status, 0, inside.stderr);
    assert.equal(existsSync(join(allowed, 'probe')), true);
    const outside = write(blocked);
    assert.notEqual(outside.status, 0);
    assert.equal(existsSync(join(blocked, 'probe')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
