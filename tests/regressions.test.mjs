import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-regressions-'));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function bundle(entry, replacements = {}) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path] }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const { SettingsPersistence } = await bundle('apps/desktop/src/lib/settingsPersistence.ts');
const { DEFAULT_SETTINGS } = await bundle('apps/desktop/src/lib/types.ts');
function persistenceFixture(saved = {}, secure = null) {
  const state = { saved, secure, writes: [], failKey: false, failSave: false };
  const persistence = new SettingsPersistence({
    get: async () => state.saved,
    set: async (_, value) => { state.buffer = value; },
    save: async () => { if (state.failSave) throw new Error('disk full'); state.saved = state.buffer; state.writes.push('settings'); },
  }, {
    get: async () => state.secure,
    set: async (value) => { if (state.failKey) throw new Error('locked'); state.secure = value || null; state.writes.push('credential'); },
  });
  return { state, persistence };
}

test('legacy key migrates before JSON is scrubbed, preserving other settings', async () => {
  const { state, persistence } = persistenceFixture({ museApiKey: 'old-test-key', theme: 'light', workspaces: [{ id: 'a', path: '/a' }] });
  const settings = await persistence.load();
  assert.equal(settings.museApiKey, 'old-test-key');
  assert.equal(settings.theme, 'light');
  assert.equal(settings.accentColor, 'blue');
  assert.equal(settings.accentSidebar, false);
  assert.equal(state.secure, 'old-test-key');
  assert.equal('museApiKey' in state.saved, false);
  assert.deepEqual(state.writes, ['credential', 'settings']);
  assert.equal(state.saved.workspaces[0].path, '/a');
});
test('locked credential store preserves legacy key and does not rewrite JSON', async () => {
  const { state, persistence } = persistenceFixture({ museApiKey: 'legacy-test' });
  state.failKey = true;
  await assert.rejects(persistence.load(), /locked/);
  assert.equal(state.saved.museApiKey, 'legacy-test');
  assert.deepEqual(state.writes, []);
  state.failKey = false;
  await persistence.load();
  assert.equal(state.secure, 'legacy-test');
  assert.equal('museApiKey' in state.saved, false);
});
test('existing secure key wins over an obsolete legacy key', async () => {
  const { state, persistence } = persistenceFixture({ museApiKey: 'obsolete-test' }, 'secure-test');
  assert.equal((await persistence.load()).museApiKey, 'secure-test');
  assert.deepEqual(state.writes, ['settings']);
});
test('save excludes credentials and serializes key changes and deletion', async () => {
  const { state, persistence } = persistenceFixture();
  await persistence.load();
  await Promise.all([
    persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'first-test' }),
    persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'second-test', theme: 'light' }),
  ]);
  assert.equal(state.secure, 'second-test');
  assert.equal(state.saved.theme, 'light');
  assert.equal(JSON.stringify(state.saved).includes('second-test'), false);
  await persistence.save({ ...DEFAULT_SETTINGS, museApiKey: '' });
  assert.equal(state.secure, null);
  assert.equal('museApiKey' in state.saved, false);
});
test('failed public settings write rolls back a credential change', async () => {
  const { state, persistence } = persistenceFixture({}, 'previous-test');
  await persistence.load(); state.failSave = true;
  await assert.rejects(persistence.save({ ...DEFAULT_SETTINGS, museApiKey: 'next-test' }), /disk full/);
  assert.equal(state.secure, 'previous-test');
});

const nativeReplacements = {
  '@tauri-apps/api/core': 'export const invoke=(...args)=>globalThis.testInvoke(...args);',
  '@tauri-apps/api/event': 'export const listen=async (_,handler)=>{globalThis.nativeEvent=handler;return ()=>{}};',
};
async function frontendBridge() {
  globalThis.window = { __TAURI_INTERNALS__: {}, setTimeout, clearTimeout };
  return bundle('apps/desktop/src/lib/bridge.ts', nativeReplacements);
}
test('intentional restart retains start request, invalidates old operations, and accepts success', async () => {
  const { bridge } = await frontendBridge();
  const requests = [];
  globalThis.testInvoke = async (_, args) => { requests.push(args); };
  const pendingTurn = bridge('sendTurn').then(() => 'unexpected', error => error.message);
  const restart = bridge('startHost');
  await new Promise(setImmediate);
  globalThis.nativeEvent({ payload: { type: 'event', event: 'hostStopping', payload: {} } });
  const request = requests.find(item => item.method === 'startHost');
  globalThis.nativeEvent({ payload: { id: request.id, ok: true, result: { server: 'replacement' } } });
  assert.match(await pendingTurn, /connection closed/);
  assert.deepEqual(await restart, { server: 'replacement' });
});
test('unexpected host death rejects a pending restart too', async () => {
  const { bridge } = await frontendBridge();
  globalThis.testInvoke = async () => {};
  const result = assert.rejects(bridge('startHost'), /connection closed/);
  await new Promise(setImmediate);
  globalThis.nativeEvent({ payload: { type: 'event', event: 'hostExit', payload: {} } });
  await result;
});

const storeReplacements = {
  './bridge': `export const persistStoreDocument=async(...args)=>globalThis.persistStoreDocument?.(...args);
    export const repairStoreDocument=async()=>globalThis.storeRepair ?? {status:'ok'};
    export const bridge=(...args)=>globalThis.storeBridge(...args);
    export const gitSnapshot=(grantId)=>globalThis.readGit(grantId);
    export const verifyGrants=async()=>[];export const removeGrant=async()=>{};
    export const onBridgeEvent=(handler)=>{globalThis.storeEvent=handler;return ()=>{}};
    export const pickFolder=async()=>null;export const mockThreads=()=>[];
    export const readDroppedPaths=async()=>globalThis.droppedPaths ?? [];
    export const agentIdentities=async()=>[];export const confirmAgentBin=async()=>{throw new Error('preview')};
    export const gitDiscardFiles=async()=>globalThis.discardedGit;export const gitDiscardAll=async()=>globalThis.discardedGit;
    export const gitDiscardHunk=async(...args)=>{globalThis.hunkCalls.push(args);return globalThis.discardedGit;};
    export const gitStage=async(...args)=>{globalThis.stageCalls.push(args);return globalThis.discardedGit;};
    export const gitCommit=async(...args)=>{globalThis.commitCalls.push(args);return globalThis.discardedGit;};
    export const trustPreview=async()=>globalThis.trustPreviewResult ?? { skills: [], rules: null };
    export const listWorkspaceFiles=async()=>globalThis.fileIndexPaths ?? [];
    export const cliLogout=async()=>{globalThis.cliLoggedOut=true;};
    export const pluginList=async()=>globalThis.pluginEntries ?? [];
    export const skillList=async()=>globalThis.skillEntries ?? [];
    export const projectInit=async(...args)=>globalThis.runProjectInit(...args);
    export const enterpriseStatus=async()=>globalThis.enterpriseFixture ?? { generation: null, sources: [] };
    export const pickPluginBundle=async()=>globalThis.pickedBundle ?? null;
    export const pluginInstall=async(path)=>{globalThis.installedBundles.push(path);};
    export const pickSkillSource=async()=>globalThis.pickedSkill ?? null;
    export const skillInstall=async(path)=>{globalThis.installedSkills.push(path);return 'installed';};
    export const skillImport=async(from,dryRun)=>{globalThis.importCalls.push([from,dryRun]);return dryRun?'preview':'done';};
    export const skillUninstall=async(id)=>{globalThis.uninstalledSkills.push(id);return 'removed';};`,
};
async function frontendStore(extra = {}, tauri = false) {
  globalThis.window = { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }), ...(tauri ? { __TAURI_INTERNALS__: {} } : {}) };
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.storeBridge = async () => ({});
  const module = await bundle('apps/desktop/src/lib/store.ts', { ...storeReplacements, ...extra });
  module.bindBridgeEvents();
  return module.useAppStore;
}
const thread = (id, path) => ({ sessionId: id, workspacePath: path, items: [], opened: true, status: 'idle' });
test('discarding files applies the fresh snapshot and prunes open diff tabs', async () => {
  const store = await frontendStore();
  globalThis.discardedGit = { branch: 'main', dirty: true, files: [{ path: 'keep.txt', status: 'M', added: 1, removed: 0 }], diff: '', truncated: false };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    diffTabs: ['drop.txt', 'keep.txt'], diffActive: 'drop.txt',
  });
  await store.getState().discardGitFiles(['drop.txt']);
  const state = store.getState();
  assert.deepEqual(state.git.files.map((file) => file.path), ['keep.txt']);
  assert.deepEqual(state.diffTabs, ['keep.txt']);
  assert.equal(state.diffActive, 'keep.txt');
  await store.getState().discardAllGit();
  assert.deepEqual(store.getState().diffTabs, []);
  assert.equal(store.getState().diffActive, null);
});
test('discarding a hunk forwards path and index and applies the fresh snapshot', async () => {
  const store = await frontendStore();
  globalThis.hunkCalls = [];
  globalThis.discardedGit = { branch: 'main', dirty: true, files: [{ path: 'keep.txt', status: 'M', added: 1, removed: 0 }], diff: '', truncated: false };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  await store.getState().discardGitHunk('keep.txt', 2);
  assert.deepEqual(globalThis.hunkCalls, [['g1', 'keep.txt', 2]]);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['keep.txt']);
});
test('staging and committing forward args and apply the fresh snapshot', async () => {
  const store = await frontendStore();
  globalThis.stageCalls = [];
  globalThis.commitCalls = [];
  globalThis.discardedGit = { branch: 'main', dirty: false, files: [], diff: '', truncated: false };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });
  await store.getState().stageGitFiles(['a.txt'], true);
  await store.getState().stageGitFiles(['b.txt'], false);
  assert.deepEqual(globalThis.stageCalls, [['g1', ['a.txt'], true], ['g1', ['b.txt'], false]]);
  await store.getState().commitGit('ship it');
  assert.deepEqual(globalThis.commitCalls, [['g1', 'ship it']]);
  assert.equal(store.getState().git.dirty, false);
});
test('sign out removes credentials, closes sessions, and re-detects', async () => {
  const store = await frontendStore();
  globalThis.cliLoggedOut = false;
  const seen = [];
  globalThis.storeBridge = async (method) => { seen.push(method); return method === 'detect' ? { found: true, authenticated: false } : {}; };
  store.setState({
    museApiKey: 'secret-test', hostInfo: { version: 'x' }, hostTrust: true, preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't0' }], selectedSessionId: 's1',
  });
  await store.getState().signOut();
  const state = store.getState();
  assert.equal(globalThis.cliLoggedOut, true);
  assert.equal(state.museApiKey, '');
  assert.equal(state.hostInfo, null);
  assert.equal(state.hostTrust, null);
  assert.equal(state.threads[0].opened, false);
  assert.equal(state.threads[0].status, 'idle');
  assert.deepEqual(state.detection, { found: true, authenticated: false });
  assert.ok(seen.includes('detect'));
});
test('shell escape routes to userShell and clears the composer without a turn', async () => {
  const store = await frontendStore();
  const calls = [];
  globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return { commandId: 'cmd-1', status: 'accepted' }; };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo') }], hostInfo: { compat: { granted: ['userShell'] } },
    composer: '!git status --short', images: [], contextRefs: [],
  });
  await store.getState().sendPrompt();
  assert.deepEqual(calls, [['userShell', { sessionId: 's1', commandText: 'git status --short' }]]);
  const state = store.getState();
  assert.equal(state.composer, '');
  assert.equal(state.threads[0].status, 'idle');
  assert.deepEqual(state.threads[0].items, []);
});
test('shell escape fails closed on foreign agents and missing grants', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => { throw new Error('must not call'); };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), agentId: 'opencode' }], hostInfo: { compat: { granted: ['userShell'] } },
    composer: '!ls', images: [], contextRefs: [],
  });
  await store.getState().sendPrompt();
  assert.match(store.getState().error, /Muse feature/);
  store.setState({ threads: [{ ...thread('s1', '/repo') }], hostInfo: { compat: { granted: [] } }, error: null });
  await store.getState().sendPrompt();
  assert.match(store.getState().error, /did not grant/);
});
test('plugin inventory refresh stores entries and tracks the available tab', async () => {
  const store = await frontendStore();
  globalThis.pluginEntries = [{ id: 'acme', version: '1.2', description: 'Tools', enabled: true }];
  await store.getState().refreshPlugins();
  const state = store.getState();
  assert.deepEqual(state.pluginEntries, globalThis.pluginEntries);
  assert.equal(state.pluginsAvailableShown, false);
  assert.equal(state.pluginsError, null);
  await store.getState().refreshPlugins(true);
  assert.equal(store.getState().pluginsAvailableShown, true);
});
test('managed skill inventory refresh stores entries and surfaces failures', async () => {
  const store = await frontendStore();
  globalThis.skillEntries = [{ id: 'bundled:git', name: 'git', description: 'Git help', scope: 'bundled', activation: 'on' }];
  await store.getState().refreshManagedSkills();
  assert.deepEqual(store.getState().skillEntries, globalThis.skillEntries);
  assert.equal(store.getState().skillsError, null);
});
test('project setup previews, scaffolds, and surfaces conflicts', async () => {
  const store = await frontendStore();
  globalThis.runProjectInit = async (grantId, museBin, dryRun, force) => {
    assert.equal(grantId, 'g1');
    if (dryRun) return '# Preview AGENTS.md';
    return force ? 'Wrote AGENTS.md' : 'AGENTS.md already exists. Pass --force to replace it, or --dry-run to preview.';
  };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: 'g1' }], preview: false });
  await store.getState().openInitDialog('w');
  assert.equal(store.getState().initDialog.preview, '# Preview AGENTS.md');
  await store.getState().runInit(false);
  assert.equal(store.getState().initDialog.conflict, true);
  assert.equal(store.getState().initDialog.done, false);
  await store.getState().runInit(true);
  assert.equal(store.getState().initDialog.done, true);
  store.getState().closeInitDialog();
  assert.equal(store.getState().initDialog, null);
});
test('startHost forwards posture and restarts on posture drift', async () => {
  const store = await frontendStore();
  const calls = [];
  const defaultPosture = { ephemeralSessions: false, disableWrite: false, disableShell: false, sandboxNetwork: 'proxy-only' };
  globalThis.storeBridge = async (method, params) => {
    calls.push([method, params]);
    if (method === 'status') return { running: true, trustWorkspace: false, posture: defaultPosture };
    if (method === 'startHost') {
      return {
        trustWorkspace: false,
        posture: { ephemeralSessions: params.noSessionLog === true, disableWrite: params.disableWrite === true, disableShell: params.disableShell === true, sandboxNetwork: params.sandboxNetwork },
      };
    }
    if (method === 'listModels') return { models: [] };
    return {};
  };
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'idle' }], selectedSessionId: 's1',
    ephemeralSessions: true, disableWrite: false, disableShell: true, sandboxNetwork: 'restricted',
  });
  await store.getState().startHost();
  const start = calls.find(([method]) => method === 'startHost');
  assert.deepEqual([start[1].noSessionLog, start[1].disableWrite, start[1].disableShell, start[1].sandboxNetwork], [true, false, true, 'restricted']);
  assert.deepEqual(store.getState().hostInfo.posture, { ephemeralSessions: true, disableWrite: false, disableShell: true, sandboxNetwork: 'restricted' });
  assert.match(store.getState().threads[0].notice.message, /posture changed/);
});
test('enterprise refresh stores generation and plane states', async () => {
  const store = await frontendStore();
  globalThis.enterpriseFixture = { generation: 'sha256:abc', sources: [{ plane: 'policy', sourceClass: 'system_file', state: 'active' }] };
  await store.getState().refreshEnterprise();
  assert.deepEqual(store.getState().enterprise, globalThis.enterpriseFixture);
  assert.equal(store.getState().enterpriseError, null);
});
test('plugin install picks a bundle, installs, and shows installed inventory', async () => {
  const store = await frontendStore();
  globalThis.installedBundles = [];
  globalThis.pickedBundle = '/bundles/acme';
  globalThis.pluginEntries = [{ id: 'acme', version: '1.0', description: 'New', enabled: false }];
  store.setState({ pluginsAvailableShown: true });
  await store.getState().installPlugin();
  assert.deepEqual(globalThis.installedBundles, ['/bundles/acme']);
  assert.equal(store.getState().pluginsAvailableShown, false);
  assert.equal(store.getState().pluginEntries[0].id, 'acme');
  globalThis.pickedBundle = null;
  globalThis.installedBundles = [];
  await store.getState().installPlugin();
  assert.deepEqual(globalThis.installedBundles, []);
});
test('skill install picks a folder, installs, and refreshes the inventory', async () => {
  const store = await frontendStore();
  globalThis.installedSkills = [];
  globalThis.pickedSkill = '/skills/acme';
  globalThis.skillEntries = [{ id: 'user:acme', name: 'acme', description: '', scope: 'user', activation: 'on' }];
  await store.getState().installSkill();
  assert.deepEqual(globalThis.installedSkills, ['/skills/acme']);
  assert.equal(store.getState().skillEntries[0].id, 'user:acme');
  globalThis.pickedSkill = null;
  globalThis.installedSkills = [];
  await store.getState().installSkill();
  assert.deepEqual(globalThis.installedSkills, []);
});
test('skill import previews without refreshing and refreshes on import', async () => {
  const store = await frontendStore();
  globalThis.importCalls = [];
  globalThis.skillEntries = [];
  assert.equal(await store.getState().importSkills('codex', true), 'preview');
  assert.deepEqual(globalThis.importCalls, [['codex', true]]);
  assert.equal(await store.getState().importSkills('claude', false), 'done');
  assert.deepEqual(globalThis.importCalls, [['codex', true], ['claude', false]]);
});
test('skill uninstall removes by id and refreshes the inventory', async () => {
  const store = await frontendStore();
  globalThis.uninstalledSkills = [];
  globalThis.skillEntries = [];
  await store.getState().uninstallSkill('user:acme');
  assert.deepEqual(globalThis.uninstalledSkills, ['user:acme']);
  assert.deepEqual(store.getState().skillEntries, []);
});
test('MCP catalog refresh stores servers and surfaces failures', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({ servers: [{ name: 'docs', transport: 'streamableHttp', oauth: true }] });
  await store.getState().refreshMcpServers();
  assert.deepEqual(store.getState().mcpServers, [{ name: 'docs', transport: 'streamableHttp', oauth: true }]);
  assert.equal(store.getState().mcpError, null);
  globalThis.storeBridge = async () => { throw new Error('host down'); };
  await store.getState().refreshMcpServers();
  assert.equal(store.getState().mcpError, 'host down');
  assert.equal(store.getState().mcpLoading, false);
});
test('busy sends queue behind the running turn and promote at launch', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't0', usage: { outputTokens: 10 } }],
    composer: 'later', images: [], contextRefs: [],
  });
  globalThis.storeBridge = async (method, params) => {
    assert.equal(method, 'sendTurn');
    assert.equal(params.ifBusy, 'queue');
    return { turnId: 't1', disposition: 'queued' };
  };
  await store.getState().sendPrompt({ disposition: 'queue' });
  let current = store.getState().threads[0];
  assert.deepEqual(current.queuedTurns, [{ turnId: 't1', text: 'later' }]);
  assert.equal(current.status, 'running');
  assert.equal(current.activeTurnId, 't0');
  assert.equal(store.getState().composer, '');
  globalThis.storeEvent('turnStarted', { sessionId: 's1', turnId: 't1' });
  current = store.getState().threads[0];
  assert.deepEqual(current.queuedTurns ?? [], []);
  assert.equal(current.activeTurnId, 't1');
  assert.equal(current.status, 'running');
});

test('unqueued completions drop the entry without failing the thread', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't0', queuedTurns: [{ turnId: 't1', text: 'later' }] }],
  });
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't1', outcome: { kind: 'unqueued' } });
  const current = store.getState().threads[0];
  assert.deepEqual(current.queuedTurns ?? [], []);
  assert.equal(current.status, 'running');
  assert.equal(current.error ?? null, null);
});

test('stale completions settle only their own turn items', async () => {
  const store = await frontendStore();
  store.setState({
    threads: [{ ...thread('s1', '/repo'), status: 'running', activeTurnId: 't-new', items: [
      { itemId: 'old-tool', kind: 'toolCall', status: 'inProgress', turnId: 't-old' },
      { itemId: 'new-tool', kind: 'toolCall', status: 'inProgress', turnId: 't-new' },
    ] }],
  });
  globalThis.storeEvent('turnCompleted', { sessionId: 's1', turnId: 't-old', outcome: { kind: 'completed', params: { terminal: 'cancelled' } } });
  const current = store.getState().threads[0];
  assert.equal(current.status, 'running');
  assert.equal(current.activeTurnId, 't-new');
  assert.deepEqual(current.items.map((item) => item.status), ['cancelled', 'inProgress']);
});

test('forkThread branches, selects the fork, and records provenance', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), title: 'Source', opened: true, config: { modelId: 'm' } }],
  });
  globalThis.storeBridge = async (method) => {
    if (method === 'forkSession') return { sessionId: 'fork-1', forkedFrom: { sourceSessionId: 's1', cutExplicit: false } };
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'listModels') return { models: [] };
    return {};
  };
  await store.getState().forkThread('s1');
  const state = store.getState();
  assert.equal(state.selectedSessionId, 'fork-1');
  const fork = state.threads.find((item) => item.sessionId === 'fork-1');
  assert.equal(fork.title, 'Source (fork)');
  assert.deepEqual(fork.forkedFrom, { sessionId: 's1', title: 'Source' });
  assert.equal(fork.opened, true);
});

test('forkThread passes real turn cut points and forks whole for local groupings', async () => {
  const store = await frontendStore();
  store.setState({
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), title: 'Source', opened: true, config: {} }],
  });
  const forks = [];
  globalThis.storeBridge = async (method, params) => {
    if (method === 'forkSession') { forks.push(params); return { sessionId: `fork-${forks.length}`, forkedFrom: { sourceSessionId: 's1' } }; }
    if (method === 'resumeSession') return { alreadyOpen: true };
    if (method === 'listModels') return { models: [] };
    return {};
  };
  await store.getState().forkThread('s1', 'turn-9');
  await store.getState().forkThread('s1', 'local:abc');
  assert.deepEqual(forks, [{ sessionId: 's1', lastTurnId: 'turn-9' }, { sessionId: 's1' }]);
});
test('compactThread reports noop reasons and clears its notice at terminal', async () => {
  const store = await frontendStore();
  store.setState({
    selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), status: 'idle' }],
  });
  globalThis.storeBridge = async () => ({ status: 'noop', reason: 'no_compactable_history' });
  await store.getState().compactThread();
  assert.match(store.getState().threads[0].notice.message, /no compactable history yet/);
  globalThis.storeBridge = async () => ({ status: 'admitted' });
  await store.getState().compactThread();
  assert.equal(store.getState().threads[0].notice.key, 'compacting');
  globalThis.storeEvent('item', { sessionId: 's1', item: { itemId: 'c1', kind: 'compaction', status: 'completed' } });
  assert.equal(store.getState().threads[0].notice, null);
});

test('openPreview reads without attaching and closePreview clears', async () => {
  const store = await frontendStore();
  store.setState({
    selectedSessionId: 's1', preview: false,
    threads: [{ ...thread('s1', '/repo'), title: 'Source', opened: false }, { ...thread('s2', '/repo'), title: 'Other', opened: false }],
  });
  globalThis.storeBridge = async (method, params) => {
    assert.equal(method, 'readSession');
    assert.equal(params.excludeItems, false);
    return { session: { sessionId: 's2', status: 'idle' }, history: { items: [] }, pendingRequests: [], viewCursor: 'v' };
  };
  await store.getState().openPreview('s2');
  const preview = store.getState().previewSession;
  assert.equal(preview.title, 'Other');
  assert.equal(preview.loading, false);
  assert.equal(preview.snapshot.session.status, 'idle');
  assert.equal(store.getState().threads.find((item) => item.sessionId === 's2').opened, false);
  store.getState().closePreview();
  assert.equal(store.getState().previewSession, null);
});

test('preview discard filters demo rows locally without a backend', async () => {
  const store = await frontendStore();
  store.setState({
    preview: true,
    git: { branch: 'main', dirty: true, files: [{ path: 'a.txt', status: 'M', added: 1, removed: 0 }, { path: 'b.txt', status: '??', added: 0, removed: 0 }], diff: 'd', truncated: false },
    diffTabs: ['a.txt', 'b.txt'], diffActive: 'a.txt',
  });
  await store.getState().discardGitFiles(['a.txt']);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['b.txt']);
  assert.equal(store.getState().git.dirty, true);
  assert.deepEqual(store.getState().diffTabs, ['b.txt']);
  await store.getState().discardAllGit();
  assert.deepEqual(store.getState().git.files, []);
  assert.equal(store.getState().git.dirty, false);
});
test('cross-project thread selection clears stale Git immediately and ignores a late response', async () => {
  const store = await frontendStore();
  const reads = { ga: deferred(), gb: deferred() };
  globalThis.readGit = grantId => reads[grantId].promise;
  store.setState({ workspaces: [{ id: 'a', path: '/a', grantId: 'ga' }, { id: 'b', path: '/b', grantId: 'gb' }], selectedWorkspaceId: 'a',
    git: { diff: 'old A' }, threads: [thread('a-thread', '/a'), thread('b-thread', '/b')] });
  await store.getState().selectThread('b-thread');
  assert.equal(store.getState().git, null);
  await store.getState().selectThread('a-thread');
  reads.gb.resolve({ diff: 'B' }); await new Promise(setImmediate);
  assert.equal(store.getState().git, null);
  reads.ga.resolve({ diff: 'new A' }); await new Promise(setImmediate);
  assert.equal(store.getState().git.diff, 'new A');
});
test('ungranted workspaces fail closed before any session call', async () => {
  const store = await frontendStore();
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    const calls = [];
    globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return {}; };
    store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }], error: null });
    await store.getState().selectWorkspace('w');
    assert.match(store.getState().error ?? '', /not granted/);
    assert.deepEqual(calls, []);
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('re-opening a folder re-attaches its native grant in place', async () => {
  const store = await frontendStore();
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    globalThis.storeBridge = async () => ({});
    store.setState({ workspaces: [{ id: 'w', path: '/repo', name: 'repo', grantId: null }] });
    await store.getState().addWorkspace('/repo', 'wg-reattached');
    const workspace = store.getState().workspaces.find((item) => item.id === 'w');
    assert.equal(workspace.grantId, 'wg-reattached');
    assert.equal(store.getState().workspaces.length, 1);
    assert.equal(store.getState().selectedWorkspaceId, 'w');
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('opening a thread in an ungranted workspace fails closed', async () => {
  const store = await frontendStore();
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    const calls = [];
    globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return {}; };
    store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }], threads: [{ ...thread('s', '/repo'), opened: false }] });
    await store.getState().selectThread('s');
    assert.match(store.getState().threads[0].error ?? '', /not granted/);
    assert.equal(store.getState().threads[0].opened, false);
    assert.deepEqual(calls, []);
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('quiet-turn reconcile skips ungranted workspaces', async () => {
  const module = await bundle('apps/desktop/src/lib/store.ts', storeReplacements);
  const store = module.useAppStore;
  globalThis.window.__TAURI_INTERNALS__ = {};
  try {
    const calls = [];
    globalThis.storeBridge = async (method, params) => { calls.push([method, params]); return { sessions: [] }; };
    store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: null }],
      threads: [{ ...thread('s', '/repo'), status: 'running', updatedAt: new Date(Date.now() - 60000).toISOString() }] });
    await module.reconcileRunningThreads();
    assert.deepEqual(calls, []);
  } finally { delete globalThis.window.__TAURI_INTERNALS__; }
});

test('host retirement invalidates opened sessions without a spurious connection error', async () => {
  const store = await frontendStore();
  store.setState({ threads: [{ ...thread('s', '/a'), status: 'running', activeTurnId: 'turn', plan: [{ id: 'p', text: 'Work', status: 'inProgress' }], items: [{ itemId: 'tool', kind: 'toolCall', status: 'inProgress', turnId: 'turn' }], userInputs: [{ userInputId: 'q' }] }] });
  globalThis.storeEvent('hostStopping', {});
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().threads[0].opened, false);
  assert.equal(store.getState().threads[0].activeTurnId, null);
  assert.equal(store.getState().threads[0].lastTurnId, 'turn');
  assert.equal(store.getState().threads[0].lastOutcome, 'interrupted');
  assert.equal(store.getState().threads[0].plan[0].status, 'cancelled');
  assert.equal(store.getState().threads[0].items[0].status, 'cancelled');
  assert.deepEqual(store.getState().threads[0].userInputs, []);
});

test('preview cancellation settles the turn, plan, and running agents together', async () => {
  const store = await frontendStore();
  store.setState({ preview: true, selectedSessionId: 's', threads: [{ ...thread('s', '/a'), status: 'running', activeTurnId: 'turn', turnStartedAt: Date.now() - 1000,
    plan: [{ id: 'p', text: 'Work', status: 'inProgress' }],
    items: [
      { itemId: 'u', kind: 'userMessage', status: 'completed', turnId: 'turn', text: 'Go' },
      { itemId: 'w', kind: 'workflow', status: 'inProgress', turnId: 'turn', children: [{ childId: 'a', attempt: 1, status: 'started' }] },
      { itemId: 't', kind: 'toolCall', status: 'inProgress', turnId: 'turn' },
    ], pendingApproval: { approvalId: 'a' } }] });
  await store.getState().stopTurn();
  const settled = store.getState().threads[0];
  assert.equal(settled.status, 'idle');
  assert.equal(settled.activeTurnId, null);
  assert.equal(settled.lastTurnId, 'turn');
  assert.equal(settled.lastOutcome, 'cancelled');
  assert.equal(settled.pendingApproval, null);
  assert.equal(settled.plan[0].status, 'cancelled');
  assert.deepEqual(settled.items.map(item => item.status), ['completed', 'cancelled', 'cancelled']);
});
const question = (id = 'q', sessionId = 's') => ({ sessionId, userInputId: id, turnId: 't', viewCursor: 'opaque', questions: [{ id: 'choice', header: 'Choose', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }], selection: { mode: 'single' } }] });
test('failed question response preserves pending questions; success removes only its own question', async () => {
  const store = await frontendStore();
  store.setState({ threads: [thread('s', '/a')] });
  globalThis.storeEvent('userInputs', { sessionId: 's', requests: [question(), question('q2')] });
  globalThis.storeBridge = async () => { throw new Error('offline'); };
  await store.getState().respondUserInput('s', 'q', { action: 'cancel' });
  assert.equal(store.getState().threads[0].userInputs.length, 2);
  assert.match(store.getState().threads[0].error, /offline/);
  globalThis.storeBridge = async () => ({ status: 'accepted' });
  await store.getState().respondUserInput('s', 'q', { action: 'cancel' });
  assert.deepEqual(store.getState().threads[0].userInputs.map(x => x.userInputId), ['q2']);
});

const { UserInputRelay, observeNotifications } = await bundle('packages/muse-bridge/src/user-input.ts');
const notification = (method, params) => ({ jsonrpc: '2.0', method, params });
test('question relay preserves simultaneous sessions and does not revive settled requests', () => {
  const relay = new UserInputRelay(() => {});
  relay.notify(notification('userInput/requested', question()));
  relay.notify(notification('userInput/requested', question('q', 'other')));
  relay.notify(notification('userInput/settled', { sessionId: 's', userInputId: 'q' }));
  relay.notify(notification('userInput/requested', question()));
  assert.equal(relay.requests('s').length, 0);
  assert.equal(relay.requests('other').length, 1);
});
test('resume reads do not erase newer questions or resurrect questions settled in flight', () => {
  const relay = new UserInputRelay(() => {});
  const version = relay.version('s');
  relay.notify(notification('userInput/requested', question('new')));
  relay.notify(notification('userInput/settled', { sessionId: 's', userInputId: 'old' }));
  relay.restore('s', [question('old')], version);
  assert.deepEqual(relay.requests('s').map(x => x.userInputId), ['new']);
  relay.restore('s', [], relay.version('s'));
  assert.deepEqual(relay.requests('s'), []);
});
test('terminal turns clear their questions while preserving other turns', () => {
  const relay = new UserInputRelay(() => {});
  relay.notify(notification('userInput/requested', question()));
  relay.notify(notification('userInput/requested', { ...question('q2'), turnId: 't2' }));
  relay.notify(notification('turn/completed', { sessionId: 's', turnId: 't' }));
  assert.deepEqual(relay.requests('s').map(x => x.userInputId), ['q2']);
});
test('notification adapter preserves SDK routing and private receiver bindings', () => {
  class Connection {
    #value = 7;
    get value() { return this.#value; }
    request() { return this.#value; }
    onNotification(callback) { this.handler = callback; }
  }
  const connection = new Connection(); const observed = [];
  const adapter = observeNotifications(connection, event => observed.push(['observer', event.method]));
  adapter.onNotification(event => observed.push(['sdk', event.method]));
  connection.handler(notification('userInput/requested', question()));
  assert.deepEqual(observed, [['sdk', 'userInput/requested'], ['observer', 'userInput/requested']]);
  assert.equal(adapter.value, 7); assert.equal(adapter.request(), 7);
});

async function fakeHost(t) {
  const hosts = [];
  const events = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = function (chunk, ...args) {
    if (typeof chunk === 'string' && chunk.startsWith('{"type":"event"')) { events.push(JSON.parse(chunk)); return true; }
    return originalWrite.call(this, chunk, ...args);
  };
  t.after(() => { process.stdout.write = originalWrite; });
  globalThis.fakeSdk = {
    spawn() {
      const exit = deferred();
      const current = { exit, requests: [], commands: [], pending: [] };
      current.connection = {
        onNotification(handler) { current.notify = handler; },
        request: async (method, params) => { current.requests.push([method, params]); return { userInputs: current.pending }; },
        command: async (method, params) => { current.commands.push([method, params]); return { status: 'accepted' }; },
      };
      current.spawned = { child: { exit: exit.promise }, connection: current.connection, initializeResult: { serverInfo: {}, sessionDurability: 'durable' } };
      hosts.push(current);
      return { initialize: async () => current.spawned };
    },
    MuseClient: class {
      constructor(connection, { host }) { this.host = host; connection.onNotification(() => {}); }
      async close() { this.host.child.exit; hosts.find(item => item.spawned === this.host).exit.resolve({ code: 0 }); await Promise.resolve(); }
      async resumeSession({ sessionId }) { return { sessionId, onApproval() {}, onApprovalError() {}, onGapError() {}, opening: { verb: 'session/resume', result: { session: { sessionId, activeTurnId: null }, history: { items: [] } } } }; }
    },
  };
  const { MuseHost } = await bundle('packages/muse-bridge/src/host.ts', {
    '@muse-code/sdk': 'export const spawnMspConnection=(...args)=>globalThis.fakeSdk.spawn(...args); export const MuseClient=globalThis.fakeSdk.MuseClient; export const readSessionDurability=()=>({kind:"durable"}); export const EXPECTED_SCHEMA_FINGERPRINT="sha256:fake-pin";',
    './detect.js': 'export const resolveMuseBin=()=>"/fake/muse"; export const detectMuse=()=>({found:true}); export const museEnv=base=>({...base});',
  });
  return { host: new MuseHost(), hosts, events };
}
test('host restart emits retirement without emitting a crash from the old process', async t => {
  const { host, hosts, events } = await fakeHost(t);
  await host.start(); await host.start();
  assert.equal(hosts.length, 2);
  assert.deepEqual(events.map(event => event.event), ['hostStopping']);
  hosts[1].exit.resolve({ code: 1 }); await new Promise(setImmediate);
  assert.equal(events.at(-1).event, 'hostExit');
  assert.equal(host.status().running, false);
});
test('host restores questions on resume and sends answer, clarification and cancellation commands', async t => {
  const { host, hosts } = await fakeHost(t);
  await host.start();
  const server = hosts[0];
  server.pending = [question()];
  const resumed = await host.resumeSession({ sessionId: 's' });
  assert.deepEqual(resumed.userInputs, [question()]);
  assert.equal(server.requests[0][0], 'approval/listPending');
  const answers = [{ questionId: 'choice', selectedLabel: 'A' }];
  await host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'answer', answers } });
  await host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'clarify', text: 'Consider C' } });
  await host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'cancel' } });
  assert.deepEqual(server.commands.map(([method]) => method), ['userInput/answer', 'userInput/clarify', 'userInput/cancel']);
  assert.deepEqual(server.commands[0][1].answers, answers);
  assert.deepEqual(server.commands[1][1].clarification, { format: 'text', content: 'Consider C' });
  server.notify(notification('userInput/settled', { sessionId: 's', userInputId: 'q' }));
  await assert.rejects(host.respondUserInput({ sessionId: 's', userInputId: 'q', response: { action: 'cancel' } }), /no longer pending/);
  await host.stop();
});

// Exercise the actual component handlers with a minimal deterministic hook host.
// Browser smoke checks cover native dialog/keyboard rendering separately.
test('first selection of an untrusted workspace prompts trust exactly once', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({});
  globalThis.readGit = async () => ({ branch: 'main', dirty: false, files: [], diff: '', truncated: false });
  globalThis.trustPreviewResult = { skills: [{ name: '/deploy', description: 'Deploys' }], rules: null };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g', trusted: false }], preview: false });
  await store.getState().selectWorkspace('w');
  await new Promise(setImmediate);
  assert.equal(store.getState().trustDialog?.workspaceId, 'w');
  assert.deepEqual(store.getState().trustDialog?.preview, globalThis.trustPreviewResult);
  assert.equal(store.getState().workspaces[0].trustPrompted, true);
  // Re-selecting after dismissing does not reopen the dialog.
  store.getState().closeTrustDialog();
  await store.getState().selectWorkspace('w');
  await new Promise(setImmediate);
  assert.equal(store.getState().trustDialog, null);
});

test('an untrusted workspace with nothing to trust marks prompted silently', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async () => ({});
  globalThis.readGit = async () => ({ branch: 'main', dirty: false, files: [], diff: '', truncated: false });
  globalThis.trustPreviewResult = { skills: [], rules: null };
  store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g' }], preview: false });
  await store.getState().selectWorkspace('w');
  await new Promise(setImmediate);
  assert.equal(store.getState().trustDialog, null);
  assert.equal(store.getState().workspaces[0].trustPrompted, true);
});

test('confirm resolves with the answer and a second confirm cancels the first', async () => {
  const store = await frontendStore();
  const first = store.getState().confirm({ title: 'Delete thread?' });
  assert.equal(store.getState().confirmDialog?.title, 'Delete thread?');
  assert.equal(store.getState().confirmDialog?.confirmLabel, 'Confirm');
  assert.equal(store.getState().confirmDialog?.danger, false);
  store.getState().resolveConfirm(true);
  assert.equal(await first, true);
  assert.equal(store.getState().confirmDialog, null);
  const second = store.getState().confirm({ title: 'One' });
  const third = store.getState().confirm({ title: 'Two' });
  assert.equal(await second, false, 'a new confirm resolves the pending one as cancelled');
  store.getState().resolveConfirm(false);
  assert.equal(await third, false);
});

test('hydrate clamps a persisted allowAll approval default to promptUnmatched', async () => {
  globalThis.persistedData = { settings: { defaultApprovalMode: 'allowAll' } };
  const store = await frontendStore({
    '@tauri-apps/plugin-store': `export class LazyStore { async entries(){ return Object.entries(globalThis.persistedData ?? {}); } async get(key){ return globalThis.persistedData?.[key]; } async set(key, value){ globalThis.persistedData = { ...globalThis.persistedData, [key]: value }; } async save(){ throw new Error('the non-atomic plugin writer must not be used'); } }`,
    '@tauri-apps/api/core': `export const invoke = async (command) => command === 'acp_isolation_consent_get' ? false : command === 'credential_get' ? null : undefined;`,
    '@tauri-apps/plugin-notification': `export const isPermissionGranted=async()=>true;export const requestPermission=async()=>"granted";export const sendNotification=()=>{};`,
  }, true);
  await store.getState().hydrate();
  assert.equal(store.getState().defaultApprovalMode, 'promptUnmatched');
});

function hooks() {
  const values = []; let cursor = 0; const effects = [];
  return {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    useEffect(callback, dependencies) { const i = cursor++; if (!values[i] || dependencies.some((value, j) => value !== values[i][j])) { values[i] = dependencies; effects.push(callback); } },
    render(Component, props) { cursor = 0; const tree = Component(props); for (const effect of effects.splice(0)) effect(); return tree; },
  };
}
function nodes(element) {
  if (!element || typeof element !== 'object') return [];
  const children = Array.isArray(element.props?.children) ? element.props.children.flat(Infinity) : [element.props?.children];
  return [element, ...children.flatMap(nodes)];
}
async function settingsComponent() {
  const runtime = hooks(); globalThis.componentHooks = runtime;
  const commits = [];
  const state = { ...DEFAULT_SETTINGS, models: [], agents: [], settingsOpen: true, preview: false, hostInfo: null,
    setSettingsOpen: value => { state.settingsOpen = value; },
    commitSettings: async patch => { commits.push(patch); Object.assign(state, patch); },
    startHost: async () => { state.restarts = (state.restarts ?? 0) + 1; },
  };
  globalThis.componentState = state;
  const { SettingsModal } = await bundle('apps/desktop/src/components/SettingsModal.tsx', {
    'react/jsx-runtime': 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment=Symbol.for("react.fragment");',
    react: 'export const useState=(...args)=>globalThis.componentHooks.useState(...args); export const useRef=(...args)=>globalThis.componentHooks.useRef(...args); export const useEffect=(...args)=>globalThis.componentHooks.useEffect(...args); export const lazy=(load)=>{const component=()=>null;component.load=load;return component;}; export const Suspense=(props)=>props.children ?? null;',
    'zustand/react/shallow': 'export const useShallow=(selector)=>selector;',
    '../lib/store': 'export const useAppStore=()=>globalThis.componentState;useAppStore.getState=()=>globalThis.componentState;export const applyTheme=()=>{};export const currentThread=()=>undefined;export const currentWorkspace=()=>undefined;',
    'lucide-react': 'const I=()=>null;export const Activity=I,Archive=I,ArchiveRestore=I,Bot=I,ChartNoAxesColumn=I,Check=I,Command=I,Cpu=I,Eye=I,EyeOff=I,FilePlus=I,FolderOpen=I,Info=I,KeyRound=I,Lock=I,MessagesSquare=I,Monitor=I,Moon=I,Palette=I,PanelLeft=I,Puzzle=I,RefreshCw=I,Search=I,Settings2=I,ShieldCheck=I,Sun=I,Trash2=I,TriangleAlert=I,X=I;',
    './SelectMenu': 'export const SelectMenu=()=>null;',
    './AgentPicker': 'export const AgentMark=()=>null;',
    './ExtensionsView': 'export const ExtensionsView=()=>null;',
    './UsageView': 'export const UsageView=()=>null;',
    './LoginPanel': 'export const LoginPanel=()=>null;',
  });
  const render = () => runtime.render(SettingsModal);
  render(); render();
  return { state, commits, render };
}
test('Settings Cancel discards approval, theme and executable edits', async () => {
  const { state, commits, render } = await settingsComponent();
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Permissions').props.onClick();
  tree = nodes(render());
  tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange).props.onChange({ defaultApprovalMode: 'allowAll' });
  tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Account').props.onClick();
  tree = nodes(render());
  tree.find(node => node.props?.id === 'muse-bin').props.onChange({ target: { value: '/other/muse' } });
  tree.find(node => node.props?.['aria-label'] === 'Theme').props.onClick();
  tree = nodes(render());
  const theme = tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange);
  nodes(theme.type(theme.props)).filter(node => node.props?.role === 'radio')[1].props.onClick();
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Cancel').props.onClick();
  assert.equal(state.settingsOpen, false);
  assert.equal(state.defaultApprovalMode, 'onRequest');
  assert.equal(state.theme, 'system'); assert.equal(state.museBin, '');
  assert.deepEqual(commits, []);
});
test('Settings save restarts a running host only when posture changed', async () => {
  const { state, commits, render } = await settingsComponent();
  state.hostInfo = { posture: { ephemeralSessions: false, disableWrite: false, disableShell: false, sandboxNetwork: 'proxy-only' } };
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Permissions').props.onClick();
  tree = nodes(render());
  tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange).props.onChange({ ephemeralSessions: true });
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Save changes').props.onClick();
  await new Promise(setImmediate);
  assert.equal(commits[0].ephemeralSessions, true);
  assert.equal(state.restarts, 1);
});
test('Settings Done commits all edits together and a failed save keeps the dialog open', async () => {
  const { state, commits, render } = await settingsComponent();
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Permissions').props.onClick();
  tree = nodes(render());
  tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange).props.onChange({ defaultApprovalMode: 'onRequest' });
  tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Theme').props.onClick();
  tree = nodes(render());
  const theme = tree.find(node => typeof node.type === 'function' && node.props?.draft && node.props?.onChange);
  nodes(theme.type(theme.props)).filter(node => node.props?.role === 'radio')[1].props.onClick();
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Save changes').props.onClick();
  await new Promise(setImmediate);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].defaultApprovalMode, 'onRequest'); assert.equal(commits[0].theme, 'light');
  assert.equal(state.settingsOpen, false);
  state.settingsOpen = true; render(); render();
  state.commitSettings = async () => { throw new Error('credential store locked'); };
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Save changes').props.onClick();
  await new Promise(setImmediate);
  assert.equal(state.settingsOpen, true);
  assert.ok(nodes(render()).some(node => node.props?.role === 'status' && node.props.children.includes('credential store locked')));
});

async function questionComponent(request) {
  const runtime = hooks(); globalThis.componentHooks = runtime;
  const sent = [];
  globalThis.componentState = { respondUserInput: (...args) => sent.push(args) };
  const { UserInputCard } = await bundle('apps/desktop/src/components/UserInputCard.tsx', {
    react: 'export const useState=(...args)=>globalThis.componentHooks.useState(...args);',
    'react/jsx-runtime': 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment=Symbol.for("react.fragment");',
    '../lib/store': 'export const useAppStore=(selector)=>selector(globalThis.componentState);',
  });
  return { sent, render: () => runtime.render(UserInputCard, { request, disabled: false }) };
}
test('question form validates all questions and emits single, multiple and free-text answers', async () => {
  const request = question();
  request.questions.push({ id: 'multi', header: 'Pick two', question: 'Which two?', options: [{ label: 'C' }, { label: 'D' }], selection: { mode: 'multiple', minSelections: 2, maxSelections: 2 } });
  request.questions.push({ id: 'text', header: 'Explain', question: 'Why?', options: [], selection: { mode: 'single' } });
  const { sent, render } = await questionComponent(request);
  let tree = nodes(render());
  const submit = () => nodes(render()).find(node => node.type === 'button' && node.props.children === 'Send answers').props.onClick();
  submit(); assert.equal(sent.length, 0);
  tree.find(node => node.type === 'input' && node.props.type === 'radio').props.onChange({ target: { checked: true } });
  tree = nodes(render());
  tree.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } });
  submit(); assert.equal(sent.length, 0);
  tree = nodes(render());
  tree.filter(node => node.type === 'input' && node.props.type === 'checkbox')[1].props.onChange({ target: { checked: true } });
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Because it works' } });
  submit();
  assert.deepEqual(sent, [['s', 'q', { action: 'answer', answers: [
    { questionId: 'choice', selectedLabel: 'A' },
    { questionId: 'multi', selectedLabels: ['C', 'D'] },
    { questionId: 'text', freeText: 'Because it works' },
  ] }]]);
});
test('question form offers clarification and decline independently of required answers', async () => {
  const { sent, render } = await questionComponent(question());
  nodes(render()).find(node => node.type === 'button' && node.props.children === 'Let me explain').props.onClick();
  let tree = nodes(render());
  assert.equal(tree.find(node => node.type === 'button' && node.props.children === 'Send explanation').props.disabled, true);
  tree.find(node => node.type === 'textarea').props.onChange({ target: { value: 'Consider a third option' } });
  tree = nodes(render());
  tree.find(node => node.type === 'button' && node.props.children === 'Send explanation').props.onClick();
  tree.find(node => node.type === 'button' && node.props.children === 'Decline to answer').props.onClick();
  assert.deepEqual(sent.map(args => args[2]), [{ action: 'clarify', text: 'Consider a third option' }, { action: 'cancel' }]);
});

test('workflow reconciled envelope renders as a summary, not raw JSON', async () => {
  const { parseWorkflowMessage, agentCounts } = await bundle('apps/desktop/src/lib/agent.ts');
  const payload = { type: 'workflow_launch_reconciled', launch_admitted: true,
    final_summary: { status: 'completed', summary: JSON.stringify({ complete: true, evidence: ['wrote docs/release-readiness.md'], unresolved: ['open_url scheme validation'] }) },
    latest_failure: null,
    agents_activity: [{ agent: 'a1', tool_calls: 47, duration_ms: 207249 }, { agent: 'a2', tool_calls: 38, duration_ms: 224644 }] };
  const message = `<workflow-launch-reconciled>${JSON.stringify(payload)}</workflow-launch-reconciled>`;
  const outcome = parseWorkflowMessage(message);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(outcome.evidence, ['wrote docs/release-readiness.md']);
  assert.deepEqual(outcome.unresolved, ['open_url scheme validation']);
  assert.equal(outcome.activity.get('a1').durationMs, 207249);
  assert.ok(!outcome.text.includes('{'));
  assert.equal(parseWorkflowMessage('<x-y>not json</x-y>').text, '');
  assert.equal(parseWorkflowMessage('All done.').text, 'All done.');
  const children = [{ childId: 'a1', attempt: 1, status: 'started' }, { childId: 'a2', attempt: 1, status: 'queued' }];
  assert.deepEqual(agentCounts({ kind: 'workflow', status: 'completed', message, children }).states, ['completed', 'completed']);
  assert.deepEqual(agentCounts({ kind: 'workflow', status: 'completed', message: 'done', children }).states, ['cancelled', 'cancelled']);
});

// React rejects a component that renders more hooks than it did last time
// (error #310). ReviewDock once returned null for a closed dock *before* two
// useMemo calls, so opening the Changes dock crashed the whole window.
test('no component calls a hook after an early return', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
  const hook = /\buse(State|Effect|LayoutEffect|Memo|Ref|Callback|Id|AppStore|SyncExternalStore)\s*\(/;
  const componentStart = /^(export )?(default )?function [A-Za-z]|^(export )?const [A-Z][A-Za-z]*\s*[:=].*=>\s*\{/;
  const offenders = [];
  for (const file of walk('apps/desktop/src')) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let inComponent = false, earlyReturn = null;
    lines.forEach((line, index) => {
      if (componentStart.test(line)) { inComponent = true; earlyReturn = null; return; }
      if (!inComponent) return;
      // A bail-out in the component body, guarded or not.
      if (earlyReturn === null && /^ {2}(if \(.*\) )?return\b/.test(line)) earlyReturn = index + 1;
      if (earlyReturn !== null && hook.test(line) && !line.includes('useAppStore.getState')) {
        offenders.push(`${file}:${index + 1} calls a hook after the return on line ${earlyReturn}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});

// Agent toggles looked dead: every switch rendered disabled with the reason
// only in a `title` attribute, which browsers never show on disabled buttons.
// The reason now renders inline on the row, and the consent gate unlocks the
// third-party toggle so a second ready agent frees the Muse switch.
test('Agent toggles explain consent and last-ready-agent gates, then unlock', async () => {
  const { state, commits, render } = await settingsComponent();
  state.agents = [
    { id: 'muse', name: 'Muse', protocol: 'msp', found: true, path: '/bin/muse', version: '1.3.0', verified: true, signIn: '', authenticated: true },
    { id: 'opencode', name: 'OpenCode', protocol: 'acp', found: true, path: '/bin/opencode', version: '1.18.31', verified: true, signIn: '' },
  ];
  state.agentIdentities = [];
  state.refreshAgentIdentities = async () => {};
  let tree = nodes(render());
  tree.find(node => node.props?.['aria-label'] === 'Agents').props.onClick();
  tree = nodes(render());
  const toggleFor = (label) => tree.find(node => node.type === 'button' && node.props?.['aria-label'] === label);
  assert.equal(toggleFor('Show OpenCode in the composer').props.disabled, true);
  assert.equal(toggleFor('Hide Muse in the composer').props.disabled, true);
  assert.ok(tree.some(node => node.props?.children === 'Hidden — accept the isolation notice above to enable'));
  tree.find(node => node.type === 'input' && node.props?.type === 'checkbox').props.onChange({ target: { checked: true } });
  tree = nodes(render());
  assert.equal(toggleFor('Show OpenCode in the composer').props.disabled, false);
  assert.equal(toggleFor('Hide Muse in the composer').props.disabled, true);
  toggleFor('Show OpenCode in the composer').props.onClick();
  tree = nodes(render());
  assert.equal(toggleFor('Hide Muse in the composer').props.disabled, false);
  assert.equal(toggleFor('Hide OpenCode in the composer').props['aria-checked'], true);
  tree.find(node => node.type === 'button' && node.props.children === 'Save changes').props.onClick();
  await new Promise(setImmediate);
  assert.equal(commits[0].acpUnisolatedConsent, true);
  assert.equal(commits[0].enabledAgents.opencode, true);
  assert.equal(commits[0].enabledAgents.muse, true);
});

// Grok's set_config_option takes ~2s. Scrubbing effort during the apply used to
// drop input and fire two listModels refreshes per echo — seconds of churn per
// detent. Patches now merge into one trailing call, and effort-only echoes skip
// the catalog refresh.
test('ACP config changes coalesce in flight and effort echoes skip listModels', async () => {
  const store = await frontendStore();
  const calls = [];
  const releases = [];
  globalThis.storeBridge = (method, params) => {
    calls.push({ method, params });
    if (method === 'setSessionOption') return new Promise((resolve) => releases.push(resolve));
    return Promise.resolve({});
  };
  store.setState({
    preview: false,
    workspaces: [{ id: 'w', path: '/repo', grantId: 'g' }], selectedWorkspaceId: 'w',
    threads: [{ ...thread('s1', '/repo'), agentId: 'grok', config: { agentId: 'grok', modelId: 'grok-4.6', effort: 'low', mode: 'agent' } }],
    selectedSessionId: 's1', modelsAgentId: 'grok', models: [],
  });
  const first = store.getState().setSessionConfig({ effort: 'high' });
  await new Promise(setImmediate);
  assert.equal(store.getState().threads[0].configPending, true);
  await store.getState().setSessionConfig({ effort: 'medium' });
  await store.getState().setSessionConfig({ effort: 'max' });
  assert.deepEqual(store.getState().threads[0].pendingConfig, { effort: 'max' });
  assert.equal(calls.filter((c) => c.method === 'setSessionOption').length, 1, 'no second call while one is in flight');
  releases.shift()({ agentConfig: { modelId: 'grok-4.6', effort: 'high', mode: 'agent' } });
  await first;
  await new Promise(setImmediate);
  const options = calls.filter((c) => c.method === 'setSessionOption');
  assert.equal(options.length, 2);
  assert.equal(options[1].params.value, 'max', 'the merged stash sends only the newest value');
  releases.shift()({ agentConfig: { modelId: 'grok-4.6', effort: 'max', mode: 'agent' } });
  await new Promise(setImmediate);
  assert.equal(store.getState().threads[0].config.effort, 'max');
  assert.equal(store.getState().threads[0].pendingConfig, undefined);
  globalThis.storeEvent('agentConfig', { sessionId: 's1', config: { modelId: 'grok-4.6', effort: 'high', mode: 'agent' } });
  await new Promise(setImmediate);
  assert.equal(calls.filter((c) => c.method === 'listModels').length, 0, 'effort-only echo skips the refresh');
  globalThis.storeEvent('agentConfig', { sessionId: 's1', config: { modelId: 'grok-5', effort: 'high', mode: 'agent' } });
  await new Promise(setImmediate);
  assert.equal(calls.filter((c) => c.method === 'listModels').length, 1, 'a model move still refreshes the catalog');
});
