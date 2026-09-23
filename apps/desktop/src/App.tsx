import { lazy, Suspense, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle } from "lucide-react";
import { activeAgentId, activeConfig, applyTheme, bindBridgeEvents, reconcileRunningThreads, useAppStore } from "./lib/store";
import { isTauri } from "./lib/format";
import { defaultTier, isPeak, modelFor, tiersFor } from "./lib/effort";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { EffortRipple } from "./components/EffortRipple";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ImageViewer } from "./components/ImageViewer";
import { Onboarding } from "./components/Onboarding";
import { OutputModal } from "./components/OutputModal";
import { PreviewModal } from "./components/PreviewModal";
import { SubagentModal } from "./components/SubagentModal";
import { InitModal } from "./components/InitModal";
import { TrustModal } from "./components/TrustModal";
import { ReviewDock } from "./components/ReviewDock";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import "./styles.css";
import "./settings.css";

const SettingsModal = lazy(() => import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal })));

function useDesktopShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        const state = useAppStore.getState();
        if (state.paletteOpen) { event.preventDefault(); state.setPaletteOpen(false); return; }
        if (state.settingsOpen) { event.preventDefault(); state.setSettingsOpen(false); }
        return;
      }
      if (!meta) return;
      // In the desktop shell the native menu owns these accelerators and
      // consumes the key before the webview; keep the JS paths for the browser
      // preview only so they cannot fire twice.
      if (!isTauri()) {
        if (event.key.toLowerCase() === "k") { event.preventDefault(); useAppStore.getState().setPaletteOpen(true); }
        if (event.key.toLowerCase() === "n") { event.preventDefault(); void useAppStore.getState().newThread(); }
        if (event.key === ",") { event.preventDefault(); useAppStore.getState().setSettingsOpen(true); }
        if (event.key.toLowerCase() === "b") { event.preventDefault(); const state = useAppStore.getState(); state.setSidebarCollapsed(!state.sidebarCollapsed); }
        if (event.key.toLowerCase() === "i") { event.preventDefault(); const state = useAppStore.getState(); state.setDockOpen(!state.dockOpen); }
        if (event.key.toLowerCase() === "f") { event.preventDefault(); document.getElementById("thread-search")?.focus(); }
        if (event.key.toLowerCase() === "p") { event.preventDefault(); void useAppStore.getState().chooseProject(); }
      }
      // Approval decisions: mod+Y takes the first allow choice, mod+Shift+Y the
      // wider-scoped second, mod+Backspace the first deny. Never fires while
      // typing, while a decision is in flight, or past the host deadline.
      if (event.key.toLowerCase() === "y" || event.key === "Backspace") {
        const state = useAppStore.getState();
        const thread = state.threads.find((item) => item.sessionId === state.selectedSessionId);
        const approval = thread?.pendingApproval;
        const target = event.target as HTMLElement | null;
        const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable === true;
        if (!approval || thread?.approvalPending || editable) return;
        if (approval.expiresAt != null && approval.expiresAt <= Date.now()) return;
        const allow = approval.availableChoices.filter((choice) => !choice.decision.startsWith("denied"));
        const deny = approval.availableChoices.filter((choice) => choice.decision.startsWith("denied"));
        const choice = event.key === "Backspace" ? deny[0] : event.shiftKey ? allow[1] : allow[0];
        if (!choice) return;
        event.preventDefault();
        void state.decide(approval.approvalId, choice.choiceId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Native menu items arrive as `app-menu` events carrying the item id. */
function useAppMenu() {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ id: string }>("app-menu", (event) => {
      const state = useAppStore.getState();
      switch (event.payload.id) {
        case "settings": state.setSettingsOpen(true); break;
        case "new-thread": void state.newThread(); break;
        case "open-workspace": void state.chooseProject(); break;
        case "toggle-sidebar": state.setSidebarCollapsed(!state.sidebarCollapsed); break;
        case "toggle-changes": state.setDockOpen(!state.dockOpen); break;
        case "command-palette": state.setPaletteOpen(true); break;
        case "search-threads": document.getElementById("thread-search")?.focus(); break;
      }
    });
    return () => { void unlisten.then((off) => off()); };
  }, []);
}

export default function App() {
  const hydrate = useAppStore((s) => s.hydrate);
  const ready = useAppStore((s) => s.ready);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const previewSession = useAppStore((s) => s.previewSession);
  const outputViewer = useAppStore((s) => s.outputViewer);
  const viewingChildAgent = useAppStore((s) => s.childSession);
  const trustDialog = useAppStore((s) => s.trustDialog);
  const confirmDialog = useAppStore((s) => s.confirmDialog);
  const initDialog = useAppStore((s) => s.initDialog);
  const enterPreview = useAppStore((s) => s.enterPreview);
  const showBootPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).has("boot");
  const showUsagePreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("usage") === "preview";
  const peak = useAppStore((s) => {
    const config = activeConfig(s);
    const agentId = activeAgentId(s);
    const model = s.modelsAgentId === agentId ? modelFor(s.models, config) : undefined;
    const tiers = tiersFor(model, agentId);
    return isPeak(config.effort ?? defaultTier(model, tiers), tiers);
  });
  useDesktopShortcuts();
  useAppMenu();

  useEffect(() => {
    const unbind = bindBridgeEvents();
    void hydrate();
    // Clears a thread stuck on "Thinking" when the host finished its turn but the end was missed.
    const reconcile = window.setInterval(() => void reconcileRunningThreads(), 30000);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => {
      const state = useAppStore.getState();
      if (state.theme === "system") applyTheme("system", state.accentColor, state.accentSidebar);
    };
    const online = () => useAppStore.getState().setOffline(!navigator.onLine);
    media.addEventListener("change", updateTheme);
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    return () => { window.clearInterval(reconcile); unbind(); media.removeEventListener("change", updateTheme); window.removeEventListener("online", online); window.removeEventListener("offline", online); };
  }, [hydrate]);

  useEffect(() => {
    if (ready && showUsagePreview && !useAppStore.getState().preview) enterPreview();
  }, [enterPreview, ready, showUsagePreview]);

  if (!ready || showBootPreview) {
    return (
      <div className="boot" role="status" aria-live="polite" aria-busy="true" aria-label="Starting Muse Code">
        <div className="boot-aurora" aria-hidden="true" />
        <section className="boot-panel">
          <div className="boot-brand">
            <span className="boot-logo"><img src="/spark.svg" alt="" /></span>
            <span>Muse Code</span>
          </div>
          <div className="boot-copy">
            <h1>Preparing your workspace</h1>
            <p>Restoring your projects and connecting to local agents.</p>
          </div>
          <div className="boot-progress" aria-hidden="true"><span /></div>
          <div className="boot-status">
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
            <span>Starting local workspace</span>
          </div>
        </section>
        <p className="boot-privacy">Local-first · Your workspace stays on this device</p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className={`app ${collapsed ? "sidebar-collapsed" : ""} ${peak ? "effort-peak" : ""}`}>
        <a className="visually-hidden skip-link" href="#main-content">Skip to main content</a>
        <Sidebar />
        <ThreadView />
        <ReviewDock />
        {settingsOpen ? <Suspense fallback={null}><SettingsModal /></Suspense> : null}
        {previewSession ? <PreviewModal /> : null}
        {outputViewer ? <OutputModal /> : null}
        {viewingChildAgent ? <SubagentModal /> : null}
        {trustDialog ? <TrustModal /> : null}
        {confirmDialog ? <ConfirmDialog /> : null}
        {initDialog ? <InitModal /> : null}
        <Onboarding />
        {paletteOpen ? <CommandPalette /> : null}
        <ImageViewer />
        <EffortRipple />
      </div>
    </ErrorBoundary>
  );
}
