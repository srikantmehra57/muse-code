import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('bridge cold start answers ping within 5 seconds', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/measure-cold-start.mjs')], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.trim().split('\n').at(-1);
  const measured = JSON.parse(line);
  assert.equal(typeof measured.bridgeMs, 'number');
  assert.ok(measured.bridgeMs < 5000, `bridge cold start ${measured.bridgeMs}ms`);
  assert.ok(measured.bridgeMs >= 0);
});
