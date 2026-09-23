import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('renderer icon buttons, dialogs, and images have accessible names', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/check-a11y.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
