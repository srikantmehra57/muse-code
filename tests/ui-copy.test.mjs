import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-ui-copy-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const types = await bundle('apps/desktop/src/lib/types.ts');
const format = await bundle('apps/desktop/src/lib/format.ts');

test('approval picker exposes every MSP mode with a label and description', () => {
  assert.deepEqual([...types.APPROVAL_ORDER].sort(), ['allowAll', 'denyUnmatched', 'onRequest', 'promptUnmatched']);
  assert.equal(new Set(types.APPROVAL_ORDER).size, types.APPROVAL_ORDER.length);
  for (const mode of types.APPROVAL_ORDER) {
    assert.ok(types.APPROVAL_LABELS[mode]?.length > 0, `${mode} has a label`);
    assert.ok(types.APPROVAL_DESCRIPTIONS[mode]?.length > 0, `${mode} has a description`);
  }
});

test('shortcut labels follow the platform and the metaKey||ctrlKey handler', () => {
  assert.equal(format.isMacPlatform('MacIntel'), true);
  assert.equal(format.isMacPlatform('Win32'), false);
  assert.equal(format.isMacPlatform('Linux x86_64'), false);
  assert.equal(format.modGlyph('MacIntel'), '⌘');
  assert.equal(format.modGlyph('Win32'), 'Ctrl');
  assert.equal(format.shortcutLabel('K', 'MacIntel'), '⌘K');
  assert.equal(format.shortcutLabel('K', 'Win32'), 'Ctrl+K');
  assert.equal(format.shortcutLabel(',', 'Win32'), 'Ctrl+,');
  // No navigator in this runner: must fall back to the non-Mac shape, never crash.
  assert.match(format.shortcutLabel('K'), /^(⌘.|Ctrl\+.)$/);
});

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function themeBlock(css, selector) {
  const match = css.match(new RegExp(`${selector}\\s*{([^}]*)}`));
  assert.ok(match, `${selector} block exists in styles.css`);
  const vars = {};
  for (const [, name, value] of match[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[name] = value;
  return vars;
}

test('tertiary text meets WCAG AA (4.5:1) on surfaces in both themes', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  for (const selector of [':root', 'html\\[data-theme="light"\\]']) {
    const vars = themeBlock(css, selector);
    assert.ok(vars.tertiary && vars.secondary && vars.surface && vars.bg, `${selector} defines text tokens`);
    assert.notEqual(vars.tertiary.toLowerCase(), vars.secondary.toLowerCase(), `${selector} keeps tertiary distinct from secondary`);
    for (const bg of ['surface', 'bg']) {
      const ratio = contrast(vars.tertiary, vars[bg]);
      assert.ok(ratio >= 4.5, `${selector} tertiary on --${bg} is ${ratio.toFixed(2)}:1, want ≥ 4.5:1`);
    }
  }
});
