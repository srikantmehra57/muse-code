import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const dir = await mkdtemp(join(tmpdir(), 'muse-framing-'));
after(() => rm(dir, { recursive: true, force: true }));
// Exercise the real transport with a small ceiling so malicious fixtures stay cheap.
const options = { bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{
  name: 'small-frame-budget', setup(builder) {
    builder.onLoad({ filter: /\/framing\.ts$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('64 * 1024 * 1024', '1024'), loader: 'ts',
    }));
  },
}] };
for (const name of ['framing', 'acp', 'index']) {
  await build({ ...options, entryPoints: [resolve(`packages/muse-bridge/src/${name}.ts`)], outfile: join(dir, `${name}.mjs`) });
}
const { LineFrames, encodeFrame } = await import(pathToFileURL(join(dir, 'framing.mjs')).href);
const { AcpAgentHost } = await import(pathToFileURL(join(dir, 'acp.mjs')).href);

test('framing preserves split UTF-8 and coalesced lines, with byte rather than character limits', () => {
  const reader = new LineFrames(4);
  const lines = [];
  for (const byte of Buffer.from('éxy\n\nend\r\n')) reader.push(Buffer.from([byte]), (line) => lines.push(line));
  assert.deepEqual(lines, ['éxy', '', 'end\r']);
  assert.throws(() => reader.push(Buffer.from('ééx'), () => {}), /byte limit/);
  assert.throws(() => reader.push(Buffer.from('\n'), () => {}), /closed/);
});

test('multiple frames may exceed the ceiling together, but a single unterminated frame cannot', () => {
  const lines = [];
  new LineFrames(2).push(Buffer.from('ab\ncd\nef\n'), (line) => lines.push(line));
  assert.deepEqual(lines, ['ab', 'cd', 'ef']);
  assert.throws(() => new LineFrames(2).push(Buffer.from('abc\n'), () => assert.fail('oversized line delivered')), /byte limit/);
  const reader = new LineFrames(2);
  reader.push(Buffer.from('ab'), () => assert.fail());
  assert.throws(() => reader.push(Buffer.from('c'), () => assert.fail()), /byte limit/);
});

test('outgoing frames account for JSON escaping and multibyte text', () => {
  assert.equal(encodeFrame({ ok: true }), '{"ok":true}\n');
  assert.throws(() => encodeFrame({ text: '\u0000'.repeat(200) }), /byte limit/);
  assert.throws(() => encodeFrame({ text: 'é'.repeat(512) }), /byte limit/);
});

test('bridge rejects malformed request shapes without exposing input and still answers ping', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [join(dir, 'index.mjs')]);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.resume();
  try {
    child.stdin.write('null\n[]\n{"secret":"CANARY"\n{"id":"ping-1","method":"ping"}\n');
    while (!output.includes('ping-1')) await new Promise((resolve) => setTimeout(resolve, 10));
    const messages = output.trim().split('\n').map(JSON.parse);
    assert.equal(messages.filter((item) => item.ok === false).length, 3);
    assert.equal(messages.find((item) => item.id === 'ping-1').result.pong, true);
    assert.ok(!output.includes('CANARY'));
  } finally {
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
  }
});

test('bridge fails closed on an oversized unterminated frame', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, [join(dir, 'index.mjs')]);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.resume();
  const exited = once(child, 'exit');
  try {
    child.stdin.write('x'.repeat(1025));
    await exited;
    assert.ok(output.includes('byte limit'));
    assert.ok(output.includes('bridgeExit'));
    assert.ok(!output.includes('x'.repeat(100)));
  } finally { child.kill(); }
});

test('ACP oversized output rejects pending initialization promptly', { timeout: 5000 }, async () => {
  const spec = { id: 'fake', name: 'Fake', protocol: 'acp', bins: [], verified: true, signIn: '',
    acpArgs: ['-e', "process.stdin.once('data', () => process.stdout.write('x'.repeat(1025))); setInterval(() => {}, 1000)"] };
  const host = new AcpAgentHost(spec, process.execPath, () => {});
  try { await assert.rejects(host.start(), /byte limit/); }
  finally { await host.stop(); }
});
