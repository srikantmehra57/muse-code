// Captures real screenshots of the desktop app (apps/desktop dev:ui preview
// mode) for use on the marketing site. Requires `npm run dev:ui` at repo root.
//
//   node apps/website/scripts/capture.mjs [--base http://localhost:1420] [--only app,components,window]
//
// Output: apps/website/public/shots/

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "public", "shots");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:1420");
const ONLY = (arg("only", "app,components,window")).split(",");
const URL = `${BASE}/?usage=preview`;

const THEMES = ["dark", "light"];
const ACCENTS = ["blue", "violet", "pink", "orange", "yellow", "green", "teal"];
const PAD = 16;

// Skip animations entirely (paused ones freeze mount animations at opacity:0).
const FREEZE_CSS =
  "*{animation:none!important;transition:none!important;caret-color:transparent!important}";
// Preview-mode-only chrome that should not appear in product shots.
const PREVIEW_HIDE_CSS = [
  ".sidebar-nav .nav-row:nth-child(2)", // "Exit preview" row
  ".regrant-btn", // "Re-open" pill beside the workspace
  ".account-status", // "Preview · demo data" footer line
  ".jump-latest", // scroll affordance left over from the scripted scroll-to-top
]
  .map((sel) => `${sel}{display:none!important}`)
  .join("");

const results = [];
async function snap(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, ...options });
  results.push(name);
  console.log(`  ✓ ${name}`);
}

/** Union of the bounding boxes of every locator + PAD, clamped to the viewport. */
async function cropShot(page, name, locators, pad = PAD) {
  let box = null;
  for (const locator of locators) {
    const b = await locator.boundingBox();
    if (!b) throw new Error(`no bounding box for ${name}`);
    const r = b.x + b.width;
    const bot = b.y + b.height;
    box = box
      ? {
          x: Math.min(box.x, b.x),
          y: Math.min(box.y, b.y),
          r: Math.max(box.r, r),
          b: Math.max(box.b, bot),
        }
      : { x: b.x, y: b.y, r, b: bot };
  }
  const vp = page.viewportSize();
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: Math.min(vp.width, box.r + pad) - Math.max(0, box.x - pad),
    height: Math.min(vp.height, box.b + pad) - Math.max(0, box.y - pad),
  };
  await snap(page, name, { clip });
}

async function newPage(browser, { theme, width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme === "light" ? "light" : "dark",
  });
  const page = await context.newPage();
  await page.goto(URL, { waitUntil: "networkidle" });
  // Preview mode populates after hydration; wait for the dressed UI.
  await page.waitForSelector(".sidebar .thread", { timeout: 15000 });
  await page.waitForSelector(".conversation-inner .item, .conversation-inner > *", {
    timeout: 15000,
  });
  await page.waitForSelector(".composer .picker-trigger", { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.addStyleTag({ content: FREEZE_CSS + PREVIEW_HIDE_CSS });
  return { context, page };
}

/** Point the CSS theme/accent datasets at the requested look (no store write). */
async function setLook(page, theme, accent = "blue") {
  await page.evaluate(
    ([t, a]) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.accent = a;
      document.documentElement.dataset.sidebarAccent = "false";
    },
    [theme, accent],
  );
  await page.waitForTimeout(250);
}

/** The topbar PanelRight button toggles the review dock (⌘I). */
async function setDock(page, open) {
  const visible = await page.locator("aside.dock").isVisible().catch(() => false);
  if (visible !== open) {
    await page.locator('.icon-btn[aria-label="Toggle changes"]').click();
    await page.waitForTimeout(350);
  }
  if (open) {
    const tab = page.locator('aside.dock [role="tab"]:has-text("Changes")');
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await page.waitForTimeout(250);
  }
}

/** Transcript to the top, run groups expanded so tool cards are visible. */
async function scrollTop(page) {
  for (const head of await page.locator(".group-head").all()) {
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  }
  await page
    .locator(".conversation")
    .evaluate((el) => {
      el.scrollTop = 0;
    })
    .catch(() => {});
  await page.waitForTimeout(300);
}

/** Click the sidebar thread row by its title. */
async function selectThread(page, title) {
  await page.locator(`.sidebar .thread:has-text("${title}")`).first().click();
  await page.waitForTimeout(500);
}

async function shootApp(browser, theme, accent) {
  const { context, page } = await newPage(browser, { theme });
  await setLook(page, theme, accent);
  await scrollTop(page);
  await setDock(page, true); // three-pane look: sidebar · transcript · changes
  await snap(page, `app-${theme}-${accent}.png`);
  await context.close();
}

async function shootWindow(browser, theme) {
  const { context, page } = await newPage(browser, { theme, width: 1280, height: 800 });
  await setLook(page, theme, "blue");
  await scrollTop(page);
  await setDock(page, true);
  await snap(page, `window-${theme}-blue.png`);
  await context.close();
}

async function shootComponents(browser, theme) {
  const { context, page } = await newPage(browser, { theme });
  await setLook(page, theme, "blue");
  await setDock(page, false);
  const composer = page.locator(".composer-beam");

  // Effort popover, default tier (High).
  await page.locator(".effort-picker .picker-trigger").click();
  await page.waitForSelector(".effort-pop .scrubber", { timeout: 5000 });
  await page.waitForTimeout(250);
  await cropShot(page, `effort-open-${theme}.png`, [composer, page.locator(".effort-pop")]);

  if (theme === "dark") {
    // Scrub to the last tier so the peak/flame state shows.
    await page.locator(".scrubber-labels button").last().click();
    // The peak ripple self-removes after ~1.4s; wait it out so the shot is clean.
    await page
      .waitForFunction(
        () =>
          !document.querySelector(".effort-ripple") &&
          !document.querySelector(".app")?.classList.contains("thump"),
        { timeout: 5000 },
      )
      .catch(() => {});
    await page.waitForTimeout(400);
    await cropShot(page, "effort-max-dark.png", [composer, page.locator(".effort-pop")]);
    // Scrub back to High so the remaining shots on this page match the light set.
    const labels = page.locator(".scrubber-labels button");
    await labels.nth(4).click(); // tiers: none minimal low medium high xhigh max
    await page.waitForTimeout(400);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Model picker popover.
  await page.locator('.picker-trigger[aria-label="Model"]').click();
  await page.waitForSelector(".model-pop", { timeout: 5000 });
  await page.waitForTimeout(250);
  await cropShot(page, `model-open-${theme}.png`, [composer, page.locator(".model-pop")]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Idle composer — drop focus first so no trigger shows a focus ring.
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(150);
  await cropShot(page, `composer-${theme}.png`, [composer]);

  if (theme === "dark") {
    await cropShot(page, "sidebar-dark.png", [page.locator("aside.sidebar")], 0);
  }

  // Approval card on the running mock thread.
  await selectThread(page, "Wire muse serve");
  const approval = page.locator("section.approval");
  if (await approval.isVisible().catch(() => false)) {
    await cropShot(page, `approval-${theme}.png`, [approval]);
  } else {
    console.log(`  ! approval card not visible for ${theme} — skipped`);
  }
  await selectThread(page, "Command center layout");

  // Settings modal on the Appearance tab.
  await page.keyboard.press("Control+,");
  await page.waitForSelector("dialog.settings-dialog", { timeout: 5000 });
  await page.locator('dialog.settings-dialog button[aria-label="Theme"]').click();
  await page.waitForSelector(".theme-panel", { timeout: 5000 });
  await page.waitForTimeout(250);
  await cropShot(page, `settings-theme-${theme}.png`, [
    page.locator("dialog.settings-dialog"),
  ]);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  await context.close();
}

// channel "chromium" uses the full Chromium build; headless shell is optional then.
const browser = await chromium.launch({ channel: "chromium" });
await mkdir(OUT, { recursive: true });
try {
  if (ONLY.includes("app")) {
    for (const theme of THEMES) {
      for (const accent of ACCENTS) {
        await shootApp(browser, theme, accent);
      }
    }
  }
  if (ONLY.includes("components")) {
    for (const theme of THEMES) await shootComponents(browser, theme);
  }
  if (ONLY.includes("window")) {
    for (const theme of THEMES) await shootWindow(browser, theme);
  }
} finally {
  await browser.close();
}
console.log(`\n${results.length} screenshots written to ${OUT}`);
