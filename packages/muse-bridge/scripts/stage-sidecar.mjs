#!/usr/bin/env node
/**
 * Stage the bridge sidecar runtime for Tauri `externalBin` distribution.
 *
 * Release builds spawn ONLY this bundled Node — never an ambient `node`
 * (SEC-02). The script downloads the official nodejs.org binary for the host
 * triple, verifies its SHA-256 against the published SHASUMS256.txt, and
 * stages it at `apps/desktop/src-tauri/binaries/` (gitignored; the release
 * pipeline stages one per target triple). The staged runtime is signed with
 * the app bundle, and the Rust side verifies its digest before every spawn.
 *
 * Single-executable (SEA) packaging was evaluated and rejected: its injector
 * (`postject`, abandoned 2023) cannot parse current Node Mach-O binaries.
 * Bundling the stock runtime keeps dev/prod behavior identical.
 *
 * Usage: npm run build:sidecar -w @muse/bridge
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const outDir = join(pkg, "..", "..", "apps", "desktop", "src-tauri", "binaries");

// Pinned for reproducible, dev/prod-identical releases. Bump deliberately.
const NODE_VERSION = "v26.8.2";

const TARGETS = {
  "darwin-arm64": { dist: "darwin-arm64.tar.gz", member: "bin/node", out: "muse-node-aarch64-apple-darwin" },
  "darwin-x64": { dist: "darwin-x64.tar.gz", member: "bin/node", out: "muse-node-x86_64-apple-darwin" },
  "linux-x64": { dist: "linux-x64.tar.gz", member: "bin/node", out: "muse-node-x86_64-unknown-linux-gnu" },
  "linux-arm64": { dist: "linux-arm64.tar.gz", member: "bin/node", out: "muse-node-aarch64-unknown-linux-gnu" },
  "win32-x64": { dist: "win-x64.zip", member: "node.exe", out: "muse-node-x86_64-pc-windows-msvc.exe" },
  "win32-arm64": { dist: "win-arm64.zip", member: "node.exe", out: "muse-node-aarch64-pc-windows-msvc.exe" },
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) throw new Error(`Unsupported sidecar target: ${key}`);

const base = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${target.dist}`;
const work = mkdtempSync(join(tmpdir(), "muse-sidecar-"));
mkdirSync(outDir, { recursive: true });

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const file = createWriteStream(dest);
  await response.body.pipeTo(new WritableStream({ write: (chunk) => file.write(chunk), close: () => file.end() }));
  await new Promise((resolve, reject) => {
    file.on("finish", resolve);
    file.on("error", reject);
  });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const archive = join(work, `node.${target.dist.endsWith(".zip") ? "zip" : "tar.gz"}`);
const sumsFile = join(work, "SHASUMS256.txt");
await download(base, archive);
await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sumsFile);

const fileName = base.split("/").pop();
const sums = Object.fromEntries(
  readFileSync(sumsFile, "utf8").trim().split("\n").map((line) => line.trim().split(/\s+/).reverse()),
);
if (!sums[fileName]) throw new Error(`No checksum published for ${fileName}`);
if (sha256(archive).toLowerCase() !== sums[fileName].toLowerCase()) {
  throw new Error(`Checksum mismatch for ${fileName}; refusing to stage.`);
}

// Extract only the runtime binary (bsdtar handles zip on Windows too).
execFileSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
const extracted = join(work, `node-${NODE_VERSION}-${target.dist.replace(/\.(tar\.gz|zip)$/, "")}`, target.member);

const binary = join(outDir, target.out);
copyFileSync(extracted, binary);
if (process.platform !== "win32") chmodSync(binary, 0o755);
rmSync(work, { recursive: true, force: true });
console.log(`sidecar: ${binary} (sha256 ${sha256(binary).slice(0, 16)}…)`);
