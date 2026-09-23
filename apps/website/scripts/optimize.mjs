// Converts the PNG captures in public/shots to WebP for the site.
// Emits `{name}.webp` at full (2x) size and `{name}@1x.webp` at half size,
// then removes the PNG. Re-run after scripts/capture.mjs.
//
//   node apps/website/scripts/optimize.mjs [--keep-png]

import sharp from "sharp";
import { readdir, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "..", "public", "shots");
const KEEP = process.argv.includes("--keep-png");

const pngs = (await readdir(SHOTS)).filter((name) => name.endsWith(".png"));
if (!pngs.length) {
  console.log(`no PNGs in ${SHOTS}`);
  process.exit(0);
}

for (const name of pngs) {
  const src = path.join(SHOTS, name);
  const base = name.replace(/\.png$/, "");
  const image = sharp(src);
  const { width } = await image.metadata();
  await image.webp({ quality: 82 }).toFile(path.join(SHOTS, `${base}.webp`));
  await sharp(src)
    .resize({ width: Math.round(width / 2) })
    .webp({ quality: 82 })
    .toFile(path.join(SHOTS, `${base}@1x.webp`));
  if (!KEEP) await unlink(src);
  console.log(`  ✓ ${base}.webp + ${base}@1x.webp`);
}
console.log(`${pngs.length} images optimized${KEEP ? " (PNGs kept)" : " (PNGs removed)"}`);
