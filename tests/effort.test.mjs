import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-effort-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { clampTier, tiersFor, defaultTier, isPeak, VOCABULARY } = await bundle('apps/desktop/src/lib/effort.ts');
const { annotateEfforts } = await bundle('packages/muse-bridge/src/efforts.ts');
const { stepFromItem } = await bundle('apps/desktop/src/lib/agent.ts');

test('Muse models top out at max; ultra only behind the experimental flag', () => {
  const plain = annotateEfforts({ models: [{ modelId: 'muse-spark-1.3' }] }, {});
  assert.deepEqual(plain.models[0].reasoningEfforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(plain.models[0].defaultReasoningEffort, 'high');
  assert.equal(plain.models[0].effortSource, 'vocabulary');
  const gated = annotateEfforts({ models: [{ modelId: 'm' }] }, { MUSE_EXPERIMENTAL_ULTRA_REASONING_EFFORT: '1' });
  assert.equal(gated.models[0].reasoningEfforts.at(-1), 'ultra');
});

test('tiers a host forwards on the model row win over the vocabulary', () => {
  const result = annotateEfforts({ models: [{ modelId: 'm', reasoningEffortVariants: [{ tier: 'max' }, { tier: 'low' }, { tier: 'bogus' }], defaultReasoningEffort: 'low' }] }, {});
  assert.deepEqual(result.models[0].reasoningEfforts, ['low', 'max']);
  assert.equal(result.models[0].defaultReasoningEffort, 'low');
  assert.equal(result.models[0].effortSource, 'host');
});

test('effort clamps to the nearest supported tier at or below when the model changes', () => {
  const tiers = ['low', 'medium', 'high', 'max'];
  assert.equal(clampTier('xhigh', tiers), 'high');
  assert.equal(clampTier('none', tiers), 'low');
  assert.equal(clampTier('max', tiers), 'max');
  assert.deepEqual(tiersFor(undefined), VOCABULARY);
  assert.equal(defaultTier({ modelId: 'm', reasoningEfforts: tiers }), 'high');
  assert.equal(isPeak('max', tiers), true);
  assert.equal(isPeak('high', ['low', 'high']), false);
});

test('reminderChild and unknown items never render as the agent reply', () => {
  assert.equal(stepFromItem({ itemId: 'r', kind: 'reminderChild', status: 'completed', fallbackText: 'Reminder child session' }).kind, 'reminder');
  const unknown = stepFromItem({ itemId: 'u', kind: 'futureThing', status: 'completed', fallbackText: 'x' });
  assert.equal(unknown.kind, 'other');
  assert.equal(unknown.title, 'Future thing');
  assert.equal(stepFromItem({ itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'hi' }).kind, 'message');
});
