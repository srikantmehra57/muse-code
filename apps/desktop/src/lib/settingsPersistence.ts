import { DEFAULT_ENABLED_AGENTS, DEFAULT_SETTINGS, type Settings } from "./types";

type SettingsStore = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  save(): Promise<unknown>;
};
type Credentials = { get(): Promise<string | null>; set(value: string): Promise<void> };
const SAVED_KEY_MASK = "••••••••";

export function settingsFields(settings: Settings): Settings {
  const { museBin, museApiKey, museAuthMode, ephemeralSessions, disableWrite, disableShell, sandboxNetwork, theme, accentColor, accentSidebar, defaultModel, defaultProviderId, defaultEffort, defaultApprovalMode, defaultAgentId, enabledAgents, acpUnisolatedConsent, notifications, workspaces } = settings;
  return { museBin, museApiKey, museAuthMode: museAuthMode ?? DEFAULT_SETTINGS.museAuthMode, ephemeralSessions: ephemeralSessions ?? false, disableWrite: disableWrite ?? false, disableShell: disableShell ?? false, sandboxNetwork: sandboxNetwork ?? "proxy-only", theme, accentColor, accentSidebar, defaultModel, defaultProviderId, defaultEffort, defaultApprovalMode, defaultAgentId, enabledAgents: { ...DEFAULT_ENABLED_AGENTS, ...enabledAgents }, acpUnisolatedConsent: acpUnisolatedConsent === true, notifications: notifications ?? true, workspaces };
}

export class SettingsPersistence {
  private key: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: SettingsStore, private credentials: Credentials) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => {});
    return next;
  }

  load(): Promise<Settings> {
    return this.serialize(async () => {
      const saved = await this.store.get<Partial<Settings>>("settings") ?? {};
      const secureKey = await this.credentials.get();
      const legacyKey = saved.museApiKey?.trim() ?? "";
      // Never delete the only persisted copy if the credential store is locked.
      if (secureKey === null && legacyKey) await this.credentials.set(legacyKey);
      this.key = secureKey ?? legacyKey;
      const settings = settingsFields({ ...DEFAULT_SETTINGS, ...saved, museApiKey: this.key });
      if (Object.prototype.hasOwnProperty.call(saved, "museApiKey")) {
        await this.writePublicSettings(settings);
      }
      return settings;
    });
  }

  save(value: Settings): Promise<void> {
    const settings = settingsFields(value);
    return this.serialize(async () => {
      const previousKey = this.key ?? await this.credentials.get() ?? "";
      const changed = previousKey !== settings.museApiKey;
      if (changed) await this.credentials.set(settings.museApiKey === SAVED_KEY_MASK ? previousKey : settings.museApiKey);
      try {
        await this.writePublicSettings(settings);
        this.key = settings.museApiKey;
      } catch (error) {
        if (changed) {
          try { await this.credentials.set(previousKey); }
          catch { this.key = undefined; throw new Error("Settings save failed and the API-key change could not be rolled back. Reopen Settings before retrying."); }
        }
        throw error;
      }
    });
  }

  private async writePublicSettings(settings: Settings) {
    const { museApiKey: _secret, ...publicSettings } = settings;
    await this.store.set("settings", publicSettings);
    await this.store.save();
  }
}
