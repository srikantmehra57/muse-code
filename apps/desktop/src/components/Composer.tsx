import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, AtSign, FileText, FileUp, Hammer, Lock, Paperclip, Play, RotateCcw, ShieldCheck, Square, Terminal, TriangleAlert, X } from "lucide-react";
import { APPROVAL_DESCRIPTIONS, APPROVAL_LABELS, APPROVAL_ORDER, agentEnabled, type ApprovalMode, type ContextRef } from "../lib/types";
import { defaultTier, isPeak, modelFor, tiersFor } from "../lib/effort";
import { AgentPicker } from "./AgentPicker";
import { formatTokens, humanizeModelLabel, isTauri, uid } from "../lib/format";
import { fuzzyScore } from "../lib/fuzzy";
import { listen } from "@tauri-apps/api/event";
import { activeAgentId, activeConfig, currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { EffortScrubber } from "./EffortScrubber";
import { ModelPicker, modelKey } from "./ModelPicker";
import { SelectMenu } from "./SelectMenu";
import { collectCandidates, continuationForEnter, currentWord, filterSlashCommands, findUniqueCompletion, indentText, isStopWord, outdentText, parseShellEscape, slashQuery } from "../lib/composerText";
import { MAX_DROP_FILES, isImageFile, refPathForDrop } from "../lib/drop";

function filePath(file: File): string {
  const withPath = file as File & { path?: string };
  return typeof withPath.path === "string" && withPath.path ? withPath.path : file.name;
}

function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|[\s])@([^\s@]*)$/);
  if (!match || match.index == null) return null;
  return { start: match.index + match[1].length, query: match[2] };
}

function hasFileDrag(event: ReactDragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function Composer() {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    drafts: state.drafts,
    enabledAgents: state.enabledAgents,
    defaultAgentId: state.defaultAgentId,
    defaultModel: state.defaultModel,
    defaultProviderId: state.defaultProviderId,
    defaultApprovalMode: state.defaultApprovalMode,
    defaultEffort: state.defaultEffort,
    agents: state.agents,
    detection: state.detection,
    models: state.models,
    modelsAgentId: state.modelsAgentId,
    modelsLoading: state.modelsLoading,
    modelsError: state.modelsError,
    starting: state.starting,
    submitting: state.submitting,
    preview: state.preview,
    offline: state.offline,
    composer: state.composer,
    images: state.images,
    contextRefs: state.contextRefs,
    git: state.git,
    fileIndex: state.fileIndex,
    setComposer: state.setComposer,
    addContextRefs: state.addContextRefs,
    attachImages: state.attachImages,
    removeContextRef: state.removeContextRef,
    openViewer: state.openViewer,
    clearImages: state.clearImages,
    unqueueTurn: state.unqueueTurn,
    sendPrompt: state.sendPrompt,
    stopTurn: state.stopTurn,
    switchThreadAgent: state.switchThreadAgent,
    refreshDetection: state.refreshDetection,
    refreshModels: state.refreshModels,
    setSessionConfig: state.setSessionConfig,
    compactThread: state.compactThread,
    continueThread: state.continueThread,
    retryLast: state.retryLast,
    startHost: state.startHost,
  })));
  const thread = currentThread(s);
  const workspace = currentWorkspace(s);
  const config = activeConfig(s);
  const agentId = activeAgentId(s);
  const pickerAgents = s.agents.filter((item) => agentEnabled(s, item.id));
  const agent = s.agents.find((item) => item.id === agentId);
  const agentName = agent?.name ?? "Muse";
  // Models in the store may still belong to the previous agent while the new list loads.
  const models = s.modelsAgentId === agentId ? s.models : [];
  const model = modelFor(models, config);
  const tiers = tiersFor(model, agentId);
  const fallbackTier = defaultTier(model, tiers);
  const peak = isPeak(config.effort ?? fallbackTier, tiers);
  const running = thread?.status === "running";
  const busy = s.starting || s.submitting || thread?.opening || thread?.configPending;
  const locked = busy || running || !workspace || (!!thread && !thread.opened && !s.preview);
  // A pending apply merges further scrub commits instead of dropping them, so
  // only the hard locks stay off-limits — otherwise the popover slammed shut
  // mid-gesture for the length of an ACP round-trip.
  const scrubLocked = s.starting || s.submitting || thread?.opening || running || !workspace || (!!thread && !thread.opened && !s.preview);
  // Busy sends are Muse-only: ACP agents and preview keep the Stop-to-send lock.
  const busySend = Boolean(running && thread && !thread.agentId && !s.preview);
  const [disposition, setDisposition] = useState<"queue" | "steer" | "replace">("queue");
  const queued = thread?.queuedTurns ?? [];
  const inputDisabled = !workspace || s.starting || s.submitting || s.offline;
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement>(null);
  const mentionMenuRef = useRef<HTMLUListElement>(null);
  const slashMenuRef = useRef<HTMLUListElement>(null);
  const contextControlRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const [caret, setCaret] = useState(0);
  const [picker, setPicker] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [ghostDismissed, setGhostDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const empty = !s.composer.trim() && s.images.length === 0 && s.contextRefs.length === 0;
  const canContinue = Boolean(thread && thread.status !== "running" && (thread.lastOutcome === "failed" || thread.lastOutcome === "cancelled" || thread.lastOutcome === "interrupted"));
  const modelValue = model ? modelKey(model) : undefined;
  const lockReason = !workspace ? "Open a workspace to enable the composer" : running ? "Stop the current turn to change settings" : busy ? "Please wait…" : thread && !thread.opened ? "Reconnect the thread to change settings" : undefined;
  const busySendTitle = disposition === "steer" ? "Steer the running turn (Enter)" : disposition === "replace" ? "Replace the running turn (Enter)" : "Queue behind the running turn (Enter)";
  const sendTitle = !workspace ? "Open a workspace to start" : busySend ? busySendTitle : running ? "Stop" : empty ? "Type a message or attach context" : "Send (Enter)";
  const context = thread?.context;
  const contextPercent = context?.windowTokens && context.usedTokens != null ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100)) : null;
  const remainingTokens = context?.windowTokens != null && context.usedTokens != null ? Math.max(0, context.windowTokens - context.usedTokens) : null;
  // The host's pressure flag can lag behind (or disagree with) the real numbers, so the
  // warning follows what the user can see: only "blocked" is taken from the host as-is.
  const contextLevel = contextPercent == null ? "" : context?.pressure === "blocked" || contextPercent >= 95 ? "blocked" : contextPercent >= 80 ? "warning" : "";
  const mention = mentionQuery(s.composer, caret);
  const suggestions = useMemo(() => {
    const files = [
      ...(s.git?.files.map((file) => file.path) ?? []),
      ...(thread?.items.map((item) => {
        try { const parsed = item.args ? JSON.parse(item.args) as { path?: string } : {}; return typeof parsed.path === "string" ? parsed.path : ""; }
        catch { return ""; }
      }) ?? []),
    ].filter(Boolean);
    const referenced = (path: string) => s.contextRefs.some((ref) => ref.path === path);
    const known = [...new Set(files)].filter((path) => !referenced(path));
    const indexed = (s.fileIndex && s.fileIndex.workspaceId === workspace?.id ? s.fileIndex.paths : []).filter((path) => !known.includes(path) && !referenced(path));
    const query = mention?.query ?? "";
    // Empty query keeps the recent/git order first; a query fuzzy-ranks the
    // merged recent + workspace index lists together.
    if (!query) return [...known, ...indexed].slice(0, 8);
    return [...known, ...indexed]
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((entry): entry is { path: string; score: number } => entry.score != null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.path)
      .slice(0, 8);
  }, [s.git, thread?.items, s.contextRefs, s.fileIndex, workspace?.id, mention?.query]);
  const mentionOpen = suggestions.length > 0 && (picker || Boolean(mention && !mentionDismissed));

  const slash = slashQuery(s.composer, caret);
  const slashKey = slash ? slash.query : null;
  const sessionSkills = useMemo(() => thread?.skills ?? [], [thread?.skills]);
  const slashOptions = useMemo(() => (slashKey == null ? [] : filterSlashCommands(slashKey, sessionSkills)), [slashKey, sessionSkills]);
  const slashOpen = slash != null && !slashDismissed && slashOptions.length > 0 && !mention && Boolean(workspace);
  const shellEscape = agentId === "muse" ? parseShellEscape(s.composer) : null;

  const word = useMemo(() => (focused && !ghostDismissed && !inputDisabled ? currentWord(s.composer, caret) : null), [focused, ghostDismissed, inputDisabled, s.composer, caret]);
  const candidates = useMemo(() => {
    const texts = [...(thread?.items ?? [])].reverse().slice(0, 60).map((item) => item.text ?? item.fallbackText ?? "");
    const paths = [...(s.git?.files.map((file) => file.path).reverse() ?? []), ...s.contextRefs.map((ref) => ref.path).reverse()];
    return collectCandidates([...texts, ...paths]);
  }, [thread?.items, s.git, s.contextRefs]);
  const completion = word && word.word.length >= 3 && !isStopWord(word.word) ? findUniqueCompletion(word.word, candidates) : null;
  const ghostSuffix = completion && word ? completion.slice(word.word.length) : "";
  const showGhost = Boolean(ghostSuffix) && !mentionOpen && !slashOpen;

  useEffect(() => { setMentionIndex(0); }, [mention?.query, suggestions.length, picker]);
  useEffect(() => { setSlashIndex(0); }, [slashKey]);
  useEffect(() => {
    mentionMenuRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionOpen]);
  useEffect(() => {
    slashMenuRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, slashOpen]);
  useEffect(() => {
    if (!s.composer && areaRef.current) areaRef.current.style.height = "auto";
  }, [s.composer]);

  useEffect(() => {
    if (!mentionOpen && !slashOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (mentionMenuRef.current?.contains(target) || slashMenuRef.current?.contains(target) || mentionTriggerRef.current?.contains(target)) return;
      setPicker(false);
      setMentionDismissed(true);
      setSlashDismissed(true);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [mentionOpen, slashOpen]);

  // Native OS drops arrive with real paths via the window drag events; the Rust
  // shell inspects them (see attachDroppedPaths). The HTML5 handlers below are
  // the browser/preview fallback, where File objects carry no usable path.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        unlisteners.push(
          await listen("tauri://drag-enter", () => { if (!cancelled) setDragging(true); }),
          await listen("tauri://drag-leave", () => { if (!cancelled) setDragging(false); }),
          await listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
            if (cancelled) return;
            setDragging(false);
            const paths = event.payload.paths ?? [];
            if (paths.length) void useAppStore.getState().attachDroppedPaths(paths);
          }),
        );
      } catch {
        // Older shells without drag events keep the HTML5 fallback.
      }
    })();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!contextOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contextControlRef.current?.contains(event.target as Node)) setContextOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [contextOpen]);

  const syncGhostScroll = () => {
    const area = areaRef.current;
    const mirror = mirrorRef.current;
    if (area && mirror) {
      mirror.scrollTop = area.scrollTop;
      mirror.scrollLeft = area.scrollLeft;
    }
  };

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    syncGhostScroll();
  };

  const applyEdit = (next: string, selStart: number, selEnd?: number) => {
    const end = selEnd ?? selStart;
    s.setComposer(next);
    setCaret(selStart);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.selectionStart = Math.min(selStart, next.length);
      el.selectionEnd = Math.min(end, next.length);
      resize(el);
      el.focus();
    });
  };

  const addPath = (path: string) => {
    const ref: ContextRef = { id: uid(), kind: path.endsWith("/") ? "folder" : "file", path };
    s.addContextRefs([ref]);
    setPicker(false);
    setMentionDismissed(true);
    if (mention && areaRef.current) {
      const next = `${s.composer.slice(0, mention.start)}${s.composer.slice(caret)}`.replace(/  +/g, " ");
      s.setComposer(next);
      areaRef.current.focus();
    }
  };

  const acceptMention = (index: number) => {
    const path = suggestions[Math.min(Math.max(index, 0), suggestions.length - 1)];
    if (path) addPath(path);
  };

  const acceptSlash = (index: number) => {
    const current = slashQuery(s.composer, caret);
    const command = slashOptions[Math.min(Math.max(index, 0), slashOptions.length - 1)];
    if (!current || !command) return;
    setSlashDismissed(true);
    // Skills stay typed (`/selector args`) so submit invokes them for real;
    // macros expand to their prompt text as before.
    const insert = command.kind === "skill" ? `/${command.name} ` : command.prompt;
    applyEdit(`${s.composer.slice(0, current.start)}${insert}${s.composer.slice(caret)}`, current.start + insert.length);
  };

  const acceptGhost = () => {
    if (!word || !ghostSuffix || !areaRef.current) return;
    applyEdit(s.composer.slice(0, word.end) + ghostSuffix + s.composer.slice(word.end), word.end + ghostSuffix.length);
  };

  const ingestFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    const capped = list.slice(0, MAX_DROP_FILES);
    const images = capped.filter((file) => isImageFile(file));
    const others = capped.filter((file) => !isImageFile(file));
    if (images.length) void s.attachImages(images);
    if (others.length) {
      const root = workspace?.path;
      s.addContextRefs(others.map((file) => ({ id: uid(), kind: "file", path: refPathForDrop(filePath(file), root) })));
    }
    if (list.length > MAX_DROP_FILES) useAppStore.setState({ error: `Only the first ${MAX_DROP_FILES} files were attached.` });
  };


  const statusText = s.offline ? "Offline — reconnect to send" : s.starting ? "Starting thread…" : thread?.opening ? "Opening thread…" : thread?.configPending ? "Applying thread settings…" : thread?.configNotice ?? null;

  return (
    <div className="composer-wrap">
      {/* Border beam while the agent works: a light travelling round the composer (accent, or turbo on max). */}
      <div className={`composer-beam ${running ? "active" : ""} ${peak ? "peak" : ""}`}>
        <div
          className={`composer ${running ? "running" : ""} ${!workspace ? "disabled" : ""} ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => {
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(event) => {
            dragDepth.current = 0;
            setDragging(false);
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            if (event.dataTransfer.files.length) ingestFiles(event.dataTransfer.files);
          }}
        >
          {dragging ? (
            <div className="drop-hint" aria-hidden="true">
              <FileUp size={20} />
              <strong>Drop to attach</strong>
              <span>Images attach inline · other files become @references</span>
            </div>
          ) : null}
          {s.contextRefs.length || s.images.length ? <div className="attachments">
            {s.contextRefs.map((ref) => (
              <span key={ref.id} className="attachment" title={ref.path}>
                <FileText size={12} aria-hidden="true" />
                <span>{ref.path.split("/").pop()}</span>
                <button type="button" className="attachment-x" aria-label={`Remove ${ref.path}`} disabled={s.submitting} onClick={() => s.removeContextRef(ref.id)}><X size={11} /></button>
              </span>
            ))}
            {s.images.map((image, index) => (
              <figure key={`${image.name}-${index}`} className="thumb" title={image.name}>
                <button type="button" className="thumb-open" aria-label={`Preview ${image.name}`} onClick={() => s.openViewer(s.images, index)}>
                  <img src={`data:${image.mediaType};base64,${image.base64Data}`} alt={image.name} />
                </button>
                <button type="button" className="thumb-remove" aria-label={`Remove ${image.name}`} disabled={s.submitting} onClick={() => useAppStore.setState((state) => ({ images: state.images.filter((_, i) => i !== index) }))}><X size={11} /></button>
              </figure>
            ))}
            {s.images.length > 1 ? <button type="button" className="ghost-btn small" disabled={s.submitting} onClick={s.clearImages}>Clear images</button> : null}
          </div> : null}
          {queued.length ? <div className="queued-strip" role="list" aria-label="Queued turns">
            {queued.map((entry, index) => (
              <span key={entry.turnId} className="queued-item" role="listitem" title={entry.text}>
                <span className="queued-tag">Queued{queued.length > 1 ? ` ${index + 1}` : ""}</span>
                <span className="queued-text">{entry.text || "(images)"}</span>
                <button type="button" className="attachment-x" aria-label={`Reclaim queued message ${index + 1}`} title="Reclaim before it runs" onClick={() => void s.unqueueTurn(entry.turnId)}><X size={11} /></button>
              </span>
            ))}
          </div> : null}
          <label className="visually-hidden" htmlFor="prompt">Message {agentName}</label>
          <div className="composer-input">
            <div ref={mirrorRef} className="ghost-mirror" aria-hidden="true">
              {s.composer.slice(0, caret)}
              {showGhost ? <span className="ghost-suffix">{ghostSuffix}</span> : null}
              {s.composer.slice(caret)}
              {"\u200b"}
            </div>
            <textarea
              id="prompt"
              ref={areaRef}
              value={s.composer}
              disabled={inputDisabled}
              placeholder={!workspace ? "Open a workspace to start" : busySend ? disposition === "steer" ? "Steer the running turn…" : disposition === "replace" ? "Replace the running turn…" : "Queue a follow-up — runs when this turn finishes…" : running ? `${agentName} is working — Stop to send a new message` : thread?.items.length ? "Ask a follow-up…" : `Ask ${agentName} to plan, edit, or run anything in ${workspace.name}`}
              rows={1}
              onChange={(event) => {
                s.setComposer(event.target.value);
                setCaret(event.target.selectionStart);
                setMentionDismissed(false);
                setSlashDismissed(false);
                setGhostDismissed(false);
                resize(event.target);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onClick={(event) => setCaret(event.currentTarget.selectionStart)}
              onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
              onScroll={syncGhostScroll}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onPaste={(event) => {
                const files: File[] = [];
                if (event.clipboardData.files.length) files.push(...Array.from(event.clipboardData.files));
                else {
                  for (const item of Array.from(event.clipboardData.items)) {
                    if (item.kind !== "file") continue;
                    const file = item.getAsFile();
                    if (file) files.push(file);
                  }
                }
                if (files.length) {
                  event.preventDefault();
                  ingestFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (mentionOpen) {
                    event.preventDefault();
                    setPicker(false);
                    setMentionDismissed(true);
                    return;
                  }
                  if (slashOpen) {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                  if (showGhost) {
                    event.preventDefault();
                    setGhostDismissed(true);
                  }
                  return;
                }
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (mentionOpen || slashOpen)) {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  if (mentionOpen) setMentionIndex((index) => (index + delta + suggestions.length) % suggestions.length);
                  else setSlashIndex((index) => (index + delta + slashOptions.length) % slashOptions.length);
                  return;
                }
                if (event.key === "Tab") {
                  if (mentionOpen && suggestions.length) {
                    event.preventDefault();
                    acceptMention(mentionIndex);
                    return;
                  }
                  if (slashOpen && slashOptions.length) {
                    event.preventDefault();
                    acceptSlash(slashIndex);
                    return;
                  }
                  // WCAG 2.1.2 (No Keyboard Trap, Level A). Tab must be able to
                  // leave this field. It is only claimed by explicit editing
                  // gestures — a pending ghost completion, or text that is actually
                  // selected. Otherwise Tab moves focus normally and Send/Stop/attach
                  // stay reachable by keyboard alone. Every Tab-capturing state has
                  // a one-keystroke exit: Escape dismisses the ghost and the popups.
                  const el = event.currentTarget;
                  if (showGhost && word && el.selectionStart === el.selectionEnd && el.selectionStart === word.end) {
                    event.preventDefault();
                    acceptGhost();
                    return;
                  }
                  const hasSelection = el.selectionStart !== el.selectionEnd;
                  if (!hasSelection) return;
                  event.preventDefault();
                  if (event.shiftKey) {
                    const edit = outdentText(el.value, el.selectionStart, el.selectionEnd);
                    applyEdit(edit.text, edit.start, edit.end);
                  } else {
                    const edit = indentText(el.value, el.selectionStart, el.selectionEnd);
                    applyEdit(edit.text, edit.start, edit.end);
                  }
                  return;
                }
                if (event.key === "ArrowRight" && showGhost && word && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
                  && event.currentTarget.selectionStart === event.currentTarget.selectionEnd && event.currentTarget.selectionStart === word.end) {
                  event.preventDefault();
                  acceptGhost();
                  return;
                }
                if (event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  const el = event.currentTarget;
                  const base = el.value.slice(0, el.selectionStart) + el.value.slice(el.selectionEnd);
                  const edit = continuationForEnter(base, el.selectionStart);
                  applyEdit(edit.text, edit.start, edit.end);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  if (mentionOpen && suggestions.length) {
                    event.preventDefault();
                    acceptMention(mentionIndex);
                    return;
                  }
                  if (slashOpen && slashOptions.length) {
                    event.preventDefault();
                    acceptSlash(slashIndex);
                    return;
                  }
                  event.preventDefault();
                  if (!running && !busy) void s.sendPrompt();
                  else if (busySend && !busy) void s.sendPrompt({ disposition });
                }
              }}
            />
          </div>
          {mentionOpen ? (
            <ul ref={mentionMenuRef} className="menu mention-list" role="listbox" aria-label="File references">
              <li className="menu-heading">Reference a file</li>
              {suggestions.map((path, index) => (
                <li key={path}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? "active" : ""}
                    onMouseEnter={() => setMentionIndex(index)}
                    onMouseDown={(event) => { event.preventDefault(); acceptMention(index); }}
                  >
                    <FileText size={13} aria-hidden="true" />
                    <span className="mention-name">{path.split("/").pop()}</span>
                    <span className="mention-path">{path}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {slashOpen ? (
            <ul ref={slashMenuRef} className="menu mention-list slash-list" role="listbox" aria-label="Slash commands">
              <li className="menu-heading">Commands</li>
              {slashOptions.map((command, index) => (
                <li key={`${command.kind}:${command.name}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === slashIndex}
                    className={index === slashIndex ? "active" : ""}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => { event.preventDefault(); acceptSlash(index); }}
                  >
                    <Terminal size={13} aria-hidden="true" />
                    <span className="mention-name">/{command.name}</span>
                    <span className="mention-path">{command.kind === "skill" ? `Skill · ${command.hint}` : command.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="composer-foot">
            <button className="icon-btn" aria-label="Attach files" title={!workspace ? "Open a workspace to attach files" : "Attach files or images — or drag & drop / paste them"} disabled={!workspace || s.submitting || s.starting} onClick={() => fileRef.current?.click()}><Paperclip size={15} /></button>
            <input ref={fileRef} type="file" accept="image/*,*/*" hidden multiple onChange={(event) => {
              if (event.target.files) ingestFiles(event.target.files);
              event.target.value = "";
            }} />
            <button ref={mentionTriggerRef} className="icon-btn" aria-label="Add file reference" title="Reference a file  @" aria-pressed={picker} disabled={!workspace || s.submitting} onClick={() => { setMentionDismissed(false); setPicker((open) => !open); }}><AtSign size={15} /></button>
            {shellEscape ? <span className="shell-chip" role="status" title={`Terminal: runs in ${workspace?.path ?? "the session workspace"} and streams output into the thread`}><Terminal size={13} aria-hidden="true" />Terminal</span> : null}
            <span className="foot-sep" aria-hidden="true" />
            {pickerAgents.filter((item) => item.found).length > 1 || agentId !== "muse" ? (
              <AgentPicker
                agents={pickerAgents}
                value={agentId}
                disabled={busy || running || !workspace}
                title={running ? "Stop the current turn to switch agents" : lockReason}
                onChange={(id) => void s.switchThreadAgent(id)}
                onRescan={async () => { await s.refreshDetection(); await s.refreshModels(); }}
              />
            ) : null}
            <ModelPicker
              models={models}
              agentId={agentId}
              value={modelValue}
              loading={s.modelsLoading || s.modelsAgentId !== agentId}
              disabled={locked}
              title={lockReason}
              onChange={(next) => void s.setSessionConfig({ modelId: next.modelId, providerId: next.providerId })}
            />
            {tiers.length && fallbackTier ? (
              <EffortScrubber
                value={config.effort}
                tiers={tiers}
                fallback={fallbackTier}
                modelLabel={model ? humanizeModelLabel(model.modelId, model.displayLabel) : undefined}
                disabled={scrubLocked}
                title={thread?.configPending ? "Applying your last change…" : lockReason}
                onChange={(effort) => void s.setSessionConfig({ effort })}
              />
            ) : null}
            {agentId === "muse" ? (
              <div className="selector-chip" title={lockReason ?? "Approval mode"}>
                <SelectMenu
                  id="approval"
                  icon={config.approvalMode === "allowAll" ? <TriangleAlert size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}
                  ariaLabel="Permissions"
                  heading="Permissions"
                  className="approval-select"
                  value={config.approvalMode}
                  placeholder="Permissions"
                  options={APPROVAL_ORDER.map((mode) => ({
                    value: mode,
                    label: APPROVAL_LABELS[mode],
                    description: APPROVAL_DESCRIPTIONS[mode],
                    icon: mode === "allowAll" ? <TriangleAlert size={14} aria-hidden="true" /> : mode === "denyUnmatched" ? <Lock size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />,
                    ...(mode === "allowAll" ? { tone: "danger" as const } : {}),
                  }))}
                  disabled={locked}
                  onChange={(value) => void s.setSessionConfig({ approvalMode: value as ApprovalMode })}
                />
              </div>
            ) : thread?.modes?.length ? (
              <div className="selector-chip" title={lockReason ?? `${agentName} mode`}>
                <SelectMenu
                  id="agent-mode"
                  icon={<Hammer size={13} aria-hidden="true" />}
                  ariaLabel={`${agentName} mode`}
                  heading={`${agentName} mode`}
                  value={config.mode}
                  placeholder="Mode"
                  options={thread.modes.map((mode) => ({ value: mode.value, label: mode.name ? mode.name.charAt(0).toUpperCase() + mode.name.slice(1) : mode.value, description: mode.description }))}
                  disabled={locked}
                  onChange={(value) => void s.setSessionConfig({ mode: value })}
                />
              </div>
            ) : null}
            {context && contextPercent != null ? (
              <div ref={contextControlRef} className={`context-control ${contextOpen ? "open" : ""}`}>
                <button
                  type="button"
                  className={`context-meter ${contextLevel}`}
                  aria-label={`Context window: ${contextPercent}% used`}
                  aria-expanded={contextOpen}
                  aria-controls="context-details"
                  onClick={() => setContextOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setContextOpen(false);
                      event.currentTarget.focus();
                    }
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" className="track" /><circle cx="8" cy="8" r="6" className="fill" strokeDasharray={`${(contextPercent / 100) * 37.7} 37.7`} /></svg>
                  <span>{contextPercent}%</span>
                </button>
                <div id="context-details" className={`context-popover ${contextLevel}`} role="tooltip">
                  <div className="context-pop-head"><span>Context window</span><strong>{contextPercent}<small>%</small></strong></div>
                  <div className="context-bar" aria-hidden="true"><span style={{ width: `${contextPercent}%` }} /></div>
                  <dl className="context-stats">
                    <div><dt>Used</dt><dd title={context.usedTokens?.toLocaleString("en-US")}>{formatTokens(context.usedTokens ?? 0)}</dd></div>
                    <div><dt>Remaining</dt><dd title={remainingTokens?.toLocaleString("en-US")}>{formatTokens(remainingTokens ?? 0)}</dd></div>
                  </dl>
                  {contextLevel ? <span className={`context-pressure ${contextLevel}`}><TriangleAlert size={12} aria-hidden="true" />{contextLevel === "blocked" ? "Context limit reached. Compact or start a new thread to continue." : "Context is getting full. Older turns may be compacted."}</span>
                    : <span className="context-foot">{formatTokens(context.windowTokens ?? 0)} token window</span>}
                  {thread && !thread.agentId && !s.preview ? <button type="button" className="ghost-btn small context-compact" disabled={thread.status === "running"} title={thread.status === "running" ? "Compact when the turn finishes" : "Compact this thread's context now"} onClick={() => { setContextOpen(false); void s.compactThread(); }}>Compact now</button> : null}
                </div>
              </div>
            ) : null}
            <span className="grow" />
            {showGhost ? <span className="ghost-hint" aria-hidden="true"><kbd>Tab</kbd> to complete</span> : null}
            {busySend && !empty ? <SelectMenu
              id="busy-disposition"
              ariaLabel="What to do with this message while a turn runs"
              value={disposition}
              placeholder="Queue"
              options={[
                { value: "queue", label: "Queue next", description: "Run after the current turn finishes" },
                { value: "steer", label: "Steer turn", description: "Fold into the running turn" },
                { value: "replace", label: "Replace turn", description: "Interrupt and start over", tone: "danger" },
              ]}
              onChange={(value) => setDisposition(value as "queue" | "steer" | "replace")}
            /> : null}
            {running ? <>{busySend && !empty ? <button className="send" disabled={busy || s.offline} aria-label={sendTitle} title={sendTitle} onClick={() => void s.sendPrompt({ disposition })}><ArrowUp size={16} strokeWidth={2.4} /></button> : null}<button className="send stop" aria-label="Stop" title="Stop  Esc" disabled={thread?.cancelRequested} onClick={() => void s.stopTurn()}><Square size={11} fill="currentColor" /></button></>
              : <button className="send" disabled={empty || locked || s.offline} aria-label="Send" title={sendTitle} onClick={() => void s.sendPrompt()}><ArrowUp size={16} strokeWidth={2.4} /></button>}
          </div>
        </div>
        <span className="beam-ring" aria-hidden="true" />
      </div>
      <div className="composer-status" role="status">
        {s.modelsError || (!s.modelsLoading && !s.models.length) ? <span className="status-issue"><span>{s.modelsError || "No models found."}</span><button className="ghost-btn small" onClick={() => void s.startHost().catch((error) => useAppStore.setState({ modelsError: String(error) }))}>Retry</button></span> : null}
        {canContinue && !thread?.items.length ? <span className="status-actions">
          <button className="ghost-btn small" onClick={() => void s.continueThread()}><Play size={11} />Continue</button>
          <button className="ghost-btn small" onClick={() => void s.retryLast()}><RotateCcw size={11} />Retry last prompt</button>
        </span> : null}
        {thread?.notice ? <span className={`status-notice ${thread.notice.level}`}><TriangleAlert size={11} aria-hidden="true" />{thread.notice.message}</span> : null}
        {statusText ? <span>{statusText}</span> : null}
      </div>
    </div>
  );
}
