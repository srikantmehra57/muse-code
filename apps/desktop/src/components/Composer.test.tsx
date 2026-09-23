import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import { indentText } from "../lib/composerText";
import type { Thread } from "../lib/types";

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  opened: true,
  ...partial,
});

function seedWorkspace(threadPatch: Partial<Thread> = {}) {
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    threads: [thread(threadPatch)],
    selectedSessionId: "s1",
    preview: false,
  });
}

describe("Composer", () => {
  beforeEach(resetStore);

  // WCAG 2.1.2 — No Keyboard Trap (Level A).
  it("Tab moves focus out of the composer instead of trapping the keyboard", () => {
    seedWorkspace();
    useAppStore.setState({ composer: "hello" });
    render(<Composer />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    box.setSelectionRange(5, 5);

    const propagated = fireEvent.keyDown(box, { key: "Tab" });

    expect(propagated, "Tab must not be preventDefault-ed with no selection").toBe(true);
    expect(box.value, "an unselected Tab must not edit the draft").toBe("hello");
  });

  it("Shift+Tab also leaves the composer when nothing is selected", () => {
    seedWorkspace();
    useAppStore.setState({ composer: "hello" });
    render(<Composer />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    box.setSelectionRange(5, 5);

    const propagated = fireEvent.keyDown(box, { key: "Tab", shiftKey: true });

    expect(propagated, "Shift+Tab must still traverse backwards out of the field").toBe(true);
    expect(box.value).toBe("hello");
  });

  it("Tab still indents when text is selected", () => {
    seedWorkspace();
    useAppStore.setState({ composer: "alpha" });
    render(<Composer />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    box.setSelectionRange(0, 5);

    const propagated = fireEvent.keyDown(box, { key: "Tab" });

    expect(propagated, "a selection is an explicit editing gesture, so Tab is consumed").toBe(false);
    expect(box.value).toBe(indentText("alpha", 0, 5).text);
    expect(box.value).not.toBe("alpha");
  });

  it("Enter sends; Shift+Enter inserts a newline instead", async () => {
    const sendPrompt = vi.fn();
    useAppStore.setState({ sendPrompt: sendPrompt as never });
    seedWorkspace();
    const user = userEvent.setup();
    render(<Composer />);
    const box = screen.getByRole("textbox");
    await user.type(box, "hello");
    await user.keyboard("{Enter}");
    expect(sendPrompt).toHaveBeenCalledTimes(1);

    sendPrompt.mockClear();
    useAppStore.setState({ composer: "" });
    await user.type(box, "a{Shift>}{Enter}{/Shift}b");
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(useAppStore.getState().composer).toBe("a\nb");
  });

  it("shows Stop instead of Send while the turn runs and calls stopTurn", async () => {
    const stopTurn = vi.fn();
    useAppStore.setState({ stopTurn: stopTurn as never });
    seedWorkspace({ status: "running", activeTurnId: "t1" });
    const user = userEvent.setup();
    render(<Composer />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(stopTurn).toHaveBeenCalledTimes(1);
  });

  it("@-mention offers fuzzy matches from the workspace file index", async () => {
    seedWorkspace();
    seedStore({ fileIndex: { workspaceId: "w", paths: ["src/components/Composer.tsx", "README.md"], loadedAt: Date.now() } });
    const user = userEvent.setup();
    render(<Composer />);
    await user.type(screen.getByRole("textbox"), "@Comp");
    const listbox = await screen.findByRole("listbox", { name: "File references" });
    expect(within(listbox).getByRole("option", { name: /Composer\.tsx/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole("option", { name: /README/ })).toBeNull();
  });

  it("is disabled with the open-a-workspace reason when no workspace exists", () => {
    seedStore({ workspaces: [], selectedWorkspaceId: null, threads: [], selectedSessionId: null });
    render(<Composer />);
    const box = screen.getByPlaceholderText("Open a workspace to start");
    expect(box).toBeDisabled();
  });
});
