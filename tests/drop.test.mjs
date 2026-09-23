import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-drop-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { MAX_DROP_FILES, MAX_IMAGE_BYTES, displayNameForPath, extensionOf, isImageFile, isImagePath, mediaTypeForPath, refPathForDrop } = await bundle('apps/desktop/src/lib/drop.ts');

test('image detection matches the native shell table', () => {
  assert.equal(mediaTypeForPath('shot.PNG'), 'image/png');
  assert.equal(mediaTypeForPath('/tmp/photo.jpeg'), 'image/jpeg');
  assert.equal(mediaTypeForPath('C:\\pics\\anim.gif'), 'image/gif');
  assert.equal(mediaTypeForPath('pic.webp'), 'image/webp');
  assert.equal(mediaTypeForPath('pic.avif'), 'image/avif');
  assert.equal(mediaTypeForPath('pic.bmp'), 'image/bmp');
  assert.equal(mediaTypeForPath('icon.ico'), 'image/x-icon');
  assert.equal(mediaTypeForPath('icon.svg'), 'image/svg+xml');
  assert.equal(mediaTypeForPath('scan.tif'), 'image/tiff');
  assert.equal(mediaTypeForPath('scan.TIFF'), 'image/tiff');
  assert.equal(mediaTypeForPath('live.heic'), 'image/heic');
  assert.equal(mediaTypeForPath('live.heif'), 'image/heif');
  assert.equal(mediaTypeForPath('notes.txt'), null);
  assert.equal(mediaTypeForPath('Makefile'), null);
  assert.equal(mediaTypeForPath('archive.tar.gz'), null);
  assert.equal(mediaTypeForPath('.gitignore'), null);
  assert.equal(isImagePath('a.jpg'), true);
  assert.equal(isImagePath('a.pdf'), false);
});

test('browser files count as images by MIME type or extension', () => {
  assert.equal(isImageFile({ type: 'image/png', name: 'a' }), true);
  assert.equal(isImageFile({ type: '', name: 'photo.jpg' }), true);
  assert.equal(isImageFile({ name: 'photo.jpg' }), true);
  assert.equal(isImageFile({ type: 'text/plain', name: 'notes.txt' }), false);
  assert.equal(isImageFile({ type: '', name: 'README' }), false);
});

test('extensions and display names handle both separators', () => {
  assert.equal(extensionOf('C:\\pics\\Shot.JPG'), 'jpg');
  assert.equal(extensionOf('/a/b/c'), '');
  assert.equal(displayNameForPath('/a/b/c.png'), 'c.png');
  assert.equal(displayNameForPath('C:\\a\\b.png'), 'b.png');
  assert.equal(displayNameForPath('b.png'), 'b.png');
});

test('drop references stay workspace-relative inside the project', () => {
  assert.equal(refPathForDrop('/repo/src/app.ts', '/repo'), 'src/app.ts');
  assert.equal(refPathForDrop('/repo/src/app.ts', '/repo/'), 'src/app.ts');
  assert.equal(refPathForDrop('/other/app.ts', '/repo'), '/other/app.ts');
  assert.equal(refPathForDrop('/repo2/app.ts', '/repo'), '/repo2/app.ts');
  assert.equal(refPathForDrop('C:\\repo\\src\\a.ts', 'C:\\repo'), 'src\\a.ts');
  assert.equal(refPathForDrop('/repo', '/repo'), '.');
  assert.equal(refPathForDrop('/a/b.png'), '/a/b.png');
});

test('drop caps match the native shell', () => {
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_DROP_FILES, 20);
});
