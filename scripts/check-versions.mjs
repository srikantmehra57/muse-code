#!/usr/bin/env node
/**
 * REL-015: every release has to bump the same version in six places by hand.
 * Drift is a matter of time, and a bundle whose `tauri.conf.json` version
 * disagrees with its npm/Cargo manifests is a release that cannot be traced.
 *
 * This gate fails the build rather than letting a mismatched release ship.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCES = [
  ["package.json", (text) => JSON.parse(text).version],
  ["apps/desktop/package.json", (text) => JSON.parse(text).version],
  ["apps/website/package.json", (text) => JSON.parse(text).version],
  ["packages/muse-bridge/package.json", (text) => JSON.parse(text).version],
  ["apps/desktop/src-tauri/Cargo.toml", (text) => /^\s*version\s*=\s*"([^"]+)"/m.exec(text)?.[1]],
  ["apps/desktop/src-tauri/tauri.conf.json", (text) => JSON.parse(text).version],
];

const found = [];
for (const [relative, extract] of SOURCES) {
  let version;
  try {
    version = extract(await readFile(path.join(ROOT, relative), "utf8"));
  } catch (error) {
    console.error(`✗ ${relative}: could not be read (${error.message})`);
    process.exit(1);
  }
  if (!version) {
    console.error(`✗ ${relative}: no version field found`);
    process.exit(1);
  }
  found.push([relative, version]);
}

const versions = new Map();
for (const [relative, version] of found) {
  if (!versions.has(version)) versions.set(version, []);
  versions.get(version).push(relative);
}

if (versions.size === 1) {
  const [version] = versions.keys();
  console.log(`✓ ${found.length} manifests agree on ${version}`);
  process.exit(0);
}

console.error(`✗ version drift across ${found.length} manifests:`);
for (const [version, files] of versions) {
  console.error(`  ${version}:`);
  for (const file of files) console.error(`    ${file}`);
}
console.error("\nBump every manifest together (see RELEASING.md).");
process.exit(1);
