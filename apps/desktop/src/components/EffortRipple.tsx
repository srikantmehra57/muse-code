import { useEffect, useState, type CSSProperties } from "react";
import { RIPPLE_EVENT, type RippleOrigin, type RippleVariant } from "../lib/haptics";

type Ripple = RippleOrigin & { id: number; reach: number; variant: RippleVariant };

/**
 * Full-window shockwave when the model's top effort tier is switched on: warm rings
 * expand from the slider thumb to the far corner, and the window gives a small thump.
 */
export function EffortRipple() {
  const [ripples, setRipples] = useState<Ripple[]>([]);
  useEffect(() => {
    let id = 0;
    const onRipple = (event: Event) => {
      const { x, y, variant = "peak" } = (event as CustomEvent<RippleOrigin>).detail;
      const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
      const ripple = { x, y, variant, reach, id: ++id };
      setRipples((current) => [...current, ripple]);
      const app = document.querySelector(".app");
      app?.classList.remove("thump");
      void (app as HTMLElement | null)?.offsetWidth;
      app?.classList.add("thump");
      window.setTimeout(() => {
        setRipples((current) => current.filter((item) => item.id !== ripple.id));
        app?.classList.remove("thump");
      }, 1400);
    };
    window.addEventListener(RIPPLE_EVENT, onRipple);
    return () => window.removeEventListener(RIPPLE_EVENT, onRipple);
  }, []);
  if (!ripples.length) return null;
  return (
    <div className="effort-ripple" aria-hidden="true">
      {ripples.map((ripple) => (
        <div key={ripple.id} className={`ripple-burst ${ripple.variant}`} style={{ left: ripple.x, top: ripple.y, "--reach": `${ripple.reach * 2}px` } as CSSProperties}>
          <span className="ring r1" />
          <span className="ring r2" />
          <span className="ring r3" />
          <span className="flash" />
        </div>
      ))}
      <div key={ripples[ripples.length - 1].id} className={`ripple-vignette ${ripples[ripples.length - 1].variant}`} />
    </div>
  );
}
