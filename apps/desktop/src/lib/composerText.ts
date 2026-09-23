/** Pure text-editing helpers for the composer. Kept dependency-free so the
 *  node regression suite can bundle and exercise them directly. */

export const INDENT_UNIT = "  ";

export type TextEdit = { text: string; start: number; end: number };

function lineStartAt(text: string, index: number): number {
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

/** Line index (0-based) containing `index`. */
function lineIndexAt(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Indent the touched lines, or insert one indent unit at a collapsed caret. */
export function indentText(text: string, start: number, end: number, unit = INDENT_UNIT): TextEdit {
  if (start === end) {
    return { text: text.slice(0, start) + unit + text.slice(end), start: start + unit.length, end: start + unit.length };
  }
  // A selection ending at column 0 does not touch that last line.
  const lastTouched = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const firstLine = lineIndexAt(text, start);
  const lastLine = lineIndexAt(text, lastTouched);
  const lines = text.split("\n");
  for (let i = firstLine; i <= lastLine; i++) lines[i] = unit + lines[i];
  const count = lastLine - firstLine + 1;
  return { text: lines.join("\n"), start: start + unit.length, end: end + unit.length * count };
}

/** Remove one indent level from each touched line. */
export function outdentText(text: string, start: number, end: number, unit = INDENT_UNIT): TextEdit {
  const lastTouched = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const firstLine = lineIndexAt(text, start);
  const lastLine = lineIndexAt(text, lastTouched);
  const lines = text.split("\n");
  const removed: number[] = [];
  for (let i = firstLine; i <= lastLine; i++) {
    const line = lines[i];
    let cut = 0;
    if (line.startsWith(unit)) cut = unit.length;
    else if (line.startsWith("\t")) cut = 1;
    else {
      const spaces = line.match(/^ +/)?.[0].length ?? 0;
      cut = Math.min(spaces, unit.length);
    }
    lines[i] = line.slice(cut);
    removed.push(cut);
  }
  const total = removed.reduce((sum, value) => sum + value, 0);
  const firstLineStart = lineStartAt(text, start);
  return {
    text: lines.join("\n"),
    start: Math.max(firstLineStart, start - removed[0]),
    end: Math.max(firstLineStart, end - total),
  };
}

type ListPrefix = { indent: string; marker: string; ordered: number | null; delimiter: string; task: boolean };

function parseListPrefix(line: string): ListPrefix | null {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])\s+/);
  if (ordered) {
    return { indent, marker: ordered[0], ordered: Number.parseInt(ordered[1], 10), delimiter: ordered[2], task: false };
  }
  const bullet = rest.match(/^(-|\*|\+)(?:(\s+\[[ xX]\])?\s+)/);
  if (bullet) {
    return { indent, marker: bullet[0], ordered: null, delimiter: "", task: bullet[0].includes("[") };
  }
  return null;
}

/**
 * Shift+Enter behavior: split the line, preserve indentation, continue
 * `1.` / `-` / `- [ ]` lists, and exit the list on an empty item.
 */
export function continuationForEnter(text: string, caret: number): TextEdit {
  const start = lineStartAt(text, caret);
  let lineEnd = text.indexOf("\n", caret);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(start, lineEnd);
  const prefix = parseListPrefix(line);
  if (!prefix) {
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const insert = `\n${indent}`;
    return { text: text.slice(0, caret) + insert + text.slice(caret), start: caret + insert.length, end: caret + insert.length };
  }
  const content = line.slice(prefix.indent.length + prefix.marker.length);
  const caretInPrefix = caret - start < prefix.indent.length + prefix.marker.length;
  if (!content.trim() || caretInPrefix) {
    // Empty item (or caret still inside the marker): drop the marker.
    return { text: text.slice(0, start) + prefix.indent + text.slice(lineEnd), start: start + prefix.indent.length, end: start + prefix.indent.length };
  }
  const nextMarker = prefix.ordered != null && Number.isFinite(prefix.ordered)
    ? `${prefix.ordered + 1}${prefix.delimiter} `
    : prefix.task
      ? `${prefix.marker.trimStart()[0]} [ ] `
      : `${prefix.marker.trimStart()[0]} `;
  const insert = `\n${prefix.indent}${nextMarker}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), start: caret + insert.length, end: caret + insert.length };
}

export type WordAtCaret = { start: number; end: number; word: string };

const WORD_TAIL = /[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;
const WORD_BOUNDARY_AFTER = /^[\s)\].,;:!?"']|^$/;

/** The word the caret is completing, or null when mid-word / too short. */
export function currentWord(text: string, caret: number): WordAtCaret | null {
  const before = text.slice(0, caret);
  const match = before.match(WORD_TAIL);
  if (!match || match[0].length < 2) return null;
  if (!WORD_BOUNDARY_AFTER.test(text.slice(caret))) return null;
  const start = caret - match[0].length;
  return { start, end: caret, word: match[0] };
}

/** Completion only when exactly one candidate extends `word` — never guess between several. */
export function findUniqueCompletion(word: string, candidates: string[]): string | null {
  const lower = word.toLowerCase();
  let match: string | null = null;
  for (const candidate of candidates) {
    if (candidate.length > word.length && candidate.toLowerCase().startsWith(lower)) {
      if (match) return null;
      match = candidate;
    }
  }
  return match;
}

/** Common words that are never useful as (or as a prefix of) a completion. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with", "this", "that",
  "from", "they", "them", "their", "theirs", "have", "has", "had", "were", "been", "will",
  "would", "there", "what", "when", "where", "which", "while", "about", "into", "here",
  "can", "cannot", "could", "should", "shall", "may", "might", "must", "does", "did",
  "than", "then", "these", "those", "such", "only", "also", "just", "very", "much",
  "more", "most", "some", "any", "all", "each", "other", "same", "too", "how", "why",
  "who", "whom", "whose", "its", "our", "ours", "out", "over", "under", "again", "once",
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase());
}

const CANDIDATE_WORD = /[A-Za-z_@#][A-Za-z0-9_./:-]*/g;

/**
 * Completion vocabulary from recent sources (most-recent-first).
 * Deduped case-insensitively; first (most recent) spelling wins.
 */
export function collectCandidates(sources: string[], limit = 500): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    CANDIDATE_WORD.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CANDIDATE_WORD.exec(source)) !== null && out.length < limit) {
      const word = match[0].replace(/[./:-]+$/, "");
      if (word.length < 3) continue;
      const key = word.toLowerCase();
      if (seen.has(key) || STOP_WORDS.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
    if (out.length >= limit) break;
  }
  return out;
}

export type SlashQuery = { start: number; query: string };

/** A `/command` typed alone on the current line, if any. */
export function slashQuery(text: string, caret: number): SlashQuery | null {
  const start = lineStartAt(text, caret);
  let lineEnd = text.indexOf("\n", caret);
  if (lineEnd === -1) lineEnd = text.length;
  if (!/^\s*$/.test(text.slice(caret, lineEnd))) return null;
  const before = text.slice(start, caret);
  const match = before.match(/^(\s*)\/([A-Za-z0-9-]*)$/);
  if (!match) return null;
  return { start: start + match[1].length, query: match[2] };
}

export type SlashCommand = { name: string; hint: string; prompt: string };

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "explain", hint: "Tour this codebase", prompt: "Give me a tour of this codebase: the architecture, the main entry points, and how the pieces fit together." },
  { name: "plan", hint: "Plan before coding", prompt: "Before making any changes, write a short step-by-step plan and wait for my approval." },
  { name: "fix", hint: "Find and fix a bug", prompt: "Look for a likely bug in this project, explain the root cause, and fix it." },
  { name: "test", hint: "Add missing tests", prompt: "Find the most important untested code in this project and write tests for it." },
  { name: "review", hint: "Review my changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything I should clean up before committing." },
  { name: "refactor", hint: "Clean up this code", prompt: "Refactor the code I am working on for clarity without changing behavior. Explain each change." },
  { name: "commit", hint: "Draft a commit message", prompt: "Look at my staged and unstaged changes and draft a concise commit message for them." },
];

export type SlashSkill = { selector: string; displayName?: string; description?: string; argumentHint?: string };

export type SlashEntry =
  | { kind: "skill"; name: string; hint: string; selector: string; argumentHint?: string }
  | { kind: "macro"; name: string; hint: string; prompt: string };

/**
 * Slash menu entries: live session skills first (real invocations), then
 * the static prompt macros as an offline fallback. Either half may be
 * empty; the menu never invents a skill the catalog did not list.
 */
export function filterSlashCommands(query: string, skills: SlashSkill[] = [], limit = 6): SlashEntry[] {
  const lower = query.toLowerCase();
  const scored = skills
    .filter((row) => row.selector)
    .map((row) => {
      const name = row.selector.replace(/^\//, "");
      const hay = `${name} ${row.displayName ?? ""} ${row.description ?? ""}`.toLowerCase();
      const rank = name.toLowerCase().startsWith(lower) ? 0 : hay.includes(lower) ? 1 : -1;
      return { rank, entry: { kind: "skill" as const, name, hint: row.displayName || row.description || "Skill", selector: row.selector, ...(row.argumentHint ? { argumentHint: row.argumentHint } : {}) } };
    })
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((row) => row.entry);
  const starts = SLASH_COMMANDS.filter((command) => command.name.toLowerCase().startsWith(lower));
  const contains = SLASH_COMMANDS.filter((command) => !command.name.toLowerCase().startsWith(lower) && (command.name.toLowerCase().includes(lower) || command.hint.toLowerCase().includes(lower)));
  const macros: SlashEntry[] = [...starts, ...contains].map((command) => ({ kind: "macro" as const, name: command.name, hint: command.hint, prompt: command.prompt }));
  return [...scored, ...macros].slice(0, limit);
}

const SKILL_INVOCATION = /^\/(\S+)[ \t]*([\s\S]*)$/;

/**
 * Parse a leading `/selector arguments` skill invocation. Selectors are
 * matched verbatim against the session catalog at submit; unknown
 * spellings stay plain text so typos never summon the wrong skill.
 */
export function parseSkillInvocation(text: string): { selector: string; args: string } | null {
  const match = text.trimStart().match(SKILL_INVOCATION);
  if (!match) return null;
  return { selector: match[1], args: (match[2] ?? "").trim() };
}

const SHELL_ESCAPE = /^![ \t]*(\S[\s\S]*)$/;

/**
 * Parse a leading `!command` shell escape (TUI parity). A bare `!` with no
 * command is not an escape: it stays plain text so the submit path can ask
 * for the command instead of running nothing.
 */
export function parseShellEscape(text: string): { command: string } | null {
  const match = text.trimStart().match(SHELL_ESCAPE);
  if (!match) return null;
  return { command: match[1].trim() };
}

/** Canonical typed spelling for a catalog selector: exactly one leading slash. */
export function skillSelectorText(selector: string): string {
  return `/${selector.replace(/^\//, "")}`;
}

/**
 * Draft text after pressing "Use" on a catalog skill. The invocation
 * leads (existing draft text becomes the skill's arguments) so submit
 * parses it back through `parseSkillInvocation`.
 */
export function skillUseText(selector: string, draft: string): string {
  const invocation = skillSelectorText(selector);
  return draft.trim() ? `${invocation} ${draft.trim()}` : `${invocation} `;
}
