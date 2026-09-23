import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, KeyRound, LogOut, Package, Puzzle, RefreshCw, Server, WandSparkles, X } from "lucide-react";
import { mcpLogin, mcpLogout, pluginInspect, pluginReview, skillInspect, skillSet } from "../lib/bridge";
import { skillSelectorText, skillUseText } from "../lib/composerText";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { skillScopeArg, type PluginDetail, type SkillDetail, type SkillEntry, type SkillRow } from "../lib/types";

const selectorText = (row: SkillRow) => skillSelectorText(row.selector);

function SkillCard({ row, onUse }: { row: SkillRow; onUse: (row: SkillRow) => void }) {
  return (
    <li className="extension-card">
      <WandSparkles size={16} aria-hidden="true" />
      <span className="extension-copy">
        <span className="extension-name">{selectorText(row)}{row.displayName && row.displayName !== row.selector ? <span className="picker-tag">{row.displayName}</span> : null}{row.source ? <span className="picker-tag">{row.source}</span> : null}</span>
        {row.description ? <span className="extension-meta">{row.description}</span> : null}
        {row.argumentHint ? <span className="extension-meta">Arguments: {row.argumentHint}</span> : null}
      </span>
      <button type="button" className="ghost-btn small" onClick={() => onUse(row)}>Use</button>
    </li>
  );
}

export function ExtensionsView({ onOpenThreads, embedded = false }: { onOpenThreads?: () => void; embedded?: boolean }) {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    preview: state.preview,
    composer: state.composer,
    museBin: state.museBin,
    mcpServers: state.mcpServers,
    mcpLoading: state.mcpLoading,
    mcpError: state.mcpError,
    pluginEntries: state.pluginEntries,
    pluginsAvailableShown: state.pluginsAvailableShown,
    pluginsLoading: state.pluginsLoading,
    pluginsError: state.pluginsError,
    skillEntries: state.skillEntries,
    skillsLoading: state.skillsLoading,
    skillsError: state.skillsError,
    refreshMcpServers: state.refreshMcpServers,
    refreshSkills: state.refreshSkills,
    refreshManagedSkills: state.refreshManagedSkills,
    refreshPlugins: state.refreshPlugins,
    installPlugin: state.installPlugin,
    installSkill: state.installSkill,
    importSkills: state.importSkills,
    uninstallSkill: state.uninstallSkill,
    setComposer: state.setComposer,
    setSettingsOpen: state.setSettingsOpen,
    confirm: state.confirm,
  })));
  const thread = currentThread(s);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [importFrom, setImportFrom] = useState<"claude" | "codex">("claude");
  const [importPreview, setImportPreview] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [inspectedSkill, setInspectedSkill] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);

  useEffect(() => {
    if (!s.preview) void s.refreshMcpServers();
    // Load the catalog once; per-session skills refresh with the thread lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.preview]);

  const refreshSkills = async () => {
    if (!thread || skillsBusy) return;
    setSkillsBusy(true);
    try { await s.refreshSkills(thread.sessionId); }
    finally { setSkillsBusy(false); }
  };

  const useSkill = (row: SkillRow) => {
    s.setComposer(skillUseText(row.selector, s.composer));
    // From Settings the composer is behind the dialog; close it so the
    // inserted text is where the user is looking.
    if (embedded) s.setSettingsOpen(false);
    onOpenThreads?.();
  };

  const authServer = async (server: string, login: boolean) => {
    setAuthBusy(server); setAuthError(null);
    try {
      if (login) await mcpLogin(server, s.museBin || undefined);
      else await mcpLogout(server, s.museBin || undefined);
      await s.refreshMcpServers();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : String(error));
    } finally {
      setAuthBusy(null);
    }
  };

  const skills = thread && !thread.agentId ? thread.skills : null;
  const skillsState = !thread ? "none" : thread.agentId ? "foreign" : skills == null ? "unloaded" : skills.length ? "ready" : "empty";
  const workspace = currentWorkspace(s);

  const toggleSkill = async (entry: SkillEntry, enabled: boolean) => {
    const scope = skillScopeArg(entry.scope);
    if (!scope) return;
    if (scope === "project" && !workspace?.grantId) { setSkillError("Open a workspace to manage project skills."); return; }
    setSkillBusy(entry.id); setSkillError(null);
    try {
      await skillSet(entry.id, scope, enabled, workspace?.grantId ?? undefined, s.museBin || undefined);
      await s.refreshManagedSkills();
      if (thread && !thread.agentId) await s.refreshSkills(thread.sessionId);
    } catch (error) {
      setSkillError(error instanceof Error ? error.message : String(error));
    } finally {
      setSkillBusy(null);
    }
  };

  const inspectPlugin = async (id: string) => {
    if (inspectedId === id) { setInspectedId(null); setDetail(null); setDetailError(null); return; }
    setInspectedId(id); setDetail(null); setDetailError(null); setDetailLoading(true);
    try {
      setDetail(await pluginInspect(id, s.museBin || undefined));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const reviewPlugin = async (id: string, approve: boolean) => {
    const verb = approve ? "approve and enable" : "reject and disable";
    if (!(await s.confirm({ title: `${approve ? "Approve" : "Reject"} ${id}?`, body: `This ${verb}s its current runtime capabilities.`, confirmLabel: approve ? "Approve" : "Reject" }))) return;
    setReviewBusy(id); setReviewError(null);
    try {
      await pluginReview(id, approve, s.museBin || undefined);
      await s.refreshPlugins(s.pluginsAvailableShown);
      if (inspectedId === id) setDetail(await pluginInspect(id, s.museBin || undefined).catch(() => detail));
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewBusy(null);
    }
  };

  const Shell = embedded ? "div" : "main";
  const shellProps = embedded
    ? { className: "extensions-embed" }
    : { id: "main-content", tabIndex: -1, className: "main extensions-main solo" };

  return (
    <Shell {...shellProps}>
      {embedded ? null : (
        <header className="topbar extensions-topbar" data-tauri-drag-region>
          <div>
            <h1>Extensions</h1>
            <span>Skills and MCP servers for {thread ? `“${thread.title}”` : "the selected thread"}</span>
          </div>
        </header>
      )}
      <div className="extensions-scroll">
        <section className="extensions-section" aria-labelledby="extensions-skills-title">
          <div className="extensions-section-head">
            <h2 id="extensions-skills-title"><Puzzle size={15} aria-hidden="true" />Skills</h2>
            <button type="button" className="ghost-btn small" disabled={!thread || !!thread.agentId || skillsBusy} onClick={() => void refreshSkills()}>
              <RefreshCw size={11} className={skillsBusy ? "spin" : ""} />{skillsBusy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {skillsState === "none" ? <p className="permission-note">Open a thread to see its skills.</p> : null}
          {skillsState === "foreign" ? <p className="permission-note">Skills are a Muse capability; this thread runs on another agent.</p> : null}
          {skillsState === "unloaded" ? <p className="permission-note">The skill catalog has not loaded yet. Refresh to fetch it.</p> : null}
          {skillsState === "empty" ? <p className="permission-note">No skills are available for this session. Workspace skills load only from trusted workspaces.</p> : null}
          {skillsState === "ready" ? <ul className="extension-list">
            {(skills ?? []).map((row) => <SkillCard key={`${row.source ?? ""}:${row.selector}`} row={row} onUse={useSkill} />)}
          </ul> : null}
        </section>
        <section className="extensions-section" aria-labelledby="extensions-lifecycle-title">
          <div className="extensions-section-head">
            <h2 id="extensions-lifecycle-title"><WandSparkles size={15} aria-hidden="true" />Skill lifecycle</h2>
            <span className="extension-actions">
              <button type="button" className="ghost-btn small" disabled={s.skillsLoading} title="Install a skill from a folder" onClick={() => void s.installSkill()}>
                <WandSparkles size={11} />Install
              </button>
              <button type="button" className="ghost-btn small" disabled={s.skillsLoading} onClick={() => void s.refreshManagedSkills()}>
                <RefreshCw size={11} className={s.skillsLoading ? "spin" : ""} />{s.skillsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </span>
          </div>
          <p className="permission-note">Enable or disable CLI skills, including the open workspace's project skills.</p>
          {s.skillsError ? <p className="permission-note" role="alert">{s.skillsError}</p> : null}
          {skillError ? <p className="permission-note" role="alert">{skillError}</p> : null}
          <div className="import-row">
            <span className="usage-periods" role="tablist" aria-label="Import source">
              <button type="button" role="tab" aria-selected={importFrom === "claude"} onClick={() => { setImportFrom("claude"); setImportPreview(null); }}>Claude</button>
              <button type="button" role="tab" aria-selected={importFrom === "codex"} onClick={() => { setImportFrom("codex"); setImportPreview(null); }}>Codex</button>
            </span>
            <button
              type="button"
              className="ghost-btn small"
              disabled={importBusy || s.skillsLoading}
              title={`Preview importing ${importFrom} skills`}
              onClick={() => {
                setImportBusy(true); setImportError(null);
                s.importSkills(importFrom, true).then(setImportPreview, (error) => setImportError(error instanceof Error ? error.message : String(error))).finally(() => setImportBusy(false));
              }}
            >{importBusy ? "Working…" : "Preview import"}</button>
            {importPreview ? <button
              type="button"
              className="ghost-btn small"
              disabled={importBusy || s.skillsLoading}
              title={`Import ${importFrom} skills into scope user`}
              onClick={() => {
                void s.confirm({ title: `Import ${importFrom} skills into your user scope?`, confirmLabel: "Import" }).then((ok) => {
                  if (!ok) return;
                  setImportBusy(true); setImportError(null);
                  s.importSkills(importFrom, false).then(() => setImportPreview(null), (error) => setImportError(error instanceof Error ? error.message : String(error))).finally(() => setImportBusy(false));
                });
              }}
            >Import</button> : null}
          </div>
          {importError ? <p className="permission-note" role="alert">{importError}</p> : null}
          {importPreview ? <pre className="import-preview">{importPreview}</pre> : null}
          {!s.skillEntries.length && !s.skillsLoading ? <p className="permission-note">No skills found. Refresh to fetch the inventory.</p> : null}
          {s.skillEntries.length ? <ul className="extension-list">
            {s.skillEntries.map((entry) => {
              const scope = skillScopeArg(entry.scope);
              const on = entry.activation.toLowerCase() === "on";
              const uninstallable = entry.scope.toLowerCase() === "user" || entry.scope.toLowerCase() === "project" || entry.scope.toLowerCase() === "plugin";
              return (
                <li key={entry.id}>
                  <div className="extension-card">
                    <WandSparkles size={16} aria-hidden="true" />
                    <span className="extension-copy">
                      <span className="extension-name">{entry.id}<span className="picker-tag">{entry.scope || "unknown"}</span><span className={on ? "picker-tag" : "picker-tag warm"}>{on ? "On" : "Off"}</span></span>
                      {entry.description ? <span className="extension-meta">{entry.description}</span> : null}
                    </span>
                    <span className="extension-actions">
                      <button
                        type="button"
                        className="ghost-btn small"
                        aria-expanded={inspectedSkill === entry.id}
                        onClick={() => {
                          if (inspectedSkill === entry.id) { setInspectedSkill(null); setSkillDetail(null); setSkillDetailError(null); return; }
                          setInspectedSkill(entry.id); setSkillDetail(null); setSkillDetailError(null); setSkillDetailLoading(true);
                          skillInspect(entry.id, s.museBin || undefined).then(setSkillDetail, (error) => setSkillDetailError(error instanceof Error ? error.message : String(error))).finally(() => setSkillDetailLoading(false));
                        }}
                      >{inspectedSkill === entry.id ? "Hide" : "Inspect"}</button>
                      {uninstallable ? <button
                        type="button"
                        className="ghost-btn small"
                        disabled={s.skillsLoading}
                        title={`Uninstall ${entry.id}`}
                        onClick={() => { void s.confirm({ title: `Uninstall ${entry.id}?`, body: "Its files are removed. This cannot be undone.", confirmLabel: "Uninstall", danger: true }).then((ok) => { if (ok) void s.uninstallSkill(entry.id); }); }}
                      >Uninstall</button> : null}
                      {scope ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${on ? "Disable" : "Enable"} ${entry.id}`}
                          className="toggle"
                          disabled={skillBusy === entry.id}
                          onClick={() => void toggleSkill(entry, !on)}
                        ><i /></button>
                      ) : null}
                    </span>
                  </div>
                  {inspectedSkill === entry.id ? <div className="extension-detail">
                    {skillDetailLoading ? <p className="permission-note">Inspecting {entry.id}…</p> : null}
                    {skillDetailError ? <p className="permission-note" role="alert">{skillDetailError}</p> : null}
                    {skillDetail && !skillDetailLoading ? <>
                      {skillDetail.description ? <p className="permission-note">{skillDetail.description}</p> : null}
                      <p className="permission-note">Scope {skillDetail.scope || "unknown"} · {skillDetail.activation === "on" ? "on" : "off"}{skillDetail.path ? <> · <span className="extension-name">{skillDetail.path}</span></> : null}</p>
                    </> : null}
                  </div> : null}
                </li>
              );
            })}
          </ul> : null}
        </section>
        <section className="extensions-section" aria-labelledby="extensions-mcp-title">
          <div className="extensions-section-head">
            <h2 id="extensions-mcp-title"><Server size={15} aria-hidden="true" />MCP servers</h2>
            <button type="button" className="ghost-btn small" disabled={s.mcpLoading} onClick={() => void s.refreshMcpServers()}>
              <RefreshCw size={11} className={s.mcpLoading ? "spin" : ""} />{s.mcpLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          <p className="permission-note">Servers configured for the Muse CLI. OAuth servers need a sign-in before their tools work.</p>
          {s.mcpError ? <p className="permission-note" role="alert">{s.mcpError}</p> : null}
          {authError ? <p className="permission-note" role="alert">{authError}</p> : null}
          {!s.mcpServers.length && !s.mcpLoading ? <p className="permission-note">No MCP servers are configured. Add them with the Muse CLI, then refresh.</p> : null}
          {s.mcpServers.length ? <ul className="extension-list">
            {s.mcpServers.map((server) => (
              <li key={server.name} className="extension-card">
                <Server size={16} aria-hidden="true" />
                <span className="extension-copy">
                  <span className="extension-name">{server.name}<span className="picker-tag">{server.transport}</span>{server.oauth ? <span className="picker-tag">OAuth</span> : null}</span>
                </span>
                {server.oauth ? (
                  <span className="extension-actions">
                    <button type="button" className="ghost-btn small" disabled={authBusy === server.name} title={`Sign in to ${server.name}`} onClick={() => void authServer(server.name, true)}>
                      <KeyRound size={11} />{authBusy === server.name ? "Working…" : "Sign in"}
                    </button>
                    <button type="button" className="ghost-btn small" disabled={authBusy === server.name} title={`Remove the saved credential for ${server.name}`} onClick={() => { void s.confirm({ title: `Remove the saved credential for ${server.name}?`, confirmLabel: "Remove", danger: true }).then((ok) => { if (ok) void authServer(server.name, false); }); }}>
                      <LogOut size={11} />Sign out
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul> : null}
        </section>
        <section className="extensions-section" aria-labelledby="extensions-plugins-title">
          <div className="extensions-section-head">
            <h2 id="extensions-plugins-title"><Package size={15} aria-hidden="true" />Plugins</h2>
            <span className="extension-actions">
              <span className="usage-periods" role="tablist" aria-label="Plugin inventory">
                <button type="button" role="tab" aria-selected={!s.pluginsAvailableShown} onClick={() => void s.refreshPlugins(false)}>Installed</button>
                <button type="button" role="tab" aria-selected={s.pluginsAvailableShown} onClick={() => void s.refreshPlugins(true)}>Available</button>
              </span>
              <button type="button" className="ghost-btn small" disabled={s.pluginsLoading} title="Install a plugin from a bundle folder" onClick={() => void s.installPlugin()}>
                <Package size={11} />Install
              </button>
              <button type="button" className="ghost-btn small" disabled={s.pluginsLoading} onClick={() => void s.refreshPlugins(s.pluginsAvailableShown)}>
                <RefreshCw size={11} className={s.pluginsLoading ? "spin" : ""} />{s.pluginsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </span>
          </div>
          <p className="permission-note">Inspect a plugin's runtime capabilities before approving it. Per-capability review and marketplace management still need the CLI.</p>
          {s.pluginsError ? <p className="permission-note" role="alert">{s.pluginsError}</p> : null}
          {reviewError ? <p className="permission-note" role="alert">{reviewError}</p> : null}
          {!s.pluginEntries.length && !s.pluginsLoading ? <p className="permission-note">{s.pluginsAvailableShown ? "No marketplace plugins are available." : "No plugins are installed."}</p> : null}
          {s.pluginEntries.length ? <ul className="extension-list">
            {s.pluginEntries.map((plugin) => (
              <li key={plugin.id}>
                <div className="extension-card">
                  <Package size={16} aria-hidden="true" />
                  <span className="extension-copy">
                    <span className="extension-name">{plugin.id}{plugin.version ? <span className="picker-tag">v{plugin.version}</span> : null}{plugin.enabled == null ? null : plugin.enabled ? <span className="picker-tag">Enabled</span> : <span className="picker-tag warm">Disabled</span>}</span>
                    {plugin.description ? <span className="extension-meta">{plugin.description}</span> : null}
                  </span>
                  <span className="extension-actions">
                    <button type="button" className="ghost-btn small" aria-expanded={inspectedId === plugin.id} onClick={() => void inspectPlugin(plugin.id)}>
                      {inspectedId === plugin.id ? "Hide" : "Inspect"}
                    </button>
                    {!s.pluginsAvailableShown ? <>
                      <button type="button" className="ghost-btn small" disabled={reviewBusy === plugin.id} title={`Approve and enable ${plugin.id}`} onClick={() => void reviewPlugin(plugin.id, true)}>
                        <Check size={11} />{reviewBusy === plugin.id ? "Working…" : "Approve"}
                      </button>
                      <button type="button" className="ghost-btn small" disabled={reviewBusy === plugin.id} title={`Reject and disable ${plugin.id}`} onClick={() => void reviewPlugin(plugin.id, false)}>
                        <X size={11} />Reject
                      </button>
                    </> : null}
                  </span>
                </div>
                {inspectedId === plugin.id ? <div className="extension-detail">
                  {detailLoading ? <p className="permission-note">Inspecting {plugin.id}…</p> : null}
                  {detailError ? <p className="permission-note" role="alert">{detailError}</p> : null}
                  {detail && !detailLoading ? detail.capabilities.length ? <ul className="capability-list">
                    {detail.capabilities.map((cap) => (
                      <li key={cap.id}>
                        <span className="extension-name">{cap.id}{cap.kind ? <span className="picker-tag">{cap.kind}</span> : null}{cap.enabled == null ? null : cap.enabled ? <span className="picker-tag">On</span> : <span className="picker-tag warm">Off</span>}</span>
                        <span className="extension-meta">{cap.description}</span>
                      </li>
                    ))}
                  </ul> : <p className="permission-note">No runtime capabilities reported.</p> : null}
                </div> : null}
              </li>
            ))}
          </ul> : null}
        </section>
      </div>
    </Shell>
  );
}
