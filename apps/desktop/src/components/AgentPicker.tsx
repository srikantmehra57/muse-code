import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import type { AgentId, AgentInfo } from "../lib/types";

const MARKS: Record<AgentId, { glyph: string; tone: string }> = {
  muse: { glyph: "M", tone: "muse" },
  opencode: { glyph: "OC", tone: "opencode" },
  grok: { glyph: "G", tone: "grok" },
  gemini: { glyph: "Ge", tone: "gemini" },
  qwen: { glyph: "Q", tone: "qwen" },
  goose: { glyph: "Go", tone: "goose" },
};

const ICONS: Partial<Record<AgentId, string>> = {
  muse: "/spark.svg",
  grok: "/agents/grok.svg",
  opencode: "/agents/opencode.svg",
  gemini: "/agents/gemini.svg",
  qwen: "/agents/qwen.svg",
};

/** Agents with a published product mark use it; the rest stay lettered. */
export function AgentMark({ id, size = 16 }: { id: AgentId; size?: number }) {
  const icon = ICONS[id];
  if (icon) {
    return (
      <span className={`agent-mark img ${id}`} style={{ width: size, height: size }} aria-hidden="true">
        <img src={icon} alt="" width={size} height={size} />
      </span>
    );
  }
  const mark = MARKS[id] ?? { glyph: id.slice(0, 1).toUpperCase(), tone: "muse" };
  return <span className={`agent-mark ${mark.tone}`} style={{ width: size, height: size, fontSize: size * (mark.glyph.length > 1 ? 0.5 : 0.62) }} aria-hidden="true">{mark.glyph}</span>;
}

function status(agent: AgentInfo) {
  if (!agent.found) return "Not installed";
  if (agent.id === "muse" && !agent.authenticated) return "Needs sign-in";
  return [agent.version ? `v${agent.version}` : null, agent.verified ? null : "Experimental"].filter(Boolean).join(" · ") || "Ready";
}

type Props = {
  agents: AgentInfo[];
  value: AgentId;
  disabled: boolean;
  title?: string;
  onChange: (id: AgentId) => void;
  onRescan: () => Promise<void>;
};

export function AgentPicker({ agents, value, disabled, title, onChange, onRescan }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const current = agents.find((agent) => agent.id === value);
  const installed = agents.filter((agent) => agent.found);

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", esc, true); };
  }, [open]);

  const name = current?.name ?? "Muse";
  return (
    <div ref={root} className="picker agent-picker" title={title}>
      <button type="button" className="picker-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={`Agent: ${name}`} disabled={disabled} onClick={() => setOpen(!open)}>
        <AgentMark id={value} />
        <span className="picker-value">{name}</span>
        <ChevronDown size={12} className="select-chevron" data-open={open || undefined} aria-hidden="true" />
      </button>
      {open ? (
        <div className="picker-pop agent-pop" role="menu" aria-label="Agent">
          <div className="menu-heading">Agent</div>
          {installed.map((agent) => {
            const usable = agent.id !== "muse" || agent.authenticated;
            return (
              <button
                key={agent.id}
                type="button"
                role="menuitemradio"
                aria-checked={agent.id === value}
                className="agent-option"
                disabled={!usable}
                title={!usable ? agent.signIn : agent.path ?? undefined}
                onClick={() => { setOpen(false); if (agent.id !== value) onChange(agent.id); }}
              >
                <AgentMark id={agent.id} size={22} />
                <span className="model-copy">
                  <span className="model-name">{agent.name}{agent.protocol === "acp" ? <span className="picker-tag">ACP</span> : null}</span>
                  <span className="model-meta">{status(agent)}</span>
                </span>
                {agent.id === value ? <Check size={14} className="option-check" aria-hidden="true" /> : null}
              </button>
            );
          })}
          <div className="agent-foot">
            <span>Installed agent CLIs are found automatically.</span>
            <button type="button" className="ghost-btn small" disabled={scanning} onClick={() => { setScanning(true); void onRescan().finally(() => setScanning(false)); }}>
              <RefreshCw size={11} className={scanning ? "spin" : ""} aria-hidden="true" />{scanning ? "Scanning…" : "Rescan"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
