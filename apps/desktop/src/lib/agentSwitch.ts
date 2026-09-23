import type { Draft, ThreadMeta } from "./sessionMemory";
import type { AgentId, SessionConfig, Thread } from "./types";

type ThreadState = {
  threads: Thread[];
  drafts: Record<string, Draft>;
  threadMeta: Record<string, ThreadMeta>;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
};

/** Project-level draft follows the agent the user just picked, so New Thread cannot resurrect the previous one. */
export function projectDraftForAgent(drafts: Record<string, Draft>, workspaceId: string | null, agentId: AgentId): Record<string, Draft> {
  if (!workspaceId) return drafts;
  const key = `project:${workspaceId}`;
  const current = drafts[key] ?? { text: "", images: [], refs: [] };
  const config: SessionConfig = { ...(current.config ?? {}), modelId: undefined, providerId: undefined, effort: undefined, mode: undefined, agentId: agentId === "muse" ? undefined : agentId };
  return { ...drafts, [key]: { ...current, config } };
}

/** Replace a thread's backend session after an agent switch, keeping local messages and moving drafts/meta. */
export function rekeyThreadState(state: ThreadState, previousId: string, next: Thread): ThreadState {
  const threads = state.threads.map((thread) => thread.sessionId === previousId ? next : thread);
  const drafts = projectDraftForAgent(state.drafts, state.selectedWorkspaceId, next.agentId ?? "muse");
  const oldKey = `thread:${previousId}`;
  const newKey = `thread:${next.sessionId}`;
  if (previousId !== next.sessionId && drafts[oldKey]) {
    drafts[newKey] = { ...drafts[oldKey], config: next.config };
    delete drafts[oldKey];
  } else if (drafts[newKey]) {
    drafts[newKey] = { ...drafts[newKey], config: next.config };
  }
  const threadMeta = { ...state.threadMeta };
  if (previousId !== next.sessionId && threadMeta[previousId]) {
    threadMeta[next.sessionId] = { ...threadMeta[previousId], agentId: next.agentId };
    delete threadMeta[previousId];
  } else if (threadMeta[next.sessionId] || next.agentId) {
    threadMeta[next.sessionId] = { ...threadMeta[next.sessionId], agentId: next.agentId };
  }
  return { threads, drafts, threadMeta, selectedWorkspaceId: state.selectedWorkspaceId, selectedSessionId: next.sessionId };
}
