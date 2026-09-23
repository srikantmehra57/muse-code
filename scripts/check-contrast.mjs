#!/usr/bin/env node
/** WCAG 2.1 contrast audit for the theme tokens in apps/desktop/src/styles.css. */

function rgb(hex) {
  const v = hex.replace("#", "");
  return [parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255];
}
function channel(c) { return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function luminance([r, g, b]) { return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function over(fg, alpha, bg) { return fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)); }

const themes = {
  dark: {
    bg: "#0D0D0F", surface: "#151517", surface2: "#1B1B1E", surface3: "#232327",
    ink: "#EDEDEC", secondary: "#A3A3A8", tertiary: "#8E8E93",
    accent: "#0064E0", accentHover: "#1870DC", accentSoft: [0, 100, 224, 0.16], accentText: "#7EB3FF", accentContrast: "#FFFFFF",
    success: "#3FB27F", warning: "#D6A23A", danger: "#E5534B", onInk: "#0D0D0F",
  },
  light: {
    bg: "#F3F3F1", surface: "#FFFFFF", surface2: "#FAFAF9", surface3: "#F1F1EF",
    ink: "#1B1B1D", secondary: "#5E5E63", tertiary: "#6B6B70",
    accent: "#0064E0", accentHover: "#0057C4", accentSoft: [0, 100, 224, 0.1], accentText: "#0052C2", accentContrast: "#FFFFFF",
    success: "#1C7F52", warning: "#8F6610", danger: "#C8362F", onInk: "#FFFFFF",
  },
};

const accents = {
  dark: {
    blue: { accent: "#9DBCF4", accentHover: "#B1C9F6", accentText: "#B6CEF7", accentContrast: "#152033" },
    violet: { accent: "#C5B0E8", accentHover: "#D3C3ED", accentText: "#D5C5EF", accentContrast: "#21182E" },
    pink: { accent: "#E9B3C8", accentHover: "#EFC4D4", accentText: "#F0C6D6", accentContrast: "#321A24" },
    orange: { accent: "#F0B78F", accentHover: "#F4C8A8", accentText: "#F6CCAF", accentContrast: "#321F14" },
    yellow: { accent: "#E9D48F", accentHover: "#F0DEA8", accentText: "#F2E1AE", accentContrast: "#2C2816" },
    green: { accent: "#A8CEB0", accentHover: "#BAD8C1", accentText: "#C0DEC7", accentContrast: "#17271C" },
    teal: { accent: "#96CECA", accentHover: "#ACDAD6", accentText: "#B4E0DC", accentContrast: "#162728" },
  },
  light: {
    blue: { accent: "#9DBCF4", accentHover: "#8EAFE9", accentText: "#355C9C", accentContrast: "#152033" },
    violet: { accent: "#C5B0E8", accentHover: "#B59DDF", accentText: "#624D87", accentContrast: "#21182E" },
    pink: { accent: "#E9B3C8", accentHover: "#DFA0B8", accentText: "#875065", accentContrast: "#321A24" },
    orange: { accent: "#F0B78F", accentHover: "#E5A579", accentText: "#86563A", accentContrast: "#321F14" },
    yellow: { accent: "#E9D48F", accentHover: "#DDC77F", accentText: "#746126", accentContrast: "#2C2816" },
    green: { accent: "#A8CEB0", accentHover: "#96BF9F", accentText: "#466D4D", accentContrast: "#17271C" },
    teal: { accent: "#96CECA", accentHover: "#83BFBB", accentText: "#3E706D", accentContrast: "#162728" },
  },
};

let failures = 0;
const rows = [];
function check(name, fgHex, bgHex, min = 4.5) {
  const ratio = contrast(rgb(fgHex), rgb(bgHex));
  const ok = ratio >= min;
  if (!ok) failures++;
  rows.push({ name, ratio: ratio.toFixed(2), min, ok });
}

for (const [name, t] of Object.entries(themes)) {
  for (const bg of ["bg", "surface", "surface2", "surface3"]) {
    check(`${name} ink/${bg}`, t.ink, t[bg]);
    check(`${name} secondary/${bg}`, t.secondary, t[bg]);
    check(`${name} tertiary/${bg}`, t.tertiary, t[bg]);
    check(`${name} accentText/${bg}`, t.accentText, t[bg]);
  }
  check(`${name} accentContrast/accent`, t.accentContrast, t.accent);
  check(`${name} accentContrast/accentHover`, t.accentContrast, t.accentHover);
  const softBg = over(rgb("#0064E0"), t.accentSoft[3], rgb(t.surface2));
  const softRatio = contrast(rgb(t.accentText), softBg);
  const softOk = softRatio >= 4.5;
  if (!softOk) failures++;
  rows.push({ name: `${name} accentText/accentSoft(surface2)`, ratio: softRatio.toFixed(2), min: 4.5, ok: softOk });
  for (const status of ["success", "warning", "danger"]) {
    check(`${name} ${status}/surface2`, t[status], t.surface2);
  }
  check(`${name} onInk/ink`, t.onInk, t.ink);
}

for (const [theme, set] of Object.entries(accents)) {
  const t = themes[theme];
  for (const [accent, a] of Object.entries(set)) {
    for (const bg of ["bg", "surface", "surface2"]) {
      check(`${theme}/${accent} accentText/${bg}`, a.accentText, t[bg]);
    }
    check(`${theme}/${accent} accentContrast/accent`, a.accentContrast, a.accent);
    check(`${theme}/${accent} accentContrast/accentHover`, a.accentContrast, a.accentHover);
  }
}

const pad = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(pad)}  ${r.ratio}:1  (min ${r.min}:1)`);
}
console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} pairs meet WCAG AA (4.5:1).`);
if (failures) process.exit(1);
