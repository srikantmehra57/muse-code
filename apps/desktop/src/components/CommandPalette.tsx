import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, MessageSquare, Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { shortcutLabel, threadMatches } from "../lib/format";
import { agentEnabled, type Thread } from "../lib/types";

type Command = { id: string; label: string; shortcut?: string; run: () => void; hidden?: boolean; thread?: Thread };

export function CommandPalette() {
  const s = useAppStore(useShallow((state) => ({
    paletteOpen: state.paletteOpen,
    setPaletteOpen: state.setPaletteOpen,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    enabledAgents: state.enabledAgents,
    dockOpen: state.dockOpen,
    setDockOpen: state.setDockOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    setSidebarCollapsed: state.setSidebarCollapsed,
    selectThread: state.selectThread,
    newThread: state.newThread,
    openLastThread: state.openLastThread,
    chooseProject: state.chooseProject,
    setSettingsOpen: state.setSettingsOpen,
    stopTurn: state.stopTurn,
    continueThread: state.continueThread,
    retryLast: state.retryLast,
  })));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const workspace = currentWorkspace(s);
  const thread = currentThread(s);
  const commands = useMemo<Command[]>(() => {
    const threads = s.threads
      .filter((item) => !item.archived && agentEnabled(s, item.agentId ?? "muse") && (!workspace || item.workspacePath === workspace.path))
      .slice(0, 8)
      .map((item) => ({
        id: `thread-${item.sessionId}`,
        label: `Open thread · ${item.title}`,
        run: () => void s.selectThread(item.sessionId),
        thread: item,
      }));
    return [
      { id: "new", label: "New thread", shortcut: shortcutLabel("N"), run: () => void s.newThread() },
      { id: "last", label: "Open last thread", run: () => void s.openLastThread() },
      { id: "open", label: "Open workspace", run: () => void s.chooseProject() },
      { id: "search", label: "Search threads", shortcut: shortcutLabel("F"), run: () => document.getElementById("thread-search")?.focus() },
      { id: "settings", label: "Open settings", shortcut: shortcutLabel(","), run: () => s.setSettingsOpen(true) },
      { id: "inspector", label: s.dockOpen ? "Hide changes" : "Show changes", shortcut: shortcutLabel("I"), run: () => s.setDockOpen(!s.dockOpen) },
      { id: "sidebar", label: s.sidebarCollapsed ? "Show sidebar" : "Hide sidebar", shortcut: shortcutLabel("B"), run: () => s.setSidebarCollapsed(!s.sidebarCollapsed) },
      { id: "stop", label: "Stop agent", hidden: thread?.status !== "running", run: () => void s.stopTurn() },
      { id: "continue", label: "Continue thread", hidden: thread?.status === "running" || !thread?.lastOutcome || thread.lastOutcome === "completed", run: () => void s.continueThread() },
      { id: "retry", label: "Retry last prompt", hidden: thread?.status === "running" || !thread?.items.some((item) => item.kind === "userMessage"), run: () => void s.retryLast() },
      { id: "composer", label: "Focus composer", run: () => document.getElementById("prompt")?.focus() },
      { id: "reconnect", label: "Reconnect Muse", run: () => { s.setSettingsOpen(true); } },
      ...threads,
    ];
  }, [s, thread?.status, thread?.lastOutcome, thread?.items, s.dockOpen, s.sidebarCollapsed, s.threads, workspace]);
  const visible = commands.filter((command) => !command.hidden && (command.label.toLowerCase().includes(query.toLowerCase()) || (command.thread != null && threadMatches(command.thread, query))));
  useEffect(() => {
    if (s.paletteOpen) { setQuery(""); setActive(0); input.current?.focus(); }
  }, [s.paletteOpen]);
  if (!s.paletteOpen) return null;
  const choose = (command: Command) => { s.setPaletteOpen(false); command.run(); };
  return (
    <div className="overlay palette-overlay" onClick={() => s.setPaletteOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette" onClick={(event) => event.stopPropagation()}>
        <div className="palette-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          value={query}
          placeholder={workspace ? "Run a command or switch thread…" : "Open a workspace first…"}
          aria-label="Filter commands"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); s.setPaletteOpen(false); }
            if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(visible.length - 1, value + 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
            if (event.key === "Enter" && visible[active]) { event.preventDefault(); choose(visible[active]); }
          }}
        />
        <kbd>esc</kbd>
        </div>
        <ul role="listbox">
          {visible.map((command, index) => (
            <li key={command.id}>
              <button type="button" className={index === active ? "active" : ""} role="option" aria-selected={index === active} onMouseEnter={() => setActive(index)} onClick={() => choose(command)}>
                {command.id.startsWith("thread-") ? <MessageSquare size={14} className="palette-icon" aria-hidden="true" /> : null}
                <span className="palette-label">{command.label}</span>
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : index === active ? <CornerDownLeft size={13} className="palette-enter" aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
          {!visible.length ? <li className="muted empty-note">No matching commands</li> : null}
        </ul>
      </div>
    </div>
  );
}
