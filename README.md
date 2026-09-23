# Muse Code Desktop

[![CI](https://github.com/srikantmehra57/muse-code/actions/workflows/ci.yml/badge.svg)](https://github.com/srikantmehra57/muse-code/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/srikantmehra57/muse-code?include_prereleases)](https://github.com/srikantmehra57/muse-code/releases)
[![License](https://img.shields.io/github/license/srikantmehra57/muse-code)](LICENSE)

A native desktop command center for the Muse Code CLI. Muse Code Desktop brings sessions, approvals, reasoning controls, changed files, and agent activity into one focused interface while keeping the official Muse CLI as the execution engine.

> [!IMPORTANT]
> Muse Code Desktop is an independent open-source project and is not affiliated with Meta. It requires the official `muse` CLI and an active Muse Code subscription or API key.

## Highlights

- Organize workspaces, sessions, and archived threads from one sidebar.
- Follow streaming agent activity, plans, tool calls, approvals, and background work.
- Choose models, reasoning effort, and approval behavior from the composer.
- Attach files and images with the native picker or drag and drop.
- Review changed files and unified diffs without leaving the conversation.
- Use light and dark themes with seven accent palettes.
- Keep API keys in the operating system credential store.
- Run on the native operating system webview through Tauri 2.

## Download

Download the current macOS beta from the [v0.1.0 release](https://github.com/srikantmehra57/muse-code/releases/tag/v0.1.0).

The initial macOS build is for Apple silicon and is not notarized. On first launch, right-click **Muse Code** and choose **Open**. Windows packaging is supported by the project but a verified Windows installer is not included in this release.

## Prerequisites

- The official Muse Code CLI available as `muse`
- A Muse Code subscription or `META_API_KEY`
- Git for the changed-files review

Install Muse Code CLI:

```bash
# macOS / Linux
curl -fsSL https://dev.meta.ai/install.sh | sh

# Windows PowerShell
irm https://dev.meta.ai/install.ps1 | iex
```

Sign in from the CLI with `muse` and `/login`, or configure an API key in the desktop app under **Settings → Account**.

## Account and credential behavior

**Settings → Account** controls which credential the local Muse process uses:

- **Automatic** uses the signed-in subscription and falls back to the saved API key.
- **Muse Code subscription** uses CLI sign-in and removes `META_API_KEY` from the child process environment.
- **Muse API key** uses the key saved by the desktop app.

API keys are stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service. The renderer receives only a masked value. Account changes take effect after **Save & reconnect**.

## Architecture

```text
React UI → Tauri native shell → muse-bridge (@muse-code/sdk) → muse serve
```

The desktop shell uses the operating system webview rather than bundling Chromium. The bridge is packaged with its own verified Node.js runtime and communicates with the official Muse Session Protocol over standard input and output.

## Development

### Requirements

- Node.js 20 or newer
- Rust stable
- Git
- Muse Code CLI for live-session testing

Install dependencies and start the native application:

```bash
npm install
npm run dev
```

Run the desktop UI with mock data in a browser:

```bash
npm run dev:ui
```

Run the marketing website:

```bash
npm run dev:website
```

If npm skipped install scripts and the native esbuild binary is missing, run:

```bash
node node_modules/esbuild/install.js
```

## Verification

```bash
npm test
npm run test:ui
npm run typecheck -w @muse/bridge
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The CI matrix runs on macOS, Windows, and Linux. The macOS packaging job also verifies the bundled runtime, bridge digest, sidecar identity, and startup behavior without ambient Node.js.

## Build

```bash
npm run build
```

Build artifacts are written under `apps/desktop/src-tauri/target/release/bundle/`. The build may download a platform-specific Node.js runtime from `nodejs.org`; its SHA-256 digest is verified before staging. Windows builds additionally require `bash` and `tar`, available through Git Bash or WSL.

Release artifacts are currently unsigned and are not notarized. There is no automatic updater.

## Repository layout

```text
apps/desktop          Tauri 2 and React desktop application
apps/website          Product website
packages/muse-bridge  Muse Session Protocol bridge
scripts               Build and verification utilities
tests                 Cross-package regression tests
```

## Uninstall

Removing the application does not delete its local settings or logs.

| Data | macOS | Windows |
|---|---|---|
| Settings and workspace metadata | `~/Library/Application Support/com.musecode.desktop/muse-desktop.json` | `%APPDATA%\com.musecode.desktop\muse-desktop.json` |
| Application and security logs | `~/Library/Logs/com.musecode.desktop/` | `%LOCALAPPDATA%\com.musecode.desktop\` |
| Credentials | Keychain service `com.musecode.desktop` | Credential Manager |

Muse session history remains in the Muse CLI's own data directory.

## License

Muse Code Desktop is available under the [MIT License](LICENSE). Third-party attributions are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
