# Third-party notices

Muse Code Desktop redistributes third-party code. The license texts below are
summarized for attribution; the authoritative full texts ship with each
dependency (`node_modules/<pkg>/LICENSE`) and, for the Node runtime, at
<https://github.com/nodejs/node/blob/main/LICENSE>.

This product is not affiliated with or endorsed by Meta. "Muse Code" refers to
Meta's separately distributed CLI.

## Redistributed in the shipped application

| Component | Version | License | Notes |
|---|---|---|---|
| Node.js runtime | 26.8.2 | MIT (OpenJS Foundation) | Staged as the `muse-node` sidecar by `packages/muse-bridge/scripts/stage-sidecar.mjs`; only `bin/node` is extracted from the official archive |
| `@muse-code/sdk` | 1.3.0 | MIT — © Meta Platforms, Inc. and affiliates | Bundled into `muse-bridge/dist/index.js` |
| `react`, `react-dom` | 19.x | MIT — © Meta Platforms, Inc. and affiliates | Compiled into the webview bundle |
| `react-markdown` | 10.1.0 | MIT | Compiled into the webview bundle |
| `remark-gfm` | 4.0.1 | MIT | Compiled into the webview bundle |
| `zustand` | 5.x | MIT — © 2019 Paul Henschel | Compiled into the webview bundle |
| `lucide-react` | 0.544.0 | ISC — © Cole Bemis and contributors | Icons compiled into the webview bundle |
| `thinking-orbs` | 0.3.1 | MIT — © 2026 Jakub Antalik | Compiled into the webview bundle |
| `esbuild` | 0.25.12 | MIT — © 2020 Evan Wallace | Build tool only; not redistributed at runtime |

Agent identity marks (`apps/desktop/public/agents/*.svg` and the bundled
copies) are the trademarks of their respective owners and are used only to
identify interoperating third-party CLIs. No endorsement is implied.

## Development and website tooling only (not redistributed)

| Component | Version | License |
|---|---|---|
| `three` | 0.180.0 | MIT — © three.js authors (marketing site) |
| `playwright` | 1.63.0 | Apache-2.0 (screenshot capture) |
| `sharp` | 0.35.4 | Apache-2.0 (image optimization) |
| `vite`, `vitest`, `typescript`, `tailwindcss`, `jsdom`, `@testing-library/*`, `@tauri-apps/cli` | various | MIT / Apache-2.0 / BSD |

## Rust crates

The Tauri host links crates resolved through `Cargo.lock` (Tauri, tokio, serde,
keyring, objc2, and their transitive dependencies). All resolved crates are
licensed MIT, Apache-2.0, ISC, BSD, or Unicode-3.0; no copyleft license is in
the dependency set. Per-crate notices are available from
`cargo license --manifest-path apps/desktop/src-tauri/Cargo.toml` or from the
crate sources in the local cargo registry.

## Fonts and icons

No third-party fonts are bundled or remotely loaded. The UI uses system font
stacks (`SF`/`system-ui`). The app icon derives from the in-repo `spark.svg`.

## Repository license

MIT — see [LICENSE](LICENSE).
