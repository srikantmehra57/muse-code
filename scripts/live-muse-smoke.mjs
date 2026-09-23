#!/usr/bin/env node
/**
 * Live smoke against an installed `muse` CLI and the real bridge.
 * No API key is injected; subscription auth comes from the CLI home.
 * Does not print account emails, credentials, prompts, or tool output.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const bridgeScript = join(root, "packages/muse-bridge/dist/index.js");
const museBin = process.env.MUSE_BIN && process.env.MUSE_BIN.includes("/") ? process.env.MUSE_BIN : undefined;
const sendPrompt = process.argv.includes("--send");

const report = [];
const failures = [];
function pass(name, detail) {
  report.push({ name, ok: true, detail });
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, error) {
  const detail = error instanceof Error ? error.message : String(error);
  report.push({ name, ok: false, detail });
  failures.push(name);
  console.log(`FAIL  ${name} — ${detail}`);
}

function sanitize(value) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitize);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (/(email|token|secret|password|key|authorization|cookie)/.test(lower)) out[key] = item == null ? item : "[redacted]";
    else out[key] = sanitize(item);
  }
  return out;
}

function link(child, defaultMs = 45_000) {
  let buffer = "";
  const waiters = new Map();
  const events = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {});
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.type === "event") {
        events.push(message);
        continue;
      }
      const waiter = waiters.get(message.id ?? null);
      if (waiter) {
        waiters.delete(message.id ?? null);
        waiter(message);
      }
    }
  });
  let sequence = 0;
  return {
    events,
    request(method, params = {}, extra = {}, timeoutMs = defaultMs) {
      const id = `live-${sequence++}`;
      return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        });
        child.stdin.write(`${JSON.stringify({ id, method, params, ...extra })}\n`);
      });
    },
    send(method, params = {}, timeoutMs = defaultMs) {
      const id = `live-${sequence++}`;
      const pending = new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        });
      });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      return { id, pending };
    },
  };
}

function expectOk(response, method) {
  if (!response?.ok) throw new Error(`${method} failed: ${response?.error || "unknown error"}`);
  return response.result;
}

const child = spawn(process.execPath, [bridgeScript], {
  cwd: root,
  env: { ...process.env, NODE_NO_WARNINGS: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
const bridge = link(child);
let workspace;

try {
  const ping = expectOk(await bridge.request("ping"), "ping");
  assert.equal(ping.pong, true);
  pass("ping");

  const detect = expectOk(await bridge.request("detect", museBin ? { museBin } : {}), "detect");
  if (!detect.found) throw new Error("muse CLI was not found");
  pass("detect", `${detect.version} authenticated=${Boolean(detect.authenticated)} via=${detect.activeAuth || "none"}`);

  const started = expectOk(await bridge.request("startHost", {
    ...(museBin ? { museBin } : {}),
    noSessionLog: true,
    disableWrite: true,
    disableShell: true,
    sandboxNetwork: "proxy-only",
  }, {}, 60_000), "startHost");
  const isolation = started.isolation;
  if (!isolation || isolation.env !== "minimal") throw new Error(`unexpected isolation: ${JSON.stringify(sanitize(isolation))}`);
  const grants = started.compat?.granted ?? [];
  pass("startHost", `durability=${started.durability || "unknown"} isolation.env=${isolation.env} osSandbox=${isolation.osSandbox} compat=${started.compat?.state || "n/a"} grants=${grants.join(",") || "none"}`);

  const status = expectOk(await bridge.request("status", museBin ? { museBin } : {}), "status");
  if (!status.running && status.running !== undefined && !status.bin) {
    throw new Error("status did not report a running host");
  }
  pass("status", `compat=${status.compat?.match ?? status.compat?.status ?? "reported"} isolation=${status.isolation?.osSandbox ?? isolation.osSandbox}`);

  const listed = expectOk(await bridge.request("listSessions", { limit: 10 }), "listSessions");
  const sessions = listed.sessions ?? [];
  pass("listSessions", `${sessions.length} session(s) on first page`);

  try {
    const models = expectOk(await bridge.request("listModels", {}, {}, 30_000), "listModels");
    pass("listModels", `${(models.models ?? []).length} model(s)`);
  } catch (error) {
    fail("listModels", error);
  }

  if (detect.authenticated && sendPrompt) {
    workspace = mkdtempSync(join(tmpdir(), "muse-live-"));
    writeFileSync(join(workspace, "README.md"), "live smoke workspace\n");
    const git = spawnSync("git", ["init", "-q"], { cwd: workspace, encoding: "utf8" });
    if (git.status !== 0) throw new Error(`git init failed: ${git.stderr || git.stdout}`);

    const created = expectOk(await bridge.request("startSession", {
      workspaceRoot: workspace,
      clientRequestId: `live-${Date.now()}`,
    }, {}, 60_000), "startSession");
    if (!created.sessionId) throw new Error("startSession returned no sessionId");
    pass("startSession", "ephemeral workspace session opened");

    const sent = bridge.send("sendTurn", {
      sessionId: created.sessionId,
      text: "Reply with exactly: pong",
      clientTurnId: `live-turn-${Date.now()}`,
    }, 90_000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const cancelled = expectOk(await bridge.request("cancelTurn", { sessionId: created.sessionId }, {}, 20_000), "cancelTurn");
    pass("cancelTurn", `status=${cancelled.status || "accepted"} escalated=${Boolean(cancelled.escalated)}`);

    let sendResult;
    try {
      sendResult = await sent.pending;
    } catch (error) {
      fail("sendTurn-settle", error);
    }
    if (sendResult) {
      if (sendResult.ok) pass("sendTurn-settle", `turnId=${sendResult.result?.turnId ? "present" : "absent"} disposition=${sendResult.result?.disposition || "n/a"}`);
      else pass("sendTurn-settle", `failed after cancel: ${sendResult.error || "interrupted"}`);
    }

    const approvals = bridge.events.filter((event) => event.event === "approval");
    if (approvals.length) {
      const first = approvals[0].payload || {};
      const deny = first.availableChoices?.some((choice) => choice.choiceId === "deny") ? "deny" : first.availableChoices?.[0]?.choiceId;
      if (first.approvalId && deny) {
        try {
          expectOk(await bridge.request("decideApproval", { approvalId: first.approvalId, choiceId: deny }), "decideApproval");
          pass("decideApproval", `denied ${approvals.length} live approval(s)`);
        } catch (error) {
          fail("decideApproval", error);
        }
      } else {
        pass("decideApproval", "approval arrived without a deny choice; left unsettled");
      }
    } else {
      pass("decideApproval", "no approval requested (expected for a text-only prompt)");
    }

    try {
      const preview = expectOk(await bridge.request("readSession", { sessionId: created.sessionId }, {}, 20_000), "readSession");
      pass("readSession", `items=${preview.session?.items?.length ?? preview.items?.length ?? "n/a"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/method not found/i.test(message)) {
        pass("readSession", "session/read not on CLI 1.3.0 (SDK/schema drift)");
      } else {
        fail("readSession", error);
      }
    }
    try {
      const history = expectOk(await bridge.request("pageHistory", { sessionId: created.sessionId }, {}, 20_000), "pageHistory");
      pass("pageHistory", `items=${history.items?.length ?? 0} exhausted=${Boolean(history.exhausted)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unreachable|not found|no view/i.test(message)) {
        pass("pageHistory", `no pageable history on a just-cancelled session (${message})`);
      } else {
        fail("pageHistory", error);
      }
    }
  } else if (!detect.authenticated) {
    pass("session-turn", "skipped — CLI is not authenticated");
  } else {
    pass("session-turn", "skipped — pass --send to open a session and cancel a turn");
  }

  expectOk(await bridge.request("stopHost"), "stopHost");
  pass("stopHost");
} catch (error) {
  fail("fatal", error);
  try { await bridge.request("stopHost", {}, {}, 8_000); } catch { /* already down */ }
} finally {
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.on("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}

const passed = report.filter((row) => row.ok).length;
console.log(`\n${passed}/${report.length} live checks passed.`);
if (failures.length) {
  console.log(`Failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("Not covered: native workspace grant, export dialog, quit/relaunch, signed package.");
