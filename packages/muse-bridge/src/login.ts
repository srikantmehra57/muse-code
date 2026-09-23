import { diagnostics, DiagnosticLines } from "./redaction.js";
import { spawn, type ChildProcess } from "node:child_process";
import { resolveMuseBin } from "./detect.js";
import { filterChildEnv, terminateTree } from "./isolation.js";

export type LoginPrompt = { url: string; code: string };
export type LoginEvent = (event: "loginDone" | "loginError", payload: Record<string, unknown>) => void;

/**
 * Parse the `muse login` device-code prompt. Real output is:
 *
 *   Open this page to sign in:
 *     https://auth.meta.com/oauth/device/?code=VSFM-XQQQ
 *   confirm this code matches:
 *     VSFM-XQQQ
 *
 * Returns null until both the URL and the code have been observed.
 */
export function parseLoginPrompt(output: string): LoginPrompt | null {
  const url = output.match(/https?:\/\/\S+/)?.[0] ?? null;
  const confirm = output.match(/confirm this code matches:\s*\n?\s*(\S+)/i)?.[1] ?? null;
  const code = confirm ?? output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0] ?? null;
  if (!url || !code) return null;
  return { url, code };
}

type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv },
) => ChildProcess;

/**
 * Runs one `muse login` device-code flow at a time. `start` resolves with the
 * URL + code as soon as the CLI prints them; approval (or failure) arrives
 * later through the event callback, since the user may take minutes.
 */
export class LoginFlow {
  private child: ChildProcess | null = null;

  private emit: LoginEvent;
  constructor(emit: LoginEvent = () => {}) {
    this.emit = (event, payload) => emit(event, diagnostics.value(payload) as Record<string, unknown>);
  }

  get running(): boolean {
    return this.child !== null;
  }

  async start(museBin: string | null, spawnFn: SpawnFn = spawn): Promise<LoginPrompt> {
    if (this.child) throw new Error("A sign-in is already in progress.");
    const bin = resolveMuseBin(museBin);
    if (!bin) throw new Error("Muse CLI was not found. Install it or set a custom binary path in Settings.");
    diagnostics.remember(process.env);
    const child = spawnFn(bin, ["login"], { stdio: ["ignore", "pipe", "pipe"], env: filterChildEnv(process.env, "muse") });
    this.child = child;
    // Parse stdout only: a stderr warning must never inject a decoy URL/code.
    let stdout = "";
    let tail = "";
    let settled = false;
    const appendDiagnostic = (line: string) => { tail = `${tail}\n${line}`.slice(-8192); };
    const stdoutDiagnostics = new DiagnosticLines(appendDiagnostic);
    const stderrDiagnostics = new DiagnosticLines(appendDiagnostic);
    const finish = (event: "loginDone" | "loginError", payload: Record<string, unknown>) => {
      // A cancelled flow already reported its outcome; ignore the late exit.
      if (this.child !== child) return;
      this.child = null;
      this.emit(event, payload);
    };
    child.on("error", (error) => {
      if (settled) finish("loginError", { error: String(error) });
    });
    child.on("close", (code) => {
      if (settled) {
        finish(code === 0 ? "loginDone" : "loginError", code === 0 ? {} : { error: `Sign-in exited (${code ?? "signal"}). Try again.` });
      }
    });
    try {
      const prompt = await new Promise<LoginPrompt>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Muse did not show a sign-in code in time. Try again.")), 30_000);
        timer.unref?.();
        const cleanup = () => clearTimeout(timer);
        child.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          stdoutDiagnostics.push(text);
          if (settled) return;
          if (stdout.length + text.length > 32768) {
            cleanup();
            reject(new Error("Sign-in output exceeded the diagnostic limit. Try again."));
            return;
          }
          stdout += text;
          const prompt = parseLoginPrompt(stdout);
          if (prompt) {
            cleanup();
            resolve(prompt);
          }
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderrDiagnostics.push(chunk.toString());
        });
        child.on("error", (error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
        child.on("close", (code) => {
          cleanup();
          if (this.child === child) this.child = null;
          stdoutDiagnostics.end();
          stderrDiagnostics.end();
          reject(new Error(tail.trim() ? tail.trim().split("\n").slice(-3).join("\n") : `Sign-in exited before showing a code (${code ?? "signal"}).`));
        });
      });
      settled = true;
      return prompt;
    } catch (error) {
      if (this.child === child) {
        this.child = null;
        void terminateTree(child);
      }
      throw new Error(diagnostics.text(error instanceof Error ? error.message : String(error)));
    }
  }

  cancel(): { cancelled: boolean } {
    if (!this.child) return { cancelled: false };
    const child = this.child;
    this.child = null;
    void terminateTree(child);
    this.emit("loginError", { error: "Sign-in was cancelled." });
    return { cancelled: true };
  }
}
