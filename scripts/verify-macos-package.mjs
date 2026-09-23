#!/usr/bin/env node
// Local package smoke test: no account, provider call, or ambient Node needed.
import assert from 'node:assert/strict';
import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const app = resolve(process.argv[2] ?? join(root, 'apps/desktop/src-tauri/target/release/bundle/macos/Muse Code.app'));
const runtime = join(app, 'Contents/MacOS/muse-node');
const binary = join(app, 'Contents/MacOS/muse-code-desktop');
const script = join(app, 'Contents/Resources/muse-bridge/index.js');
await access(runtime, constants.X_OK);
const digest = (data) => createHash('sha256').update(data).digest('hex');
const scriptBytes = await readFile(script);
assert.equal(digest(scriptBytes), digest(await readFile(join(root, 'packages/muse-bridge/dist/index.js'))), 'Packaged bridge is stale');

// Swap rejection, statically verifiable without launching the GUI:
// build.rs bakes the bridge digest into the binary at compile time and
// verify_bridge_script compares the on-disk resource against it on launch.
// The digest bytes aren't findable (release codegen inlines the compare), but
// the branch structure is: when BAKED=="none" was compiled, only the
// "digest missing" arm survives and the compare strings are dead-stripped.
// So a real baked digest shows the compare arms and drops the "none" arm.
const binaryText = (await readFile(binary)).toString('latin1');
assert.ok(binaryText.includes('does not match this installation'), 'Script-compare code missing — release was built without the digest bake');
assert.ok(!binaryText.includes('digest missing from this build'), 'Baked digest is "none" — script swaps would not be rejected');
// The sidecar check requires a regular file: a symlink planted beside the app
// must fail `sidecar_path` before it ever runs.
const sidecarStat = await lstat(runtime);
assert.ok(sidecarStat.isFile() && !sidecarStat.isSymbolicLink(), 'Packaged runtime is not a regular file');
const child = spawn(runtime, [script], {
  cwd: app,
  // The packaged runtime must work without the developer's Node or credentials.
  env: { PATH: '/usr/bin:/bin', NODE_NO_WARNINGS: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
await new Promise((resolve, reject) => {
  let buffer = '';
  let answered = false;
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged bridge timed out')); }, 10000);
  const fail = (error) => { clearTimeout(timer); child.kill(); reject(error); };
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stderr.resume();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > 65536) return fail(new Error('Unexpected oversized smoke output'));
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { return fail(new Error('Invalid packaged bridge response')); }
      if (message.id === 'package-smoke') {
        if (!message.ok || message.result?.pong !== true) return fail(new Error('Packaged bridge ping failed'));
        answered = true;
        child.stdin.end();
      }
    }
  });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0 && answered) resolve();
    else reject(new Error(`Packaged bridge exited without a successful ping (code ${code})`));
  });
  child.stdin.write('{"id":"package-smoke","method":"ping"}\n');
});
console.log('PASS: packaged runtime exists, bridge matches build, digest baked for swap rejection, sidecar is a real file, ping succeeds without ambient Node, EOF shuts down.');
console.log('Not covered: native UI launch, real provider session, clean-host install, signing/notarization.');
