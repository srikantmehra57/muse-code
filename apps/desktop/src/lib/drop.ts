/** Shared drag-and-drop attachment rules (pure — safe to unit test). */

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_DROP_FILES = 20;

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
};

/** Lowercase extension without the dot, or "" when there is none. */
export function extensionOf(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Image MIME type for a file path, or null for non-images/unknown. */
export function mediaTypeForPath(path: string): string | null {
  return IMAGE_MEDIA_TYPES[extensionOf(path)] ?? null;
}

export function isImagePath(path: string): boolean {
  return mediaTypeForPath(path) !== null;
}

/** A browser File is an image when its MIME type says so, or its name has an image extension. */
export function isImageFile(file: { type?: string; name: string }): boolean {
  if (typeof file.type === "string" && file.type.startsWith("image/")) return true;
  return isImagePath(file.name);
}

export function displayNameForPath(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").filter(Boolean).pop();
  return base || path;
}

/**
 * Reference path for a dropped file: workspace-relative when the drop lands
 * inside the workspace, otherwise the absolute path (Muse can still read it).
 */
export function refPathForDrop(rawPath: string, workspaceRoot?: string): string {
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const raw = rawPath.replace(/\\/g, "/");
    if (raw === root) return ".";
    if (raw.startsWith(`${root}/`)) return rawPath.slice(root.length + 1);
  }
  return rawPath;
}
