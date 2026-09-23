import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-usage-'));
after(() => rm(temporary, { recursive: true, force: true }));
let sequence = 0;
async function bundle(entry, replacements = {}) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
    plugins: [{ name: 'test-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(replacements, path) ? { path, namespace: 'test-boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'test-boundary' }, ({ path }) => ({ contents: replacements[path], loader: 'ts', resolveDir: resolve('packages/muse-bridge/src') }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}

const usage = {
  observedAtMs: 1_700_000_000_000,
  tier: 'pro',
  window: { usedPercent: 42, resetsAtMs: 1_700_001_000_000, windowDurationMins: 300 },
  weekly: { usedPercent: 18, resetsAtMs: 1_700_100_000_000 },
};

async function fakeHost(usageResult) {
  let notify;
  globalThis.fakeUsageSdk = {
    usageResult,
    spawn() {
      const connection = {
        onNotification(handler) { notify = handler; },
        request: async (method) => (method === 'usage/read' ? globalThis.fakeUsageSdk.usageResult : {}),
        command: async () => ({ status: 'accepted' }),
      };
      return { initialize: async () => ({ child: { exit: new Promise(() => {}) }, connection, initializeResult: { serverInfo: {}, sessionDurability: 'durable' } }) };
    },
  };
  const { MuseHost } = await bundle('packages/muse-bridge/src/host.ts', {
    '@muse-code/sdk': 'export const spawnMspConnection=(...args)=>globalThis.fakeUsageSdk.spawn(...args); export const MuseClient=class{constructor(connection){connection.onNotification(()=>{});}async close(){}}; export const readSessionDurability=()=>({kind:"durable"}); export const EXPECTED_SCHEMA_FINGERPRINT="sha256:fake-pin";',
    './detect.js': `export * from ${JSON.stringify(resolve('packages/muse-bridge/src/detect.ts'))}; export const resolveMuseBin=()=>"/fake/muse";`,
  });
  const host = new MuseHost();
  await host.start(null, null, 'auto');
  assert.ok(notify, 'host subscribes to notifications');
  return { host, notify };
}

test('readUsage returns the host usage snapshot', async () => {
  const { host } = await fakeHost({ usage });
  assert.deepEqual(await host.readUsage(), { usage });
  await host.stop();
});

test('readUsage reports absence when nothing was observed', async () => {
  const { host } = await fakeHost({});
  assert.deepEqual(await host.readUsage(), {});
  await host.stop();
});

test('usage/changed notifications are forwarded as events', async () => {
  const { host, notify } = await fakeHost({ usage });
  // Capture only the synchronous notify: concurrent tests' reporter output must never be swallowed.
  const lines = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    notify({ method: 'usage/changed', params: usage });
  } finally {
    process.stdout.write = write;
  }
  const events = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  assert.deepEqual(events.find((entry) => entry.event === 'usageChanged'), { type: 'event', event: 'usageChanged', payload: usage });
  await host.stop();
});

const { usageWindowLabel, formatResetIn } = await bundle('apps/desktop/src/lib/format.ts');

test('usage window label follows the provider window length', () => {
  assert.equal(usageWindowLabel(300), '5-hour window');
  assert.equal(usageWindowLabel(60), '1-hour window');
  assert.equal(usageWindowLabel(90), '1.5-hour window');
  assert.equal(usageWindowLabel(45), '45-minute window');
  assert.equal(usageWindowLabel(undefined), 'Current window');
  assert.equal(usageWindowLabel(0), 'Current window');
});

test('reset countdown renders largest units first', () => {
  const now = 1_700_000_000_000;
  assert.equal(formatResetIn(now + 30_000, now), 'resets in under a minute');
  assert.equal(formatResetIn(now + 12 * 60_000, now), 'resets in 12m');
  assert.equal(formatResetIn(now + (2 * 60 + 14) * 60_000, now), 'resets in 2h 14m');
  assert.equal(formatResetIn(now + 3 * 3_600_000, now), 'resets in 3h');
  assert.equal(formatResetIn(now + (3 * 24 + 5) * 3_600_000, now), 'resets in 3d 5h');
  assert.equal(formatResetIn(now - 1_000, now), 'resetting…');
});

// The usage card renders through the real Sidebar with stubbed hooks/store;
// DOM effects stay unflushed so the tree can be walked without a browser.
function usageHooks() {
  const values = []; let cursor = 0;
  return {
    useState(initial) { const i = cursor++; if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial; return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }]; },
    render(Component, props) { cursor = 0; return Component(props); },
  };
}
function usageNodes(element) {
  if (!element || typeof element !== 'object') return [];
  const children = Array.isArray(element.props?.children) ? element.props.children.flat(Infinity) : [element.props?.children];
  const rendered = typeof element.type === 'function' ? element.type(element.props ?? {}) : null;
  return [element, ...children.flatMap(usageNodes), ...usageNodes(rendered)];
}
async function usageCard(overrides = {}) {
  const runtime = usageHooks(); globalThis.componentHooks = runtime;
  const refreshes = [];
  globalThis.componentState = {
    threads: [], threadSearch: '', enabledAgents: {}, workspaces: [],
    selectedWorkspaceId: null, selectedSessionId: null,
    detection: { authenticated: true, accountName: 'Ada' }, agents: [],
    preview: false, offline: false, sidebarCollapsed: false, starting: false,
    subscriptionUsage: { ...usage, tier: '276813933948512345' },
    subscriptionUsageLoading: false, subscriptionUsageError: null,
    refreshSubscriptionUsage: async (...args) => { refreshes.push(args); },
    ...overrides,
  };
  const { Sidebar } = await bundle('apps/desktop/src/components/Sidebar.tsx', {
    react: 'export const useState=(...args)=>globalThis.componentHooks.useState(...args); export const useMemo=(factory)=>factory(); export const useEffect=()=>{}; export const useRef=(initial)=>({ current: initial });',
    'zustand/react/shallow': 'export const useShallow=(selector)=>selector;',
    'react/jsx-runtime': 'export const jsx=(type,props,key)=>({type,props,key});export const jsxs=jsx;export const Fragment=Symbol.for("react.fragment");',
    '../lib/store': 'export const useAppStore=(selector)=>selector?selector(globalThis.componentState):globalThis.componentState; export const currentWorkspace=()=>null; export const readyAgents=()=>[];',
    './AgentPicker': 'export const AgentMark=()=>null;',
    'lucide-react': `const mk=(n)=>{const f=()=>null;f.displayName=n;return f;};export const Archive=mk('Archive'),ArrowDown=mk('ArrowDown'),ArrowUp=mk('ArrowUp'),ChevronRight=mk('ChevronRight'),Download=mk('Download'),Folder=mk('Folder'),FolderOpen=mk('FolderOpen'),FilePlus=mk('FilePlus'),GitFork=mk('GitFork'),History=mk('History'),LoaderCircle=mk('LoaderCircle'),LogOut=mk('LogOut'),MoreHorizontal=mk('MoreHorizontal'),PanelLeft=mk('PanelLeft'),Pencil=mk('Pencil'),Pin=mk('Pin'),PinOff=mk('PinOff'),Plus=mk('Plus'),Puzzle=mk('Puzzle'),RotateCcw=mk('RotateCcw'),ScanSearch=mk('ScanSearch'),Search=mk('Search'),Settings=mk('Settings'),ShieldAlert=mk('ShieldAlert'),ShieldCheck=mk('ShieldCheck'),SquarePen=mk('SquarePen'),Trash2=mk('Trash2'),X=mk('X');`,
  });
  const render = () => runtime.render(Sidebar);
  usageNodes(render()).find(node => node.props?.className === 'account').props.onMouseEnter();
  const renderCard = () => {
    const tree = usageNodes(render());
    const card = tree.find(node => node.props?.['aria-label'] === 'Subscription usage');
    assert.ok(card, 'usage card opens on account hover');
    return usageNodes(card);
  };
  return { refreshes, renderCard };
}

test('usage card hides the opaque tier id and refreshes on demand', async () => {
  const { refreshes, renderCard } = await usageCard();
  const card = renderCard();
  assert.ok(card.every(node => typeof node.props?.className !== 'string' || !node.props.className.includes('usage-tier')), 'no tier badge renders the provider id');
  assert.ok(card.every(node => node.props?.title !== '276813933948512345'), 'provider id is not kept in a tooltip');
  const refresh = card.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Refresh usage');
  assert.ok(refresh, 'refresh button renders in the usage header');
  assert.equal(usageNodes(refresh).find(node => typeof node.type === 'function')?.type.displayName, 'RotateCcw');
  refresh.props.onClick({ stopPropagation() {} });
  assert.deepEqual(refreshes.at(-1), [true], 'refresh button force-refreshes usage');
});

test('usage refresh button spins while reloading', async () => {
  const { renderCard } = await usageCard({ subscriptionUsageLoading: true });
  const card = renderCard();
  const refresh = card.find(node => node.type === 'button' && node.props?.['aria-label'] === 'Refresh usage');
  assert.equal(refresh.props.disabled, true);
  const icon = usageNodes(refresh).find(node => typeof node.type === 'function');
  assert.equal(icon?.type.displayName, 'LoaderCircle');
  assert.equal(icon?.props.className, 'spin');
});
