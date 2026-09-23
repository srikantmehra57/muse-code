# Muse Code Desktop — Design System

Implementation must follow this document. Tokens live in `apps/desktop/src/styles.css`.

---

## Product principles

1. **Protocol-honest.** Show what Muse is doing. Never invent chain-of-thought. Prefer host todos, goals, tool names, and exit codes.
2. **Quiet confidence.** Meta-adjacent: disciplined, technical, unflashy. No neon, no glass stacks, no dashboard widgets. Motion is reserved for live agent state: `thinking-orbs` (monochrome) for thinking/empty states and `border-beam` (ocean) on the composer while a run is active — both from libraries.dev.
3. **Desktop, not web.** System type, overlay titlebar, dense lists, real menus/palettes, no remote fonts.
4. **Density with hierarchy.** Developer sessions are long. Prefer 13px body, tight rows, collapsed tools. Hierarchy from contrast and spacing, not cards.
5. **One vocabulary.** Workspace, Thread, Agent, Run, Plan, Changes, Terminal.
6. **Every control is real.** Hidden > disabled > fake.

---

## Terminology

| Use | Do not use |
|---|---|
| Workspace | Project (UI may say “Open a workspace”; “Add project” is retired) |
| Thread | Chat, conversation, session (except protocol errors) |
| Agent / Run | Task, job (unless quoting a host field) |
| Plan | Todo list (internal only) |
| Changes | Review dock, git panel |
| Terminal | Shell card in the run (not a PTY) |
| Stop | Cancel turn (button label: Stop) |

Copy: short, present tense, no “successfully been executed.”

- Bad: “There are currently no previous conversations.”
- Good: “No threads yet”

Errors always answer: what happened, whether work was lost, what to do, whether we can recover.

---

## Color

Accent is **Meta blue**, not purple.

### Dark (default follows OS when theme is `system`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0B0B0C` | Window under |
| `--bg-elevated` | `#141416` | Main / inspector |
| `--bg-sidebar` | `#101012` | Sidebar |
| `--text` | `#E8E8E6` | Primary |
| `--text-secondary` | `#A8A8A4` | Secondary |
| `--text-muted` | `#6E6E6A` | Meta, timestamps |
| `--border` | `rgba(255,255,255,0.08)` | Subtle |
| `--border-strong` | `rgba(255,255,255,0.14)` | Composer, dialogs |
| `--accent` | `#0064E0` | Focus, selection, links |
| `--accent-text` | `#7EB3FF` | Link text on dark |
| `--success` | `#3D9A6A` | Running complete, additions |
| `--warning` | `#C5922A` | Pressure warning |
| `--destructive` | `#D94A4A` | Errors, deletions |
| `--hover` | `rgba(255,255,255,0.05)` | Rows |
| `--fog` | `rgba(255,255,255,0.035)` | Selected row |

### Light

| Token | Value |
|---|---|
| `--bg` | `#EDEDEB` |
| `--bg-elevated` | `#F7F7F5` |
| `--bg-sidebar` | `#F0F0EE` |
| `--text` | `#1A1A1C` |
| `--text-secondary` | `#5C5C58` |
| `--text-muted` | `#8A8A86` |
| `--border` | `rgba(20,20,22,0.08)` |
| `--border-strong` | `rgba(20,20,22,0.14)` |
| `--accent` | `#0064E0` |
| `--accent-text` | `#0052C2` |
| `--success` | `#217A4B` |
| `--warning` | `#9A6B10` |
| `--destructive` | `#C03939` |

Do not introduce a second accent. Skill/purple tokens are retired.

---

## Typography

```
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
--font-mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
```

No Google Fonts. No webfont download.

| Role | Size | Weight | Tracking |
|---|---|---|---|
| Display (empty titles) | 22px | 560 | -0.03em |
| Title (thread name) | 13px | 600 | -0.01em |
| Body | 13px | 400 | -0.01em |
| Compact | 12px | 400 | 0 |
| Caption | 11px | 500 | 0.02em |
| Mono | 12px | 400 | 0 |

---

## Spacing

Scale: 2, 4, 6, 8, 10, 12, 16, 20, 24, 32.

- Sidebar row padding: 6×8
- Conversation column: `min(720px, 100% - 40px)`
- Inspector width: 320–360
- Titlebar height: 44 (clears traffic lights)

---

## Radius

4, 6, 8, 10. **Not** 16–24 cards.

- Controls: 6
- Inputs / composer: 10
- Dialogs: 10
- Pills / chips: 999

---

## Borders and elevation

Hierarchy from background + 1px border. Shadows only on overlays (palette, dialog, jump chip):

`--shadow: 0 8px 28px rgba(0,0,0,0.28)` (dark) / `0 8px 24px rgba(16,16,18,0.10)` (light)

---

## Iconography

One set: `lucide-react`, 13–16px, 1.75–2 stroke, monochrome `currentColor`. No icon wells. Status uses a 6px dot: muted idle, accent unread, success running, destructive error.

---

## Motion

120–200ms, `ease`. Panel, collapse, insert, status.

Honor `prefers-reduced-motion: reduce` — no transitions, no pulse.

Do not animate decorative blobs.

---

## Component behavior

### Thread row

Shows title, relative time, status dot. Running is a success pulse (disabled if reduced motion). Unread is accent, never the same as running. Hover reveals pin. Context menu: Rename, Pin, Archive.

### Agent step / tool card

One line by default: icon, verb, path or command, status, duration. Expand for output/error. Routine completed reads/searches start collapsed. Failures start expanded.

### Plan

Checklist. `completed` check, `inProgress` filled current, `pending` empty, `cancelled` muted strike.

### Composer

Attached to the thread, not a floating island. Enter sends, Shift+Enter newline. Stop replaces send while running. Context chips are removable.

### Inspector

Appears when the user opens Changes or when the workspace is dirty *and* they have not dismissed it. Not a permanent third column on clean trees after first dismiss.

### Palette

Centered, 420px, search field + command rows with shortcut glyphs. Arrow keys + Enter. Esc closes.

### Dialogs

`<dialog>` with backdrop. Esc = cancel (discard drafts). Do not persist on backdrop without an explicit Done.

---

## State patterns

| State | Treatment |
|---|---|
| Empty | Title + one next action |
| Loading | Named status (“Opening thread…”) not a mystery spinner |
| Running | Timeline + plan + Stop |
| Waiting | Approval / question card, focus moved, `alertdialog` |
| Failed | Banner + retry/settings |
| Interrupted | Receipt on the run + Continue |
| Offline | Top banner, composer disabled |
| Preview | Badge on sidebar; no live host commands |

---

## Accessibility

- Visible 2px accent focus rings, 3px offset
- Icon-only buttons have `aria-label`
- Transcript `role="log"`; running status `aria-live="polite"`
- Contrast ≥ 4.5:1 for body (`--text-muted` is caption-only)
- Tab order: sidebar → thread → composer → inspector
- Skip link retained
- Minimum hit target 28px (32px preferred for primary)

---

## macOS

- Overlay titlebar, `hiddenTitle`, traffic lights at (16, 18)
- Drag regions on titlebar and sidebar top
- No custom window controls
- `⌘,` Settings, `⌘N` new thread, `⌘K` palette — do not steal `⌘Q` / `⌘W` / `⌘H` / `⌘M`
- Reduced transparency: we do not use vibrancy blur (keeps contrast predictable)

---

## Brand

Identity is the system, not a logo wall. Spark mark 16–18px beside “Muse”. Footer/About: **Not affiliated with Meta.** No Meta wordmark.
