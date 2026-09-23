import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Least-privilege regression test for the Tauri capability file (SEC-08).
 * Every renderer-reachable plugin command must be justified by a real call
 * site; broadening this set re-opens direct mailto:/tel:/reveal, dialog, or
 * event-forgery primitives that bypass the checked native wrappers.
 */
const capability = JSON.parse(readFileSync(resolve('apps/desktop/src-tauri/capabilities/default.json'), 'utf8'));

test('main window grants the exact minimal plugin surface', () => {
  assert.deepEqual(capability.permissions, [
    // bridge.ts + Composer listen/unlisten; never emit (bridge-line is not forgeable).
    'core:event:allow-listen',
    'core:event:allow-unlisten',
    // data-tauri-drag-region in Sidebar/ThreadView/UsageView.
    'core:window:allow-start-dragging',
    // LazyStore get/set/save (+ implicit load) on muse-desktop.json.
    'store:allow-load',
    'store:allow-get',
    'store:allow-set',
    'store:allow-save',
    // notify.ts only: permission check, one-time ask, send.
    'notification:allow-is-permission-granted',
    'notification:allow-request-permission',
    'notification:allow-notify',
  ]);
});

test('no default permission set survives minimization', () => {
  for (const permission of capability.permissions) {
    assert.doesNotMatch(permission, /:default$/, `${permission} re-broadens the surface`);
  }
  assert.deepEqual(capability.windows, ['main']);
});
