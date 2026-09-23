import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Flame } from "lucide-react";
import { TIER_COPY, isPeak } from "../lib/effort";
import { effortRipple, haptic } from "../lib/haptics";
import type { ReasoningEffort } from "../lib/types";

/** Minor ticks between two tiers on the ruler. */
const STEPS = 6;

type Props = {
  value?: ReasoningEffort;
  tiers: ReasoningEffort[];
  fallback: ReasoningEffort;
  modelLabel?: string;
  disabled: boolean;
  title?: string;
  onChange: (tier: ReasoningEffort) => void;
};

/** Hue for a 0–1 position: calm blue → violet → magenta → ember. */
function hue(t: number) { return 215 + t * 165; }

function EffortMeter({ level, count, peak }: { level: number; count: number; peak: boolean }) {
  const bars = Math.min(count, 5);
  const filled = count <= 1 ? bars : Math.round((level / (count - 1)) * (bars - 1)) + 1;
  return (
    <span className={`effort-meter ${peak ? "peak" : ""}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => (
        <i key={index} className={index < filled ? "on" : ""} style={{ height: `${4 + index * 2}px`, "--h": hue(index / Math.max(1, bars - 1)) } as CSSProperties} />
      ))}
    </span>
  );
}

export function EffortScrubber({ value, tiers, fallback, modelLabel, disabled, title, onChange }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const current = value && tiers.includes(value) ? value : fallback;
  const index = Math.max(0, tiers.indexOf(current));
  const max = Math.max(1, tiers.length - 1);
  const [pos, setPos] = useState(index);
  const [dragging, setDragging] = useState(false);
  const detent = useRef(index);
  const preview = tiers[Math.round(pos)] ?? current;
  const peak = isPeak(current, tiers);
  const previewPeak = isPeak(preview, tiers);

  // Sync only when the applied tier changes: re-running on drag end used to
  // snap the handle back to the old config until the agent's reply landed,
  // which read as the slider fighting the user on slow ACP round-trips.
  useEffect(() => { if (!dragging) { setPos(index); detent.current = index; } }, [index]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>(".picker-trigger")?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc, true);
    window.setTimeout(() => track.current?.focus(), 0);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc, true); };
  }, [open]);

  const ticks = useMemo(() => Array.from({ length: max * STEPS + 1 }, (_, i) => i / STEPS), [max]);

  const commit = (next: number) => {
    const snapped = Math.min(max, Math.max(0, Math.round(next)));
    setPos(snapped);
    detent.current = snapped;
    const tier = tiers[snapped];
    if (tier === current) return;
    haptic("level");
    const nextPeak = isPeak(tier, tiers);
    if (nextPeak !== peak) {
      const rect = track.current?.getBoundingClientRect();
      const x = rect ? rect.left + (snapped / max) * rect.width : window.innerWidth / 2;
      const y = rect ? rect.bottom - 9 : window.innerHeight / 2;
      effortRipple({ x, y, variant: nextPeak ? "peak" : "calm" });
    }
    onChange(tier);
  };

  const fromPointer = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect) return pos;
    return Math.min(max, Math.max(0, ((clientX - rect.left) / rect.width) * max));
  };

  const scrubTo = (next: number) => {
    setPos(next);
    const nearest = Math.round(next);
    if (nearest !== detent.current) { detent.current = nearest; haptic("tick"); }
  };

  return (
    <div ref={root} className={`picker effort-picker ${peak ? "peak" : ""}`} title={title}>
      <button
        type="button"
        className="picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Reasoning effort: ${TIER_COPY[current].label}`}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {peak ? <Flame size={13} className="effort-flame" aria-hidden="true" /> : <EffortMeter level={index} count={tiers.length} peak={false} />}
        <span className="picker-value">{TIER_COPY[current].label}</span>
        <ChevronDown size={12} className="select-chevron" data-open={open || undefined} aria-hidden="true" />
      </button>
      {open ? (
        <div className={`picker-pop effort-pop ${previewPeak ? "peak" : ""}`} role="dialog" aria-label="Reasoning effort">
          <div className="effort-head">
            <span className="menu-heading">Reasoning effort</span>
            {modelLabel ? <span className="effort-model">{modelLabel}</span> : null}
          </div>
          <div className="effort-readout" aria-live="polite">
            <span key={preview} className="effort-name">{previewPeak ? <Flame size={18} aria-hidden="true" /> : null}{TIER_COPY[preview].label}</span>
            <span className="effort-blurb">{TIER_COPY[preview].blurb}</span>
          </div>
          <div
            ref={track}
            className={`scrubber ${dragging ? "dragging" : ""}`}
            role="slider"
            tabIndex={0}
            aria-label="Reasoning effort"
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={Math.round(pos)}
            aria-valuetext={TIER_COPY[preview].label}
            style={{ "--pos": pos / max, "--h": hue(pos / max) } as CSSProperties}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragging(true);
              scrubTo(fromPointer(event.clientX));
            }}
            onPointerMove={(event) => { if (dragging) scrubTo(fromPointer(event.clientX)); }}
            onPointerUp={(event) => { if (!dragging) return; setDragging(false); commit(fromPointer(event.clientX)); }}
            onPointerCancel={() => { setDragging(false); setPos(index); }}
            onWheel={(event) => {
              const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY;
              if (Math.abs(delta) < 4) return;
              commit(index + (delta > 0 ? 1 : -1));
            }}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
              if (step) { event.preventDefault(); commit(index + step); }
              else if (event.key === "Home") { event.preventDefault(); commit(0); }
              else if (event.key === "End") { event.preventDefault(); commit(max); }
              else if (event.key === "Enter") { event.preventDefault(); setOpen(false); }
            }}
          >
            <div className="scrubber-ticks" aria-hidden="true">
              {ticks.map((t) => {
                const major = Number.isInteger(t);
                const distance = Math.abs(t - pos);
                const swell = Math.exp(-(distance * distance) / 0.35);
                const height = (major ? 8 : 5) + swell * 14;
                return (
                  <i
                    key={t}
                    className={`${major ? "major" : ""} ${t <= pos + 0.001 ? "on" : ""}`}
                    style={{ left: `${(t / max) * 100}%`, height: `${height}px`, "--h": hue(t / max), opacity: 0.4 + swell * 0.6 } as CSSProperties}
                  />
                );
              })}
            </div>
            <div className="scrubber-rail" aria-hidden="true">
              <span className="scrubber-fill" />
              {tiers.map((tier, i) => (
                <span key={tier} className={`scrubber-dot ${i <= pos + 0.001 ? "on" : ""}`} style={{ left: `${(i / max) * 100}%`, "--h": hue(i / max) } as CSSProperties} />
              ))}
              <span className="scrubber-handle" />
            </div>
          </div>
          <div className="scrubber-labels" aria-hidden="true">
            {tiers.map((tier, i) => (
              <button key={tier} type="button" tabIndex={-1} className={Math.round(pos) === i ? "active" : ""} style={{ left: `${(i / max) * 100}%` }} onClick={() => commit(i)}>
                {TIER_COPY[tier].short}
              </button>
            ))}
          </div>
          <div className="effort-foot">
            <span>Faster · cheaper</span>
            <span>Deeper · slower</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
