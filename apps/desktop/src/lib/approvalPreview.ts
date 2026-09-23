/**
 * Best-effort preview of a write-class tool call for the approval card:
 * the before/after an edit applies, the unified diff a patch applies, or the
 * full content a write creates. Pure parsing only — anything unrecognised is
 * null and the card falls back to its argument summary.
 */
export type ApprovalPreview =
  | { kind: "replace"; path?: string; before: string; after: string }
  | { kind: "patch"; diff: string }
  | { kind: "write"; path?: string; content: string }
  | null;

const WRITE_TOOLS = new Set(["edit_file", "str_replace", "apply_patch", "write_file", "write", "edit"]);
const REPLACE_KEYS: Array<[string, string]> = [["old_string", "new_string"], ["oldText", "newText"], ["old", "new"], ["before", "after"]];
const PATCH_KEYS = ["patch", "diff"];
const CONTENT_KEYS = ["content", "text", "contents"];
const PATH_KEYS = ["path", "file", "filePath", "target"];

const firstString = (args: Record<string, unknown>, keys: string[]) =>
  keys.map((key) => args[key]).find((value): value is string => typeof value === "string");

export function approvalPreview(toolName: string, rawArgs?: string): ApprovalPreview {
  // MCP tool names arrive as `mcp__server__tool` (same strip as humanizeToolName).
  const tool = toolName.replace(/^mcp__[^_]+__/, "").toLowerCase();
  if (!WRITE_TOOLS.has(tool) || !rawArgs) return null;
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (!parsed || typeof parsed !== "object") return null;
    args = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const path = firstString(args, PATH_KEYS);
  for (const [beforeKey, afterKey] of REPLACE_KEYS) {
    const before = args[beforeKey];
    const after = args[afterKey];
    if (typeof before === "string" && typeof after === "string") return { kind: "replace", path, before, after };
  }
  const patch = firstString(args, PATCH_KEYS);
  if (patch) return { kind: "patch", diff: patch };
  const content = firstString(args, CONTENT_KEYS);
  if (content != null) return { kind: "write", path, content };
  return null;
}
