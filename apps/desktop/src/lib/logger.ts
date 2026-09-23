import { diagnostics, DIAGNOSTIC_LIMIT } from "../../../../packages/muse-bridge/src/redaction";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./format";

function write(level: "debug" | "info" | "warn" | "error", event: string, extra?: Record<string, unknown>) {
  event = diagnostics.text(event);
  const serialized = extra ? JSON.stringify(diagnostics.value(extra)) : "";
  const detail = serialized.length > DIAGNOSTIC_LIMIT ? "[diagnostic omitted: size limit]" : serialized;
  const line = detail ? `${event} ${detail}` : event;
  if (level === "error") console.error(`[muse] ${line}`);
  else if (level === "warn") console.warn(`[muse] ${line}`);
  else if (import.meta.env?.DEV) console.info(`[muse:${level}] ${line}`);
  if (isTauri()) void invoke("append_app_log", { level, event, detail }).catch(() => {});
}

export const log = {
  debug: (event: string, extra?: Record<string, unknown>) => write("debug", event, extra),
  info: (event: string, extra?: Record<string, unknown>) => write("info", event, extra),
  warn: (event: string, extra?: Record<string, unknown>) => write("warn", event, extra),
  error: (event: string, extra?: Record<string, unknown>) => write("error", event, extra),
};
