import { useEffect, useRef } from "react";
import { ThinkingOrb, type ThinkingOrbProps } from "thinking-orbs";

/** Any CSS color → [r, g, b], via a 1×1 canvas so every syntax the browser knows works. */
function toRgb(color: string): [number, number, number] {
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) return [126, 179, 255];
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/**
 * ThinkingOrb drawn in the theme accent. The orb only paints grey dots on its canvas and
 * offers no color option, and the macOS web view ignores SVG filters on canvas while blend
 * modes depend on what sits behind the orb. So a second canvas mirrors each frame and
 * repaints its dots in the accent color.
 */
export function Orb({ className, ...props }: ThinkingOrbProps) {
  const wrap = useRef<HTMLSpanElement>(null);
  const tint = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const host = wrap.current;
    const out = tint.current;
    const ctx = out?.getContext("2d", { willReadFrequently: true });
    if (!host || !out || !ctx) return;
    let frame = 0;
    let color = "";
    let checked = 0;
    let parsed = { key: "", rgb: [126, 179, 255] as [number, number, number] };
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      const source = host.querySelector<HTMLCanvasElement>("canvas:not(.orb-tint)");
      if (!source || !source.width || !source.height) return;
      // Accent and theme can change at any time; re-read the token a couple of times a second.
      if (now - checked > 400) { color = getComputedStyle(host).getPropertyValue("--accent-text").trim() || "#7EB3FF"; checked = now; }
      if (out.width !== source.width || out.height !== source.height) { out.width = source.width; out.height = source.height; }
      out.style.width = `${source.clientWidth}px`;
      out.style.height = `${source.clientHeight}px`;
      if (color !== parsed.key) parsed = { key: color, rgb: toRgb(color) };
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(source, 0, 0);
      // Recolor per pixel (WebKit's canvas composite modes proved unreliable here). A dot's
      // strength is its alpha; if the canvas ever paints a backdrop, use distance from it instead.
      const image = ctx.getImageData(0, 0, out.width, out.height);
      const px = image.data;
      const [br, bg, bb, ba] = [px[0], px[1], px[2], px[3]];
      const opaque = ba > 16;
      const range = opaque ? Math.max(br, 255 - br, bg, 255 - bg, bb, 255 - bb) || 255 : 255;
      const [r, g, b] = parsed.rgb;
      for (let i = 0; i < px.length; i += 4) {
        const weight = opaque
          ? Math.max(Math.abs(px[i] - br), Math.abs(px[i + 1] - bg), Math.abs(px[i + 2] - bb)) / range
          : px[i + 3] / 255;
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
        px[i + 3] = Math.min(255, Math.round(weight * 255));
      }
      ctx.putImageData(image, 0, 0);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <span ref={wrap} className={`accent-orb ${className ?? ""}`}>
      <ThinkingOrb {...props} />
      <canvas ref={tint} className="orb-tint" aria-hidden="true" />
    </span>
  );
}
