import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { ApprovalRequest, Thread } from "../lib/types";

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "running",
  unread: false,
  items: [],
  ...partial,
});

const approval = (partial: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approvalId: "a1",
  sessionId: "s1",
  turnId: "t1",
  toolName: "bash",
  rawArgs: JSON.stringify({ command: "ls -la" }),
  availableChoices: [
    { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
    { choiceId: "allow-session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
    { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
  ],
  ...partial,
});

function mount(request: ApprovalRequest, threadPatch: Partial<Thread> = {}) {
  seedStore({ threads: [thread({ pendingApproval: request, ...threadPatch })], selectedSessionId: "s1" });
  return render(<ApprovalCard />);
}

describe("ApprovalCard", () => {
  beforeEach(resetStore);
  afterEach(() => vi.useRealTimers());

  it("renders the tool label, summary, and decisions; allow calls decide", () => {
    const decide = vi.fn();
    useAppStore.setState({ decide: decide as never });
    mount(approval());
    expect(screen.getByRole("heading", { name: "Allow Terminal?" })).toBeInTheDocument();
    expect(screen.getByText("ls -la")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow once/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Deny/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Allow once/ }));
    expect(decide).toHaveBeenCalledWith("a1", "allow-once");
  });

  it("shows the proposed change for an edit_file approval", () => {
    mount(approval({
      toolName: "edit_file",
      rawArgs: JSON.stringify({ path: "src/lib/store.ts", old_string: "const a = 1;", new_string: "const a = 2;" }),
    }));
    const region = screen.getByLabelText("Proposed change");
    expect(region).toHaveTextContent("- const a = 1;");
    expect(region).toHaveTextContent("+ const a = 2;");
    expect(region).toHaveTextContent("src/lib/store.ts");
  });

  it("ticks the expiry countdown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T12:00:00Z"));
    mount(approval({ expiresAt: Date.now() + 60_000 }));
    expect(screen.getByText("Expires in 1:00")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("Expires in 0:59")).toBeInTheDocument();
  });

  it("past expiresAt shows the expired notice and disables every choice", () => {
    mount(approval({ expiresAt: Date.now() - 1000 }));
    expect(screen.getByText("This approval expired. Stop or re-run the turn.")).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
    }
  });

  it("describes the first allow choice's scope", () => {
    mount(approval());
    expect(screen.getByText("Allows this call only.")).toBeInTheDocument();
    act(() => {
      useAppStore.setState({
        threads: [thread({
          pendingApproval: approval({
            availableChoices: [
              { choiceId: "allow-session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
              { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
            ],
          }),
        })],
      });
    });
    expect(screen.getByText("Allows every matching call for the rest of this thread.")).toBeInTheDocument();
  });
});
