import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-session-files-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { editedPaths } = await bundle('apps/desktop/src/lib/agent.ts');

const edit = (tool, path) => ({ itemId: Math.random().toString(36), kind: 'toolCall', status: 'completed', tool, args: JSON.stringify({ path }) });

test('only write-class tool calls contribute paths', () => {
  const items = [
    edit('write_file', 'src/a.ts'),
    edit('edit_file', 'src/b.ts'),
    edit('create_file', 'src/c.ts'),
    edit('str_replace', 'src/d.ts'),
    edit('apply_patch', 'src/e.ts'),
    edit('read_file', 'src/read.ts'),
    edit('bash', 'src/run.sh'),
    { itemId: 'r1', kind: 'reasoning', status: 'completed', text: 'thinking' },
    { itemId: 'm1', kind: 'agentMessage', status: 'completed', text: 'done' },
  ];
  assert.deepEqual(editedPaths(items), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
});

test('paths dedupe and keep first-touch order', () => {
  const items = [edit('write_file', 'b.ts'), edit('edit_file', 'a.ts'), edit('write_file', 'b.ts')];
  assert.deepEqual(editedPaths(items), ['b.ts', 'a.ts']);
});

test('absolute paths relativize inside the workspace and drop outside it', () => {
  const items = [
    edit('write_file', '/repo/src/in.ts'),
    edit('write_file', '/elsewhere/out.ts'),
    edit('write_file', 'src/rel.ts'),
  ];
  assert.deepEqual(editedPaths(items, '/repo'), ['src/in.ts', 'src/rel.ts']);
  assert.deepEqual(editedPaths(items, '/repo/'), ['src/in.ts', 'src/rel.ts']);
  assert.deepEqual(editedPaths(items), ['src/rel.ts']);
});

test('separators and prefixes normalize', () => {
  const items = [
    edit('write_file', 'C:\\repo\\src\\win.ts'),
    edit('write_file', './src/dot.ts'),
  ];
  assert.deepEqual(editedPaths(items, 'C:\\repo'), ['src/win.ts', 'src/dot.ts']);
});

test('calls without a usable path are skipped', () => {
  const items = [
    { itemId: 'x1', kind: 'toolCall', status: 'completed', tool: 'write_file', args: 'not-json' },
    { itemId: 'x2', kind: 'toolCall', status: 'completed', tool: 'write_file' },
    { itemId: 'x3', kind: 'toolCall', status: 'completed', tool: 'write_file', args: JSON.stringify({ command: 'ls' }) },
  ];
  assert.deepEqual(editedPaths(items, '/repo'), []);
});
