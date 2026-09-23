import { useEffect, useRef } from "react";
import { LoaderCircle, ScanSearch, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { currentThread, useAppStore } from "../lib/store";
import type { TranscriptItem } from "../lib/types";

const PREVIEW_ITEMS = 40;
const SNIPPET = 280;

export function snippet(item: TranscriptItem): string {
  const text = item.text ?? item.fallbackText ?? "";
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
}

export function role(item: TranscriptItem): string {
  if (item.kind === "userMessage") return "You";
  if (item.kind === "agentMessage") return "Muse";
  if (item.kind === "toolCall") return item.tool ? `Tool · ${item.tool}` : "Tool";
  if (item.kind === "compaction") return "Compaction";
  return item.kind;
}

export function PreviewModal() {
  const s = useAppStore(useShallow((state) => ({
    previewSession: state.previewSession,
    closePreview: state.closePreview,
    selectThread: state.selectThread,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
  })));
  const preview = s.previewSession;
  const dialog = useRef<HTMLDialogElement>(null);
  const live = currentThread(s)?.sessionId === preview?.sessionId;

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (preview) { if (!node.open) node.showModal(); }
    else if (node.open) node.close();
  }, [preview]);

  const close = () => s.closePreview();
  const items = preview?.snapshot?.history?.items ?? [];
  const shown = items.slice(-PREVIEW_ITEMS);
  const turns = items.filter((item) => item.kind === "userMessage").length;

  if (!preview) return null;

  return <dialog ref={dialog} className="modal preview-dialog" aria-labelledby="preview-title" aria-hidden={!preview} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="settings-header">
      <div>
        <h2 id="preview-title">{preview?.title ?? "Preview"}</h2>
        <p>Read-only — opening the thread attaches it.</p>
      </div>
      <button type="button" className="icon-btn settings-close" aria-label="Close preview" onClick={close}><X size={17} /></button>
    </header>
    {!preview ? null : preview.loading ? (
      <p className="review-note"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Reading session…</p>
    ) : preview.error ? (
      <p className="review-note" role="alert">{preview.error}</p>
    ) : (
      <>
        <dl className="preview-meta">
          <div><dt>Status</dt><dd>{preview.snapshot?.session?.status ?? "unknown"}</dd></div>
          <div><dt>Turns</dt><dd>{turns}</dd></div>
          <div><dt>Items</dt><dd>{items.length}</dd></div>
          {preview.snapshot?.session?.updatedAt ? <div><dt>Updated</dt><dd>{new Date(preview.snapshot.session.updatedAt).toLocaleString()}</dd></div> : null}
        </dl>
        {shown.length ? (
          <ol className="preview-items">
            {items.length > shown.length ? <li className="preview-gap" aria-hidden="true">⋯ {items.length - shown.length} earlier items</li> : null}
            {shown.map((item) => (
              <li key={item.itemId} className={`preview-item kind-${item.kind}`}>
                <span className="preview-role">{role(item)}</span>
                <span className="preview-text">{snippet(item) || "—"}</span>
              </li>
            ))}
          </ol>
        ) : <p className="review-note">No transcript items yet.</p>}
        <footer className="preview-foot">
          <span className="preview-note"><ScanSearch size={12} aria-hidden="true" />Point-in-time read{live ? " — this thread is open, so it may already be stale" : ""}.</span>
          <button type="button" className="ghost-btn small" onClick={() => { const id = preview.sessionId; close(); void s.selectThread(id); }}>Open thread</button>
        </footer>
      </>
    )}
  </dialog>;
}
