import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { filterChildEnv } from "./isolation.js";

function extraBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".muse", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".nvm", "current", "bin"),
    join(home, "AppData", "Local", "muse"),
    join(home, "AppData", "Local", "Programs", "muse"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
}

function isAllowedMusePath(candidate: string): boolean {
  const name = candidate.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!(name === "muse" || name === "muse.exe" || name.startsWith("muse-bin-"))) return false;
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  if (normalized.startsWith("/tmp/") || normalized.startsWith("/var/tmp/") || normalized.startsWith("/private/tmp/") || normalized.includes("/appdata/local/temp/")) {
    return false;
  }
  return true;
}

/** Resolve symlinks first so the name/temp checks below see the real target. */
function canonical(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

export function resolveMuseBin(custom?: string | null): string | null {
  if (custom) {
    const resolved = canonical(custom);
    if (!resolved || !isAllowedMusePath(resolved)) return null;
    return resolved;
  }
  const names = process.platform === "win32" ? ["muse.exe", "muse"] : ["muse"];
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of [...extraBinDirs(), ...pathDirs]) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (!existsSync(candidate)) continue;
      const resolved = canonical(candidate);
      // A discovered entry that fails the checks is skipped, not fatal: a
      // shadowing junk file must not wedge auto-discovery.
      if (resolved && isAllowedMusePath(resolved)) return resolved;
    }
  }
  return null;
}

export function museVersion(bin: string): string | null {
  try {
    const result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 8000,
    });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Which credential the app asks Muse to bill: the CLI sign-in, the API key, or whichever is present. */
export type AuthMode = "auto" | "subscription" | "apiKey";

export function normalizeAuthMode(value?: string | null): AuthMode {
  return value === "subscription" || value === "apiKey" ? value : "auto";
}

/** `muse /login` writes one of these; their presence means a subscription sign-in is available. */
export function authFileCandidates(): string[] {
  const home = homedir();
  return [
    join(home, ".config", "muse", "auth.json"),
    join(home, ".muse", "auth.json"),
    join(home, "Library", "Application Support", "muse", "auth.json"),
    join(home, "AppData", "Roaming", "muse", "auth.json"),
  ];
}

export function subscriptionPresent(): boolean {
  return authFileCandidates().some((file) => existsSync(file));
}

function displayString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Display name for the signed-in Muse subscription, e.g. `providers.meta.user_full_name`.
 * Only name/email fields are read — tokens are never parsed out of the credential file.
 */
export function subscriptionAccount(): { name: string | null; email: string | null } {
  let name: string | null = null;
  let email: string | null = null;
  for (const file of authFileCandidates()) {
    let parsed: unknown = null;
    try {
      if (!existsSync(file)) continue;
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const scopes: unknown[] = [parsed];
    const providers = (parsed as { providers?: unknown }).providers;
    if (providers && typeof providers === "object") scopes.push(...Object.values(providers));
    for (const scope of scopes) {
      if (!scope || typeof scope !== "object") continue;
      const record = scope as Record<string, unknown>;
      name ??= displayString(record.user_full_name) ?? displayString(record.user_name) ?? displayString(record.name);
      email ??= displayString(record.user_email) ?? displayString(record.email);
      if (name && email) return { name, email };
    }
  }
  return { name, email };
}

export type AuthStatus = {
  authenticated: boolean;
  method: string | null;
  authMode: AuthMode;
  activeAuth: "subscription" | "apiKey" | null;
  subscriptionAvailable: boolean;
  apiKeyAvailable: boolean;
};

export function authPresent(apiKey?: string | null, mode?: string | null): AuthStatus {
  const authMode = normalizeAuthMode(mode);
  const subscriptionAvailable = subscriptionPresent();
  const apiKeyAvailable = Boolean(apiKey?.trim() || process.env.META_API_KEY?.trim());
  const activeAuth = authMode === "subscription"
    ? (subscriptionAvailable ? "subscription" : null)
    : authMode === "apiKey"
      ? (apiKeyAvailable ? "apiKey" : null)
      // Automatic prefers the sign-in: a leftover key would silently bill per token instead.
      : subscriptionAvailable ? "subscription" : apiKeyAvailable ? "apiKey" : null;
  return {
    authenticated: activeAuth !== null,
    method: activeAuth === "apiKey" ? "META_API_KEY" : activeAuth === "subscription" ? "auth.json" : null,
    authMode,
    activeAuth,
    subscriptionAvailable,
    apiKeyAvailable,
  };
}

/**
 * Environment for `muse serve`. META_API_KEY outranks the CLI sign-in inside Muse, so it is
 * removed whenever the subscription should pay for the session — including keys inherited
 * from the user's shell.
 */
export function museEnv(base: NodeJS.ProcessEnv, apiKey?: string | null, mode?: string | null): NodeJS.ProcessEnv {
  const env = filterChildEnv(base, "muse");
  if (authPresent(apiKey, mode).activeAuth === "apiKey") {
    const key = apiKey?.trim() || env.META_API_KEY?.trim();
    if (key) env.META_API_KEY = key;
  } else {
    delete env.META_API_KEY;
  }
  return env;
}

export function detectMuse(custom?: string | null, apiKey?: string | null, mode?: string | null) {
  const path = resolveMuseBin(custom);
  const version = path ? museVersion(path) : null;
  const auth = authPresent(apiKey, mode);
  const account = auth.subscriptionAvailable ? subscriptionAccount() : { name: null, email: null };
  return {
    found: Boolean(path && version),
    path,
    version,
    ...auth,
    accountName: account.name,
    accountEmail: account.email,
  };
}
