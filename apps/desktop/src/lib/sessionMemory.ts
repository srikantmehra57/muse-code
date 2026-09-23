import type { ComposerImage, ContextRef, SessionConfig, SubscriptionUsage } from "./types";

export type Draft = { text: string; images: ComposerImage[]; config?: SessionConfig; refs?: ContextRef[] };

export type ThreadMeta = {
  title?: string;
  agentId?: string;
  customTitle?: boolean;
  pinned?: boolean;
  order?: number;
  archived?: boolean;
  /** Locally removed; skip this session if the host lists it again. */
  deleted?: boolean;
  lastStatus?: "idle" | "running" | "error";
  lastOutcome?: "completed" | "failed" | "cancelled" | "interrupted";
  forkedFrom?: { sessionId: string; title: string } | null;
};

export type SessionMemory = {
  version: 1;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  drafts: Record<string, Draft>;
  threadMeta: Record<string, ThreadMeta>;
  dockOpen: boolean;
  sidebarCollapsed: boolean;
  subscriptionUsage: SubscriptionUsage | null;
};

export const EMPTY_MEMORY: SessionMemory = {
  version: 1,
  selectedWorkspaceId: null,
  selectedSessionId: null,
  drafts: {},
  threadMeta: {},
  dockOpen: true,
  sidebarCollapsed: false,
  subscriptionUsage: null,
};

type Store = {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<unknown>;
  save(): Promise<unknown>;
};

export function normalizeMemory(value: Partial<SessionMemory> | undefined): SessionMemory {
  return {
    ...EMPTY_MEMORY,
    ...value,
    version: 1,
    drafts: value?.drafts ?? {},
    threadMeta: value?.threadMeta ?? {},
  };
}

export class SessionMemoryPersistence {
  constructor(private store: Store | null, private fallback?: Storage | null) {}

  async load(): Promise<SessionMemory> {
    if (this.store) {
      const saved = await this.store.get<Partial<SessionMemory>>("sessionMemory");
      return normalizeMemory(saved);
    }
    if (this.fallback) {
      try {
        const raw = this.fallback.getItem("muse-session-memory");
        return normalizeMemory(raw ? JSON.parse(raw) as Partial<SessionMemory> : undefined);
      } catch {
        return { ...EMPTY_MEMORY };
      }
    }
    return { ...EMPTY_MEMORY };
  }

  async save(value: SessionMemory): Promise<void> {
    const memory = normalizeMemory(value);
    if (this.store) {
      await this.store.set("sessionMemory", memory);
      await this.store.save();
      return;
    }
    this.fallback?.setItem("muse-session-memory", JSON.stringify(memory));
  }
}

export function applyThreadMeta<T extends { sessionId: string; title: string }>(thread: T, meta?: ThreadMeta): T {
  if (!meta) return thread;
  return {
    ...thread,
    title: meta.customTitle && meta.title ? meta.title : thread.title,
    ...(meta as object),
  };
}
