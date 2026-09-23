// Minimal ACP agent for tests: one session, one scripted turn with a permission request.
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
let pendingPrompt = null;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params } = message;
  if (method === "initialize") return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, sessionCapabilities: { list: {} } } } });
  if (method === "session/list") return send({ id, result: { sessions: [{ sessionId: "s-old", cwd: params.cwd, title: "Earlier work", updatedAt: "2026-09-19T00:00:00Z" }] } });
  if (method === "session/new") return send({ id, result: { sessionId: "s1", configOptions: [
    { id: "model", category: "model", type: "select", currentValue: "zen/a", options: [{ value: "zen/a", name: "Zen/Model A" }, { value: "zen/b", name: "Zen/Model B" }] },
    { id: "effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low" }, { value: "high" }, { value: "max" }, { value: "default" }] },
    { id: "mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] },
  ] } });
  if (method === "session/set_config_option") return send({ id, result: { configOptions: [{ id: "model", category: "model", currentValue: params.configId === "model" ? params.value : "zen/a", options: [{ value: "zen/a" }, { value: "zen/b" }] }, { id: "effort", category: "thought_level", currentValue: params.configId === "effort" ? params.value : "high", options: [{ value: "low" }, { value: "high" }, { value: "max" }] }] } });
  if (method === "session/prompt") {
    pendingPrompt = id;
    update("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking " } });
    update("s1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hard." } });
    update("s1", { sessionUpdate: "plan", entries: [{ content: "Run ls", status: "in_progress", priority: "medium" }] });
    update("s1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Execute `ls`", kind: "execute", status: "pending", rawInput: { command: "ls" } });
    return send({ id: 900, method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "t1", title: "Execute `ls`", kind: "execute", rawInput: { command: "ls" } }, options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] } });
  }
  if (id === 900 && message.result) {
    const allowed = message.result.outcome?.optionId === "yes";
    update("s1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "a.txt\n" : "denied" } }], rawOutput: { exit_code: allowed ? 0 : 1 } });
    update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done, " } });
    update("s1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "found a.txt." } });
    update("s1", { sessionUpdate: "session_info_update", title: "List files" });
    return send({ id: pendingPrompt, result: { stopReason: "end_turn" } });
  }
  if (method === "session/cancel") {
    if (pendingPrompt != null) {
      send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
      pendingPrompt = null;
    }
    return;
  }
  if (id != null && method) send({ id, error: { code: -32601, message: `unsupported ${method}` } });
});
