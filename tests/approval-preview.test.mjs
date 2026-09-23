import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-approval-preview-'));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { approvalPreview } = await bundle('apps/desktop/src/lib/approvalPreview.ts');
const { describeApprovalScope } = await bundle('apps/desktop/src/lib/format.ts');

test('replace preview reads old_string/new_string and the path', () => {
  const args = JSON.stringify({ path: '/repo/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' });
  assert.deepEqual(approvalPreview('edit_file', args), { kind: 'replace', path: '/repo/a.ts', before: 'const a = 1;', after: 'const a = 2;' });
});

test('replace preview falls back through the other key pairs', () => {
  assert.deepEqual(approvalPreview('str_replace', JSON.stringify({ oldText: 'x', newText: 'y' })),
    { kind: 'replace', path: undefined, before: 'x', after: 'y' });
  assert.deepEqual(approvalPreview('edit', JSON.stringify({ old: 'x', new: 'y' })),
    { kind: 'replace', path: undefined, before: 'x', after: 'y' });
  assert.deepEqual(approvalPreview('write', JSON.stringify({ before: 'x', after: 'y' })),
    { kind: 'replace', path: undefined, before: 'x', after: 'y' });
});

test('patch preview reads the patch/diff string', () => {
  const diff = 'diff --git a/f.ts b/f.ts\n@@ -1 +1 @@\n-a\n+b';
  assert.deepEqual(approvalPreview('apply_patch', JSON.stringify({ patch: diff })), { kind: 'patch', diff });
  assert.deepEqual(approvalPreview('edit_file', JSON.stringify({ diff })), { kind: 'patch', diff });
});

test('write preview reads content/text/contents', () => {
  assert.deepEqual(approvalPreview('write_file', JSON.stringify({ path: '/repo/b.ts', content: 'hello\nworld' })),
    { kind: 'write', path: '/repo/b.ts', content: 'hello\nworld' });
  assert.deepEqual(approvalPreview('write_file', JSON.stringify({ text: 'via text' })),
    { kind: 'write', path: undefined, content: 'via text' });
});

test('non-write tools and malformed arguments produce no preview', () => {
  assert.equal(approvalPreview('bash', JSON.stringify({ command: 'rm -rf x' })), null);
  assert.equal(approvalPreview('read_file', JSON.stringify({ path: '/a', content: 'c' })), null);
  assert.equal(approvalPreview('edit_file', '{not json'), null);
  assert.equal(approvalPreview('edit_file', '"a string"'), null);
  assert.equal(approvalPreview('edit_file', '[]'), null);
  assert.equal(approvalPreview('edit_file'), null);
  assert.equal(approvalPreview('edit_file', JSON.stringify({ path: '/a' })), null);
});

test('mcp-prefixed and differently-cased write tools are recognized', () => {
  const args = JSON.stringify({ old_string: 'a', new_string: 'b' });
  assert.equal(approvalPreview('mcp__foo__edit_file', args)?.kind, 'replace');
  assert.equal(approvalPreview('Edit_File', args)?.kind, 'replace');
  assert.equal(approvalPreview('mcp__foo__bash', JSON.stringify({ command: 'ls' })), null);
});

test('describeApprovalScope explains each known scope and stays quiet otherwise', () => {
  for (const scope of ['once', 'session', 'localPersistent']) {
    assert.notEqual(describeApprovalScope(scope), '', scope);
  }
  assert.equal(describeApprovalScope('tenantPersistent'), '');
  assert.equal(describeApprovalScope(''), '');
});
