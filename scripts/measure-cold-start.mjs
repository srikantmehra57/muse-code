#!/usr/bin/env node
/**
 * Cold-start measurement for the protocol bridge.
 * Times a fresh Node process from spawn until the first `ping` reply.
 * Prints one JSON line: {"bridgeMs": number}
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const temporary = await mkdtemp(join(tmpdir(), "muse-cold-"));
const outfile = join(temporary, "bridge.mjs");
try {
  await build({
    entryPoints: [resolve("packages/muse-bridge/src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  const child = spawn(process.execPath, [outfile], { stdio: ["pipe", "pipe", "pipe"] });
  const started = performance.now();
  const reply = await new Promise((resolveReply, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`bridge ping timed out: ${buffer.slice(0, 200)}`)), 8000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((entry) => entry.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timer);
      resolveReply(line);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`bridge exited ${code} before ping: ${buffer.slice(0, 200)}`));
    });
    child.stdin.write(`${JSON.stringify({ id: "cold", method: "ping", params: {} })}\n`);
  });
  const bridgeMs = Math.round(performance.now() - started);
  const message = JSON.parse(reply);
  if (!message.ok || message.result?.pong !== true) {
    throw new Error(`unexpected ping reply: ${reply}`);
  }
  child.kill();
  console.log(JSON.stringify({ bridgeMs }));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
