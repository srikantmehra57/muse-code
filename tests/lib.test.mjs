import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-lib-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { groupAgentRuns, classifyTool, inferPlan } = await bundle('apps/desktop/src/lib/agent.ts');
const { parseUnifiedDiff, parseNumstatZ, dropHunk } = await bundle('apps/desktop/src/lib/diff.ts');
const { composePrompt, shortHash } = await bundle('apps/desktop/src/lib/format.ts');
const { classifyError, authRequired } = await bundle('apps/desktop/src/lib/errors.ts');
const { SessionMemoryPersistence, normalizeMemory } = await bundle('apps/desktop/src/lib/sessionMemory.ts');
const { resolveMuseBin } = await bundle('packages/muse-bridge/src/detect.ts');
const { agentEnabled, DEFAULT_ENABLED_AGENTS, DEFAULT_SETTINGS, skillScopeArg } = await bundle('apps/desktop/src/lib/types.ts');
const { settingsFields } = await bundle('apps/desktop/src/lib/settingsPersistence.ts');
const { rekeyThreadState, projectDraftForAgent } = await bundle('apps/desktop/src/lib/agentSwitch.ts');

test('groups transcript items into agent runs by turnId', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Fix auth', turnId: 't1' },
    { itemId: 'r', kind: 'reasoning', status: 'completed', text: 'Inspect the session store', turnId: 't1' },
    { itemId: 'tool', kind: 'toolCall', status: 'completed', tool: 'read_file', args: '{"path":"src/app.ts"}', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Updated refresh handling.', turnId: 't1' },
  ], { activeTurnId: null });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].steps.length, 4);
  assert.equal(runs[0].steps[2].kind, 'read');
  assert.equal(runs[0].steps[2].path, 'src/app.ts');
  assert.equal(runs[0].status, 'completed');
});

test('keeps the latest run running when the thread is still working', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Summarize this' },
  ], { threadRunning: true });
  assert.equal(runs[0].status, 'running');
});

test('marks a finished turn as cancelled from lastOutcome', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Go', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Halfway', turnId: 't1' },
  ], { lastTurnId: 't1', lastOutcome: 'cancelled' });
  assert.equal(runs[0].status, 'cancelled');
});

test('marks the active turn as running and waiting', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Go', turnId: 'live' },
    { itemId: 't', kind: 'toolCall', status: 'inProgress', tool: 'bash', args: '{"command":"npm test"}', turnId: 'live' },
  ], { activeTurnId: 'live', waiting: true });
  assert.equal(runs[0].status, 'waiting');
  assert.equal(classifyTool('bash', 'userShell'), 'command');
});

test('a stale active turn id cannot resurrect a settled thread', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Go', turnId: 'stale' },
    { itemId: 't', kind: 'toolCall', status: 'cancelled', tool: 'bash', turnId: 'stale' },
  ], { activeTurnId: 'stale', lastTurnId: 'stale', lastOutcome: 'cancelled', threadRunning: false });
  assert.equal(runs[0].status, 'cancelled');
});

test('infers a plan from markdown lists when the host sent none', () => {
  const plan = inferPlan([{ itemId: 'a', kind: 'agentMessage', status: 'completed', text: '- Inspect repo\n- [x] Done already\n- Add persistence' }]);
  assert.equal(plan.length, 3);
  assert.equal(plan[1].status, 'completed');
});

test('composePrompt prefixes file references without inventing text', () => {
  assert.equal(composePrompt('Fix auth', [{ path: 'src/app.ts' }]), '@src/app.ts\n\nFix auth');
  assert.equal(composePrompt('', [{ path: 'README.md' }]), '@README.md');
  assert.equal(composePrompt('Hello'), 'Hello');
});

test('parses unified diffs per file', () => {
  const { files } = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`);
  assert.equal(files[0].path, 'src/a.ts');
  assert.equal(files[0].lines.filter((line) => line.type === 'add').length, 1);
});

test('numstat -z maps rename targets', () => {
  const counts = parseNumstatZ('12\t3\0plain.txt\0renamed file.txt\0');
  assert.deepEqual(counts.get('renamed file.txt'), { added: 12, removed: 3 });
});

test('dropHunk removes only the indexed block of the named file', () => {
  const diff = 'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-old\n+new\n@@ -10 +10 @@\n-x\n+y\n';
  const dropped = dropHunk(diff, 'f.txt', 0);
  assert.ok(!dropped.includes('@@ -1 +1 @@') && dropped.includes('@@ -10 +10 @@'));
  assert.ok(dropped.includes('diff --git a/f.txt b/f.txt'));
  assert.equal(dropHunk(diff, 'other.txt', 0), diff);
  assert.equal(dropHunk(diff, 'f.txt', 9), diff);
});

test('classifies auth and host failures', () => {
  assert.equal(classifyError('not logged in: run /login').code, 'auth');
  assert.equal(classifyError('Muse connection closed. Reconnect from Settings.').code, 'host');
  assert.equal(authRequired({ params: { error: { kind: 'authRequired', message: 'login' } } }), true);
});

test('session memory round-trips titles and archives without secrets', async () => {
  const saved = {};
  const persistence = new SessionMemoryPersistence({
    get: async (key) => saved[key],
    set: async (key, value) => { saved[key] = value; },
    save: async () => {},
  });
  await persistence.save(normalizeMemory({
    selectedWorkspaceId: 'w',
    selectedSessionId: 's',
    threadMeta: { s: { title: 'Auth refresh', customTitle: true, pinned: true } },
    drafts: { 'thread:s': { text: 'continue', images: [] } },
  }));
  const loaded = await persistence.load();
  assert.equal(loaded.threadMeta.s.title, 'Auth refresh');
  assert.equal(loaded.drafts['thread:s'].text, 'continue');
  assert.equal(JSON.stringify(loaded).includes('museApiKey'), false);
});

test('deleted archived threads stay forgotten in session memory', async () => {
  const saved = {};
  const persistence = new SessionMemoryPersistence({
    get: async (key) => saved[key],
    set: async (key, value) => { saved[key] = value; },
    save: async () => {},
  });
  await persistence.save(normalizeMemory({
    threadMeta: { gone: { title: 'Old', archived: true, deleted: true } },
  }));
  const loaded = await persistence.load();
  assert.equal(loaded.threadMeta.gone.deleted, true);
  assert.equal(loaded.threadMeta.gone.archived, true);
});

test('custom muse paths in temp dirs are rejected', () => {
  assert.equal(resolveMuseBin('/tmp/muse'), null);
  assert.equal(resolveMuseBin('/tmp/muse-audit-probe.sh'), null);
});

test('muse resolution checks the canonical target, not the link string', async () => {
  const { mkdtemp, mkdir, rm, symlink, writeFile, chmod, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  // Non-temp link dir inside the repo (cleaned up); target inside temp.
  // Absolute: relative symlink targets resolve against the link's own dir.
  const outer = join(process.cwd(), 'tests', 'fixtures', `muse-link-${process.pid}`);
  await mkdir(outer, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), 'muse-resolve-'));
  try {
    const target = join(work, 'real-muse');
    await writeFile(target, '#!/bin/sh\necho hi\n');
    await chmod(target, 0o755);
    const link = join(outer, 'muse');
    await symlink(target, link);
    // The link string is non-temp and well-named, but its target is temp.
    assert.equal(resolveMuseBin(link), null);
    // A well-named non-temp target resolves even behind a misnamed link.
    await rm(link, { force: true });
    const real = join(outer, 'muse');
    await writeFile(real, '#!/bin/sh\necho hi\n');
    await chmod(real, 0o755);
    const alias = join(outer, 'launcher');
    await symlink(real, alias);
    assert.equal(resolveMuseBin(alias), await realpath(real));
    assert.equal(resolveMuseBin(join(work, 'missing')), null);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(outer, { recursive: true, force: true });
  }
});

test('OpenCode is off by default and can be toggled in persisted settings', () => {
  assert.equal(DEFAULT_ENABLED_AGENTS.opencode, false);
  assert.equal(agentEnabled({}, 'opencode'), false);
  assert.equal(agentEnabled({}, 'grok'), false);
  assert.equal(agentEnabled({ enabledAgents: { opencode: true } }, 'opencode'), true);
  const saved = settingsFields({ ...DEFAULT_SETTINGS, enabledAgents: { grok: false } });
  assert.equal(saved.enabledAgents.opencode, false);
  assert.equal(saved.enabledAgents.grok, false);
  assert.equal(saved.enabledAgents.muse, true);
  assert.equal(saved.acpUnisolatedConsent, false);
  assert.equal(settingsFields({ ...DEFAULT_SETTINGS, acpUnisolatedConsent: true }).acpUnisolatedConsent, true);
  assert.equal(DEFAULT_SETTINGS.accentColor, 'blue');
  assert.equal(DEFAULT_SETTINGS.accentSidebar, false);
  const themed = settingsFields({ ...DEFAULT_SETTINGS, accentColor: 'green', accentSidebar: true });
  assert.equal(themed.accentColor, 'green');
  assert.equal(themed.accentSidebar, true);
});

test('shortHash truncates digests and leaves short text alone', () => {
  assert.equal(shortHash('sha256:df5e43fed1bd4c9a7c7358e2a3e69c67'), 'sha256:df5e43fed1bd…');
  assert.equal(shortHash('abc123'), 'abc123');
  assert.equal(shortHash('z'.repeat(40)), `${'z'.repeat(24)}…`);
  assert.equal(shortHash(null), '');
});

test('skill list scopes map to the enable/disable scope argument', () => {
  assert.equal(skillScopeArg('bundled'), 'built-in');
  assert.equal(skillScopeArg('built-in'), 'built-in');
  assert.equal(skillScopeArg('user'), 'user');
  assert.equal(skillScopeArg('project'), 'project');
  assert.equal(skillScopeArg('plugin'), 'plugin');
  assert.equal(skillScopeArg('  Bundled '), 'built-in');
  assert.equal(skillScopeArg('marketplace'), null);
  assert.equal(skillScopeArg(''), null);
});

test('switching agents rebinds the current thread and does not keep the previous agent on the project draft', () => {
  const previous = {
    sessionId: 'oc-1',
    agentId: 'opencode',
    workspacePath: '/ws',
    title: 'hi',
    updatedAt: '2026-09-19T00:00:00Z',
    status: 'idle',
    unread: false,
    items: [{ itemId: 'u', kind: 'userMessage', status: 'completed', text: 'hi' }],
    config: { agentId: 'opencode', modelId: 'opencode/mimo-v2.5-free' },
  };
  const next = {
    ...previous,
    sessionId: 'grok-9',
    agentId: 'grok',
    config: { agentId: 'grok', modelId: 'grok-4.6' },
    configNotice: 'Now using Grok',
  };
  const state = rekeyThreadState({
    threads: [previous],
    drafts: {
      'project:w': { text: '', images: [], refs: [], config: { agentId: 'opencode', modelId: 'opencode/mimo-v2.5-free' } },
      'thread:oc-1': { text: 'follow up', images: [], refs: [], config: { agentId: 'opencode' } },
    },
    threadMeta: { 'oc-1': { title: 'hi', agentId: 'opencode' } },
    selectedWorkspaceId: 'w',
    selectedSessionId: 'oc-1',
  }, 'oc-1', next);
  assert.equal(state.selectedSessionId, 'grok-9');
  assert.equal(state.threads[0].agentId, 'grok');
  assert.equal(state.threads[0].items[0].text, 'hi');
  assert.equal(state.drafts['project:w'].config.agentId, 'grok');
  assert.equal(state.drafts['project:w'].config.modelId, undefined);
  assert.equal(state.drafts['thread:grok-9'].text, 'follow up');
  assert.equal(state.drafts['thread:oc-1'], undefined);
  assert.equal(state.threadMeta['grok-9'].agentId, 'grok');
  assert.equal(projectDraftForAgent({}, 'w', 'muse')['project:w'].config.agentId, undefined);
});
