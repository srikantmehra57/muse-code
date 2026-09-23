import { useEffect, useMemo, useState, type CSSProperties, type ComponentType } from "react";
import { Clock3, FilePenLine, FileText, LoaderCircle, RotateCcw, Search, Terminal, Wrench } from "lucide-react";
import { useAppStore } from "../lib/store";
import { formatResetIn, usageWindowLabel } from "../lib/format";
import type { AgentId, Thread, TranscriptItem } from "../lib/types";
import { AgentMark } from "./AgentPicker";

type Period = "today" | "week" | "overview";
type UsageEvent = { at: Date; tokens: number; tool?: string; agentId: string; threadId: string; workspace: string };
type Cell = { key: string; label: string; tokens: number; level: number };
type MapModel = { cells: Cell[]; columns: number; rows: number; labels: { text: string; column: number }[]; range: string; peakLabel: string };

const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "week", label: "This week" },
  { id: "overview", label: "Overview" },
];

const DAY = 86_400_000;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const formatTokens = (value: number) => value ? compact.format(Math.round(value)) : "0";
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
const mondayOf = (date: Date) => {
  const value = startOfDay(date);
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
  return value;
};
const sundayOf = (date: Date) => {
  const value = startOfDay(date);
  value.setDate(value.getDate() - value.getDay());
  return value;
};
const safeDate = (value?: string, fallback?: string) => {
  const parsed = new Date(value || fallback || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};
const itemTokens = (item: TranscriptItem) => Math.max(0, Math.round(((item.text?.length ?? 0) + (item.visibleOutput?.length ?? 0)) / 4));

function usageEvents(threads: Thread[]): UsageEvent[] {
  return threads.flatMap((thread) => thread.items.map((item) => ({
    at: safeDate(item.recordedAt, thread.updatedAt),
    tokens: itemTokens(item),
    tool: item.kind === "toolCall" ? item.tool : undefined,
    agentId: thread.agentId ?? "muse",
    threadId: thread.sessionId,
    workspace: thread.workspacePath,
  })));
}

function demoTokens(date: Date, granularity: Period, row = 0) {
  const seed = (date.getFullYear() * 31 + (date.getMonth() + 1) * 17 + date.getDate() * 13 + date.getHours() * 7 + row * 11) % 29;
  if (granularity === "today") {
    const hour = date.getHours();
    if (hour < 8 || hour > 22 || seed < 8) return 0;
    return (seed % 5 + 1) * 460 + row * 190;
  }
  if (granularity === "week") {
    if (date.getDay() === 0 || seed < 7) return 0;
    return (seed % 7 + 1) * 980 + row * 230;
  }
  const age = Math.max(0, (startOfDay(new Date()).getTime() - startOfDay(date).getTime()) / DAY);
  const recent = age < 75 ? 1.9 : age < 180 ? 0.85 : 0.28;
  if (seed > 12 * recent || date.getDay() === 0) return 0;
  return Math.round((seed % 6 + 1) * 1500 * recent);
}

function totalBetween(events: UsageEvent[], from: Date, to: Date) {
  return events.reduce((sum, event) => event.at >= from && event.at < to ? sum + Math.max(event.tokens, event.tool ? 100 : 0) : sum, 0);
}

function quantize(values: number[]) {
  const active = values.filter(Boolean).sort((a, b) => a - b);
  return values.map((value) => {
    if (!value || !active.length) return 0;
    const rank = active.findIndex((candidate) => candidate >= value) / Math.max(1, active.length - 1);
    return Math.min(4, Math.max(1, Math.ceil(rank * 4)));
  });
}

function makeMap(period: Period, events: UsageEvent[], demo: boolean, now: Date): MapModel {
  const raw: Omit<Cell, "level">[] = [];
  const labels: MapModel["labels"] = [];
  let columns = 0;
  let rows = 0;
  let range = "";
  let peakLabel = "Peak period";

  if (period === "today") {
    columns = 24;
    rows = 4;
    const day = startOfDay(now);
    for (let row = 0; row < rows; row += 1) {
      for (let hour = 0; hour < columns; hour += 1) {
        const from = new Date(day.getTime() + hour * 3_600_000 + row * 900_000);
        const to = new Date(from.getTime() + 900_000);
        const future = from > now;
        const tokens = future ? 0 : demo ? demoTokens(from, period, row) : totalBetween(events, from, to);
        raw.push({ key: from.toISOString(), label: `${from.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · about ${formatTokens(tokens)} tokens`, tokens });
      }
    }
    [0, 4, 8, 12, 16, 20].forEach((hour) => labels.push({ text: hour === 0 ? "12am" : hour < 12 ? `${hour}am` : hour === 12 ? "12pm" : `${hour - 12}pm`, column: hour + 1 }));
    range = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    peakLabel = "Peak 15 min";
  } else if (period === "week") {
    columns = 7;
    rows = 6;
    const week = mondayOf(now);
    for (let row = 0; row < rows; row += 1) {
      for (let dayIndex = 0; dayIndex < columns; dayIndex += 1) {
        const from = new Date(week.getTime() + dayIndex * DAY + row * 4 * 3_600_000);
        const to = new Date(from.getTime() + 4 * 3_600_000);
        const future = from > now;
        const tokens = future ? 0 : demo ? demoTokens(from, period, row) : totalBetween(events, from, to);
        raw.push({ key: from.toISOString(), label: `${from.toLocaleDateString([], { weekday: "long" })}, ${from.toLocaleTimeString([], { hour: "numeric" })} · about ${formatTokens(tokens)} tokens`, tokens });
      }
    }
    for (let dayIndex = 0; dayIndex < columns; dayIndex += 1) {
      const date = new Date(week.getTime() + dayIndex * DAY);
      labels.push({ text: date.toLocaleDateString([], { weekday: "short" }), column: dayIndex + 1 });
    }
    const end = new Date(week.getTime() + 6 * DAY);
    range = `${week.toLocaleDateString([], { month: "short", day: "numeric" })} – ${end.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    peakLabel = "Peak block";
  } else {
    columns = 53;
    rows = 7;
    const thisWeek = sundayOf(now);
    const start = new Date(thisWeek.getTime() - 52 * 7 * DAY);
    for (let row = 0; row < rows; row += 1) {
      for (let week = 0; week < columns; week += 1) {
        const from = new Date(start.getTime() + (week * 7 + row) * DAY);
        const to = new Date(from.getTime() + DAY);
        const future = from > now;
        const tokens = future ? 0 : demo ? demoTokens(from, period, row) : totalBetween(events, from, to);
        raw.push({ key: from.toISOString(), label: `${from.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })} · about ${formatTokens(tokens)} tokens`, tokens });
      }
    }
    let month = -1;
    for (let week = 0; week < columns; week += 1) {
      const date = new Date(start.getTime() + week * 7 * DAY);
      if (date.getMonth() !== month) {
        month = date.getMonth();
        labels.push({ text: date.toLocaleDateString([], { month: "short" }), column: week + 1 });
      }
    }
    range = `${start.toLocaleDateString([], { month: "short", year: "numeric" })} – ${now.toLocaleDateString([], { month: "short", year: "numeric" })}`;
    peakLabel = "Peak day";
  }

  const levels = quantize(raw.map((cell) => cell.tokens));
  return { cells: raw.map((cell, index) => ({ ...cell, level: levels[index] })), columns, rows, labels, range, peakLabel };
}

const TOOL_ICONS: Record<string, ComponentType<{ size?: number; "aria-hidden"?: boolean }>> = {
  bash: Terminal,
  shell: Terminal,
  codebase_search: Search,
  grep: Search,
  read_file: FileText,
  edit_file: FilePenLine,
};

function currentStreak(events: UsageEvent[], demo: boolean, now: Date) {
  if (demo) return 6;
  const days = new Set(events.map((event) => startOfDay(event.at).toISOString()));
  let cursor = startOfDay(now);
  if (!days.has(cursor.toISOString())) cursor = new Date(cursor.getTime() - DAY);
  let streak = 0;
  while (days.has(cursor.toISOString())) { streak += 1; cursor = new Date(cursor.getTime() - DAY); }
  return streak;
}

function periodStart(period: Period, now: Date) {
  if (period === "today") return startOfDay(now);
  if (period === "week") return mondayOf(now);
  return new Date(sundayOf(now).getTime() - 52 * 7 * DAY);
}

function PlanUsage() {
  const usage = useAppStore((state) => state.subscriptionUsage);
  const loading = useAppStore((state) => state.subscriptionUsageLoading);
  const error = useAppStore((state) => state.subscriptionUsageError);
  const authenticated = useAppStore((state) => state.detection?.authenticated);
  const refresh = useAppStore((state) => state.refreshSubscriptionUsage);
  const [now] = useState(() => Date.now());
  useEffect(() => { void refresh(); }, [refresh]);
  const rows = usage
    ? [
      { label: usageWindowLabel(usage.window.windowDurationMins), percent: usage.window.usedPercent, resetsAtMs: usage.window.resetsAtMs },
      { label: "Weekly", percent: usage.weekly.usedPercent, resetsAtMs: usage.weekly.resetsAtMs },
    ]
    : [];
  return (
    <section className="usage-plan" aria-labelledby="plan-usage-title">
      <div className="usage-section-head">
        <div>
          <h2 id="plan-usage-title">Subscription usage</h2>
          <p>{usage ? "Reported by the Muse host — the only numbers here that are not estimates." : "Reported by the Muse host once it has seen a turn."}</p>
        </div>
        <button type="button" className="ghost-btn small" disabled={loading} onClick={() => void refresh(true)}>
          {loading ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : <RotateCcw size={11} aria-hidden="true" />}
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      {rows.length ? (
        <div className="usage-plan-rows">
          {rows.map((row) => {
            const rounded = Math.round(row.percent);
            const tone = rounded >= 100 ? " over" : rounded >= 80 ? " high" : "";
            return (
              <div className="usage-row" key={row.label}>
                <div className="usage-row-head"><span>{row.label}</span><span className="usage-pct">{rounded}%</span></div>
                <span className={`usage-bar${tone}`} role="img" aria-label={`${rounded}% used`}><span style={{ width: `${Math.min(100, Math.max(0, rounded))}%` }} /></span>
                <div className="usage-sub">{formatResetIn(row.resetsAtMs, now)}</div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="usage-empty" role={error ? "alert" : "status"}>
          {error ? error : loading ? "Reading usage…" : authenticated === false ? "Sign in with the Muse CLI to see subscription usage." : "No usage observed yet — it appears after your first turn."}
        </p>
      )}
    </section>
  );
}

export function UsageView({ embedded = false }: { embedded?: boolean } = {}) {
  const threads = useAppStore((state) => state.threads);
  const preview = useAppStore((state) => state.preview);
  const [period, setPeriod] = useState<Period>("overview");
  const now = useMemo(() => new Date(), []);
  const events = useMemo(() => usageEvents(threads), [threads]);
  const model = useMemo(() => makeMap(period, events, preview, now), [events, now, period, preview]);
  const from = periodStart(period, now);
  const filtered = events.filter((event) => event.at >= from && event.at <= now);
  const total = model.cells.reduce((sum, cell) => sum + cell.tokens, 0);
  const peak = Math.max(0, ...model.cells.map((cell) => cell.tokens));
  const activeThreads = new Set(filtered.map((event) => event.threadId)).size || (preview ? (period === "today" ? 3 : 8) : 0);
  const longest = Math.max(0, ...threads.map((thread) => thread.turnStats?.durationMs ?? 0));
  const toolCounts = filtered.reduce<Record<string, number>>((result, event) => {
    if (event.tool) result[event.tool] = (result[event.tool] ?? 0) + 1;
    return result;
  }, {});
  if (preview && !Object.keys(toolCounts).length) Object.assign(toolCounts, { bash: 18, codebase_search: 14, read_file: 12, edit_file: 9, grep: 7 });
  const tools = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const effortCounts = threads.reduce<Record<string, number>>((result, thread) => {
    const effort = thread.config?.effort ?? "high";
    result[effort] = (result[effort] ?? 0) + 1;
    return result;
  }, {});
  const reasoning = Object.entries(effortCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
  const agentCounts = threads.reduce<Record<string, number>>((result, thread) => {
    const agent = thread.agentId ?? "muse";
    result[agent] = (result[agent] ?? 0) + 1;
    return result;
  }, {});
  const agents = Object.entries(agentCounts).sort((a, b) => b[1] - a[1]);
  const longestLabel = longest ? `${Math.max(1, Math.round(longest / 60_000))}m` : preview ? "18m" : "—";
  const mapStyle = { "--activity-columns": model.columns } as CSSProperties;

  const periods = (
    <div className="usage-periods" role="tablist" aria-label="Usage period">
      {PERIODS.map((item) => (
        <button key={item.id} role="tab" aria-selected={period === item.id} onClick={() => setPeriod(item.id)}>{item.label}</button>
      ))}
    </div>
  );

  const Shell = embedded ? "div" : "main";
  const shellProps = embedded
    ? { className: "usage-embed" }
    : { id: "main-content", tabIndex: -1, className: "main usage-main solo" };

  return (
    <Shell {...shellProps}>
      {embedded ? <div className="usage-embed-head">{periods}</div> : (
        <header className="topbar usage-topbar" data-tauri-drag-region>
          <div>
            <h1>Usage</h1>
            <span>Activity across Muse threads</span>
          </div>
          <span className="grow" />
          {periods}
        </header>
      )}

      <div className="usage-scroll">
        <PlanUsage />
        <section className="usage-summary" aria-label="Usage summary">
          <div><span>Estimated tokens</span><strong>≈{formatTokens(total)}</strong></div>
          <div title="Estimated from transcript characters"><span>{model.peakLabel}</span><strong>≈{formatTokens(peak)}</strong></div>
          <div><span>Longest run</span><strong>{longestLabel}</strong></div>
          <div><span>Current streak</span><strong>{currentStreak(events, preview, now)} days</strong></div>
          <div><span>Active threads</span><strong>{activeThreads}</strong></div>
        </section>

        <section className="usage-activity" aria-labelledby="token-activity-title">
          <div className="usage-section-head">
            <div><h2 id="token-activity-title">Estimated token activity</h2><p>{model.range} · Based on locally rendered text, not billing data</p></div>
            <div className="usage-legend" aria-label="Activity intensity"><span>Less</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} data-level={level} />)}<span>More</span></div>
          </div>
          <div className={`activity-map period-${period}`} style={mapStyle} role="grid" aria-label={`${PERIODS.find((item) => item.id === period)?.label} token activity`}>
            {model.cells.map((cell) => <span key={cell.key} role="gridcell" data-level={cell.level} aria-label={cell.label} title={cell.label} />)}
          </div>
          <div className="activity-labels" style={mapStyle} aria-hidden="true">
            {model.labels.map((label) => <span key={`${label.text}-${label.column}`} style={{ gridColumn: label.column }}>{label.text}</span>)}
          </div>
        </section>

        <div className="usage-details">
          <section aria-labelledby="activity-insights-title">
            <h2 id="activity-insights-title">Activity insights</h2>
            <dl className="insight-list">
              <div><dt>Most used reasoning</dt><dd>{reasoning === "—" ? reasoning : reasoning[0].toUpperCase() + reasoning.slice(1)}</dd></div>
              <div><dt>Tools used</dt><dd>{Object.values(toolCounts).reduce((sum, count) => sum + count, 0)}</dd></div>
              <div><dt>Active workspaces</dt><dd>{new Set(filtered.map((event) => event.workspace)).size || (preview ? 2 : 0)}</dd></div>
              <div><dt>Runs</dt><dd>{activeThreads}</dd></div>
              <div title="Estimated from transcript characters"><dt>Average per active block</dt><dd>≈{formatTokens(total / Math.max(1, model.cells.filter((cell) => cell.tokens).length))}</dd></div>
            </dl>
          </section>

          <section aria-labelledby="used-tools-title">
            <h2 id="used-tools-title">Most used tools</h2>
            {tools.length ? <ol className="usage-ranking">
              {tools.map(([tool, count]) => {
                const Icon = TOOL_ICONS[tool] ?? Wrench;
                return <li key={tool}><span className="usage-tool-icon"><Icon size={15} aria-hidden /></span><span>{tool.replaceAll("_", " ")}</span><strong>{count} runs</strong></li>;
              })}
            </ol> : <p className="usage-empty">Tool activity will appear after your first run.</p>}
          </section>

          <section className="usage-agents" aria-labelledby="active-agents-title">
            <h2 id="active-agents-title">Active agents</h2>
            {agents.length ? <ol className="usage-ranking">
              {agents.map(([agent, count]) => <li key={agent}><span className="usage-agent-mark"><AgentMark id={agent as AgentId} size={17} /></span><span>{agent === "muse" ? "Muse" : agent}</span><strong>{count} threads</strong></li>)}
            </ol> : <p className="usage-empty">Agent activity will appear after your first thread.</p>}
          </section>
        </div>
        <p className="usage-note"><Clock3 size={12} aria-hidden />Usage is calculated from locally available thread history.</p>
      </div>
    </Shell>
  );
}
