import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";
import { useAppStore } from "../lib/store";
import { resetStore } from "../test/store";

describe("ConfirmDialog", () => {
  beforeEach(resetStore);

  it("resolves false on Escape and true on the confirm button", async () => {
    render(<ConfirmDialog />);

    const cancelled = useAppStore.getState().confirm({ title: "Delete thread?", body: "Gone forever.", confirmLabel: "Delete", danger: true });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Delete thread?");
    expect(dialog).toHaveTextContent("Gone forever.");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await expect(cancelled).resolves.toBe(false);
    expect(useAppStore.getState().confirmDialog).toBeNull();

    const accepted = useAppStore.getState().confirm({ title: "Discard changes?", confirmLabel: "Discard" });
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await expect(accepted).resolves.toBe(true);
    expect(useAppStore.getState().confirmDialog).toBeNull();
  });

  it("a second confirm cancels the first", async () => {
    render(<ConfirmDialog />);
    const first = useAppStore.getState().confirm({ title: "One?" });
    const second = useAppStore.getState().confirm({ title: "Two?" });
    await expect(first).resolves.toBe(false);
    expect(await screen.findByRole("dialog")).toHaveTextContent("Two?");
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await expect(second).resolves.toBe(false);
  });

  it("Enter on the focused Cancel button cancels a danger dialog instead of destroying", async () => {
    render(<ConfirmDialog />);
    // Danger prompts focus Cancel so Enter cannot destroy by accident; that
    // only holds if the dialog does not confirm on Enter while Cancel is armed.
    const pending = useAppStore.getState().confirm({ title: "Delete thread?", confirmLabel: "Delete", danger: true });
    await screen.findByRole("dialog");
    // The dialog has two "Cancel" controls (the header close icon and the
    // footer button); the footer one is the armed safe-default focus target.
    const cancel = screen.getAllByRole("button", { name: "Cancel" }).find((node) => node.closest("footer"))!;
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Enter" });
    await expect(pending).resolves.toBe(false);
    expect(useAppStore.getState().confirmDialog).toBeNull();
  });

  it("Enter on the focused confirm button accepts", async () => {
    render(<ConfirmDialog />);
    const pending = useAppStore.getState().confirm({ title: "Discard changes?", confirmLabel: "Discard", danger: true });
    await screen.findByRole("dialog");
    const confirm = screen.getByRole("button", { name: "Discard" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Enter" });
    await expect(pending).resolves.toBe(true);
  });

  it("Enter with no button focused accepts", async () => {
    render(<ConfirmDialog />);
    const pending = useAppStore.getState().confirm({ title: "Continue?" });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Enter", target: dialog });
    await expect(pending).resolves.toBe(true);
  });

  it("uses compact confirm chrome with equally weighted footer buttons", async () => {
    render(<ConfirmDialog />);
    const title = "Delete “clicking on workspace is buggy and laggy, it lag…”?";
    const pending = useAppStore.getState().confirm({ title, body: "It is removed from Muse Code. This cannot be undone.", confirmLabel: "Delete", danger: true });
    const dialog = await screen.findByRole("dialog");
    // Narrow confirm width, not the 560px preview chrome.
    expect(dialog).toHaveClass("confirm-dialog");
    expect(dialog).not.toHaveClass("preview-dialog");
    // The full title stays available on hover when the clamped heading truncates it.
    expect(screen.getByRole("heading", { name: title })).toHaveAttribute("title", title);
    const footer = dialog.querySelector("footer")!;
    expect(footer).toHaveClass("confirm-foot");
    const [cancel, confirm] = Array.from(footer.querySelectorAll("button"));
    expect(cancel).toHaveTextContent("Cancel");
    expect(confirm).toHaveTextContent("Delete");
    // Same size and weight: no 24px ghost next to a 30px bordered button.
    expect(cancel).toHaveClass("secondary");
    expect(cancel).not.toHaveClass("small");
    expect(confirm).toHaveClass("secondary", "danger");
    fireEvent.click(cancel);
    await expect(pending).resolves.toBe(false);
  });
});
