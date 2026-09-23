import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Activity, ArchiveRestore, Bot, ChartNoAxesColumn, Check, Command, Cpu, Eye, EyeOff, FilePlus, FolderOpen, Info, KeyRound, Lock, MessagesSquare, Monitor, Moon, Palette, PanelLeft, Puzzle, RefreshCw, Search, ShieldCheck, Sun, Trash2, TriangleAlert, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/format";
import { VOCABULARY } from "../lib/effort";
import { AgentMark } from "./AgentPicker";
import { AGENT_IDS, AGENT_LABELS, APPROVAL_DESCRIPTIONS, APPROVAL_LABELS, APPROVAL_ORDER, AUTH_MODE_DESCRIPTIONS, AUTH_MODE_LABELS, AUTH_MODE_ORDER, AUTH_SOURCE_LABELS, AUTH_SOURCE_SHORT, DEFAULT_ENABLED_AGENTS, EFFORT_LABELS, agentEnabled, type AccentColor, type AgentId, type AgentInfo, type ApprovalMode, type AuthMode, type Detection, type HostPosture, type ReasoningEffort, type SandboxNetwork, type ThemeMode, type Settings } from "../lib/types";
import { humanizeModelLabel, humanizeProvider, relativeTime, shortCliVersion, shortHash, shortcutLabel } from "../lib/format";
import { settingsFields } from "../lib/settingsPersistence";
import { applyTheme, currentThread, currentWorkspace, useAppStore } from "../lib/store";
const ExtensionsView = lazy(() => import("./ExtensionsView").then((module) => ({ default: module.ExtensionsView })));
const UsageView = lazy(() => import("./UsageView").then((module) => ({ default: module.UsageView })));
import { LoginPanel } from "./LoginPanel";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

const EFFORTS = VOCABULARY;
const TABS = ["Agents", "Extensions", "Threads", "Theme", "Models", "Account", "Permissions", "Usage", "Shortcuts", "Diagnostics", "About"] as const;
type SettingsTab = (typeof TABS)[number];
const NAV_GROUPS: Array<{ label: string; tabs: SettingsTab[] }> = [
  { label: "Workspace", tabs: ["Models", "Agents", "Extensions", "Threads"] },
  { label: "Preferences", tabs: ["Theme", "Permissions", "Shortcuts"] },
  { label: "Your account", tabs: ["Account", "Usage"] },
  { label: "Application", tabs: ["Diagnostics", "About"] },
];
const TAB_LABELS: Partial<Record<SettingsTab, string>> = { Theme: "Appearance", Models: "Models & reasoning", Permissions: "Permissions & safety", Shortcuts: "Keyboard shortcuts" };
const SEARCH_TERMS: Partial<Record<SettingsTab, string>> = {
  Theme: "light dark system accent color sidebar", Models: "default effort model provider reasoning", Account: "sign in out subscription api key credential binary path connection",
  Permissions: "approval sandbox network shell file writes ephemeral", Threads: "archive restore delete history", Extensions: "skills mcp servers plugins import",
};

/** Tabs with no draft-backed controls; their footer offers Done instead of Save. */
const READ_ONLY_TABS: SettingsTab[] = ["Extensions", "Threads", "Usage", "Shortcuts", "Diagnostics", "About"];

const TAB_COPY: Record<SettingsTab, string> = {
  Agents: "Choose which local coding agents are available in Muse.",
  Extensions: "Skills, MCP servers, and plugins available to Muse.",
  Threads: "Choose how far back the sidebar lists, and clean up old conversations.",
  Theme: "Choose the mode and accent used throughout Muse.",
  Models: "Set the model and reasoning defaults for new conversations.",
  Account: "Choose which Muse credential pays for your sessions.",
  Permissions: "Choose when Muse should ask, and how locked down its host runs.",
  Usage: "Activity across your Muse threads.",
  Shortcuts: "Move around Muse without leaving the keyboard.",
  Diagnostics: "A quick look at the health of this local session.",
  About: "Version and privacy details for Muse Code.",
};

const ACCENTS: Array<{ id: AccentColor; label: string; hex: string }> = [
  { id: "blue", label: "Glacier Mist", hex: "#9DBCF4" },
  { id: "violet", label: "Lavender Fog", hex: "#C5B0E8" },
  { id: "pink", label: "Rosewater", hex: "#E9B3C8" },
  { id: "orange", label: "Peach Sorbet", hex: "#F0B78F" },
  { id: "yellow", label: "Buttercream", hex: "#E9D48F" },
  { id: "green", label: "Sage Leaf", hex: "#A8CEB0" },
  { id: "teal", label: "Sea Glass", hex: "#96CECA" },
];

function tabIcon(tab: SettingsTab) {
  const props = { size: 15, strokeWidth: 1.8, "aria-hidden": true } as const;
  if (tab === "Agents") return <Bot {...props} />;
  if (tab === "Extensions") return <Puzzle {...props} />;
  if (tab === "Threads") return <MessagesSquare {...props} />;
  if (tab === "Usage") return <ChartNoAxesColumn {...props} />;
  if (tab === "Theme") return <Palette {...props} />;
  if (tab === "Models") return <Cpu {...props} />;
  if (tab === "Account") return <KeyRound {...props} />;
  if (tab === "Permissions") return <ShieldCheck {...props} />;
  if (tab === "Shortcuts") return <Command {...props} />;
  if (tab === "Diagnostics") return <Activity {...props} />;
  return <Info {...props} />;
}

function ThemePanel({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const choices: Array<{ id: ThemeMode; label: string; description: string; icon: typeof Monitor }> = [
    { id: "system", label: "System", description: "Match your system", icon: Monitor },
    { id: "light", label: "Light", description: "Bright and crisp", icon: Sun },
    { id: "dark", label: "Dark", description: "Easy on the eyes", icon: Moon },
  ];
  return <div className="theme-panel">
    <section className="theme-section" aria-labelledby="interface-mode-title">
      <div className="theme-section-heading"><h4 id="interface-mode-title">Interface theme</h4><p>Changes preview immediately and save when you choose Save changes.</p></div>
      <div className="theme-choice-grid" role="radiogroup" aria-label="Interface mode">
        {choices.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" role="radio" aria-checked={draft.theme === id} className={`theme-choice ${draft.theme === id ? "selected" : ""}`} onClick={() => onChange({ theme: id })}>
          <span className={`theme-preview theme-preview-${id}`} aria-hidden="true"><span className="theme-preview-sidebar"><i /><i /><i /></span><span className="theme-preview-main"><i /><i /><span /><i /></span></span>
          <span className={`theme-mode-icon theme-mode-icon-${id}`} aria-hidden="true"><Icon size={17} strokeWidth={1.7} /></span>
          <span className="theme-choice-copy"><strong>{label}</strong><span>{description}</span></span>
          <span className="choice-check" aria-hidden="true"><Check size={12} strokeWidth={2.5} /></span>
        </button>)}
      </div>
    </section>

    <section className="theme-section" aria-labelledby="accent-color-title">
      <div className="theme-section-heading"><h4 id="accent-color-title">Accent color</h4><p>Used for selections and highlights in both light and dark mode.</p></div>
      <div className="accent-choice-grid" role="radiogroup" aria-label="Accent color">
        {ACCENTS.map((accent) => <button key={accent.id} type="button" role="radio" aria-checked={draft.accentColor === accent.id} className={`accent-choice accent-${accent.id} ${draft.accentColor === accent.id ? "selected" : ""}`} onClick={() => onChange({ accentColor: accent.id })}>
          <span className="accent-swatch" style={{ backgroundColor: accent.hex }}><Check size={13} aria-hidden="true" /></span>
          <span>{accent.label}</span>
        </button>)}
      </div>
    </section>

    <button type="button" role="switch" aria-checked={draft.accentSidebar} className={`sidebar-accent-option ${draft.accentSidebar ? "selected" : ""}`} onClick={() => onChange({ accentSidebar: !draft.accentSidebar })}>
      <span className="sidebar-accent-icon" aria-hidden="true"><PanelLeft size={19} /></span>
      <span className="sidebar-accent-copy"><strong>Tint the sidebar</strong><span>Use the accent color in the left navigation.</span></span>
      <span className="toggle" aria-hidden="true" aria-checked={draft.accentSidebar}><i /></span>
    </button>
  </div>;
}

const PERMISSION_BADGES: Record<ApprovalMode, string> = {
  onRequest: "Recommended",
  promptUnmatched: "More review",
  denyUnmatched: "Strict",
  allowAll: "No prompts",
};

const PERMISSION_ICONS: Record<ApprovalMode, ReactNode> = {
  onRequest: <ShieldCheck size={15} aria-hidden="true" />,
  promptUnmatched: <ShieldCheck size={15} aria-hidden="true" />,
  denyUnmatched: <Lock size={15} aria-hidden="true" />,
  allowAll: <TriangleAlert size={15} aria-hidden="true" />,
};

const POSTURE_TOGGLES: Array<{ key: "ephemeralSessions" | "disableWrite" | "disableShell"; label: string; help: string }> = [
  { key: "ephemeralSessions", label: "Ephemeral sessions", help: "Memory-only sessions; nothing persists to the session log." },
  { key: "disableWrite", label: "Disable file writes", help: "Block non-shell workspace filesystem writes." },
  { key: "disableShell", label: "Disable shell execution", help: "Block workspace shell execution, including user shells." },
];

const SANDBOX_NETWORKS: Array<{ value: SandboxNetwork; label: string; description: string }> = [
  { value: "proxy-only", label: "Proxy only", description: "Sandboxed network access through the proxy (CLI default)." },
  { value: "restricted", label: "Restricted", description: "Tighter sandbox network limits." },
  { value: "enabled", label: "Enabled", description: "Full sandbox network access." },
];

function PermissionsPanel({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  return <div className="permissions-panel">
    <div className="permission-explainer"><ShieldCheck size={16} aria-hidden="true" /><div><strong>How much should Muse ask?</strong><span>Ask before sensitive actions, allow only saved permissions, or skip prompts entirely.</span></div></div>
    <div className="permission-options" role="radiogroup" aria-label="Default permissions for Muse">
      {APPROVAL_ORDER.filter((mode) => mode !== "allowAll").map((mode) => <button key={mode} type="button" role="radio" aria-checked={draft.defaultApprovalMode === mode} className={`permission-option ${draft.defaultApprovalMode === mode ? "selected" : ""}`} onClick={() => onChange({ defaultApprovalMode: mode })}>
        <span className="permission-radio" aria-hidden="true"><i /></span>
        <span className="permission-icon" aria-hidden="true">{PERMISSION_ICONS[mode]}</span>
        <span className="permission-copy"><span><strong>{APPROVAL_LABELS[mode]}</strong><em>{PERMISSION_BADGES[mode]}</em></span><small>{APPROVAL_DESCRIPTIONS[mode]}</small></span>
      </button>)}
    </div>
    <p className="permission-note">This is the default for new Muse conversations. You can change it per conversation from the composer.</p>
    <p className="permission-note">Skipping all prompts is available per thread from the composer's approval menu.</p>
    <div className="permission-explainer"><Lock size={16} aria-hidden="true" /><div><strong>How locked down is the host?</strong><span>Posture applies when the connection starts; saving a change restarts it.</span></div></div>
    <ul className="agent-list posture-list">
      {POSTURE_TOGGLES.map((item) => (
        <li key={item.key}>
          <span className="model-copy">
            <span className="model-name">{item.label}</span>
            <span className="model-meta">{item.help}</span>
          </span>
          <button type="button" role="switch" aria-checked={draft[item.key]} aria-label={item.label} className="toggle" onClick={() => onChange({ [item.key]: !draft[item.key] } as Partial<Settings>)}><i /></button>
        </li>
      ))}
      <li>
        <span className="model-copy">
          <span className="model-name">Sandbox network</span>
          <span className="model-meta">{SANDBOX_NETWORKS.find((item) => item.value === draft.sandboxNetwork)?.description}</span>
        </span>
        <SelectMenu id="sandbox-network" ariaLabel="Sandbox network mode" value={draft.sandboxNetwork} placeholder="Network mode" options={SANDBOX_NETWORKS} onChange={(value) => onChange({ sandboxNetwork: value as SandboxNetwork })} />
      </li>
    </ul>
    {draft.ephemeralSessions ? <p className="permission-note" role="status">Ephemeral sessions live in memory only: restarting the connection or closing the app loses them.</p> : null}
  </div>;
}

function postureSummary(posture: HostPosture | null | undefined): string {
  if (!posture) return "—";
  const parts: string[] = [];
  if (posture.ephemeralSessions) parts.push("ephemeral sessions");
  if (posture.disableWrite) parts.push("file writes off");
  if (posture.disableShell) parts.push("shell off");
  if (posture.sandboxNetwork !== "proxy-only") parts.push(`network ${posture.sandboxNetwork}`);
  return parts.length ? parts.join(", ") : "default";
}

function connectionSummary(detection: Detection | null): string {
  if (!detection?.found) return "Muse CLI not detected";
  const version = shortCliVersion(detection.version);
  const prefix = version ? `Muse ${version} · ` : "Muse CLI · ";
  if (!detection.authenticated) return `${prefix}sign in needed`;
  return `${prefix}${detection.activeAuth ? AUTH_SOURCE_SHORT[detection.activeAuth] : "signed in"}`;
}

function AuthModePanel({ value, detection, onChange }: { value: AuthMode; detection: Detection | null; onChange: (mode: AuthMode) => void }) {
  const ready: Record<AuthMode, boolean> = {
    auto: Boolean(detection?.subscriptionAvailable || detection?.apiKeyAvailable),
    subscription: Boolean(detection?.subscriptionAvailable),
    apiKey: Boolean(detection?.apiKeyAvailable),
  };
  const status = (mode: AuthMode) => {
    if (mode === "auto") return detection?.activeAuth ? `Using your ${AUTH_SOURCE_LABELS[detection.activeAuth].toLowerCase()}` : "No credential found yet";
    if (ready[mode]) return "Ready";
    return mode === "subscription" ? "Not signed in" : "No key saved";
  };
  return <div className="permission-options" role="radiogroup" aria-label="Muse credential">
    {AUTH_MODE_ORDER.map((mode) => <button key={mode} type="button" role="radio" aria-checked={value === mode} className={`permission-option ${value === mode ? "selected" : ""}`} onClick={() => onChange(mode)}>
      <span className="permission-radio" aria-hidden="true"><i /></span>
      <span className="permission-copy"><span><strong>{AUTH_MODE_LABELS[mode]}</strong><em>{status(mode)}</em></span><small>{AUTH_MODE_DESCRIPTIONS[mode]}</small></span>
    </button>)}
  </div>;
}

function modelKey(model: { modelId: string; providerId?: string }) {
  return JSON.stringify([model.providerId ?? "", model.modelId]);
}

export function SettingsModal() {
  const s = useAppStore(useShallow((state) => ({
    // settingsFields(s) reads the whole Settings slice, so all of it is selected.
    museBin: state.museBin,
    museApiKey: state.museApiKey,
    museAuthMode: state.museAuthMode,
    ephemeralSessions: state.ephemeralSessions,
    disableWrite: state.disableWrite,
    disableShell: state.disableShell,
    sandboxNetwork: state.sandboxNetwork,
    theme: state.theme,
    accentColor: state.accentColor,
    accentSidebar: state.accentSidebar,
    defaultModel: state.defaultModel,
    defaultProviderId: state.defaultProviderId,
    defaultEffort: state.defaultEffort,
    defaultApprovalMode: state.defaultApprovalMode,
    defaultAgentId: state.defaultAgentId,
    enabledAgents: state.enabledAgents,
    acpUnisolatedConsent: state.acpUnisolatedConsent,
    notifications: state.notifications,
    workspaces: state.workspaces,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    settingsOpen: state.settingsOpen,
    preview: state.preview,
    detection: state.detection,
    hostInfo: state.hostInfo,
    hostTrust: state.hostTrust,
    models: state.models,
    agents: state.agents,
    agentIdentities: state.agentIdentities,
    enterprise: state.enterprise,
    enterpriseLoading: state.enterpriseLoading,
    enterpriseError: state.enterpriseError,
    listSince: state.listSince,
    commitSettings: state.commitSettings,
    refreshDetection: state.refreshDetection,
    startHost: state.startHost,
    signOut: state.signOut,
    setSettingsOpen: state.setSettingsOpen,
    refreshAgentIdentities: state.refreshAgentIdentities,
    refreshEnterprise: state.refreshEnterprise,
    confirmAgentBin: state.confirmAgentBin,
    openInitDialog: state.openInitDialog,
    untrustWorkspace: state.untrustWorkspace,
    openTrustDialog: state.openTrustDialog,
    setListSince: state.setListSince,
    selectWorkspace: state.selectWorkspace,
    archiveThread: state.archiveThread,
    deleteThread: state.deleteThread,
    confirm: state.confirm,
  })));
  const thread = currentThread(s);
  const workspace = currentWorkspace(s);
  const dialog = useRef<HTMLDialogElement>(null);
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<SettingsTab>("Models");
  const [search, setSearch] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scanning, setScanning] = useState(false);
  const [draft, setDraft] = useState<Settings>(() => settingsFields(s));
  const edit = (patch: Partial<Settings>) => setDraft((value) => ({ ...value, ...patch }));
  const editTheme = (patch: Partial<Settings>) => setDraft((value) => {
    const next = { ...value, ...patch };
    applyTheme(next.theme, next.accentColor, next.accentSidebar);
    return next;
  });
  const dirty = JSON.stringify(settingsFields(draft)) !== JSON.stringify(settingsFields(s));
  const visibleTabs = TABS.filter((item) => `${item} ${TAB_LABELS[item] ?? ""} ${TAB_COPY[item]} ${SEARCH_TERMS[item] ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); }, [tab]);
  useEffect(() => () => {
    const saved = useAppStore.getState();
    applyTheme(saved.theme, saved.accentColor, saved.accentSidebar);
  }, []);
  const [showKey, setShowKey] = useState(false);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (s.settingsOpen) { if (!node.open) node.showModal(); }
    else if (node.open) node.close();
  }, [s.settingsOpen]);
  useEffect(() => {
    if (s.settingsOpen) { setDraft(settingsFields(useAppStore.getState())); setNotice(""); setShowKey(false); setTab("Models"); }
  }, [s.settingsOpen]);
  const [confirming, setConfirming] = useState<AgentId | null>(null);
  useEffect(() => {
    if (s.settingsOpen && tab === "Agents") void s.refreshAgentIdentities();
    if (s.settingsOpen && tab === "Diagnostics" && !s.preview) void s.refreshEnterprise();
  }, [s.settingsOpen, tab]);
  const modelOptions: SelectMenuOption[] = s.models.map((model) => ({
    value: modelKey(model),
    label: humanizeModelLabel(model.modelId, model.displayLabel),
    description: humanizeProvider(model.providerId),
  }));
  const defaultModelValue = draft.defaultModel ? modelKey({ modelId: draft.defaultModel, providerId: draft.defaultProviderId }) : undefined;
  const modelByKey = new Map(s.models.map((model) => [modelKey(model), model]));
  if (defaultModelValue && !modelByKey.has(defaultModelValue)) {
    modelOptions.push({ value: defaultModelValue, label: humanizeModelLabel(draft.defaultModel), description: humanizeProvider(draft.defaultProviderId) });
  }
  const settingsPatch = () => {
    const { workspaces: _workspaces, ...settings } = draft;
    return { ...settings, museApiKey: draft.museApiKey.trim(), museBin: draft.museBin.trim() };
  };
  const saveAndClose = async () => {
    setConnecting(true); setNotice("");
    try {
      const before = useAppStore.getState();
      const had = [before.ephemeralSessions, before.disableWrite, before.disableShell, before.sandboxNetwork] as const;
      await s.commitSettings(settingsPatch());
      const after = useAppStore.getState();
      // Posture is host-construction: a changed posture restarts the
      // connection so the settings always describe the running host.
      const postureChanged = had[0] !== after.ephemeralSessions || had[1] !== after.disableWrite || had[2] !== after.disableShell || had[3] !== after.sandboxNetwork;
      if (postureChanged && !after.preview && after.hostInfo) await after.startHost();
      s.setSettingsOpen(false);
    } catch (error) { setNotice(`Could not save settings: ${String(error)}`); }
    finally { setConnecting(false); }
  };
  const discardAndClose = () => {
    if (connecting) return;
    setNotice("");
    applyTheme(s.theme, s.accentColor, s.accentSidebar);
    s.setSettingsOpen(false);
  };
  const reconnect = async () => {
    if (s.preview) { setNotice("Preview mode — no live session to connect. Exit preview in the sidebar to use a real workspace."); return; }
    setConnecting(true); setNotice("");
    try {
      await s.commitSettings(settingsPatch());
      await s.refreshDetection();
      const detection = useAppStore.getState().detection;
      if (!detection?.found) throw new Error("Muse CLI was not found. Install it or set a custom binary path above.");
      if (!detection.authenticated) {
        throw new Error(draft.museAuthMode === "subscription"
          ? "No Muse Code sign-in was found. Use Sign in with Meta above, then try again."
          : draft.museAuthMode === "apiKey"
            ? "No Muse API key was found. Paste one above and try again."
            : "No Muse credential was found. Sign in above, or paste an API key.");
      }
      await s.startHost(true);
      s.setSettingsOpen(false);
    } catch (error) { setNotice(`Connection failed: ${String(error)}`); }
    finally { setConnecting(false); }
  };
  const allAgents = s.agents.length ? s.agents : AGENT_IDS.map((id): AgentInfo => ({ id, name: AGENT_LABELS[id], protocol: id === "muse" ? "msp" : "acp", found: false, path: null, version: null, verified: id === "muse" || id === "opencode" || id === "grok", signIn: "" }));
  const installedAgents = allAgents.filter((agent) => agent.found);
  const unavailableAgents = allAgents.filter((agent) => !agent.found);
  const readyAgents = installedAgents.filter((agent) => agentEnabled(draft, agent.id) && (agent.id !== "muse" || agent.authenticated));
  const copyDiagnostics = async () => {
    const lines = [
      "Muse Desktop 0.1.0",
      `Muse CLI: ${s.detection?.version ?? "unknown"}`,
      `CLI path: ${s.detection?.path ?? "not detected"}`,
      `Host running: ${s.detection?.running ? "yes" : "no"}`,
      `Protocol: ${s.hostInfo?.compat ? `${s.hostInfo.compat.state} (SDK ${s.hostInfo.compat.sdk}; served ${s.hostInfo.compat.served ?? "none"})` : "unknown"}`,
      `Granted: ${s.hostInfo?.compat?.granted.join(", ") || "none"}`,
      `Durability: ${s.hostInfo?.durability ?? "unknown"}`,
      `Posture: ${postureSummary(s.hostInfo?.posture)}`,
      `Credential: ${s.detection?.activeAuth ? AUTH_SOURCE_LABELS[s.detection.activeAuth] : "none detected"}`,
      `Workspace: ${workspace?.path ?? "none"}`,
      `Session: ${thread?.sessionId ?? "none"}`,
      `Agent: ${thread?.agentId ?? "muse"}`,
      `Thread state: ${thread?.status ?? "none"}`,
      `Threads in memory: ${s.threads.length}`,
      `Child environment: ${s.hostInfo?.isolation?.env ?? "minimal"}`,
      `OS sandbox: ${s.hostInfo?.isolation ? s.hostInfo.isolation.osSandbox : "unknown — not verifiable on this platform"}`,
      `ACP isolation consent: ${s.acpUnisolatedConsent ? "yes" : "no"}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setNotice("Diagnostics copied. No credentials or prompt contents were included.");
    } catch (error) {
      setNotice(`Could not copy diagnostics: ${String(error)}`);
    }
  };
  return <dialog ref={dialog} className="modal settings-dialog" aria-labelledby="settings-title" aria-hidden={!s.settingsOpen} onCancel={(event) => { event.preventDefault(); discardAndClose(); }} onClose={() => s.setSettingsOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) discardAndClose(); } }}>
    <header className="settings-header">
      <div className="settings-brand"><span className="settings-brand-mark"><img src="/spark.svg" alt="" /></span><div><h2 id="settings-title">Settings</h2><p>Make Muse your own</p></div></div>
      <button type="button" className="icon-btn settings-close" aria-label="Close settings" onClick={discardAndClose}><X size={17} /></button>
    </header>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings categories">
        <div className="settings-search"><Search size={14} aria-hidden="true" /><input aria-label="Search settings" placeholder="Find a setting…" value={search} onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" aria-label="Clear settings search" onClick={() => setSearch("")}><X size={12} /></button> : null}</div>
        <div className="settings-nav-groups">
          {NAV_GROUPS.map((group) => {
            const matches = group.tabs.filter((item) => visibleTabs.includes(item));
            return matches.length ? <div className="settings-nav-group" key={group.label}><span className="settings-nav-label">{group.label}</span>{matches.map((item) => <button key={item} type="button" title={TAB_LABELS[item] ?? item} aria-label={item} aria-current={tab === item ? "page" : undefined} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabIcon(item)}<span>{TAB_LABELS[item] ?? item}</span></button>)}</div> : null;
          })}
          {!visibleTabs.length ? <p className="settings-search-empty" role="status">No settings found. Try “theme” or “model”.</p> : null}
        </div>
        <div className="settings-version"><span>Muse Code</span><span>Desktop 0.1.0</span></div>
      </nav>
      <fieldset disabled={connecting} className="settings-fields settings-content">
        <div className="settings-section-head"><span className="settings-eyebrow">{NAV_GROUPS.find((group) => group.tabs.includes(tab))?.label}</span><h3 id="settings-page-title">{TAB_LABELS[tab] ?? tab}</h3><p>{TAB_COPY[tab]}</p></div>
        <div ref={bodyRef} className={`settings-section-body settings-page-${tab.toLowerCase()}`} role="region" aria-labelledby="settings-page-title" tabIndex={0}>
        {tab === "Account" ? <>
          <div className="settings-card-heading"><h4>How you connect</h4><p>Choose the credential Muse uses for your sessions.</p></div>
          <AuthModePanel value={draft.museAuthMode} detection={s.detection} onChange={(mode) => edit({ museAuthMode: mode })} />
          {draft.museAuthMode === "subscription" && s.detection?.found && !s.detection.subscriptionAvailable
            ? <><p className="permission-note" role="status">No Muse Code sign-in found. Sign in below, then choose Save &amp; restart connection.</p><LoginPanel /></>
            : <p className="permission-note">Subscription sessions use the sign-in stored by the Muse CLI. Choosing it clears <code>META_API_KEY</code> for the local Muse process so your plan is billed instead of the API.</p>}
          <div className="connection-explainer"><RefreshCw size={16} aria-hidden="true" /><div><strong>When is a connection restart needed?</strong><span>Only after changing the credential, the API key, or the binary path. Save &amp; restart connection briefly restarts the local Muse process so it uses these values. It does not restart the app or delete conversations.</span></div></div>
          <div className="settings-card-heading"><h4>Connection details</h4><p>Manage your API key and local Muse installation.</p></div>
          <section className="settings-card" aria-label="Connection details">
          <div className="field"><label htmlFor="muse-api-key">Muse API key</label><div className="input-with-action"><input id="muse-api-key" type={showKey ? "text" : "password"} value={draft.museApiKey} placeholder="Paste API key to connect" autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} onChange={(event) => edit({ museApiKey: event.target.value })} /><button type="button" className="icon-btn input-action" aria-label={showKey ? "Hide API key" : "Show API key"} aria-pressed={showKey} title={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><span className="field-help">Saved in your system credential store. A saved key appears as dots and is never returned to the interface. Replace the dots to change it, or clear the field to remove it.</span></div>
          <div className="field"><label htmlFor="muse-bin">Muse binary (optional)</label><input id="muse-bin" value={draft.museBin} placeholder="Auto-detect from PATH" spellCheck={false} onChange={(event) => edit({ museBin: event.target.value })} /><span className="field-help">Full path to a muse executable. Temporary directories are rejected.</span></div>
          {s.detection?.authenticated ? <div className="field"><span className="field-label-row"><label>Sign out</label></span><div><button type="button" className="ghost-btn small" disabled={connecting} onClick={() => { void s.confirm({ title: "Sign out of Muse on this device?", body: "The saved credential and API key are removed and open sessions close.", confirmLabel: "Sign out", danger: true }).then((ok) => { if (ok) { setConnecting(true); setNotice(""); void s.signOut().then(() => { setDraft((prev) => ({ ...prev, museApiKey: "" })); setNotice("Signed out. Sign in again to reconnect."); }).catch((error) => setNotice(`Sign-out failed: ${String(error)}`)).finally(() => setConnecting(false)); } }); }}>Sign out of Muse</button></div><span className="field-help">Removes the CLI credential and the API key stored on this device, and closes open sessions.</span></div> : null}
          </section>
        </> : null}
        {tab === "Theme" ? <ThemePanel draft={draft} onChange={editTheme} /> : null}
        {tab === "Models" ? <>
          <div className="settings-card-heading"><h4>Conversation defaults</h4><p>A starting point for every new conversation. You can adjust these in the composer.</p></div>
          <section className="settings-card" aria-label="Conversation defaults">
          <div className="field"><div className="field-label-row"><label htmlFor="default-model">Default model</label>{draft.defaultModel ? <button className="text-btn" type="button" onClick={() => edit({ defaultModel: "", defaultProviderId: undefined })}>Use host default</button> : null}</div><SelectMenu id="default-model" ariaLabel="Default model" value={defaultModelValue} placeholder={s.models.length ? "Use host default" : "Connect to load models"} options={modelOptions} disabled={!s.models.length && !draft.defaultModel} onChange={(value) => { const model = modelByKey.get(value); if (model) edit({ defaultModel: model.modelId, defaultProviderId: model.providerId }); }} /></div>
          <div className="field"><label htmlFor="default-effort">Default reasoning effort</label><SelectMenu id="default-effort" ariaLabel="Default reasoning effort" value={draft.defaultEffort} placeholder="Use host default" options={EFFORTS.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))} onChange={(value) => edit({ defaultEffort: value as ReasoningEffort })} /></div>
          </section>
          <div className="settings-tip"><Cpu size={18} aria-hidden="true" /><div><strong>Find your balance</strong><p>Higher reasoning effort gives the model more time to work through complex tasks. Lower effort works well for quick edits and everyday questions.</p></div></div>
        </> : null}
        {tab === "Agents" ? <div className="agents-panel">
          <div className="agents-toolbar"><span>Shown agents appear in the composer. At least one ready agent stays enabled.</span><button type="button" className="ghost-btn small" disabled={scanning} onClick={() => { setScanning(true); void s.refreshDetection().finally(() => setScanning(false)); }}><RefreshCw size={11} className={scanning ? "spin" : ""} />{scanning ? "Scanning…" : "Rescan"}</button></div>
          <label className="permission-note isolation-consent">
            <input type="checkbox" checked={draft.acpUnisolatedConsent === true} onChange={(event) => {
              const acpUnisolatedConsent = event.target.checked;
              const enabledAgents = acpUnisolatedConsent ? draft.enabledAgents : { ...DEFAULT_ENABLED_AGENTS, ...draft.enabledAgents, opencode: false, grok: false, gemini: false, qwen: false, goose: false };
              edit({ acpUnisolatedConsent, enabledAgents, ...(acpUnisolatedConsent || draft.defaultAgentId === "muse" || !draft.defaultAgentId ? {} : { defaultAgentId: undefined }) });
            }} />
            <span>Third-party agents are <strong>not OS-sandboxed</strong>. They inherit a minimal environment and the selected workspace, but can still read this account. I understand and want to enable them.</span>
          </label>
          <ul className="agent-list">
            {installedAgents.map((agent) => {
              const on = agentEnabled(draft, agent.id);
              const ready = agent.id !== "muse" || agent.authenticated;
              const lastOn = on && ready && readyAgents.length <= 1;
              const needsConsent = agent.id !== "muse" && !on && !draft.acpUnisolatedConsent;
              const locked = lastOn || needsConsent;
              const gated = needsConsent ? "Accept the isolation notice above to show this agent" : lastOn ? "Keep at least one ready agent enabled" : null;
              const identity = agent.id === "muse" ? undefined : s.agentIdentities.find((item) => item.agentId === agent.id);
              return <li key={agent.id} className={on ? "" : "off"}>
                <AgentMark id={agent.id} size={26} />
                <span className="model-copy">
                  <span className="model-name">{agent.name}{agent.version ? <span className="picker-tag">v{agent.version}</span> : null}{!agent.verified ? <span className="picker-tag">Experimental</span> : null}{identity?.changed ? <span className="picker-tag warm">Binary changed</span> : null}</span>
                  <span className="model-meta">{ready ? needsConsent ? "Hidden — accept the isolation notice above to enable" : on ? "Available in the composer" : "Hidden from the composer" : agent.signIn || "Sign in required"}</span>
                  {identity?.path ? <span className="model-meta identity-path" title={identity.path}>{identity.path}</span> : null}
                  {identity?.changed ? <span className="model-meta identity-changed">This binary moved or changed since it was trusted. Review the path, then <button type="button" className="text-btn" disabled={confirming === agent.id} onClick={() => { setConfirming(agent.id); setNotice(""); void s.confirmAgentBin(agent.id).then(() => setNotice(`${agent.name} binary trusted.`)).catch((error) => setNotice(`Could not trust binary: ${String(error)}`)).finally(() => setConfirming(null)); }}>{confirming === agent.id ? "Trusting…" : "trust this binary"}</button>.</span> : null}
                </span>
                <span className={`agent-state ${!ready ? "warn" : on ? "on" : "off"}`}>{!ready ? "Sign in" : on ? "Ready" : "Hidden"}</span>
                <span className="toggle-anchor" title={gated ?? (on ? `Hide ${agent.name} from the composer` : `Show ${agent.name} in the composer`)}>
                  <button type="button" role="switch" aria-checked={on} aria-label={`${on ? "Hide" : "Show"} ${agent.name} in the composer`} className="toggle" disabled={locked} onClick={() => {
                    const enabledAgents = { ...DEFAULT_ENABLED_AGENTS, ...draft.enabledAgents, [agent.id]: !on };
                    edit({ enabledAgents, ...(on && draft.defaultAgentId === agent.id ? { defaultAgentId: undefined } : {}) });
                  }}><i /></button>
                </span>
              </li>;
            })}
            {!installedAgents.length ? <li className="missing"><span className="model-meta">No supported coding agents found</span></li> : null}
          </ul>
          <section className="agent-default-section" aria-labelledby="default-agent-title"><div><h4 id="default-agent-title">Default for new conversations</h4><p>Automatic uses the first ready agent.</p></div><div className="agent-default-options" role="radiogroup" aria-label="Default agent for new conversations"><button type="button" role="radio" aria-checked={!draft.defaultAgentId} className={!draft.defaultAgentId ? "selected" : ""} onClick={() => edit({ defaultAgentId: undefined })}>Automatic</button>{readyAgents.map((agent) => <button key={agent.id} type="button" role="radio" aria-checked={draft.defaultAgentId === agent.id} className={draft.defaultAgentId === agent.id ? "selected" : ""} onClick={() => edit({ defaultAgentId: agent.id as AgentId })}><AgentMark id={agent.id} size={16} />{agent.name}</button>)}</div></section>
          <section className="agent-default-section" aria-labelledby="workspace-config-title">
            <div><h4 id="workspace-config-title">Workspace agent config</h4><p>{workspace ? `Create or refresh AGENTS.md in ${workspace.name}.` : "Open a workspace to set up its AGENTS.md."}</p></div>
            <button type="button" className="ghost-btn small" disabled={!workspace?.grantId} title={workspace?.grantId ? "Preview and write AGENTS.md" : "This workspace has no access grant"} onClick={() => { s.setSettingsOpen(false); if (workspace) void s.openInitDialog(workspace.id); }}>
              <FilePlus size={11} />Set up AGENTS.md
            </button>
          </section>
          {unavailableAgents.length ? <details className="unavailable-agents"><summary>Not installed ({unavailableAgents.length})</summary><ul>{unavailableAgents.map((agent) => <li key={agent.id}><AgentMark id={agent.id} size={20} /><span>{agent.name}</span>{!agent.verified ? <span className="picker-tag">Experimental</span> : null}</li>)}</ul></details> : null}
        </div> : null}
        {tab === "Threads" ? <div className="archive-panel">
          <div className="field">
            <label htmlFor="list-since">Show threads updated within</label>
            <SelectMenu
              id="list-since"
              ariaLabel="Show threads updated within"
              value={s.listSince ?? "all"}
              placeholder="All time"
              options={[
                { value: "all", label: "All time" },
                { value: "day", label: "Last day" },
                { value: "week", label: "Last week" },
                { value: "month", label: "Last month" },
              ]}
              onChange={(value) => {
                s.setListSince(value === "all" ? null : value as "day" | "week" | "month");
                if (workspace) void s.selectWorkspace(workspace.id);
              }}
            />
            <span className="field-help">A narrower window lists fewer sessions per workspace, which keeps very large histories quick to load.</span>
          </div>
          <div className="field">
            <span className="field-label-row"><label id="notifications-label">Notifications</label><button type="button" role="switch" aria-labelledby="notifications-label" aria-checked={s.notifications !== false} className="toggle" onClick={() => void s.commitSettings({ notifications: !(s.notifications !== false) })}><i /></button></span>
            <span className="field-help">Notify when a turn finishes or needs approval while you're elsewhere.</span>
          </div>
          <div className="settings-card-heading"><h4>Archived conversations</h4></div>
          <div className="field-label-row">
            <span className="field-help">Threads you archived in an earlier version are hidden from the sidebar. Restore them here, or delete them from this app. Deleting does not erase the session on the agent CLI.</span>
            {s.threads.some((thread) => thread.archived) ? (
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => {
                  const count = s.threads.filter((thread) => thread.archived).length;
                  void s.confirm({ title: `Delete ${count} archived thread${count === 1 ? "" : "s"} from Muse Code?`, confirmLabel: "Delete all", danger: true }).then((ok) => {
                    if (!ok) return;
                    for (const thread of s.threads.filter((item) => item.archived)) s.deleteThread(thread.sessionId);
                  });
                }}
              >
                <Trash2 size={11} />Delete all
              </button>
            ) : null}
          </div>
          <ul className="archive-list">
            {s.threads.filter((thread) => thread.archived).slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((thread) => {
              const workspace = s.workspaces.find((item) => item.path === thread.workspacePath);
              return (
                <li key={thread.sessionId}>
                  {thread.agentId ? <AgentMark id={thread.agentId} size={22} /> : <AgentMark id="muse" size={22} />}
                  <span className="model-copy">
                    <span className="model-name">{thread.title}</span>
                    <span className="model-meta">{workspace?.name ?? thread.workspacePath} · {relativeTime(thread.updatedAt)}</span>
                  </span>
                  <button type="button" className="ghost-btn small" onClick={() => s.archiveThread(thread.sessionId, false)}><ArchiveRestore size={11} />Restore</button>
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => {
                      void s.confirm({ title: `Delete “${thread.title}” from Muse Code?`, confirmLabel: "Delete", danger: true }).then((ok) => { if (ok) s.deleteThread(thread.sessionId); });
                    }}
                  >
                    <Trash2 size={11} />Delete
                  </button>
                </li>
              );
            })}
            {!s.threads.some((thread) => thread.archived) ? <li className="missing"><ArchiveRestore size={25} aria-hidden="true" /><span><strong>All caught up</strong><span className="model-meta">Archived threads will appear here. Your active conversations are in the sidebar.</span></span></li> : null}
          </ul>
        </div> : null}
        {tab === "Extensions" ? <Suspense fallback={null}><ExtensionsView embedded /></Suspense> : null}
        {tab === "Usage" ? <Suspense fallback={null}><UsageView embedded /></Suspense> : null}
        {tab === "Permissions" ? <PermissionsPanel draft={draft} onChange={edit} /> : null}
        {tab === "Shortcuts" ? <ul className="shortcut-list">
          <li><span>Command palette</span><kbd>{shortcutLabel("K")}</kbd></li>
          <li><span>New thread</span><kbd>{shortcutLabel("N")}</kbd></li>
          <li><span>Settings</span><kbd>{shortcutLabel(",")}</kbd></li>
          <li><span>Search threads</span><kbd>{shortcutLabel("F")}</kbd></li>
          <li><span>Open workspace</span><kbd>{shortcutLabel("P")}</kbd></li>
          <li><span>Toggle sidebar</span><kbd>{shortcutLabel("B")}</kbd></li>
          <li><span>Toggle changes</span><kbd>{shortcutLabel("I")}</kbd></li>
          <li><span>Send</span><kbd>Enter</kbd></li>
          <li><span>Newline</span><kbd>⇧Enter</kbd></li>
          <li><span>Approve first choice</span><kbd>{shortcutLabel("Y")}</kbd></li>
          <li><span>Approve wider scope</span><kbd>{shortcutLabel("⇧Y")}</kbd></li>
          <li><span>Deny approval</span><kbd>{shortcutLabel("⌫")}</kbd></li>
        </ul> : null}
        {tab === "Diagnostics" ? <div className="diagnostics">
          <p className="muted" title={s.detection?.path ?? undefined}>{s.preview ? "Preview mode — no live session commands" : connectionSummary(s.detection)}</p>
          <p className="muted"><span className="diagnostic-label">Muse CLI</span><span className="diagnostic-value">{s.detection?.version ?? "unknown"}{s.detection?.path ? ` (${s.detection.path})` : ""}</span></p>
          <p className="muted"><span className="diagnostic-label">Host running</span><span className="diagnostic-value">{s.detection?.running ? "yes" : "no"}</span></p>
          <p className="muted" title={s.hostInfo?.compat ? `SDK pins ${s.hostInfo.compat.pinned}; host served ${s.hostInfo.compat.served ?? "no fingerprint"}` : undefined}><span className="diagnostic-label">Protocol</span><span className="diagnostic-value">{s.hostInfo?.compat ? s.hostInfo.compat.state === "match" ? `match (SDK ${s.hostInfo.compat.sdk})` : s.hostInfo.compat.state === "mismatch" ? `mismatch — host print differs from SDK ${s.hostInfo.compat.sdk} pin` : "unknown — host sent no fingerprint" : "unknown — start the host to check"}</span></p>
          <p className="muted"><span className="diagnostic-label">Granted</span><span className="diagnostic-value">{s.hostInfo?.compat ? (s.hostInfo.compat.granted.length ? s.hostInfo.compat.granted.join(", ") : "none") : "—"}</span></p>
          <p className="muted"><span className="diagnostic-label">Durability</span><span className="diagnostic-value">{s.hostInfo?.durability ?? "—"}</span></p>
          <p className="muted" title="Host-construction flags: ephemeral sessions, write/shell hardening, sandbox network mode"><span className="diagnostic-label">Posture</span><span className="diagnostic-value">{postureSummary(s.hostInfo?.posture)}</span></p>
          <p className="muted" title={s.enterprise?.generation ?? undefined}><span className="diagnostic-label">Enterprise</span><span className="diagnostic-value">{s.enterpriseLoading ? "reading…" : s.enterpriseError ? `unavailable — ${s.enterpriseError}` : s.enterprise?.generation ? `generation ${shortHash(s.enterprise.generation)}` : "no managed configuration"}{s.enterprise && !s.enterpriseLoading && !s.enterpriseError ? ` · ${s.enterprise.sources.filter((source) => source.state !== "absent").length} of ${s.enterprise.sources.length} planes active` : ""}</span></p>
          {s.enterprise && !s.enterpriseLoading && !s.enterpriseError && s.enterprise.sources.some((source) => source.state !== "absent") ? <p className="muted"><span className="diagnostic-label">Active planes</span><span className="diagnostic-value">{s.enterprise.sources.filter((source) => source.state !== "absent").map((source) => `${source.plane}/${source.sourceClass}`).join(", ")}</span></p> : null}
          <p className="muted" title="Trusted hosts load the selected workspace's skills and rules"><span className="diagnostic-label">Workspace trust</span><span className="diagnostic-value">{s.hostInfo == null ? "—" : (s.hostTrust ?? s.hostInfo.trustWorkspace) ? "trusted — skills and rules load" : "untrusted — skills and rules do not load"}{workspace?.grantId ? <> · <button type="button" className="text-btn" onClick={() => { if (workspace.trusted) { void s.confirm({ title: `Stop trusting ${workspace.name}?`, body: "Its skills and rules will no longer load.", confirmLabel: "Stop trusting", danger: true }).then((ok) => { if (ok) void s.untrustWorkspace(workspace.id); }); } else { void s.openTrustDialog(workspace.id); } }}>{workspace.trusted ? "untrust" : "trust this workspace"}</button></> : null}</span></p>
          <p className="muted" title={workspace?.path}><span className="diagnostic-label">Workspace</span><span className="diagnostic-value">{workspace?.name ?? "none open"}</span></p>
          <p className="muted" title={thread?.sessionId}><span className="diagnostic-label">Session</span><span className="diagnostic-value">{thread ? `${thread.title} · ${thread.status}` : "none open"}</span></p>
          <p className="muted"><span className="diagnostic-label">Agent</span><span className="diagnostic-value">{thread ? AGENT_LABELS[thread.agentId ?? "muse"] : "none"}</span></p>
          <p className="muted" title={s.hostInfo?.isolation?.cwd}><span className="diagnostic-label">Child environment</span><span className="diagnostic-value">{s.hostInfo?.isolation?.env ?? "minimal"} · OS sandbox: {s.hostInfo?.isolation ? `${s.hostInfo.isolation.osSandbox} (${s.hostInfo.isolation.platform})` : "unknown — not verifiable until the host starts"}</span></p>
          <p className="muted"><span className="diagnostic-label">ACP isolation consent</span><span className="diagnostic-value">{s.acpUnisolatedConsent ? "yes — third-party agents may start" : "no — third-party agents stay off"}</span></p>
          <p className="muted"><span className="diagnostic-label">Workspaces</span><span className="diagnostic-value">{s.workspaces.length}</span></p>
          <p className="muted"><span className="diagnostic-label">Threads in memory</span><span className="diagnostic-value">{s.threads.length}</span></p>
          <div className="row">
            <button type="button" className="ghost-btn small" onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
            {isTauri() ? <button type="button" className="ghost-btn small" onClick={() => void invoke<string>("open_log_folder").then((path) => setNotice(`Opened logs. Current file: ${path}`)).catch((error) => setNotice(`Could not open logs: ${String(error)}`))}><FolderOpen size={11} />Open logs</button> : null}
          </div>
        </div> : null}
        {tab === "About" ? <div className="about">
          <div className="about-identity"><span className="about-mark"><img src="/spark.svg" alt="" /></span><h4>Muse Code</h4><span className="about-version">Desktop version 0.1.0</span></div>
          <p className="muted" title={s.detection?.path ?? undefined}>Muse CLI {s.detection?.version ? shortCliVersion(s.detection.version) : "not detected"}</p>
          <h4 className="about-section-title">Your local coding companion</h4><p>Unofficial local command center for Muse Code. Not affiliated with Meta.</p>
          <h4 className="about-section-title">Privacy &amp; your data</h4><p className="muted">Muse stays the engine. This app is a GUI over your installed CLI: it sends prompts and project context to the local Muse process, which in turn uses its configured model service under that provider&apos;s data policy.</p>
        </div> : null}
        </div>
      </fieldset>
    </div>
    {notice ? <p className="settings-notice" role="status">{notice}</p> : null}
    <footer className="settings-footer">
      <span className="settings-connection" title={s.detection?.path ?? undefined}><i className={s.detection?.found ? "connected" : ""} />{s.preview ? "Preview mode" : connectionSummary(s.detection)}</span>
      <div className="row"><span className="settings-save-status" role="status">{dirty ? "Unsaved changes" : READ_ONLY_TABS.includes(tab) ? "" : "Changes save when you’re ready"}</span><button className="ghost-btn" disabled={connecting} onClick={discardAndClose}>Cancel</button>{tab === "Account" ? <button className="primary accent" disabled={connecting} onClick={() => void reconnect()}>{connecting ? "Restarting…" : "Save & restart connection"}</button> : READ_ONLY_TABS.includes(tab) && !dirty ? <button className="primary accent" disabled={connecting} onClick={discardAndClose}>Done</button> : <button className="primary accent" disabled={connecting} onClick={() => void saveAndClose()}>{connecting ? "Saving…" : "Save changes"}</button>}</div>
    </footer>
  </dialog>;
}
