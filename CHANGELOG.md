# Changelog

All notable changes to Muse Code Desktop are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

See `THIRD_PARTY_NOTICES.md` for redistributed components and `README.md` for
licence terms.

## [Unreleased]

### Added

- Atomic settings persistence: `muse-desktop.json` is written via a temp file and
  rename with the previous good copy kept as `.bak`, so a crash mid-save can no
  longer truncate it and destroy every draft and thread title.
- Corruption recovery on launch: an unreadable settings file is quarantined as
  `muse-desktop.json.corrupt` instead of being silently overwritten, and the
  newest complete backup is restored.
- A visible banner when local persistence fails, so drafts are never described as
  saved when they are not.
- `THIRD_PARTY_NOTICES.md` and `RELEASING.md`.
- `npm run verify` runs the full documented gate set, and `npm run check:versions`
  fails the build when the six version-carrying manifests disagree.

### Fixed

- Tab no longer traps keyboard focus in the composer (WCAG 2.1.2): indentation
  now claims Tab only when text is selected or a completion is pending.
- The danger-confirm dialog treats Enter on a focused Cancel as cancel, so the
  safe default can no longer be defeated by keyboard.
- `skills install` and `plugins install` pass paths after `--`, so a folder name
  beginning with `-` cannot be read as a flag.
- A stale `git` snapshot can no longer resurrect pre-mutation state, `forkThread`
  can no longer create two sessions from one double-click, and a failed
  superseding send rolls the optimistic message back instead of leaving an
  unsent message in the transcript.
- The development PATH no longer includes `~/.hermes/node/bin`.
- Log detail sanitisation strips control characters and is size-capped, so an
  agent name cannot forge extra log columns.

### Security

- Skill and plugin installation is gated behind a one-time native picker
  authorisation instead of trusting any renderer-nominated path.
- Playwright raised to 1.63.1 (GHSA-7mvr-c777-76hp is dev-only but is now gone
  from the tree).

## [0.1.0] — unreleased

Initial internal build. No public release has been made; signing, notarisation
and the update feed are not yet in place (see `RELEASING.md`).
