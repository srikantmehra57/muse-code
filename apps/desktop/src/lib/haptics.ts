import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./format";

/** `tick`: a detent while scrubbing · `level`: a committed change · `thump`: a heavy hit. */
export type HapticKind = "tick" | "level" | "thump";

const NATIVE: Record<HapticKind, string> = { tick: "alignment", level: "level", thump: "generic" };
const VIBRATE: Record<HapticKind, number | number[]> = { tick: 6, level: 14, thump: [18, 30, 28] };
let last = 0;

/**
 * Trackpad haptics on macOS (Force Touch) through the shell; `navigator.vibrate`
 * elsewhere. Never throws — haptics are decoration.
 */
export function haptic(kind: HapticKind) {
  const now = performance.now();
  if (kind === "tick" && now - last < 28) return;
  last = now;
  if (isTauri()) {
    void invoke("haptic", { kind: NATIVE[kind] }).catch(() => {});
    return;
  }
  try { navigator.vibrate?.(VIBRATE[kind]); } catch { /* unsupported */ }
}

/** A rolling rumble: a heavy hit followed by decaying ticks. */
export function rumble() {
  haptic("thump");
  [70, 150, 240, 340].forEach((delay, index) => window.setTimeout(() => {
    last = 0;
    haptic(index < 2 ? "level" : "tick");
  }, delay));
}

export type RippleVariant = "peak" | "calm";
export type RippleOrigin = { x: number; y: number; variant?: RippleVariant };
export const RIPPLE_EVENT = "muse:effort-ripple";

/** Sends a warm peak or cool reset ripple across the window, with a matching rumble. */
export function effortRipple(origin: RippleOrigin) {
  window.dispatchEvent(new CustomEvent<RippleOrigin>(RIPPLE_EVENT, { detail: origin }));
  rumble();
}
