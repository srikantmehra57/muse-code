import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Error classification (`apps/desktop/src/lib/errors.ts`): every code branch
 * plus the timeout-unknown detector the send-retry path relies on.
 */

const temporary = await mkdtemp(join(tmpdir(), 'muse-errors-'));
after(() => rm(temporary, { recursive: true, force: true }));

const outfile = join(temporary, 'errors.mjs');
await build({
  entryPoints: [resolve('apps/desktop/src/lib/errors.ts')],
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
});
const { classifyError, timeoutUnknown } = await import(pathToFileURL(outfile).href);

test('classifyError routes auth failures to settings', () => {
  const classified = classifyError(new Error('authRequired: not logged in, run /login'));
  assert.equal(classified.code, 'auth');
  assert.equal(classified.action, 'settings');
  assert.match(classified.lost, /draft is kept/i);
});

test('classifyError routes a missing CLI to settings', () => {
  const classified = classifyError(new Error('Could not find the Muse CLI'));
  assert.equal(classified.code, 'cli');
  assert.equal(classified.action, 'settings');
});

test('classifyError treats timeouts as retryable-unknown', () => {
  const classified = classifyError(new Error('sendTurn timed out. Its result is unknown; check before retrying.'));
  assert.equal(classified.code, 'timeout');
  assert.equal(classified.action, 'retry');
  assert.match(classified.lost, /may still be running/i);
});

test('classifyError routes disconnects to reconnect', () => {
  const classified = classifyError(new Error('Muse connection closed. Reconnect from Settings.'));
  assert.equal(classified.code, 'host');
  assert.equal(classified.action, 'reconnect');
});

test('classifyError falls back to retry with the caller title', () => {
  const classified = classifyError(new Error('weird failure'), 'Send failed');
  assert.equal(classified.code, 'unknown');
  assert.equal(classified.title, 'Send failed');
  assert.equal(classified.action, 'retry');
});

test('timeoutUnknown recognizes the tagged bridge timeout', () => {
  const tagged = new Error('sendTurn timed out.');
  tagged.code = 'timeout-unknown';
  assert.equal(timeoutUnknown(tagged), true);
});

test('timeoutUnknown falls back to the result-unknown wording', () => {
  assert.equal(timeoutUnknown(new Error('sendTurn timed out. Its result is unknown; check before retrying.')), true);
  assert.equal(timeoutUnknown(new Error('Muse connection closed.')), false);
  assert.equal(timeoutUnknown(new Error('weird failure')), false);
  assert.equal(timeoutUnknown(null), false);
});

test('classifyError prefers the structured MSP kind over message text', () => {
  const coded = (code) => Object.assign(new Error('friendly wrapper'), { code });
  assert.deepEqual(
    [classifyError(coded('overloaded')).code, classifyError(coded('overloaded')).action],
    ['busy', 'retry'],
  );
  assert.deepEqual(
    [classifyError(coded('sessionNotFound')).code, classifyError(coded('sessionNotFound')).action],
    ['gone', 'reconnect'],
  );
  assert.deepEqual(
    [classifyError(coded('cancelled')).code, classifyError(coded('cancelled')).action],
    ['stopped', 'dismiss'],
  );
  assert.deepEqual(
    [classifyError(coded('inputTooLarge')).code, classifyError(coded('inputTooLarge')).action],
    ['invalid', 'retry'],
  );
  // Unknown kinds still fall through to the message matchers.
  assert.equal(classifyError(coded('noBoundary')).code, 'unknown');
});
