import type { Session } from "@muse-code/sdk";

export type SessionFacts = {
  sessionId: string;
  plan: Array<{ id: string; text: string; status: string; activeForm?: string }>;
  goal: { objective: string; currentWork?: string; nextWork?: string; percentComplete?: number; status?: string } | null;
  context: { usedTokens?: number; windowTokens?: number; pressure?: string } | null;
  usage: { promptTokens?: number; totalTokens?: number; outputTokens?: number } | null;
  branch: string | null;
};

const SESSION_METHODS = new Set([
  "session/todoListChanged",
  "session/goalChanged",
  "session/contextUsage",
  "session/tokenUsage",
  "session/branchChanged",
  "session/modelChanged",
]);

export function isSessionFactNotification(method: string): boolean {
  return SESSION_METHODS.has(method);
}

export function factsFromSession(session: Session): SessionFacts {
  const empty: SessionFacts = { sessionId: session.sessionId, plan: [], goal: null, context: null, usage: null, branch: null };
  try {
    const state = session.fold?.sessionState;
    if (!state) return empty;
    const todos = state.get("session/todoListChanged");
    const goalEvent = state.get("session/goalChanged");
    const context = state.get("session/contextUsage");
    const usage = state.get("session/tokenUsage");
    const branch = state.get("session/branchChanged");
    const goal = goalEvent?.goal ?? null;
    return {
      sessionId: session.sessionId,
      plan: (todos?.items ?? []).map((item, index) => ({
        id: `${item.text}:${index}`,
        text: item.text,
        status: String(item.status),
        activeForm: item.activeForm,
      })),
      goal: goal ? {
        objective: String(goal.objective ?? ""),
        currentWork: goal.currentWork,
        nextWork: goal.nextWork,
        percentComplete: goal.percentComplete,
        status: goal.status,
      } : null,
      context: context ? { usedTokens: context.usedTokens, windowTokens: context.windowTokens, pressure: context.pressure ? String(context.pressure) : undefined } : null,
      usage: usage ? {
        promptTokens: usage.promptTokens ?? usage.cumulative?.promptTokens,
        totalTokens: usage.totalTokens ?? usage.cumulative?.totalTokens,
        outputTokens: usage.cumulative?.outputTokens,
      } : null,
      branch: branch?.branch ?? null,
    };
  } catch {
    return empty;
  }
}
