// 04 — a scroll-scrubbed run reconstructed from the app's preview thread.

export function initRun() {
  const wrap = document.getElementById("run-wrap");
  const col = document.getElementById("run-col");
  const count = document.getElementById("run-count");
  const items = [...wrap.querySelectorAll(".run-item")];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = window.matchMedia("(max-width: 800px)");
  const COUNT = 9; // thresholds are k/9 per the design

  const sticky = () => !reducedMotion.matches && !narrow.matches;

  /* approval card */
  const approval = wrap.querySelector(".approval");
  const receipt = document.getElementById("approval-receipt");
  approval?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-decision]");
    if (!button) return;
    approval.querySelectorAll("[data-decision]").forEach((b) => {
      b.classList.toggle("chosen", b === button);
      b.classList.toggle("dim", b !== button);
    });
    receipt.textContent = `${button.dataset.decision} · nothing was executed on this page`;
  });

  let liveDot = null;
  const dotFor = (item) => {
    if (!liveDot) {
      liveDot = document.createElement("span");
      liveDot.className = "live-dot";
      liveDot.setAttribute("aria-hidden", "true");
    }
    item.appendChild(liveDot);
  };

  function progress() {
    const rect = wrap.getBoundingClientRect();
    const scrollable = rect.height - window.innerHeight;
    if (scrollable <= 0) return 1;
    return Math.min(1, Math.max(0, -rect.top / scrollable));
  }

  let p = -1;
  function scrub() {
    if (!sticky()) return;
    p = progress();
    col.style.setProperty("--p", p.toFixed(4));
    let newest = -1;
    items.forEach((item, k) => {
      const on = p >= k / COUNT;
      item.classList.toggle("on", on);
      if (on) newest = k;
    });
    items.forEach((item) => item.contains(liveDot) && liveDot.remove());
    if (count) count.textContent = String(newest + 1);
    if (newest >= 0 && p < (newest + 1) / COUNT) dotFor(items[newest]);
  }

  let io = null;
  function mode() {
    wrap.classList.toggle("sticky-on", sticky());
    if (sticky()) {
      io?.disconnect();
      io = null;
      items.forEach((item) => item.classList.remove("on"));
      scrub();
    } else {
      col.style.setProperty("--p", "1");
      if (count) count.textContent = String(items.length);
      items.forEach((item) => item.contains(liveDot) && liveDot.remove());
      if (reducedMotion.matches) {
        items.forEach((item) => item.classList.add("on"));
        io?.disconnect();
        io = null;
      } else if (!io) {
        io = new IntersectionObserver(
          (entries) => entries.forEach((e) => e.isIntersecting && e.target.classList.add("on")),
          { threshold: 0.2 },
        );
        items.forEach((item) => io.observe(item));
      }
    }
  }

  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      scrub();
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", mode);
  reducedMotion.addEventListener("change", mode);
  narrow.addEventListener("change", mode);
  mode();
}
