import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { detectMuse } from "./detect.js";
import { confinedCwd, filterChildEnv } from "./isolation.js";

/**
 * Coding-agent CLIs this app can drive. Muse speaks MSP through its SDK; the rest
 * speak ACP (Agent Client Protocol, JSON-RPC over stdio). Only binaries named here
 * are ever spawned — detection never runs arbitrary paths.
 */
export type AgentId = "muse" | "opencode" | "grok" | "gemini" | "qwen" | "goose";

export type AgentSpec = {
  id: AgentId;
  name: string;
  protocol: "msp" | "acp";
  bins: string[];
  /** Arguments that start the ACP server over stdio. */
  acpArgs?: string[];
  /** Extra install locations beyond PATH. */
  dirs?: string[];
  /** Verified end-to-end against a real install; others are best-effort ACP. */
  verified: boolean;
  signIn: string;
};

const home = homedir();
const COMMON_DIRS = [
  join(home, ".local", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".npm-global", "bin"),
  join(home, ".volta", "bin"),
  join(home, ".asdf", "shims"),
  join(home, ".nvm", "current", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

export const AGENTS: AgentSpec[] = [
  { id: "muse", name: "Muse", protocol: "msp", bins: ["muse"], verified: true, signIn: "Run `muse` and `/login` for a Muse Code subscription, or add an API key in Settings." },
  { id: "opencode", name: "OpenCode", protocol: "acp", bins: ["opencode"], acpArgs: ["acp"], dirs: [join(home, ".opencode", "bin")], verified: true, signIn: "Run `opencode auth login` in a terminal, then Rescan." },
  { id: "grok", name: "Grok", protocol: "acp", bins: ["grok"], acpArgs: ["agent", "stdio"], dirs: [join(home, ".grok", "bin")], verified: true, signIn: "Run `grok login` in a terminal, then Rescan." },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", bins: ["gemini"], acpArgs: ["--experimental-acp"], verified: false, signIn: "Run `gemini` once in a terminal to sign in." },
  { id: "qwen", name: "Qwen Code", protocol: "acp", bins: ["qwen"], acpArgs: ["--experimental-acp"], verified: false, signIn: "Run `qwen` once in a terminal to sign in." },
  { id: "goose", name: "Goose", protocol: "acp", bins: ["goose"], acpArgs: ["acp"], verified: false, signIn: "Run `goose configure` in a terminal." },
];

export function agentSpec(id: string): AgentSpec {
  const spec = AGENTS.find((agent) => agent.id === id);
  if (!spec) throw new Error(`Unknown agent: ${id}`);
  return spec;
}

function isTempTarget(resolved: string): boolean {
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  return normalized.startsWith("/tmp/") || normalized.startsWith("/var/tmp/")
    || normalized.startsWith("/private/tmp/") || normalized.includes("/appdata/local/temp/");
}

export function resolveAgentBin(spec: AgentSpec): string | null {
  const names = process.platform === "win32" ? spec.bins.flatMap((bin) => [`${bin}.exe`, `${bin}.cmd`, bin]) : spec.bins;
  const dirs = [...(spec.dirs ?? []), ...COMMON_DIRS, ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      // Fallback resolution only (Tauri injects the checked path): still
      // canonicalize and skip temp targets instead of spawning them.
      let resolved: string;
      try {
        resolved = realpathSync(candidate);
      } catch {
        continue;
      }
      if (!isTempTarget(resolved)) return resolved;
    }
  }
  return null;
}

function versionOf(bin: string): string | null {
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 6000, cwd: confinedCwd(), env: filterChildEnv(process.env) });
    const line = `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").map((text) => text.trim()).find(Boolean);
    return line?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? line ?? null;
  } catch {
    return null;
  }
}

export type AgentInfo = {
  id: AgentId;
  name: string;
  protocol: "msp" | "acp";
  found: boolean;
  path: string | null;
  version: string | null;
  verified: boolean;
  signIn: string;
  /** Muse only: whether the chosen credential is present. ACP agents report auth on connect. */
  authenticated?: boolean;
};

export function detectAgents(museBin?: string | null, museApiKey?: string | null, museAuthMode?: string | null): AgentInfo[] {
  return AGENTS.map((spec) => {
    if (spec.id === "muse") {
      const muse = detectMuse(museBin, museApiKey, museAuthMode);
      return { id: spec.id, name: spec.name, protocol: spec.protocol, found: muse.found, path: muse.path, version: muse.version?.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? muse.version, verified: true, signIn: spec.signIn, authenticated: muse.authenticated };
    }
    const path = resolveAgentBin(spec);
    return { id: spec.id, name: spec.name, protocol: spec.protocol, found: Boolean(path), path, version: path ? versionOf(path) : null, verified: spec.verified, signIn: spec.signIn };
  });
}
