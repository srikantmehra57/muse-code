# Releasing Muse Code Desktop

This runbook exists because releasing requires six coordinated version bumps, a
signing identity that is not in this repository, and a rollback story. Nothing
here is optional for a public build.

## 0. Preconditions (currently unmet — this is why there is no public release)

| Requirement | Status | What it needs |
|---|---|---|
| Apple Developer ID Application certificate | ❌ missing | An Apple Developer Program membership. `REL-001` |
| Notarisation credentials | ❌ missing | An App Store Connect API key or app-specific password for `notarytool` |
| Windows code-signing certificate | ❌ missing | An Authenticode cert (EV preferred, to avoid SmartScreen) |
| Update feed + signing key | ❌ missing | `tauri-plugin-updater` needs a `pubkey`, a JSON feed, and signed artifacts. `REL-002` |

Until the first two rows are satisfied, Gatekeeper blocks first launch on any
other Mac. Do **not** describe a build as production-ready while they are empty.

### Adding signing and notarisation

Tauri reads these from the environment; keep them in CI secrets, never in the
repo:

```bash
export APPLE_CERTIFICATE           # base64 .p12 of "Developer ID Application: …"
export APPLE_CERTIFICATE_PASSWORD
export APPLE_SIGNING_IDENTITY="Developer ID Application: …"
export APPLE_ID / APPLE_PASSWORD / APPLE_TEAM_ID   # notarisation
```

Then `tauri.conf.json` → `bundle.macOS.signingIdentity` and
`notarize` must be enabled. `npm run build` produces a signed, notarised `.dmg`.

### Adding the auto-updater

1. `cargo add tauri-plugin-updater tauri-plugin-process` in `apps/desktop/src-tauri`,
   and the matching `@tauri-apps/plugin-updater` for the renderer.
2. Generate a keypair with `tauri signer generate`, publish the **public** key as
   `plugins.updater.pubkey`, and keep the private key as a CI secret.
3. Host `latest.json` over HTTPS with per-platform URLs and `signatures`.
4. Publish only signed artifacts. Never ship an updater that cannot verify its
   own payload.

An updater is not a substitute for signing: without `REL-001` there is no
signature for the updater to chain to.

## 1. Version bump

Six manifests carry the version and must move together. The gate enforces this:

```bash
npm run check:versions    # fails on any drift (REL-015)
```

Bump all of: `package.json`, `apps/desktop/package.json`, `apps/website/package.json`,
`packages/muse-bridge/package.json`, `apps/desktop/src-tauri/Cargo.toml`,
`apps/desktop/src-tauri/tauri.conf.json`.

## 2. Changelog

Move `[Unreleased]` entries in `CHANGELOG.md` into a new version heading with a
date. Anything user-visible must be listed.

## 3. Gates

```bash
npm run verify            # versions, typecheck, node + DOM tests, a11y,
                          # contrast, audit, web build, native tests
```

Run the gates **serially**. `node --test` and `cargo test` each saturate the
machine; run concurrently they starve each other's timers and produce spurious
failures (observed: a bridge test sat 925 s behind a nominal 5 s deadline).

Also run the live host probe when a `muse` CLI is available:

```bash
node scripts/live-muse-smoke.mjs
```

## 4. Package

```bash
npm run build
```

| Host | Artifact | Verified by |
|---|---|---|
| macOS | `.app` / `.dmg` | `node scripts/verify-macos-package.mjs` (CI runs this) |
| Windows | NSIS / MSI | manual until a Windows agent is wired up |

## 5. Pre-flight manual check

These cannot be automated in CI and must be signed off by a person:

- [ ] Folder picker and save dialog actually appear and return a grant.
- [ ] First-launch Gatekeeper prompt behaves as documented.
- [ ] Update feed installs a newer build and refuses an unsigned one.
- [ ] Cold start from Finder / Explorer is within the 5 s budget.
- [ ] Uninstall instructions in `README.md` were followed and no data is left
      behind unexpectedly (`REL-004` documents the residue).

## 6. Publish and roll back

Rollback is **restore the previous artifact**, because there is no downgrade path
in the updater (`REL-003`):

1. Pull the previous release artifact from the store/archive.
2. Replace the feed entry so `latest.json` points at it, and revoke the bad
   build's signature so it cannot be reinstalled.
3. Users on the bad build must be told to reinstall manually — the updater only
   moves forward.
4. Post the incident in `CHANGELOG.md` under the offending version.

Because rollback is manual and destructive to user state, prefer shipping behind
a staged rollout once the updater exists.

## 7. Uninstall and residue

Removing the app does not remove its data (settings, workspace list, thread
titles, pins, drafts, logs, cached CLI metadata). The exact paths and the
one-shot removal commands are in `README.md` → *Uninstall*. Ship those
instructions with every release until an in-app "Remove local data" exists.
