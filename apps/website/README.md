# Muse Code website

Marketing site for the Muse Code desktop app: a dark, glow-lit single page set in Array (display) and General Sans
(text) from Fontshare, with Geist Mono for code and one three.js particle system running behind the content. This workspace
does not modify the desktop application's UI or native build.

From the repository root:

```sh
npm install
npm run dev:website    # http://127.0.0.1:4174
npm run build:website  # emits apps/website/dist
```

## Sections

- **Hero**: "Muse Code Desktop", download/source actions and quick facts, over the particle spark.
  The nav carries the site's dark/light toggle (a colour sweep from the button).
- **Inside the app** (tour): a pinned, scroll-driven tour of a real screenshot (`public/shots/app-*.webp`).
  While it is pinned the nav's section links give way to the tour stops (Threads, Timeline,
  Composer, Changes), and a callout rides beside each spotlit, zoomed region.
- **Features**: a bento grid with cursor-lit borders.
- **Use your own agent**: the agent CLIs the app drives (Muse by default; OpenCode and Grok
  verified; Gemini CLI, Qwen Code and Goose experimental, per `packages/muse-bridge/src/agents.ts`)
  around a hub, plus subscription-or-own-key, ACP and mid-thread switching. Marks are copied from
  `apps/desktop/public/agents`.
- **Reasoning effort**: a working rebuild of the composer's effort scrubber. It drives the particle ring's
  turbulence and heat via `window.museScene.setEffort(t)`.
- **A sample run**: a scroll-scrubbed timeline rebuilt from the app's preview thread, with an interactive
  approval card (receipts only; nothing executes).
- **Themes**: a compact product preview. Its dark/light switch and seven accent swatches
  restyle only the screenshot; the site keeps its own theme and the Glacier Mist accent.
- **Get started**: the CLI install command per platform (copy button), downloads, a closing
  call to action.

## The scene

`src/scene.js` renders about 26k additive points (14k on narrow screens) on a fixed layer. Every
point stores a position for six forms: the Muse spark (the logo from `public/spark.svg`, in
volume), a wave floor, a galaxy, the effort ring, a run helix and a sphere. Each element with
`data-scene="shape x y scale opacity effortGain"` names its form and framing, and the shader
morphs between neighbours as you scroll, with per-particle stagger and a noise burst mid-morph.
Points repel from the cursor and take their colours from the current accent.

It pauses when the tab is hidden or via the bottom-right toggle, and renders only on scroll under
reduced motion. It halves density and resolution if the GPU sustains under 30 fps, and falls back
to a CSS glow when WebGL is unavailable. Scrolling uses Lenis, except under reduced motion.

Visual check (after `npm run preview -w @muse/website`):

```sh
GPU_ARGS="--use-angle=metal --enable-gpu" node apps/website/scripts/verify-site.mjs /tmp/muse-site-shots
```

## Screenshots

Product shots live in `public/shots/*.webp` (`@1x` halves alongside). They are regenerated
against the desktop app's preview mode (`npm run dev:ui` on http://localhost:1420):

```sh
node apps/website/scripts/capture.mjs    # PNGs into public/shots
node apps/website/scripts/optimize.mjs   # webp + @1x, removes the PNGs
```

The walkthrough and approval card are illustrative; nothing on the page executes commands or
connects to the Muse agent. Fonts load from Google Fonts with system fallbacks.
