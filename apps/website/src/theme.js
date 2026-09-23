// Two separate looks:
//  • the site's own dark/light theme — toggled from the nav, persisted, broadcast as "muse:theme"
//    (the site keeps the default Glacier Mist accent);
//  • the product preview in the themes section — its own dark/light + seven accents, which only
//    restyle the screenshot.

export const ACCENTS = [
  { id: "blue", label: "Glacier Mist", hex: "#9DBCF4" },
  { id: "violet", label: "Lavender Fog", hex: "#C5B0E8" },
  { id: "pink", label: "Rosewater", hex: "#E9B3C8" },
  { id: "orange", label: "Peach Sorbet", hex: "#F0B78F" },
  { id: "yellow", label: "Buttercream", hex: "#E9D48F" },
  { id: "green", label: "Sage Leaf", hex: "#A8CEB0" },
  { id: "teal", label: "Sea Glass", hex: "#96CECA" },
];

const KEY = "muse-site-theme";
const SITE_ACCENT = "blue";

export function currentLook() {
  return { theme: document.documentElement.dataset.theme === "light" ? "light" : "dark", accent: SITE_ACCENT };
}

export function applyTheme({ theme }) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = SITE_ACCENT;
  try {
    localStorage.setItem(KEY, JSON.stringify({ theme }));
  } catch {}
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "light" ? "#F4F4F1" : "#060608");
  window.dispatchEvent(new CustomEvent("muse:theme", { detail: { theme, accent: SITE_ACCENT } }));
}

/* nav toggle — one solid layer in the next theme's colour grows from the button, the theme flips
   underneath it with transitions suspended, then the layer fades out */
function initSiteToggle() {
  const button = document.getElementById("theme-toggle");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const root = document.documentElement;
  const veil = document.createElement("div");
  veil.className = "theme-veil";
  veil.setAttribute("aria-hidden", "true");
  document.body.append(veil);
  let busy = false;

  const label = () =>
    button.setAttribute("aria-label", currentLook().theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  const flip = (theme) => {
    root.classList.add("theme-snap");
    applyTheme({ theme });
    label();
    void root.offsetWidth;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-snap")));
  };

  label();
  button.addEventListener("click", async () => {
    if (busy) return;
    const next = currentLook().theme === "dark" ? "light" : "dark";
    if (reduced.matches || !veil.animate) return flip(next);
    busy = true;
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    veil.style.background = next === "light" ? "#F4F4F1" : "#060608";
    veil.style.opacity = "1";
    veil.classList.add("on");
    try {
      await veil.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 520, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" },
      ).finished;
      flip(next);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await veil.animate({ opacity: [1, 0] }, { duration: 320, easing: "ease-out", fill: "forwards" }).finished;
    } finally {
      veil.getAnimations().forEach((a) => a.cancel());
      veil.classList.remove("on");
      busy = false;
    }
  });
  window.addEventListener("muse:theme", label);
}

/* product preview */
function initPreview() {
  const seg = document.getElementById("theme-seg");
  const swatchesEl = document.getElementById("swatches");
  const nameEl = document.getElementById("accent-name");
  const monitor = document.getElementById("monitor");
  const imgA = document.getElementById("theme-a");
  const imgB = document.getElementById("theme-b");
  const frame = imgA.parentElement;

  const look = { theme: currentLook().theme, accent: "blue" };
  let themeTouched = false;

  const swatchButtons = ACCENTS.map((accent) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.setAttribute("role", "radio");
    button.style.setProperty("--c", accent.hex);
    button.title = accent.label;
    button.setAttribute("aria-label", accent.label);
    button.addEventListener("click", () => set({ accent: accent.id }));
    swatchesEl.appendChild(button);
    return button;
  });

  swatchesEl.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const i = ACCENTS.findIndex((a) => a.id === look.accent);
    const next = (i + step + ACCENTS.length) % ACCENTS.length;
    set({ accent: ACCENTS[next].id });
    swatchButtons[next].focus();
  });

  const srcFor = ({ theme, accent }) => ({
    src: `/shots/app-${theme}-${accent}.webp`,
    srcset: `/shots/app-${theme}-${accent}@1x.webp 1440w, /shots/app-${theme}-${accent}.webp 2880w`,
  });
  let showingB = false;
  function swapShot() {
    const { src, srcset } = srcFor(look);
    const incoming = showingB ? imgA : imgB;
    const outgoing = showingB ? imgB : imgA;
    incoming.sizes = imgA.sizes;
    incoming.srcset = srcset;
    incoming.src = src;
    const done = () => {
      incoming.style.opacity = "1";
      outgoing.style.opacity = "0";
      incoming.alt = "The Muse Code app in the selected theme and accent.";
      incoming.removeAttribute("aria-hidden");
      outgoing.alt = "";
      outgoing.setAttribute("aria-hidden", "true");
      showingB = !showingB;
      frame.classList.remove("flash");
      void frame.offsetWidth;
      frame.classList.add("flash");
    };
    // decode off the main thread before the crossfade so the swap never stalls a frame
    (incoming.decode ? incoming.decode() : Promise.resolve()).then(done, done);
  }

  function sync() {
    seg.querySelectorAll("[data-theme-pick]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themePick === look.theme)));
    swatchButtons.forEach((b, i) => {
      const on = ACCENTS[i].id === look.accent;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const accent = ACCENTS.find((a) => a.id === look.accent);
    monitor.style.setProperty("--pv", accent.hex);
    nameEl.parentElement.style.setProperty("--pv", accent.hex);
    if (nameEl.textContent !== accent.label) {
      nameEl.textContent = accent.label;
      nameEl.classList.remove("swap");
      void nameEl.offsetWidth;
      nameEl.classList.add("swap");
    }
  }

  function set(next) {
    const changed = (next.theme && next.theme !== look.theme) || (next.accent && next.accent !== look.accent);
    Object.assign(look, next);
    sync();
    if (changed) swapShot();
  }

  seg.addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-pick]");
    if (!button) return;
    themeTouched = true;
    set({ theme: button.dataset.themePick });
  });

  // until the visitor picks a preview theme, the preview follows the site
  window.addEventListener("muse:theme", (event) => {
    if (!themeTouched) set({ theme: event.detail.theme });
  });

  Object.assign(imgA, srcFor(look));
  sync();
}

export function initTheme() {
  initSiteToggle();
  initPreview();
}
