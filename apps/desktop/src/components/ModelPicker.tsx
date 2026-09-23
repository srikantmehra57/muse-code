import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Info, Search, Sparkles } from "lucide-react";
import { TIER_COPY, tiersFor } from "../lib/effort";
import { humanizeModelLabel } from "../lib/format";
import type { Model } from "../lib/types";

export function modelKey(model: { modelId: string; providerId?: string }) {
  return JSON.stringify([model.providerId ?? "", model.modelId]);
}

const CONTRIBUTOR = /[-\s]contributor([-:]free)?$/i;
const CONTRIBUTOR_NOTE = "Contributor model: discounted tokens in exchange for data. Your content, including inter-session messages, may be used for product improvement.";

/** The service's own description when it has one, else the known contributor terms. */
function dataNote(model: Model) {
  const description = model.description?.trim();
  return description && description !== "Free" ? description : CONTRIBUTOR_NOTE;
}

function modelName(model: Model) {
  return humanizeModelLabel(model.modelId.replace(CONTRIBUTOR, ""), model.displayLabel?.replace(CONTRIBUTOR, ""));
}

const PROVIDERS: Record<string, string> = { opencode: "OpenCode Zen", openrouter: "OpenRouter", meta: "Meta", grok: "xAI", anthropic: "Anthropic", openai: "OpenAI", google: "Google" };

function providerName(id?: string) {
  if (!id) return "Models";
  return PROVIDERS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function isFree(model: Model) {
  return model.description === "Free" || /[-:]free$/i.test(model.modelId) || (model.cost != null && Number(model.cost.input) === 0 && Number(model.cost.output) === 0);
}

function contextLabel(limit?: number | null) {
  if (!limit) return null;
  return limit >= 1_000_000 ? `${Math.round(limit / 100_000) / 10}M context`.replace(".0M", "M") : `${Math.round(limit / 1000)}K context`;
}

function costLabel(cost: Model["cost"]) {
  if (!cost || (Number(cost.input) === 0 && Number(cost.output) === 0)) return null;
  const sign = !cost.currency || cost.currency === "USD" ? "$" : `${cost.currency} `;
  return `${sign}${cost.input} in · ${sign}${cost.output} out`;
}

type Props = {
  models: Model[];
  agentId: string;
  value?: string;
  loading: boolean;
  disabled: boolean;
  title?: string;
  onChange: (model: Model) => void;
};

export function ModelPicker({ models, agentId, value, loading, disabled, title, onChange }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const selected = models.find((model) => modelKey(model) === value);
  const searchable = models.length > 8;
  // Filtered, grouped by provider, selected model's provider first.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = models.filter((model) => !needle || `${model.modelId} ${model.displayLabel ?? ""} ${providerName(model.providerId)}`.toLowerCase().includes(needle));
    const order = [...new Set([selected?.providerId, ...matches.map((model) => model.providerId)])];
    return matches.slice().sort((a, b) => {
      const unavailable = Number(Boolean(a.unavailable)) - Number(Boolean(b.unavailable));
      if (unavailable) return unavailable;
      return order.indexOf(a.providerId) - order.indexOf(b.providerId);
    });
  }, [models, query, selected?.providerId]);
  const selectedIndex = visible.findIndex((model) => modelKey(model) === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => { if (open && !searchable) items.current[active]?.focus(); else if (open) items.current[active]?.scrollIntoView({ block: "nearest" }); }, [open, active, searchable]);
  useEffect(() => {
    if (!open) { setQuery(""); return; }
    if (searchable) window.setTimeout(() => search.current?.focus(), 0);
  }, [open, searchable]);

  const choose = (model: Model) => {
    setOpen(false);
    root.current?.querySelector<HTMLButtonElement>(".picker-trigger")?.focus();
    if (modelKey(model) !== value) onChange(model);
  };

  return (
    <div ref={root} className="picker" title={title}>
      <button
        type="button"
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Model"
        disabled={disabled || loading || !models.length}
        onClick={() => { setActive(Math.max(0, visible.findIndex((model) => modelKey(model) === value))); setOpen(!open); }}
        onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setActive(Math.max(0, selectedIndex)); setOpen(true); } }}
      >
        <Sparkles size={13} aria-hidden="true" />
        <span className="picker-value">{selected ? modelName(selected) : loading ? "Loading…" : !models.length ? "No models" : "Choose model"}</span>
        {selected && CONTRIBUTOR.test(selected.modelId) ? <span className="picker-tag warm">Contributor</span> : null}
        <ChevronDown size={12} className="select-chevron" data-open={open || undefined} aria-hidden="true" />
      </button>
      {open ? (
        <div className={`picker-pop model-pop ${models.length > 6 ? "scrolls" : ""} ${searchable ? "searchable" : ""}`} role="listbox" aria-label="Model">
          {searchable ? (
            <label className="picker-search">
              <Search size={13} aria-hidden="true" />
              <input
                ref={search}
                value={query}
                placeholder={`Search ${models.length} models`}
                aria-label="Search models"
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(visible.length - 1, index + 1)); }
                  else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
                  else if (event.key === "Enter" && visible[active]) { event.preventDefault(); choose(visible[active]); }
                  else if (event.key === "Escape") { event.preventDefault(); setOpen(false); root.current?.querySelector<HTMLButtonElement>(".picker-trigger")?.focus(); }
                }}
              />
            </label>
          ) : <div className="menu-heading">Model</div>}
          {!visible.length ? <p className="picker-empty">No models match “{query}”.</p> : null}
          {visible.map((model, index) => {
            const tiers = tiersFor(model, agentId);
            const meta = [contextLabel(model.contextLimit), costLabel(model.cost)].filter(Boolean).join(" · ");
            const contributor = CONTRIBUTOR.test(model.modelId);
            const free = isFree(model);
            const group = index === 0 || visible[index - 1].providerId !== model.providerId;
            return (
              <div key={modelKey(model)} role="presentation">
                {group && (searchable || new Set(models.map((item) => item.providerId)).size > 1) ? <div className="menu-heading group">{providerName(model.providerId)}</div> : null}
                <button
                  ref={(node) => { items.current[index] = node; }}
                  type="button"
                  role="option"
                  aria-selected={index === selectedIndex}
                  aria-description={contributor ? dataNote(model) : undefined}
                  className={`model-option ${index === active ? "active" : ""} ${model.unavailable ? "unavailable" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(model)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") { event.preventDefault(); setActive((index + 1) % visible.length); }
                    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index - 1 + visible.length) % visible.length); }
                    else if (event.key === "Escape") { event.preventDefault(); setOpen(false); root.current?.querySelector<HTMLButtonElement>(".picker-trigger")?.focus(); }
                    else if (event.key === "Tab") setOpen(false);
                  }}
                >
                  <span className="model-copy">
                    <span className="model-name">
                      {modelName(model)}
                      {model.isDefault ? <span className="picker-tag">Default</span> : null}
                      {model.unavailable ? <span className="picker-tag warm">Unavailable</span> : free ? <span className="picker-tag free">Free</span> : null}
                      {contributor ? <span className="picker-tag warm">Contributor</span> : null}
                    </span>
                    {meta ? <span className="model-meta">{meta}</span> : null}
                    {tiers.length ? <span className="model-meta">Effort {TIER_COPY[tiers[0]].label} → {TIER_COPY[tiers[tiers.length - 1]].label}</span> : null}
                  </span>
                  {index === selectedIndex ? <Check size={14} className="option-check" aria-hidden="true" /> : null}
                </button>
              </div>
            );
          })}
          {models.some((model) => CONTRIBUTOR.test(model.modelId)) ? <p className="picker-note"><Info size={11} aria-hidden="true" />Contributor models are discounted because your content, including inter-session messages, may be used for product improvement.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
