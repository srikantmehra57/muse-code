// ACP agent that ignores cancel and parks a grandchild so tree-kill can be proved.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let pendingPrompt = null;
let grandchild = null;

if (process.env.MUSE_TEST_PID_FILE) {
  grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try { writeFileSync(process.env.MUSE_TEST_PID_FILE, String(grandchild.pid)); } catch { /* test observes absence */ }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method } = message;
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, sessionCapabilities: { list: {} } } } });
  if (method === "session/new") return send({ id, result: { sessionId: "s1", configOptions: [] } });
  if (method === "session/prompt") {
    pendingPrompt = id;
    return;
  }
  if (method === "session/cancel") return;
  if (id != null && method) send({ id, error: { code: -32601, message: `unsupported ${method}` } });
});

process.on("SIGTERM", () => {
  try { grandchild?.kill("SIGKILL"); } catch { /* already gone */ }
  process.exit(0);
});
