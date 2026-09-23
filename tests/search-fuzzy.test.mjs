import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-search-'));
test.after(() => rm(temporary, { recursive: true, force: true }));

const formatFile = join(temporary, 'format.mjs');
const fuzzyFile = join(temporary, 'fuzzy.mjs');
await build({ entryPoints: [resolve('apps/desktop/src/lib/format.ts')], bundle: true, platform: 'node', format: 'esm', outfile: formatFile, logLevel: 'silent' });
await build({ entryPoints: [resolve('apps/desktop/src/lib/fuzzy.ts')], bundle: true, platform: 'node', format: 'esm', outfile: fuzzyFile, logLevel: 'silent' });
const { threadMatches } = await import(pathToFileURL(formatFile).href);
const { fuzzyScore } = await import(pathToFileURL(fuzzyFile).href);

const thread = (title, items = []) => ({ title, items });
const item = (fields) => ({ kind: 'agentMessage', ...fields });

test('threadMatches hits the title even with no loaded items', () => {
  assert.equal(threadMatches(thread('Refactor login flow'), 'login'), true);
  assert.equal(threadMatches(thread('Refactor login flow'), 'deploy'), false);
});

test('threadMatches scans item text and fallback text', () => {
  const t = thread('Untitled', [item({ text: 'I refactored the cache layer' }), item({ fallbackText: 'tool call' })]);
  assert.equal(threadMatches(t, 'cache'), true);
  assert.equal(threadMatches(t, 'tool'), true);
});

test('threadMatches scans tool args so file paths are findable', () => {
  const t = thread('Work', [item({ text: 'editing', args: JSON.stringify({ path: 'src/lib/store.ts', old_string: 'x' }) })]);
  assert.equal(threadMatches(t, 'store.ts'), true);
  assert.equal(threadMatches(t, 'src/lib'), true);
});

test('threadMatches scans visible output and requires every term (AND)', () => {
  const t = thread('Work', [item({ text: 'done', visibleOutput: 'compiled 42 modules' })]);
  assert.equal(threadMatches(t, 'compiled modules'), true);
  assert.equal(threadMatches(t, 'compiled missing'), false);
  assert.equal(threadMatches(t, 'work compiled'), true, 'terms may land in different fields');
});

test('threadMatches caps the scan at the last 400 items', () => {
  const items = [item({ text: 'needle beyond the cap' }), ...Array.from({ length: 400 }, () => item({ text: 'hay' }))];
  assert.equal(threadMatches(thread('T', items), 'needle'), false);
  items.push(item({ text: 'needle inside the cap' }));
  assert.equal(threadMatches(thread('T', items), 'needle'), true);
});

test('fuzzyScore requires a subsequence and prefers basename matches', () => {
  assert.ok(fuzzyScore('cmp', 'src/components/Composer.tsx') != null);
  assert.equal(fuzzyScore('zzz', 'src/App.tsx'), null);
  assert.equal(fuzzyScore('composerstore', 'src/store.ts'), null);
  const shallow = fuzzyScore('composer', 'src/Composer.tsx');
  const deep = fuzzyScore('composer', 'src/deep/nested/tools/Composer.tsx');
  assert.ok(shallow > deep, `basename-adjacent ${shallow} should beat deep ${deep}`);
  const basename = fuzzyScore('store', 'src/lib/store.ts');
  const buried = fuzzyScore('store', 'src/components/stores/demos/order.ts');
  assert.ok(basename > buried, `basename ${basename} should beat buried ${buried}`);
  assert.equal(fuzzyScore('', 'src/App.tsx'), 0);
});
