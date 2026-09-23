#!/usr/bin/env node
/**
 * Static VoiceOver-name audit for the desktop renderer.
 * Icon buttons need an accessible name, dialogs need a label, images need alt.
 * A live VoiceOver pass still needs a person; this catches the markup gaps.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../apps/desktop/src/", import.meta.url));

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const sources = files(root);

function openingTag(source, start) {
  let brace = 0;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") brace += 1;
    else if (c === "}") brace = Math.max(0, brace - 1);
    else if (c === ">" && brace === 0) return { tag: source.slice(start, i + 1), end: i + 1 };
  }
  return null;
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

const failures = [];

for (const path of sources) {
  const source = readFileSync(path, "utf8");
  const rel = path.slice(root.length);

  let cursor = 0;
  while (cursor < source.length) {
    const at = source.indexOf("<button", cursor);
    if (at < 0) break;
    const opened = openingTag(source, at);
    if (!opened) break;
    const named = /\baria-label=|\baria-labelledby=/.test(opened.tag);
    const icon = /\bclassName="[^"]*\b(icon-btn|search-clear|thumb-remove|thumb-open|attachment-x|viewer-nav|viewer-close)\b/.test(opened.tag);
    if (icon && !named) failures.push(`${rel}:${lineOf(source, at)} icon button has no accessible name`);
    cursor = opened.end;
  }

  for (const match of source.matchAll(/<(dialog|div|section)\b[^>]*\brole="dialog"|<dialog\b/g)) {
    const opened = openingTag(source, match.index);
    if (!opened) continue;
    if (!/\baria-label=|\baria-labelledby=/.test(opened.tag)) {
      failures.push(`${rel}:${lineOf(source, match.index)} dialog has no accessible name`);
    }
  }

  for (const match of source.matchAll(/<img\b[^>]*>/g)) {
    if (!/\balt=/.test(match[0])) failures.push(`${rel}:${lineOf(source, match.index)} image has no alt`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`a11y audit passed (${sources.length} components)`);
