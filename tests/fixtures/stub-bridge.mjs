#!/usr/bin/env node
/**
 * Deterministic bridge stub for the native-shell e2e test. Speaks the bridge
 * line protocol over stdio — one JSON response per request line — and pushes
 * an `approval` event after a successful startSession so the native snoop can
 * bind it. `startSession` fails if the native side did not inject the grant's
 * canonical `workspaceRoot`, which is itself an assertion of the grant flow.
 */

let buffer = "";

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}
function fail(id, error) {
  process.stdout.write(`${JSON.stringify({ id, ok: false, error })}\n`);
}
function emit(event, payload) {
  process.stdout.write(`${JSON.stringify({ type: "event", event, payload })}\n`);
}

function handle(request) {
  const { id, method } = request;
  const params = request.params ?? {};
  switch (method) {
    case "ping":
      return respond(id, { pong: true });
    case "startHost":
      return respond(id, { host: "stub", durability: "ephemeral" });
    case "stopHost":
      return respond(id, { stopped: true });
    case "startSession": {
      if (typeof params.workspaceRoot !== "string" || !params.workspaceRoot) {
        return fail(id, "stub: native side did not inject workspaceRoot");
      }
      respond(id, { sessionId: "s-1", workspaceRoot: params.workspaceRoot });
      emit("approval", {
        approvalId: "a-1",
        sessionId: "s-1",
        subject: "stub approval",
        availableChoices: [{ choiceId: "allow" }, { choiceId: "deny" }],
      });
      return;
    }
    case "listSessions":
      return respond(id, { sessions: [{ sessionId: "s-listed" }] });
    case "sendTurn":
      return respond(id, { turnId: "t-1", sessionId: params.sessionId, text: params.text });
    case "cancelTurn":
      return respond(id, { status: "accepted", sessionId: params.sessionId });
    case "decideApproval":
      return respond(id, { decided: params.choiceId, approvalId: params.approvalId });
    default:
      return fail(id, `stub: unknown method ${method}`);
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Malformed frames are dropped; the e2e only sends well-formed ones.
      }
    }
  }
});
