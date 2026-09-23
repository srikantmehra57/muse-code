import type { Thread } from "./types";

export function uid(): string {
  return crypto.randomUUID();
}

/**
 * Sidebar/palette thread search: every whitespace-separated term must appear
 * (case-insensitive) in the title or in any item's text, fallback text, tool
 * args, or visible output. Scans at most the last 400 items per thread.
 */
export function threadMatches(thread: Thread, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const title = thread.title.toLowerCase();
  const fields: string[] = [];
  for (const item of thread.items.slice(-400)) {
    if (item.text) fields.push(item.text.toLowerCase());
    if (item.fallbackText) fields.push(item.fallbackText.toLowerCase());
    if (item.args) fields.push(item.args.toLowerCase());
    if (item.visibleOutput) fields.push(item.visibleOutput.toLowerCase());
  }
  return terms.every((term) => title.includes(term) || fields.some((field) => field.includes(term)));
}

export function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60000);
  if (Number.isNaN(minutes)) return "";
  if (Math.abs(minutes) < 1) return "now";
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}h`;
  const days = Math.round(hours / 24);
  return `${Math.abs(days)}d`;
}

/** "5-hour window" from the provider's window length in minutes. */
export function usageWindowLabel(windowDurationMins?: number): string {
  if (!windowDurationMins || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) return "Current window";
  if (windowDurationMins < 60) return `${Math.round(windowDurationMins)}-minute window`;
  const hours = windowDurationMins / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}-hour window`;
}

/** "resets in 3h 12m" countdown to a reset stamp; "resetting…" once passed. */
export function formatResetIn(resetsAtMs: number, nowMs: number): string {
  const delta = resetsAtMs - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return "resetting…";
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "resets in under a minute";
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `resets in ${days}d ${rest}h` : `resets in ${days}d`;
}

export function titleFromText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled thread";
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

export function untitledThreadTitle(updatedAt?: string): string {
  if (!updatedAt) return "Untitled thread";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Untitled thread";
  return `Untitled thread · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  read: "Read file",
  edit_file: "Edit file",
  write_file: "Write file",
  write: "Write file",
  str_replace: "Edit file",
  apply_patch: "Edit file",
  list_files: "List files",
  glob: "Search files",
  grep: "Search",
  codebase_search: "Search codebase",
  shell: "Terminal",
  bash: "Terminal",
  web_search: "Web search",
  web_fetch: "Web lookup",
};

export function humanizeToolName(tool?: string, kind?: string): string {
  if (tool && TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  if (tool) {
    const clean = tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " ").trim();
    if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  if (kind === "userShell") return "Terminal";
  return "Tool";
}

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  inProgress: "Running",
  running: "Running",
  failed: "Failed",
  error: "Failed",
  pending: "Queued",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  skipped: "Skipped",
  waiting: "Waiting",
};

export function humanizeStatus(status?: string): string {
  if (!status) return "";
  return STATUS_LABELS[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export function humanizeModelId(modelId: string): string {
  const clean = modelId.replace(/-/g, " ").trim();
  if (!clean) return modelId;
  return clean.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function humanizeProvider(providerId?: string): string | undefined {
  if (!providerId) return undefined;
  if (providerId.toLowerCase() === "meta") return "Meta";
  return providerId;
}

export function humanizeModelLabel(modelId: string, displayLabel?: string): string {
  if (displayLabel && displayLabel !== modelId) return displayLabel;
  return humanizeModelId(modelId);
}

const GIT_STATUS_LABELS: Record<string, string> = {
  "M": "Modified",
  "A": "Added",
  "D": "Deleted",
  "R": "Renamed",
  "C": "Copied",
  "U": "Conflict",
  "??": "Untracked",
  "!!": "Ignored",
};

export function humanizeGitStatus(status: string): string {
  const trimmed = status.trim();
  if (GIT_STATUS_LABELS[trimmed]) return GIT_STATUS_LABELS[trimmed];
  if (GIT_STATUS_LABELS[status]) return GIT_STATUS_LABELS[status];
  // Combined codes like "MM", "AM" — describe first meaningful letter.
  for (const ch of trimmed) {
    if (GIT_STATUS_LABELS[ch]) return GIT_STATUS_LABELS[ch];
  }
  return "Changed";
}

/** Shorten a `algo:hex` digest for display (`sha256:df5e43fed1bd…`); plain text truncates at 24 chars. */
export function shortHash(value?: string | null): string {
  if (!value) return "";
  const match = value.match(/^([a-z0-9]+:)?([0-9a-f]{13,})/i);
  if (!match) return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  return `${match[1] ?? ""}${match[2].slice(0, 12)}…`;
}

export function shortCliVersion(version?: string | null): string {
  if (!version) return "";
  const first = version.split("\n")[0].trim();
  // Prefer a semver-looking token, fall back to first 24 chars.
  const match = first.match(/\d+\.\d+\.\d+[^ ]*/);
  if (match) return `v${match[0].replace(/^v/, "")}`;
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

export function summarizeArgs(toolName: string, args?: string): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const path = ["path", "file", "filePath", "target"].map((k) => parsed[k]).find((v) => typeof v === "string") as string | undefined;
    const command = ["command", "cmd", "query", "url", "pattern"].map((k) => parsed[k]).find((v) => typeof v === "string") as string | undefined;
    if (toolName === "bash" || toolName === "shell") return typeof command === "string" ? command : formatArgs(args);
    if (path && command && path !== command) return `${path} · ${command}`.slice(0, 240);
    if (path) return path;
    if (command) return String(command).slice(0, 240);
    const keys = Object.keys(parsed);
    if (keys.length <= 2) return keys.map((k) => `${k}: ${String(parsed[k]).slice(0, 80)}`).join(" · ");
    return formatArgs(args);
  } catch {
    return args.length > 240 ? `${args.slice(0, 240)}…` : args;
  }
}

export function composePrompt(text: string, refs?: { path: string }[]): string {
  const listed = (refs ?? []).map((ref) => `@${ref.path}`).filter(Boolean);
  if (!listed.length) return text;
  return text.trim() ? `${listed.join("\n")}\n\n${text}` : listed.join("\n");
}

export function workspaceName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function formatArgs(args?: string): string {
  if (!args) return "";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** True on macOS. `platform` override exists for tests; defaults to the live navigator value. */
export function isMacPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator !== "undefined" ? navigator.platform ?? "" : "");
  return /mac/i.test(value);
}

/**
 * Modifier glyph matching the App.tsx shortcut handler (`metaKey || ctrlKey`):
 * "⌘" on macOS, "Ctrl" elsewhere.
 */
export function modGlyph(platform?: string): string {
  return isMacPlatform(platform) ? "⌘" : "Ctrl";
}

/** "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcutLabel(key: string, platform?: string): string {
  return isMacPlatform(platform) ? `${modGlyph(platform)}${key}` : `${modGlyph(platform)}+${key}`;
}

/** One plain sentence per known approval scope (`ApprovalChoiceScope` in the SDK); "" for anything else. */
export function describeApprovalScope(scope: string): string {
  switch (scope) {
    case "once": return "Allows this call only.";
    case "session": return "Allows every matching call for the rest of this thread.";
    case "localPersistent": return "Saved for this workspace; Muse will not ask again.";
    default: return "";
  }
}

/** Compact, locale-neutral token counts: 20448 → "20.4K", 1007997 → "1M". */
/** Elapsed time for status lines: "8s", "1m 12s", "1h 4m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] = count < 1_000_000 ? [count / 1000, "K"] : [count / 1_000_000, "M"];
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
}

/** Clipboard write with a legacy fallback for webviews without async clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Session-list time filter cutoff as an RFC 3339 timestamp for `updatedAfter`. */
export function timeFilterCutoff(filter: "day" | "week" | "month", now = Date.now()): string {
  const span = filter === "day" ? 24 * 3600_000 : filter === "week" ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000;
  return new Date(now - span).toISOString();
}

/** Stored-byte counts for the output viewer: 512 → "512 B", 20480 → "20 KB", 6 MiB → "6 MB". */
export function formatBytes(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0 B";
  if (count < 1024) return `${Math.floor(count)} B`;
  const [value, unit] = count < 1024 * 1024 ? [count / 1024, "KB"] : [count / (1024 * 1024), "MB"];
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}
