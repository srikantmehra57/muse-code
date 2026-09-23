export type DiffLine = { type: "meta" | "hunk" | "add" | "del" | "ctx"; text: string };

export type FileDiff = {
  path: string;
  header: string[];
  lines: DiffLine[];
};

export function parseUnifiedDiff(diff: string, limit = 4000): { files: FileDiff[]; truncated: boolean } {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let count = 0;
  let truncated = false;
  for (const raw of diff.split("\n")) {
    if (count >= limit) { truncated = true; break; }
    count += 1;
    if (raw.startsWith("diff --git ")) {
      const match = raw.match(/b\/(.+)$/) ?? raw.match(/diff --git a\/.+ b\/(.+)$/);
      current = { path: match?.[1] ?? raw.slice(11), header: [raw], lines: [] };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { path: "changes", header: [], lines: [] };
      files.push(current);
    }
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("index ") || raw.startsWith("new file") || raw.startsWith("deleted file") || raw.startsWith("rename ")) {
      current.header.push(raw);
      continue;
    }
    const type: DiffLine["type"] = raw.startsWith("@@") ? "hunk" : raw.startsWith("+") ? "add" : raw.startsWith("-") ? "del" : "ctx";
    current.lines.push({ type, text: raw || " " });
  }
  return { files, truncated };
}

/**
 * Remove the `hunk`-th `@@` block (0-based) of one file from a unified
 * diff. Preview-local discard; the native side re-derives from git.
 */
export function dropHunk(diff: string, path: string, hunk: number): string {
  const kept: string[] = [];
  let current: string | null = null;
  let index = -1;
  let dropping = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      const match = raw.match(/b\/(.+)$/);
      current = match?.[1] ?? raw.slice(11);
      index = -1;
      dropping = false;
      kept.push(raw);
      continue;
    }
    if (current === path && raw.startsWith("@@")) {
      index += 1;
      dropping = index === hunk;
      if (!dropping) kept.push(raw);
      continue;
    }
    if (!dropping) kept.push(raw);
  }
  return kept.join("\n");
}

/** Parse `git diff --numstat -z` output into added/removed keyed by the new path. */
export function parseNumstatZ(raw: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const parts = raw.split("\0").filter((part) => part.length > 0);
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index];
    const tab = line.match(/^(\d+|-)\t(\d+|-)(?:\t(.*))?$/);
    if (!tab) continue;
    const added = tab[1] === "-" ? 0 : Number(tab[1]);
    const removed = tab[2] === "-" ? 0 : Number(tab[2]);
    let path = tab[3] ?? "";
    if (!path) {
      const from = parts[index + 1];
      const to = parts[index + 2];
      if (from != null && to != null) {
        path = to.includes("\t") ? to.split("\t").pop() ?? to : to;
        index += 2;
      }
    }
    if (path.includes(" => ")) path = path.split(" => ").pop() ?? path;
    counts.set(path.replace(/^"|"$/g, ""), { added, removed });
  }
  return counts;
}
