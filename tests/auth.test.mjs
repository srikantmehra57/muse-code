import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-auth-'));
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

const { authPresent, detectMuse, museEnv, normalizeAuthMode, subscriptionAccount } = await bundle('packages/muse-bridge/src/detect.ts');

/** Runs `body` against a home directory that may or may not hold a `muse /login` credential. */
async function withHome(signedIn, body, contents = '{"account":"test"}') {
  const home = await mkdtemp(join(temporary, 'home-'));
  if (signedIn) {
    await mkdir(join(home, '.muse'), { recursive: true });
    await writeFile(join(home, '.muse', 'auth.json'), contents);
  }
  const previousHome = process.env.HOME;
  const previousKey = process.env.META_API_KEY;
  process.env.HOME = home;
  delete process.env.META_API_KEY;
  try { await body(); }
  finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousKey === undefined) delete process.env.META_API_KEY; else process.env.META_API_KEY = previousKey;
  }
}

test('unknown and missing modes fall back to automatic', () => {
  assert.equal(normalizeAuthMode(undefined), 'auto');
  assert.equal(normalizeAuthMode('metaApi'), 'auto');
  assert.equal(normalizeAuthMode('subscription'), 'subscription');
  assert.equal(normalizeAuthMode('apiKey'), 'apiKey');
});

test('automatic bills the subscription when a sign-in and a saved key both exist', async () => {
  await withHome(true, () => {
    const auth = authPresent('sk-test', 'auto');
    assert.equal(auth.activeAuth, 'subscription');
    assert.equal(auth.method, 'auth.json');
    assert.equal(auth.subscriptionAvailable, true);
    assert.equal(auth.apiKeyAvailable, true);
    assert.equal(museEnv({ PATH: '/bin', META_API_KEY: 'sk-shell' }, 'sk-test', 'auto').META_API_KEY, undefined);
    assert.equal('AWS_SECRET_ACCESS_KEY' in museEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'aws' }, 'sk-test', 'auto'), false);
  });
});

test('automatic falls back to the API key when there is no sign-in', async () => {
  await withHome(false, () => {
    const auth = authPresent('sk-test', 'auto');
    assert.equal(auth.activeAuth, 'apiKey');
    assert.equal(auth.authenticated, true);
    assert.equal(museEnv({ PATH: '/bin' }, 'sk-test', 'auto').META_API_KEY, 'sk-test');
  });
});

test('subscription mode drops a shell META_API_KEY that would outrank the plan', async () => {
  await withHome(true, () => {
    process.env.META_API_KEY = 'sk-shell';
    const env = museEnv(process.env, 'sk-test', 'subscription');
    assert.equal('META_API_KEY' in env, false);
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(authPresent('sk-test', 'subscription').activeAuth, 'subscription');
  });
});

test('subscription mode reports unauthenticated when the CLI is not signed in', async () => {
  await withHome(false, () => {
    const auth = authPresent('sk-test', 'subscription');
    assert.equal(auth.authenticated, false);
    assert.equal(auth.activeAuth, null);
    assert.equal(auth.apiKeyAvailable, true);
    assert.equal('META_API_KEY' in museEnv({}, 'sk-test', 'subscription'), false);
  });
});

test('api key mode uses the key even while a subscription sign-in exists', async () => {
  await withHome(true, () => {
    assert.equal(authPresent('sk-test', 'apiKey').activeAuth, 'apiKey');
    assert.equal(museEnv({}, 'sk-test', 'apiKey').META_API_KEY, 'sk-test');
  });
});

async function fakeHost() {
  const spawns = [];
  globalThis.fakeAuthSdk = {
    spawn(options) {
      spawns.push(options);
      const connection = { onNotification() {}, request: async () => ({}), command: async () => ({ status: 'accepted' }) };
      return { initialize: async () => ({ child: { exit: new Promise(() => {}) }, connection, initializeResult: { serverInfo: {}, sessionDurability: 'durable' } }) };
    },
  };
  const { MuseHost } = await bundle('packages/muse-bridge/src/host.ts', {
    '@muse-code/sdk': 'export const spawnMspConnection=(...args)=>globalThis.fakeAuthSdk.spawn(...args); export const MuseClient=class{constructor(){}async close(){}}; export const readSessionDurability=()=>({kind:"durable"}); export const EXPECTED_SCHEMA_FINGERPRINT="sha256:fake-pin";',
    './detect.js': `export * from ${JSON.stringify(resolve('packages/muse-bridge/src/detect.ts'))}; export const resolveMuseBin=()=>"/fake/muse";`,
  });
  return { host: new MuseHost(), spawns };
}

test('signed-in account name is read from the CLI credential', async () => {
  const credential = JSON.stringify({ schema_version: 1, providers: { meta: { mechanism: 'oauth', user_full_name: 'Ada Lovelace', user_email: 'ada@example.com' } } });
  await withHome(true, () => {
    assert.deepEqual(subscriptionAccount(), { name: 'Ada Lovelace', email: 'ada@example.com' });
    const detection = detectMuse(null, null, 'auto');
    assert.equal(detection.accountName, 'Ada Lovelace');
    assert.equal(detection.accountEmail, 'ada@example.com');
    assert.equal(detection.subscriptionAvailable, true);
  }, credential);
});

test('nameless or corrupt credentials yield no account name', async () => {
  await withHome(true, () => {
    assert.deepEqual(subscriptionAccount(), { name: null, email: null });
    assert.equal(detectMuse(null, null, 'auto').accountName, null);
  });
  await withHome(true, () => {
    assert.deepEqual(subscriptionAccount(), { name: null, email: null });
  }, 'not-json{');
});

test('signed-out home has no account name', async () => {
  await withHome(false, () => {
    assert.deepEqual(subscriptionAccount(), { name: null, email: null });
    const detection = detectMuse(null, null, 'auto');
    assert.equal(detection.accountName, null);
    assert.equal(detection.accountEmail, null);
  });
});

test('host spawns muse without an API key when the subscription should pay', async () => {
  const { host, spawns } = await fakeHost();
  await withHome(true, async () => {
    process.env.META_API_KEY = 'sk-shell';
    const started = await host.start(null, 'sk-test', 'subscription');
    assert.equal(started.activeAuth, 'subscription');
    assert.equal('META_API_KEY' in spawns[0].env, false);
    const metered = await host.start(null, 'sk-test', 'apiKey');
    assert.equal(metered.activeAuth, 'apiKey');
    assert.equal(spawns[1].env.META_API_KEY, 'sk-test');
  });
});
