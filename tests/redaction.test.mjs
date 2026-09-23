import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'muse-redaction-'));
after(() => rm(dir, { recursive: true, force: true }));
await build({ entryPoints: [resolve('packages/muse-bridge/src/redaction.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'redaction.mjs'), logLevel: 'silent' });
const { DiagnosticRedactor, DiagnosticLines, diagnosticEvent, REDACTED, DIAGNOSTIC_LIMIT } = await import(pathToFileURL(join(dir, 'redaction.mjs')));

test('diagnostics suppress quoted JSON, auth headers, URL credentials, private keys and provider formats', () => {
  const redactor = new DiagnosticRedactor();
  const samples = [
    '{"token":"CANARY-JSON"}', "{'apiKey': 'CANARY-API'}", 'Authorization: Bearer CANARY-BEARER',
    'Basic Q0FOQVJZLVNFQ1JFVA==', 'https://user:CANARY-USERINFO@example.invalid/path',
    'https://example.invalid/?access%5Ftoken=CANARY-QUERY', 'https://example.invalid/?code=CANARY-CODE',
    '-----BEGIN RSA PRIVATE KEY-----\nCANARY-PEM\n-----END RSA PRIVATE KEY-----',
    'provider rejected sk-CANARYabcdefghijklmnopqrstuvwxyz', 'git rejected ghp_CANARYabcdefghijklmnopqrstuvwxyz',
  ];
  for (const sample of samples) assert.equal(redactor.text(sample), REDACTED, sample);
  assert.equal(redactor.text('Connection refused on port 1420'), 'Connection refused on port 1420');
});

test('structured logs redact nested fields without confusing token usage with credentials', () => {
  const redactor = new DiagnosticRedactor();
  const result = redactor.value({ nested: [{ access_token: 'CANARY-A', clientSecret: 'CANARY-B' }], tokenUsage: { inputTokens: 42 }, message: 'retry in 5 seconds' });
  assert.deepEqual(result, { nested: [{ access_token: REDACTED, clientSecret: REDACTED }], tokenUsage: { inputTokens: 42 }, message: 'retry in 5 seconds' });
  assert.ok(!JSON.stringify(redactor.value(new Error('token=CANARY-CAUSE'))).includes('CANARY'));
});

test('known credentials are suppressed even when a child omits the label', () => {
  const redactor = new DiagnosticRedactor();
  redactor.remember({ META_API_KEY: 'CANARY-STORED-KEY', GITHUB_TOKEN: 'CANARY-GITHUB', PATH: '/usr/bin' });
  assert.equal(redactor.text('rejected CANARY-STORED-KEY'), REDACTED);
  assert.equal(redactor.text('rejected CANARY-GITHUB'), REDACTED);
  assert.equal(redactor.text('/usr/bin'), '/usr/bin');
});

test('unlabelled credential formats are suppressed without a label', () => {
  const redactor = new DiagnosticRedactor();
  const samples = [
    'header eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c tail',
    'aws AKIAIOSFODNN7EXAMPLE in log',
    'temp ASIAIOSFODNN7EXAMPLE here',
    'slack xoxb-1234567890-CANARYTOKENabcd',
    `npm npm_${'aB1'.repeat(12)} token`,
    `google AIza${'Sy'.repeat(17)}1 key`,
    'stripe sk_live_CANARYabcdefghijklmnop',
    `sendgrid SG.${'x'.repeat(22)}.${'Y'.repeat(43)} tail`,
    'age AGE-SECRET-KEY-1qqpqaze9canary9x8gf2tvdw0s3jn54khce6mua7l',
    `shopify shpat_${'cafe'.repeat(8)}`,
    'linear lin_api_CANARYabcdefghijklmnopqrstuvwx',
    'gitlab glpat-CANARYabcdefghijklmnop',
    'pypi pypi-CANARYabcdefghijklmnop',
    'doppler dp.pt.CANARYabcdefghijklmnopqrstuvwx',
  ];
  for (const sample of samples) assert.equal(redactor.text(sample), REDACTED, sample);
});

test('bare high-entropy tokens redact while hashes, ids and prose stay visible', () => {
  const redactor = new DiagnosticRedactor();
  assert.equal(redactor.text(`session ${'Ab1'.repeat(16)}`), REDACTED);
  // Git SHAs are single-case hex, UUIDs are short, fingerprints are labelled hashes.
  assert.equal(redactor.text('commit 54d702f8a1b2c3d4e5f60718293a4b5c6d7e8f9a'), 'commit 54d702f8a1b2c3d4e5f60718293a4b5c6d7e8f9a');
  assert.equal(redactor.text('sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81'), 'sha256:7469c9e352e67def4a59df7e439984d7194fa351e1c8b7abb34060fd977ced81');
  assert.equal(redactor.text('session 3f8a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c'), 'session 3f8a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c');
  assert.equal(redactor.text('retried 3 times on port 1420'), 'retried 3 times on port 1420');
});

test('stderr secrets split at every possible chunk boundary stay out of emitted diagnostics', () => {
  const input = 'connected\nAuthorization: Bearer CANARY-STREAM\n{"password":"CANARY-JSON"}\nretry\n';
  for (let cut = 0; cut <= input.length; cut++) {
    const lines = [];
    const reader = new DiagnosticLines((line) => lines.push(line));
    reader.push(input.slice(0, cut)); reader.push(input.slice(cut)); reader.end();
    assert.deepEqual(lines, ['connected', REDACTED, REDACTED, 'retry']);
  }
});

test('multiline private keys, oversized lines and EOF tails are handled without leaking fragments', () => {
  const lines = [];
  const reader = new DiagnosticLines((line) => lines.push(line));
  for (const char of '-----BEGIN PRIVATE KEY-----\nCANARY-BODY\n-----END PRIVATE KEY-----\nafter\n') reader.push(char);
  reader.push('x'.repeat(DIAGNOSTIC_LIMIT + 1)); reader.push('CANARY-OVERSIZE\n');
  reader.push('token=CANARY-EOF'); reader.end();
  assert.deepEqual(lines, [REDACTED, 'after', '[diagnostic omitted: size limit]', REDACTED]);
});

test('redaction is bounded for cyclic, deep and oversized diagnostic structures', () => {
  const redactor = new DiagnosticRedactor();
  const cyclic = {}; cyclic.self = cyclic;
  assert.equal(redactor.value(cyclic).self, '[circular]');
  assert.ok(redactor.text('x'.repeat(DIAGNOSTIC_LIMIT + 1)).includes('size limit'));
  let nested = { password: 'CANARY-DEEP' };
  for (let i = 0; i < 20; i++) nested = { nested };
  assert.ok(!JSON.stringify(redactor.value(nested)).includes('CANARY'));
});

test('diagnostic events are redacted while session content and login control data are untouched', () => {
  const payload = { sessionId: 's1', error: 'token=CANARY-EVENT', code: 'unauthorized', retryable: false };
  assert.deepEqual(diagnosticEvent('turnError', payload), { ...payload, error: REDACTED });
  const item = { item: { text: 'token=EXAMPLE-CODE' } };
  assert.equal(diagnosticEvent('item', item), item);
  const prompt = { url: 'https://auth.invalid/?code=ABCD-1234', code: 'ABCD-1234' };
  assert.equal(diagnosticEvent('loginPrompt', prompt), prompt);
  assert.ok(!JSON.stringify(diagnosticEvent('turnCompleted', { sessionId: 's1', outcome: { error: { message: 'password=CANARY-END' } } })).includes('CANARY'));
});

await build({ entryPoints: [resolve('apps/desktop/src/lib/logger.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'logger.mjs'), logLevel: 'silent', plugins: [{ name: 'logger-boundaries', setup(builder) {
  builder.onResolve({ filter: /^(@tauri-apps\/api\/core|\.\/format)$/ }, ({ path }) => ({ path, namespace: 'stub' }));
  builder.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: path === './format' ? 'export const isTauri = () => true;' : 'export const invoke = async (method, params) => globalThis.logInvocations.push({method, params});' }));
} }] });
const { log } = await import(pathToFileURL(join(dir, 'logger.mjs')));
test('renderer console and native log invocation never receive diagnostic canaries', () => {
  const original = console.error;
  const lines = [];
  globalThis.logInvocations = [];
  console.error = (line) => lines.push(line);
  try {
    log.error('Authorization: Bearer CANARY-EVENT-NAME', { nested: { token: 'CANARY-LOG' }, error: 'password=CANARY-MESSAGE' });
    assert.ok(!JSON.stringify({ lines, native: globalThis.logInvocations }).includes('CANARY'));
    assert.equal(globalThis.logInvocations.length, 1);
  } finally { console.error = original; delete globalThis.logInvocations; }
});
