import "./style.css";
import Lenis from "lenis";
import { initScene } from "./scene.js";
import { initEffort } from "./effort.js";
import { initRun } from "./run.js";
import { initTheme, applyTheme, currentLook } from "./theme.js";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
const narrow = window.matchMedia("(max-width: 860px)");
const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));

/* ─────────── smooth scroll ─────────── */
let lenis = null;
if (!reduced.matches) {
  lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.95 });
  const raf = (t) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
}
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute("href");
  const target = id === "#top" ? document.body : document.querySelector(id);
  if (!target) return;
  e.preventDefault();
  if (lenis) lenis.scrollTo(id === "#top" ? 0 : target, { duration: 1.6 });
  else if (id === "#top") window.scrollTo({ top: 0 });
  else target.scrollIntoView();
  if (id !== "#top") {
    target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  }
});

/* ─────────── split headings into masked words ─────────── */
document.querySelectorAll("[data-split]").forEach((el) => {
  let i = 0;
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const frag = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (!part.trim()) return frag.append(" ");
          const w = document.createElement("span");
          w.className = "w";
          const inner = document.createElement("span");
          inner.style.setProperty("--i", i++);
          inner.textContent = part;
          w.append(inner);
          frag.append(w);
        });
        child.replaceWith(frag);
      } else if (child.nodeType === Node.ELEMENT_NODE) walk(child);
    });
  };
  el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
  walk(el);
  [...el.querySelectorAll(".w")].forEach((w) => w.setAttribute("aria-hidden", "true"));
});

/* ─────────── reveals ─────────── */
(() => {
  const groups = new Map();
  document.querySelectorAll("[data-reveal]").forEach((el) => {
    const n = groups.get(el.parentElement) ?? 0;
    el.style.setProperty("--d", n);
    groups.set(el.parentElement, n + 1);
  });
  const targets = document.querySelectorAll("[data-reveal], [data-split]");
  if (reduced.matches) return targets.forEach((el) => el.classList.add("in"));
  const io = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        io.unobserve(entry.target);
      }),
    { threshold: 0.18, rootMargin: "0px 0px -6% 0px" },
  );
  targets.forEach((el) => {
    // the hero plays as the particles converge
    if (el.closest(".hero")) return;
    io.observe(el);
  });
  const hero = document.querySelectorAll(".hero [data-reveal], .hero [data-split]");
  setTimeout(() => hero.forEach((el) => el.classList.add("in")), 650);
})();

/* ─────────── nav: progress, active link, hide on scroll down ─────────── */
(() => {
  const nav = $("nav");
  const bar = $("nav-progress");
  const links = [...document.querySelectorAll("[data-nav]")];
  const NAMES = { top: "Intro", room: "The room", features: "Details", agents: "Agents", dial: "The dial", run: "A run", themes: "Themes", install: "Install" };
  const sections = Object.keys(NAMES).map((id) => $(id));
  let lastY = window.scrollY;
  let current = "";
  const update = () => {
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    bar.style.setProperty("--p", (y / Math.max(1, max)).toFixed(4));
    nav.classList.toggle("hide", y > lastY + 2 && y > 600 && !nav.classList.contains("touring"));
    if (y < lastY - 2) nav.classList.remove("hide");
    lastY = y;
    const mid = window.innerHeight * 0.45;
    let id = "top";
    for (const s of sections) if (s.getBoundingClientRect().top <= mid) id = s.id;
    if (id !== current) {
      current = id;
      links.forEach((l) => l.classList.toggle("active", l.dataset.nav === id));
    }
  };
  window.addEventListener("scroll", update, { passive: true });
  update();

  /* the middle slot is as wide as whichever set it is showing (links or tour stops) */
  const mid = nav.querySelector(".nav-mid");
  const navLinks = nav.querySelector(".nav-links");
  const navTour = $("nav-tour");
  const size = () => mid.style.setProperty("--mw", `${(nav.classList.contains("touring") ? navTour : navLinks).offsetWidth}px`);
  new MutationObserver(size).observe(nav, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", size);
  document.fonts?.ready.then(size);
  size();
})();

/* ─────────── agents orbit: spokes + pulses from the hub to each CLI ─────────── */
(() => {
  const svg = $("orbit-lines");
  const nodes = [...document.querySelectorAll(".orbit-node")];
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  svg.append(el("ellipse", { class: "orbit-ellipse", cx: 50, cy: 50, rx: 41, ry: 40 }));
  nodes.forEach((node, i) => {
    const a = ((Number(getComputedStyle(node).getPropertyValue("--a")) * 60 - 90) * Math.PI) / 180;
    const x = 50 + Math.cos(a) * 41;
    const y = 50 + Math.sin(a) * 40;
    const d = `M50 50 L${x.toFixed(2)} ${y.toFixed(2)}`;
    svg.append(el("path", { class: "ln", d }));
    const pulse = el("path", { class: "pulse", d, pathLength: 100 });
    pulse.style.setProperty("--i", i);
    svg.append(pulse);
  });
})();

/* ─────────── 01 room tour ─────────── */
(() => {
  const tour = $("tour");
  const win = $("window");
  const zoom = $("window-zoom");
  const spot = $("spot");
  const card = $("tour-card");
  const copy = $("tour-copy");
  const num = $("tour-num");
  const bar = $("tour-bar");
  const shotA = $("shot-a");
  const shotB = $("shot-b");
  const stops = [...document.querySelectorAll("[data-stop]")];
  const nav = $("nav");
  const navTour = $("nav-tour");
  const view = $("window-view");
  const callout = $("callout");
  const calloutNum = $("callout-num");
  const calloutTitle = $("callout-title");
  const calloutText = $("callout-text");

  // % coords measured on the 1440×900 capture
  const REGIONS = [
    null,
    { x: 0, y: 0, w: 18.3, h: 100 },
    { x: 18.3, y: 6, w: 55.6, h: 80.4 },
    { x: 19.4, y: 86.4, w: 53.3, h: 10.9 },
    { x: 74.4, y: 0.9, w: 25, h: 98.2 },
  ];
  const COPY = [
    ["Overview", "Workspaces on the left, the chat in the middle, changed files on the right."],
    ["Threads", "Your workspaces and chats. Chats are saved, and a run that stops early is marked as interrupted."],
    ["Timeline", "Tool calls, plans and exit codes appear as the agent works."],
    ["Composer", "Pick the model, reasoning effort and approval mode. Attach files and images."],
    ["Changes", "See changed files and diffs. Commit or revert from here."],
  ];
  const START = 0.14;
  const SPAN = (1 - START) / 4;

  /* initial shot matches the stored look; crossfade when the theme changes */
  const shotSrc = ({ theme, accent }) => [`/shots/app-${theme}-${accent}.webp`, `/shots/app-${theme}-${accent}@1x.webp 1440w, /shots/app-${theme}-${accent}.webp 2880w`];
  [shotA.src, shotA.srcset] = shotSrc(currentLook());
  let showingB = false;
  window.addEventListener("muse:theme", (e) => {
    const [src, srcset] = shotSrc(e.detail);
    const incoming = showingB ? shotA : shotB;
    const outgoing = showingB ? shotB : shotA;
    incoming.srcset = srcset;
    incoming.sizes = "(max-width: 1200px) 100vw, 1200px";
    incoming.src = src;
    const swap = () => {
      incoming.style.opacity = "1";
      outgoing.style.opacity = "0";
      incoming.alt = outgoing.alt || incoming.alt;
      incoming.removeAttribute("aria-hidden");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.alt = "";
      showingB = !showingB;
    };
    (incoming.decode ? incoming.decode() : Promise.resolve()).then(swap, swap);
  });

  // decode the big capture ahead of the tour so its first paint doesn't stall the scroll
  new IntersectionObserver((entries, io) => {
    if (!entries[0].isIntersecting) return;
    shotA.decode?.().catch(() => {});
    io.disconnect();
  }, { rootMargin: "150% 0px" }).observe(tour);

  let stop = -1;
  function show(k) {
    if (k === stop) return;
    stop = k;
    const r = REGIONS[k];
    if (r) {
      const s = clamp(Math.min(100 / (r.w * 1.25), 100 / (r.h * 1.08)), 1, 1.6);
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const zx = clamp(50 - s * cx, 100 - 100 * s, 0);
      const zy = clamp(50 - s * cy, 100 - 100 * s, 0);
      zoom.style.setProperty("--zs", s);
      zoom.style.setProperty("--zx", `${zx}%`);
      zoom.style.setProperty("--zy", `${zy}%`);
      spot.style.setProperty("--sx", `${r.x}%`);
      spot.style.setProperty("--sy", `${r.y}%`);
      spot.style.setProperty("--sw", `${r.w}%`);
      spot.style.setProperty("--sh", `${r.h}%`);
      spot.classList.add("on");
    } else {
      zoom.style.setProperty("--zs", 1);
      zoom.style.setProperty("--zx", "0%");
      zoom.style.setProperty("--zy", "0%");
      spot.classList.remove("on");
    }
    placeCallout(k, r ? { s: Number(zoom.style.getPropertyValue("--zs")), zx: parseFloat(zoom.style.getPropertyValue("--zx")), zy: parseFloat(zoom.style.getPropertyValue("--zy")) } : null);
    moveNavThumb(k);
    copy.innerHTML = `<h3>${COPY[k][0]}</h3><p>${COPY[k][1]}</p>`;
    copy.classList.remove("swap");
    void copy.offsetWidth;
    copy.classList.add("swap");
    num.textContent = String(k).padStart(2, "0");
    stops.forEach((b) => b.classList.toggle("active", Number(b.dataset.stop) === k));
  }

  /* the callout sits on whichever side of the (zoomed) region has room,
     or tucks inside the region's corner when none does */
  let calloutTimer = 0;
  function placeCallout(k, z) {
    callout.classList.remove("show");
    clearTimeout(calloutTimer);
    calloutTimer = setTimeout(() => {
      const st = callout.style;
      st.left = st.right = st.top = st.bottom = "auto";
      st.transform = "";
      const r = REGIONS[k];
      if (!r || !z) {
        st.left = "50%";
        st.bottom = "5%";
        st.transform = "translateX(-50%)";
      } else {
        const l = z.zx + z.s * r.x;
        const t = z.zy + z.s * r.y;
        const rr = z.zx + z.s * (r.x + r.w);
        const b = z.zy + z.s * (r.y + r.h);
        const W = (callout.offsetWidth / view.clientWidth) * 100 + 3;
        const H = (callout.offsetHeight / view.clientHeight) * 100 + 4;
        if (100 - rr >= W) {
          st.left = `${rr + 2}%`;
          st.top = `${Math.min(Math.max(t, 6), 94 - H)}%`;
        } else if (l >= W) {
          st.right = `${100 - l + 2}%`;
          st.top = `${Math.min(Math.max(t, 6), 94 - H)}%`;
        } else if (t >= H) {
          st.left = `${Math.max(l, 3)}%`;
          st.bottom = `${100 - t + 2.5}%`;
        } else {
          st.right = `${Math.max(100 - rr, 0) + 3}%`;
          st.bottom = `${Math.max(100 - b, 0) + 4}%`;
        }
      }
      calloutNum.textContent = k ? `${k} of 4` : "Tour";
      calloutTitle.textContent = COPY[k][0];
      calloutText.textContent = COPY[k][1];
      callout.classList.add("show");
    }, callout.classList.contains("show") ? 260 : 0);
  }

  function moveNavThumb(k) {
    const button = navTour.querySelector(`[data-stop="${k}"]`);
    if (!button) return navTour.style.setProperty("--to", 0);
    navTour.style.setProperty("--tx", `${button.offsetLeft}px`);
    navTour.style.setProperty("--tw", `${button.offsetWidth}px`);
    navTour.style.setProperty("--to", 1);
  }

  function update() {
    if (narrow.matches) {
      nav.classList.remove("touring");
      win.style.removeProperty("--rx");
      card.classList.add("show");
      bar.style.setProperty("--p", stop / 4);
      return;
    }
    const rect = tour.getBoundingClientRect();
    const vh = window.innerHeight;
    const enter = clamp(1 - rect.top / vh);
    const e = 1 - Math.pow(1 - enter, 3);
    win.style.setProperty("--rx", `${(22 * (1 - e)).toFixed(2)}deg`);
    win.style.setProperty("--s", (0.86 + 0.14 * e).toFixed(4));
    win.style.setProperty("--ty", `${(60 * (1 - e)).toFixed(1)}px`);
    card.classList.toggle("show", enter > 0.92 && rect.bottom > vh * 0.6);
    nav.classList.toggle("touring", rect.top <= vh * 0.15 && rect.bottom >= vh * 0.55);
    const p = clamp(-rect.top / (rect.height - vh));
    bar.style.setProperty("--p", p.toFixed(4));
    show(p < START ? 0 : Math.min(4, 1 + Math.floor((p - START) / SPAN)));
  }

  stops.forEach((b) =>
    b.addEventListener("click", () => {
      const k = Number(b.dataset.stop);
      if (narrow.matches) {
        show(stop === k ? 0 : k);
        bar.style.setProperty("--p", stop / 4);
        return;
      }
      const top = tour.getBoundingClientRect().top + window.scrollY;
      const y = top + (START + (k - 1) * SPAN + SPAN * 0.4) * (tour.offsetHeight - window.innerHeight);
      lenis ? lenis.scrollTo(y, { duration: 1.4 }) : window.scrollTo({ top: y, behavior: reduced.matches ? "auto" : "smooth" });
    }),
  );

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  show(0);
  update();
})();

/* ─────────── cards: cursor light + tilt ─────────── */
document.querySelectorAll(".card").forEach((card) => {
  card.addEventListener("pointermove", (e) => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    card.style.setProperty("--mx", `${x * 100}%`);
    card.style.setProperty("--my", `${y * 100}%`);
    if (fine.matches && !reduced.matches) {
      card.style.setProperty("--tx", `${((0.5 - y) * 5).toFixed(2)}deg`);
      card.style.setProperty("--ty", `${((x - 0.5) * 6).toFixed(2)}deg`);
    }
  });
  card.addEventListener("pointerleave", () => {
    card.style.setProperty("--tx", "0deg");
    card.style.setProperty("--ty", "0deg");
  });
});

/* ─────────── magnetic buttons + cursor ─────────── */
(() => {
  if (!fine.matches || reduced.matches) return;
  document.querySelectorAll(".magnetic").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - (r.left + r.width / 2);
      const y = e.clientY - (r.top + r.height / 2);
      el.style.transform = `translate(${x * 0.22}px, ${y * 0.32}px)`;
    });
    el.addEventListener("pointerleave", () => (el.style.transform = ""));
  });

  const cursor = $("cursor");
  const dot = cursor.querySelector(".cursor-dot");
  const ring = cursor.querySelector(".cursor-ring");
  let mx = -100;
  let my = -100;
  let rx = -100;
  let ry = -100;
  window.addEventListener(
    "pointermove",
    (e) => {
      mx = e.clientX;
      my = e.clientY;
      dot.style.setProperty("--x", `${mx}px`);
      dot.style.setProperty("--y", `${my}px`);
      const t = e.target;
      const drag = t.closest?.("#scrubber");
      const link = !drag && t.closest?.("a, button, [role=radio], .swatch");
      const text = !drag && !link && t.closest?.("code, pre, .terminal");
      cursor.classList.toggle("is-drag", !!drag);
      cursor.classList.toggle("is-link", !!link);
      cursor.classList.toggle("is-text", !!text);
      cursor.classList.remove("is-hidden");
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", () => cursor.classList.add("is-hidden"));
  const loop = () => {
    rx += (mx - rx) * 0.18;
    ry += (my - ry) * 0.18;
    ring.style.setProperty("--rx", `${rx}px`);
    ring.style.setProperty("--ry", `${ry}px`);
    requestAnimationFrame(loop);
  };
  loop();
})();

/* ─────────── segmented thumbs ─────────── */
function syncSeg(seg) {
  const buttons = [...seg.querySelectorAll("button")];
  const i = buttons.findIndex((b) => b.getAttribute("aria-checked") === "true" || b.getAttribute("aria-pressed") === "true");
  seg.style.setProperty("--seg-i", Math.max(0, i));
}
const segObserver = new MutationObserver((records) => records.forEach((r) => syncSeg(r.target.closest(".seg"))));
document.querySelectorAll(".seg").forEach((seg) => {
  syncSeg(seg);
  segObserver.observe(seg, { subtree: true, attributes: true, attributeFilter: ["aria-checked", "aria-pressed"] });
});

/* ─────────── install: platform toggle + copy ─────────── */
(() => {
  const commands = {
    posix: "curl -fsSL https://dev.meta.ai/install.sh | sh",
    windows: "irm https://dev.meta.ai/install.ps1 | iex",
  };
  let platform = "posix";
  const commandEl = $("install-command");
  const statusEl = $("copy-status");
  const copyBtn = $("copy-command");
  document.querySelectorAll("[data-platform]").forEach((button) =>
    button.addEventListener("click", () => {
      platform = button.dataset.platform;
      commandEl.textContent = commands[platform];
      statusEl.textContent = "";
      document.querySelectorAll("[data-platform]").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    }),
  );
  let timer = 0;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(commands[platform]);
      copyBtn.textContent = "Copied";
      copyBtn.classList.add("done");
      statusEl.textContent = "";
    } catch {
      statusEl.textContent = "Select the command above to copy it";
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      copyBtn.textContent = "Copy";
      copyBtn.classList.remove("done");
      statusEl.textContent = "";
    }, 1600);
  });
})();

initScene();

/* ─────────── hero launch video: play while visible, sound on request ─────────── */
(() => {
  const video = $("launch-video");
  const sound = $("launch-sound");
  const label = $("launch-sound-label");
  if (!video || !sound) return;
  let visible = false;
  let wanted = !reduced.matches; // reduced motion: stays on the poster until asked
  const sync = () => {
    if (visible && wanted) video.play().catch(() => {});
    else video.pause();
  };
  new IntersectionObserver(
    ([entry]) => {
      visible = entry.isIntersecting;
      sync();
    },
    { threshold: 0.25 },
  ).observe(video);
  sound.addEventListener("click", () => {
    const on = video.muted;
    video.muted = !on;
    sound.setAttribute("aria-pressed", String(on));
    label.textContent = on ? "Sound off" : "Sound on";
    if (on) {
      if (reduced.matches || video.ended) video.currentTime = 0;
      wanted = true;
    }
    sync();
  });
})();

/* ─────────── boot ─────────── */
initTheme();
initEffort();
initRun();

window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", (event) => {
  try {
    if (localStorage.getItem("muse-site-theme")) return;
  } catch {}
  applyTheme({ theme: event.matches ? "light" : "dark" });
});
