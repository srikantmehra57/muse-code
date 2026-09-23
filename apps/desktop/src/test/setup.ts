import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { vi } from "vitest";

// globals:false disables RTL's auto-cleanup — do it here instead.
afterEach(cleanup);

// Not a Tauri webview: isTauri() is false so bridge.ts uses its mock path.
delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;

window.requestAnimationFrame = ((cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 0)) as typeof window.requestAnimationFrame;
window.cancelAnimationFrame = ((id: number) => window.clearTimeout(id)) as typeof window.cancelAnimationFrame;

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
window.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver;
window.IntersectionObserver = ObserverStub as unknown as typeof IntersectionObserver;

Element.prototype.scrollIntoView = vi.fn();

// jsdom lacks <dialog> showModal/close — the tests only need the open flag.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});
