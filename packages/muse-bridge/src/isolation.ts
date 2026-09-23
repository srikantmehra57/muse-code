/**
 * Child-process isolation for Muse and ACP agents (SEC-03 / SEC-04 / SEC-05).
 *
 * The bridge never forwards the inherited desktop environment wholesale.
 * Agents start in a confined cwd, a process group we can reap, and — when
 * the platform can enforce it — a write-scoped OS sandbox. If that sandbox
 * cannot be applied, callers must collect an informed opt-in before spawn.
 */

import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assignWindowsJob, killWindowsJob, WINDOWS_JOB_SUPERVISOR } from "./winjob.js";
export { WINDOWS_JOB_SUPERVISOR };

export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const CANCEL_WAIT_MS = 2_000;
export const TREE_GRACE_MS = 1_500;
export const HOST_QUEUE_LIMIT = 16;
export const CREATE_CACHE_TTL_MS = 60_000;

/** Environment keys every child may inherit. Secrets and cloud creds stay out. */
export const BASE_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "USERNAME",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "EDITOR", "VISUAL",
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR",
  "NODE_NO_WARNINGS",
]);

const PROVIDER_ENV: Record<string, (key: string) => boolean> = {
  muse: (key) => key === "META_API_KEY" || key.startsWith("MUSE_"),
  opencode: (key) => /^(OPENCODE_|ANTHROPIC_|OPENAI_|OPENROUTER_)/.test(key),
  grok: (key) => key === "XAI_API_KEY" || key.startsWith("GROK_"),
  gemini: (key) => key === "GEMINI_API_KEY" || key === "GOOGLE_API_KEY" || key === "GOOGLE_GENAI_API_KEY" || key.startsWith("GEMINI_"),
  qwen: (key) => key === "DASHSCOPE_API_KEY" || key === "QWEN_API_KEY" || key.startsWith("QWEN_") || key.startsWith("DASHSCOPE_"),
  goose: (key) => key.startsWith("GOOSE_"),
};

export type IsolationReport = {
  env: "minimal";
  osSandbox: "enforced" | "unavailable";
  platform: NodeJS.Platform;
  cwd: string;
  consentRequired: boolean;
};

export function providerAllows(agentId: string | undefined, key: string): boolean {
  if (!agentId) return false;
  return PROVIDER_ENV[agentId]?.(key) === true;
}

/** Drop inherited secrets; keep PATH/HOME and the selected provider's keys. */
export function filterChildEnv(base: NodeJS.ProcessEnv, agentId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null || value === "") continue;
    if (key === "NODE_OPTIONS") continue;
    if (BASE_ENV_KEYS.has(key) || providerAllows(agentId, key)) env[key] = value;
  }
  return env;
}

export type SandboxBackend = "seatbelt" | "bwrap" | "none";
export type SandboxKind = "agent" | "muse";

let cachedBackend: SandboxBackend | undefined;

function commandOnPath(name: string): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [name], { encoding: "utf8", timeout: 2000, windowsHide: true });
  const line = result.stdout?.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
  return result.status === 0 && line ? line : null;
}

/** Which write-confinement wrapper this host can actually apply. */
export function sandboxBackend(): SandboxBackend {
  if (cachedBackend) return cachedBackend;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) cachedBackend = "seatbelt";
  else if (process.platform === "linux" && commandOnPath("bwrap")) cachedBackend = "bwrap";
  else cachedBackend = "none";
  return cachedBackend;
}

export function osSandboxAvailable(): boolean {
  return sandboxBackend() !== "none";
}

function seatbeltPath(path: string): string {
  return `(subpath "${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

/** Seatbelt matches the canonical path. /var on macOS is a symlink to /private/var. */
function canonicalRoots(paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    out.add(path);
    try { out.add(realpathSync(path)); } catch { /* not created yet */ }
  }
  return [...out];
}

/** Drop paths nested under an earlier root so bwrap does not double-bind them. */
export function withoutNested(paths: string[]): string[] {
  const sorted = [...new Set(paths.filter(Boolean))].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const path of sorted) {
    const nested = kept.some((parent) => path === parent || path.startsWith(parent.endsWith("/") ? parent : `${parent}/`));
    if (!nested) kept.push(path);
  }
  return kept;
}

function existingDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function agentWriteRoots(agentId: string, extra: string[]): string[] {
  const home = homedir();
  const tmp = tmpdir();
  const specific = agentId === "grok" ? [join(home, ".grok")]
    : agentId === "opencode" ? [join(home, ".opencode")]
    : agentId === "gemini" ? [join(home, ".gemini")]
    : agentId === "qwen" ? [join(home, ".qwen")]
    : agentId === "goose" ? [join(home, ".config", "goose"), join(home, ".local", "share", "goose")]
    : agentId === "muse" ? [join(home, ".muse"), join(home, ".config", "muse")]
    : [];
  return [
    ...extra, tmp, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp",
    join(home, ".config"), join(home, ".local", "share"), join(home, ".cache"),
    join(home, "Library", "Application Support"), join(home, "Library", "Caches"), join(home, "Library", "Logs"),
    ...specific,
  ];
}

/**
 * Muse `serve` writes whichever workspace the user opened, so its seatbelt
 * denies system locations instead of an allow-list of one folder. ACP agents
 * stay write-scoped to the workspace plus their config roots.
 */
export function buildSeatbeltProfile(kind: SandboxKind, agentId = "", extraRoots: string[] = []): string {
  if (kind === "muse") {
    const denied = ["/System", "/usr", "/bin", "/sbin", "/Library", "/etc", "/private/etc", "/boot"]
      .map(seatbeltPath).join(" ");
    const reallowed = canonicalRoots(["/usr/local", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp", tmpdir(), ...extraRoots])
      .map(seatbeltPath).join(" ");
    return `(version 1)\n(allow default)\n(deny file-write* ${denied})\n(allow file-write* ${reallowed})\n(allow file-write-data (regex #"^/dev/"))\n`;
  }
  const writes = canonicalRoots(agentWriteRoots(agentId, extraRoots)).map(seatbeltPath).join(" ");
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write-data (regex #"^/dev/"))\n(allow file-write* ${writes})\n`;
}

export function buildBwrapArgs(bin: string, args: string[], roots: string[]): string[] {
  const binds = withoutNested(roots).filter((path) => path !== "/" && existingDir(path));
  const argv = ["--die-with-parent", "--ro-bind", "/", "/"];
  for (const root of binds) argv.push("--bind", root, root);
  argv.push("--dev", "/dev", "--proc", "/proc", "--", bin, ...args);
  return argv;
}

function museBwrapRoots(extra: string[]): string[] {
  return [
    homedir(), tmpdir(),
    "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders",
    "/home", "/Users", "/Volumes", "/mnt", "/media", "/opt", "/usr/local", "/dev/shm",
    ...extra,
  ];
}

export type WrappedCommand = { command: string; args: string[]; sandboxed: boolean };

/** Prefix a command with seatbelt or bubblewrap when this OS can enforce it. */
export function wrapSandboxedCommand(
  bin: string,
  args: string[],
  options: { kind?: SandboxKind; agentId?: string; extraRoots?: string[]; backend?: SandboxBackend } = {},
): WrappedCommand {
  const kind = options.kind ?? "agent";
  const backend = options.backend ?? sandboxBackend();
  const extra = options.extraRoots ?? [];
  const agentId = options.agentId ?? "";
  if (backend === "seatbelt") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", buildSeatbeltProfile(kind, agentId, extra), bin, ...args],
      sandboxed: true,
    };
  }
  if (backend === "bwrap") {
    const bwrap = commandOnPath("bwrap");
    const roots = kind === "muse" ? museBwrapRoots(extra) : agentWriteRoots(agentId, extra);
    if (bwrap && roots.some(existingDir)) {
      return { command: bwrap, args: buildBwrapArgs(bin, args, roots), sandboxed: true };
    }
  }
  return { command: bin, args, sandboxed: false };
}

export function confinedCwd(workspace?: string): string {
  if (workspace) {
    try {
      if (statSync(workspace).isDirectory()) return workspace;
    } catch {
      // Fall through to a throwaway directory rather than $HOME.
    }
  }
  return tmpdir();
}

export function describeIsolation(cwd: string, sandboxed: boolean): IsolationReport {
  const osSandbox = sandboxed ? "enforced" : "unavailable";
  return {
    env: "minimal",
    osSandbox,
    platform: process.platform,
    cwd,
    consentRequired: osSandbox !== "enforced",
  };
}

export type IsolatedSpawn = {
  child: ChildProcessWithoutNullStreams;
  isolation: IsolationReport;
};

export function spawnIsolated(
  bin: string,
  args: string[],
  options: { agentId?: string; workspace?: string; sandbox?: boolean; env?: NodeJS.ProcessEnv } = {},
): IsolatedSpawn {
  const cwd = confinedCwd(options.workspace);
  const env = { ...filterChildEnv(options.env ?? process.env, options.agentId), NODE_NO_WARNINGS: "1" };
  const knownAgent = Boolean(options.agentId && ["muse", "opencode", "grok", "gemini", "qwen", "goose"].includes(options.agentId));
  const wantSandbox = options.sandbox !== false && Boolean(options.workspace) && knownAgent;
  const wrapped = wantSandbox
    ? wrapSandboxedCommand(bin, args, { kind: "agent", agentId: options.agentId, extraRoots: options.workspace ? [options.workspace] : [] })
    : { command: bin, args, sandboxed: false };
  const spawnOpts: SpawnOptions = {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(wrapped.command, wrapped.args, spawnOpts) as ChildProcessWithoutNullStreams;
  } catch {
    child = spawn(bin, args, spawnOpts) as ChildProcessWithoutNullStreams;
    wrapped.sandboxed = false;
  }
  if (process.platform === "win32" && child.pid) void assignWindowsJob(child.pid);
  return { child, isolation: describeIsolation(cwd, wrapped.sandboxed) };
}

async function signalGroup(pid: number, signal: NodeJS.Signals) {
  if (process.platform === "win32") {
    if (signal === "SIGKILL" || signal === "SIGTERM") {
      const killed = await killWindowsJob(pid);
      if (!killed) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

/** Close stdin, SIGTERM the process group, then SIGKILL after a grace period. */
export function terminateTree(child: ChildProcess, graceMs = TREE_GRACE_MS): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const pid = child.pid;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", (code, signal) => finish(code, signal));
    try { child.stdin?.end(); } catch { /* closed */ }
    const arm = () => {
      timer = setTimeout(() => {
        const escalate = pid ? signalGroup(pid, "SIGKILL") : Promise.resolve().then(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
        void escalate.finally(() => finish(null, "SIGKILL"));
      }, graceMs);
      timer.unref?.();
    };
    if (pid) void signalGroup(pid, "SIGTERM").finally(() => { if (!settled) arm(); });
    else {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      arm();
    }
  });
}

export function approvalExpiry(from = Date.now(), ttl = APPROVAL_TTL_MS): number {
  return from + ttl;
}

export function approvalAlive(expiresAt: number, now = Date.now()): boolean {
  return now <= expiresAt;
}
