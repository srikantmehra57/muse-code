import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Regression tests for concurrency and optimistic-update defects found in the
// production audit (AUD): stale read resurrecting pre-mutation git state,
// double-submit on a non-idempotent fork, and a failed busy-send leaving an
// unsent message in the transcript.
const temporary = await mkdtemp(join(tmpdir(), 'muse-state-hardening-'));
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const storeReplacements = {
  // The atomic saver reads the whole document back through `entries()`, and the
  // plugin's own `save()` is the truncate-and-write we must never fall back to.
  '@tauri-apps/plugin-store': `export class LazyStore { async entries(){ return Object.entries(globalThis.persistedData ?? {}); } async get(key){ return globalThis.persistedData?.[key]; } async set(key, value){ globalThis.persistedData = { ...globalThis.persistedData, [key]: value }; } async save(){ throw new Error('the non-atomic plugin writer must not be used'); } }`,
  './bridge': `export const persistStoreDocument=async(...args)=>globalThis.persistStoreDocument?.(...args);
    export const repairStoreDocument=async()=>globalThis.storeRepair ?? {status:'ok'};
    export const bridge=(...args)=>globalThis.storeBridge(...args);
    export const gitSnapshot=(grantId)=>globalThis.readGit(grantId);
    export const verifyGrants=async()=>[];export const removeGrant=async()=>{};
    export const onBridgeEvent=(handler)=>{globalThis.storeEvent=handler;return ()=>{}};
    export const pickFolder=async()=>null;export const mockThreads=()=>[];
    export const readDroppedPaths=async()=>globalThis.droppedPaths ?? [];
    export const agentIdentities=async()=>[];export const confirmAgentBin=async()=>{throw new Error('preview')};
    export const gitDiscardFiles=async(...args)=>{globalThis.discardCalls.push(args);return globalThis.mutationGit;};
    export const gitDiscardAll=async()=>globalThis.mutationGit;
    export const gitDiscardHunk=async()=>globalThis.mutationGit;
    export const gitStage=async()=>globalThis.mutationGit;
    export const gitCommit=async()=>globalThis.mutationGit;
    export const trustPreview=async()=>({ skills: [], rules: null });
    export const listWorkspaceFiles=async()=>[];
    export const cliLogout=async()=>{};
    export const pluginList=async()=>[];export const skillList=async()=>[];
    export const projectInit=async()=>({});
    export const enterpriseStatus=async()=>({ generation: null, sources: [] });
    export const pickPluginBundle=async()=>null;export const pluginInstall=async()=>{};
    export const pickSkillSource=async()=>null;export const skillInstall=async()=>'installed';
    export const skillImport=async()=>'done';export const skillUninstall=async()=>'removed';`,
};

async function frontendStore(tauri = true) {
  globalThis.window = { setTimeout, clearTimeout, matchMedia: () => ({ matches: false }), ...(tauri ? { __TAURI_INTERNALS__: {} } : {}) };
  globalThis.document = { documentElement: { dataset: {} } };
  globalThis.storeBridge = async () => ({});
  globalThis.discardCalls = [];
  const module = await bundle('apps/desktop/src/lib/store.ts', storeReplacements);
  module.bindBridgeEvents();
  return module.useAppStore;
}

const git = (files) => ({ branch: 'main', dirty: files.length > 0, files: files.map((path) => ({ path, status: 'M', added: 1, removed: 0 })), diff: '', truncated: false });
/**
 * `scheduleMemory` debounces local persistence at 200ms and returns nothing to
 * await, so a save is observable only after that window. Waiting out a fixed,
 * documented debounce is deterministic; polling or racing would not be.
 */
const flushMemorySave = () => new Promise((resolve) => setTimeout(resolve, 320));

const workspace = (store) => store.setState({ workspaces: [{ id: 'w', path: '/repo', grantId: 'g1' }], selectedWorkspaceId: 'w', preview: false });

test('a git read started before a mutation cannot resurrect pre-mutation state', async () => {
  const store = await frontendStore();
  workspace(store);
  const stale = deferred();
  globalThis.readGit = () => stale.promise;
  globalThis.mutationGit = git(['kept.txt']);

  // A slow snapshot is in flight while the user discards a file.
  const reading = store.getState().refreshGit();
  await sleep(5);
  await store.getState().discardGitFiles(['dropped.txt']);
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['kept.txt']);

  // The stale read lands last: it must be dropped, not applied.
  stale.resolve(git(['dropped.txt', 'kept.txt']));
  await reading;
  assert.deepEqual(store.getState().git.files.map((file) => file.path), ['kept.txt']);
  assert.equal(store.getState().gitLoading, false);
});

test('a double-click on fork sends exactly one forkSession', async () => {
  const store = await frontendStore();
  const forks = [];
  globalThis.storeBridge = async (method, args) => {
    if (method === 'forkSession') { forks.push(args); await sleep(20); return { sessionId: `fork-${forks.length}` }; }
    return {};
  };
  store.setState({ threads: [{ sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'idle', title: 'Source' }], selectedSessionId: 's1', preview: false });

  await Promise.all([store.getState().forkThread('s1'), store.getState().forkThread('s1')]);
  assert.equal(forks.length, 1, 'session/fork is not idempotent; a second concurrent call must be dropped');
  const created = store.getState().threads.filter((thread) => thread.sessionId.startsWith('fork-'));
  assert.equal(created.length, 1);
});

test('local saves go through the native atomic writer and never the plugin writer', async () => {
  const store = await frontendStore(true);
  globalThis.persistedData = {};
  // Every `frontendStore` bundles a fresh module, so an earlier test's module can
  // still have a debounced save pending. Drain those before measuring ours.
  await flushMemorySave();
  const writes = [];
  globalThis.persistStoreDocument = async (json) => { writes.push(json); };

  store.getState().setDockOpen(false);
  await flushMemorySave();

  const docs = writes.map((json) => JSON.parse(json));
  assert.equal(docs.length, 1, 'exactly one atomic write for one debounced save');
  assert.ok(docs[0].sessionMemory, 'the whole document is handed to the atomic writer');
  assert.equal(docs[0].sessionMemory.dockOpen, false, 'the payload carries the change that triggered it');
});

test('a failed local save surfaces a banner and the next success clears it', async () => {
  const store = await frontendStore(true);
  globalThis.persistedData = {};
  // Drain saves still pending from earlier bundles before measuring ours.
  await flushMemorySave();
  globalThis.persistStoreDocument = async () => { throw new Error('disk full'); };

  store.getState().setDockOpen(false);
  await flushMemorySave();

  assert.match(store.getState().persistNotice, /not being saved locally/,
    'a silent log line must not stand in for telling the user their drafts are at risk');

  globalThis.persistStoreDocument = async () => {};
  store.getState().setDockOpen(true);
  await flushMemorySave();
  assert.equal(store.getState().persistNotice, null, 'the banner clears once saves succeed again');
});

// ARCH-003: the agent-exit path used to clear a different set of fields than the
// connection-loss path, leaving a phantom approval behind.
test('an agent exit mid-approval clears the pending approval instead of leaving a phantom one', async () => {
  const store = await frontendStore();
  workspace(store);
  store.setState({
    agents: [{ id: 'agent-a', name: 'Agent A', status: 'ready' }],
    threads: [{
      sessionId: 's1', workspacePath: '/repo', items: [], opened: true,
      agentId: 'agent-a', status: 'running', activeTurnId: 't1',
      pendingApproval: { requestId: 'a1', kind: 'exec', summary: 'rm -rf', createdAt: '2026-01-01' },
      approvalPending: true, pendingTurnKey: 'p1', cancelRequested: true, configPending: true,
    }],
    selectedSessionId: 's1',
  });

  globalThis.storeEvent('agentExit', { agentId: 'agent-a', error: 'boom' });

  const thread = store.getState().threads[0];
  assert.equal(thread.pendingApproval, null, 'nothing can resolve it, so it must not stay on screen');
  assert.equal(thread.approvalPending, false);
  assert.equal(thread.pendingTurnKey, null, 'the queued send must not launch after the agent died');
  assert.equal(thread.cancelRequested, false);
  assert.equal(thread.configPending, false);
  assert.equal(thread.status, 'error');
  assert.equal(thread.lastOutcome, 'interrupted');
  assert.match(thread.error, /Agent A stopped: boom/);
});

test('a failed busy-send replaces the optimistic message and settles the thread', async () => {
  const store = await frontendStore();
  globalThis.storeBridge = async (method) => {
    if (method === 'sendTurn') throw new Error('host rejected the turn');
    return {};
  };
  store.setState({
    threads: [{ sessionId: 's1', workspacePath: '/repo', items: [], opened: true, status: 'running', activeTurnId: 't1', title: 'Busy' }],
    selectedSessionId: 's1', preview: false, composer: 'replacement prompt', submitting: false,
  });
  workspace(store);

  await store.getState().sendPrompt({ disposition: 'replace' });
  const thread = store.getState().threads.find((item) => item.sessionId === 's1');
  assert.equal(thread.items.filter((item) => item.kind === 'userMessage').length, 0, 'a message that never reached the host must not stay in the transcript');
  assert.equal(thread.activeTurnId, 't1', 'the still-running turn keeps its identity');
  assert.equal(thread.status, 'running');
  assert.equal(thread.pendingTurnKey, null);
  assert.match(thread.error, /Send failed/);
});
