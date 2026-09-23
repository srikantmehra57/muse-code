import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { isTauri } from "./format";
import { log } from "./logger";

/**
 * Notify only when the user plausibly missed the event: enabled in settings,
 * outside preview mode, and either the window is unfocused or the busy thread
 * is not the one on screen.
 */
export function shouldNotify(input: { enabled: boolean; focused: boolean; selected: boolean; preview: boolean }): boolean {
  return input.enabled && !input.preview && (!input.focused || !input.selected);
}

// The permission prompt is asked at most once per session; a failed ask clears
// the cache so a later event can retry.
let permissionRequest: Promise<boolean> | null = null;
function notificationsAllowed(): Promise<boolean> {
  permissionRequest ??= (async () => (await isPermissionGranted()) || (await requestPermission()) === "granted")()
    .catch((error: unknown) => {
      permissionRequest = null;
      throw error;
    });
  return permissionRequest;
}

/** OS notification for turn events. Never carries prompt text, output, or args. */
export async function notify(title: string, body: string): Promise<void> {
  if (!isTauri()) return;
  try {
    if (await notificationsAllowed()) sendNotification({ title, body });
  } catch (error) {
    log.warn("notification failed", { error: error instanceof Error ? error.message : String(error) });
  }
}
