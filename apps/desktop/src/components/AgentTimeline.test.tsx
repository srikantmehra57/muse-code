import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentTimeline } from "./AgentTimeline";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread, TranscriptItem } from "../lib/types";

const item = (partial: Partial<TranscriptItem>): TranscriptItem => ({
  itemId: `i-${Math.random().toString(36).slice(2)}`,
  kind: "toolCall",
  status: "completed",
  ...partial,
});

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  ...partial,
});

function mount(t: Thread) {
  seedStore({ threads: [t], selectedSessionId: t.sessionId });
  return render(<AgentTimeline thread={t} />);
}

describe("AgentTimeline", () => {
  beforeEach(resetStore);

  it("renders user and agent message text", () => {
    mount(thread({
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "Fix the flaky login test" }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Found the race in the token refresh" }),
      ],
    }));
    expect(screen.getByText("Fix the flaky login test")).toBeInTheDocument();
    expect(screen.getByText(/Found the race in the token refresh/)).toBeInTheDocument();
  });

  it("shows a files-changed receipt whose Revert files opens a danger confirm", async () => {
    mount(thread({
      lastOutcome: "completed",
      lastTurnId: "t1",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "rename both" }),
        item({ itemId: "e1", tool: "edit_file", turnId: "t1", args: JSON.stringify({ path: "src/a.ts", old_string: "x", new_string: "y" }) }),
        item({ itemId: "e2", tool: "write_file", turnId: "t1", args: JSON.stringify({ path: "src/b.ts", content: "new" }) }),
        item({ itemId: "m1", kind: "agentMessage", turnId: "t1", text: "Both files updated." }),
      ],
    }));
    expect(screen.getByText("Changed 2 files")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Revert files/ }));
    const dialog = useAppStore.getState().confirmDialog;
    expect(dialog?.danger).toBe(true);
    expect(dialog?.title).toContain("2 files");
  });

  it("labels an in-progress tool call as Running", () => {
    // The live turn's trailing steps fold into the status line, so the
    // in-progress run must be followed by a newer run to render its StepRow.
    mount(thread({
      status: "running",
      activeTurnId: "t2",
      items: [
        item({ itemId: "u1", kind: "userMessage", turnId: "t1", text: "run tests" }),
        item({ itemId: "t-cmd", tool: "bash", turnId: "t1", status: "inProgress", args: JSON.stringify({ command: "npm test" }), commandText: "npm test" }),
        item({ itemId: "u2", kind: "userMessage", turnId: "t2", text: "and lint" }),
        item({ itemId: "m2", kind: "agentMessage", turnId: "t2", text: "On it." }),
      ],
    }));
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });
});
