// 03 — a faithful rebuild of the app's effort popover
// (apps/desktop/src/components/EffortScrubber.tsx), wired to the particle ring.

const STEPS = 6; // minor ticks between two tiers on the ruler

// TIER_COPY verbatim from apps/desktop/src/lib/effort.ts (ultra excluded — the
// composer vocabulary tops out at Max).
const TIERS = [
  { id: "none", label: "None", short: "None", blurb: "Answers straight away, no reasoning" },
  { id: "minimal", label: "Minimal", short: "Min", blurb: "A glance before acting" },
  { id: "low", label: "Low", short: "Low", blurb: "Quick, light reasoning" },
  { id: "medium", label: "Medium", short: "Med", blurb: "Balanced speed and depth" },
  { id: "high", label: "High", short: "High", blurb: "Thinks it through before acting" },
  { id: "xhigh", label: "Extra high", short: "XHigh", blurb: "Careful, multi-step reasoning" },
  { id: "max", label: "Max", short: "Max", blurb: "Everything it's got. Slowest, deepest." },
];

const FLAME =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';

const hue = (t) => 215 + t * 165;

export function initEffort() {
  const pop = document.getElementById("effort-pop");
  const section = document.getElementById("dial");
  const scrubber = document.getElementById("scrubber");
  const ticksEl = document.getElementById("scrubber-ticks");
  const rail = scrubber.querySelector(".scrubber-rail");
  const labelsEl = document.getElementById("scrubber-labels");
  const nameEl = document.getElementById("effort-name");
  const blurbEl = document.getElementById("effort-blurb");
  const crop = document.getElementById("effort-crop");
  if (!pop || !scrubber) return;

  const max = TIERS.length - 1;
  let index = 4; // default High
  let pos = index;
  let dragging = false;
  let detent = index;

  /* build ticks, dots, labels */
  const ticks = [];
  for (let i = 0; i <= max * STEPS; i++) {
    const t = i / STEPS;
    const el = document.createElement("i");
    el.style.left = `${(t / max) * 100}%`;
    el.style.setProperty("--h", hue(t / max));
    if (Number.isInteger(t)) el.classList.add("major");
    ticksEl.appendChild(el);
    ticks.push({ t, el, major: Number.isInteger(t) });
  }
  const dots = TIERS.map((tier, i) => {
    const el = document.createElement("span");
    el.className = "scrubber-dot";
    el.style.left = `${(i / max) * 100}%`;
    el.style.setProperty("--h", hue(i / max));
    rail.appendChild(el);
    return el;
  });
  TIERS.forEach((tier, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.textContent = tier.short;
    button.style.left = `${(i / max) * 100}%`;
    button.addEventListener("click", () => commit(i));
    labelsEl.appendChild(button);
  });
  const labelButtons = [...labelsEl.children];

  const isPeak = (i) => i === max;

  function paint() {
    const t = pos / max;
    scrubber.style.setProperty("--pos", t);
    scrubber.style.setProperty("--h", hue(t));
    for (const tick of ticks) {
      const d = Math.abs(tick.t - pos);
      const swell = Math.exp(-(d * d) / 0.35);
      tick.el.style.height = `${(tick.major ? 8 : 5) + swell * 14}px`;
      tick.el.style.opacity = String(0.4 + swell * 0.6);
      tick.el.classList.toggle("on", tick.t <= pos + 0.001);
    }
    dots.forEach((dot, i) => dot.classList.toggle("on", i <= pos + 0.001));
    labelButtons.forEach((button, i) => button.classList.toggle("active", Math.round(pos) === i));
  }

  function preview() {
    const tier = TIERS[Math.round(pos)] ?? TIERS[index];
    const peak = isPeak(Math.round(pos));
    nameEl.innerHTML = `${peak ? FLAME : ""}${tier.label}`;
    blurbEl.textContent = tier.blurb;
    pop.classList.toggle("peak", peak);
    section?.classList.toggle("peak", peak);
    // retrigger the tier-in animation
    for (const el of [nameEl, blurbEl]) {
      el.style.animation = "none";
      void el.offsetWidth;
      el.style.animation = "";
    }
  }

  function burst() {
    scrubber.classList.remove("burst");
    void scrubber.offsetWidth;
    scrubber.classList.add("burst");
  }

  function syncCrop() {
    if (!crop) return;
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    crop.src = index === max ? "/shots/effort-max-dark.webp" : `/shots/effort-open-${theme}.webp`;
  }

  function apply(i) {
    index = Math.min(max, Math.max(0, i));
    pos = index;
    detent = index;
    scrubber.setAttribute("aria-valuenow", String(index));
    scrubber.setAttribute("aria-valuetext", TIERS[index].label);
    window.museScene?.setEffort(index / max);
    paint();
    preview();
    syncCrop();
  }

  function commit(next) {
    const snapped = Math.min(max, Math.max(0, Math.round(next)));
    const wasPeak = isPeak(index);
    apply(snapped);
    if (isPeak(snapped) !== wasPeak) burst();
  }

  const fromPointer = (clientX) => {
    const rect = scrubber.getBoundingClientRect();
    if (!rect.width) return pos;
    return Math.min(max, Math.max(0, ((clientX - rect.left) / rect.width) * max));
  };
  const scrubTo = (next) => {
    pos = next;
    const nearest = Math.round(next);
    if (nearest !== detent) {
      detent = nearest;
      preview();
    }
    paint();
  };

  scrubber.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    scrubber.setPointerCapture(event.pointerId);
    dragging = true;
    scrubber.classList.add("dragging");
    scrubTo(fromPointer(event.clientX));
  });
  scrubber.addEventListener("pointermove", (event) => {
    if (dragging) scrubTo(fromPointer(event.clientX));
  });
  scrubber.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    scrubber.classList.remove("dragging");
    commit(fromPointer(event.clientX));
  });
  scrubber.addEventListener("pointercancel", () => {
    dragging = false;
    scrubber.classList.remove("dragging");
    pos = index;
    paint();
    preview();
  });
  scrubber.addEventListener("wheel", (event) => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY;
    if (Math.abs(delta) < 4) return;
    event.preventDefault();
    commit(index + (delta > 0 ? 1 : -1));
  });
  scrubber.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (step) {
      event.preventDefault();
      commit(index + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      commit(0);
    } else if (event.key === "End") {
      event.preventDefault();
      commit(max);
    }
  });

  // theme changes swap the reference crop for non-peak tiers
  new MutationObserver(syncCrop).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  apply(index);
}
