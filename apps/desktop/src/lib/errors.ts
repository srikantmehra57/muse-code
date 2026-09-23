export type ErrorAction = "settings" | "retry" | "reconnect" | "dismiss";

export type ClassifiedError = {
  code: string;
  title: string;
  detail: string;
  action: ErrorAction;
  lost: string;
};

const AUTH = /authrequired|not logged in|api key|\/login/i;
const MISSING = /could not find the muse cli|muse cli was not found|cli not/i;
const CLOSED = /connection closed|host is not running|bridge/i;
const TIMEOUT = /timed out/i;
const NETWORK = /network|offline|econnrefused|enotfound/i;

/** MSP kinds the bridge preserves beside the message, mapped to recovery branches. */
const KIND_BRANCH: Record<string, Omit<ClassifiedError, "detail">> = {
  authRequired: { code: "auth", title: "Muse needs a sign-in", action: "settings", lost: "The draft is kept. Nothing was sent." },
  capabilityRequired: { code: "auth", title: "Muse needs a sign-in", action: "settings", lost: "The draft is kept. Nothing was sent." },
  overloaded: { code: "busy", title: "Muse is busy", action: "retry", lost: "Nothing was sent. Retry in a bit." },
  backpressured: { code: "busy", title: "Muse is busy", action: "retry", lost: "Nothing was sent. Retry in a bit." },
  sessionNotFound: { code: "gone", title: "Thread is gone from the host", action: "reconnect", lost: "Reselect the thread or workspace to restore it." },
  sessionNotLoaded: { code: "gone", title: "Thread is not loaded", action: "reconnect", lost: "Reselect the thread to open it again." },
  sessionInUse: { code: "gone", title: "Thread is open elsewhere", action: "reconnect", lost: "Another client holds it. Reselect to take it over." },
  sessionAmbiguous: { code: "gone", title: "Thread matched more than one session", action: "reconnect", lost: "Reselect the thread to disambiguate." },
  interrupted: { code: "stopped", title: "Stopped", action: "dismiss", lost: "The turn was interrupted." },
  cancelled: { code: "stopped", title: "Stopped", action: "dismiss", lost: "The turn was cancelled." },
  inputTooLarge: { code: "invalid", title: "Too much input", action: "retry", lost: "Shorten the prompt or drop attachments, then retry." },
  skillNotFound: { code: "invalid", title: "Skill unavailable", action: "retry", lost: "The skill list changed and was refreshed. Pick the skill again." },
  invalidParams: { code: "invalid", title: "The request was rejected", action: "retry", lost: "Check the thread before retrying." },
  outputResultTooLarge: { code: "large", title: "Output too large", action: "retry", lost: "Narrow the range and retry." },
  pageEventTooLarge: { code: "large", title: "History page too large", action: "retry", lost: "Retry; older history stays pageable." },
  viewTruncated: { code: "large", title: "History truncated", action: "retry", lost: "Retry; older history stays pageable." },
};

export function classifyError(error: unknown, fallback = "Something went wrong"): ClassifiedError {
  const detail = error instanceof Error ? error.message : String(error || fallback);
  const kind = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  const branch = kind ? KIND_BRANCH[kind] : undefined;
  if (branch) return { ...branch, detail };
  if (AUTH.test(detail)) {
    return { code: "auth", title: "Muse needs a sign-in", detail, action: "settings", lost: "The draft is kept. Nothing was sent." };
  }
  if (MISSING.test(detail)) {
    return { code: "cli", title: "Muse CLI not found", detail, action: "settings", lost: "No thread work was changed." };
  }
  if (TIMEOUT.test(detail)) {
    return { code: "timeout", title: "Muse did not respond in time", detail, action: "retry", lost: "The request may still be running on the host. Check the thread before retrying." };
  }
  if (CLOSED.test(detail) || NETWORK.test(detail)) {
    return { code: "host", title: "Muse disconnected", detail, action: "reconnect", lost: "Completed work is on the host. Open the thread again to restore it." };
  }
  return { code: "unknown", title: fallback, detail, action: "retry", lost: "Check the thread before retrying." };
}

/** A bridge call whose result is unknown (it timed out locally): safe to retry with the same idempotency key. */
export function timeoutUnknown(error: unknown): boolean {
  if (error instanceof Error && (error as Error & { code?: string }).code === "timeout-unknown") return true;
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return TIMEOUT.test(detail) && /result is unknown/i.test(detail);
}

export function authRequired(outcome?: { kind?: string; params?: { terminal?: string; reason?: string; error?: { kind?: string; message?: string } } }): boolean {
  const kind = outcome?.params?.error?.kind;
  const reason = `${outcome?.params?.reason ?? ""} ${outcome?.params?.error?.message ?? ""}`;
  return kind === "authRequired" || AUTH.test(reason);
}
