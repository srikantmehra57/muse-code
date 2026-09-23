import { useEffect, useRef } from "react";
import { FilePlus, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useAppStore } from "../lib/store";

/**
 * Project agent-config setup (`muse init`). Shows the dry-run AGENTS.md
 * preview before writing; an existing file surfaces as an explicit
 * conflict with a force-replace choice instead of a silent overwrite.
 */
export function InitModal() {
  const dialog = useAppStore((s) => s.initDialog);
  const close = useAppStore((s) => s.closeInitDialog);
  const run = useAppStore((s) => s.runInit);
  const workspaces = useAppStore((s) => s.workspaces);
  const node = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    if (dialog) { if (!el.open) el.showModal(); }
    else if (el.open) el.close();
  }, [dialog]);

  const workspace = workspaces.find((item) => item.id === dialog?.workspaceId);

  if (!dialog) return null;

  return <dialog ref={node} className="modal preview-dialog" aria-labelledby="init-title" aria-hidden={!dialog} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="settings-header">
      <div>
        <h2 id="init-title">Set up {workspace?.name ?? "workspace"}</h2>
        <p>Scaffold the workspace's AGENTS.md project rules. Nothing is written until you confirm.</p>
      </div>
      <button type="button" className="icon-btn settings-close" aria-label="Close project setup" onClick={close}><X size={17} /></button>
    </header>
    {!dialog ? null : dialog.loading ? (
      <p className="review-note"><LoaderCircle size={13} className="spin" aria-hidden="true" /> {dialog.preview ? "Writing AGENTS.md…" : "Previewing AGENTS.md…"}</p>
    ) : dialog.error ? (
      <p className="review-note" role="alert">{dialog.error}</p>
    ) : dialog.done ? (
      <>
        <p className="review-note">AGENTS.md is ready. Trusted workspaces load it into every session.</p>
        <footer className="preview-foot">
          <span className="preview-note" />
          <span className="output-actions">
            <button type="button" className="btn" onClick={close}>Done</button>
          </span>
        </footer>
      </>
    ) : dialog.preview ? (
      <>
        {dialog.conflict ? <p className="review-note" role="alert"><TriangleAlert size={13} aria-hidden="true" /> AGENTS.md already exists. Replace it with the scaffold below, or cancel to keep it.</p> : null}
        <div className="monitor-heading trust-head"><span>AGENTS.md preview</span></div>
        <pre className="trust-rules">{dialog.preview}</pre>
        <footer className="preview-foot">
          <span className="preview-note">{dialog.conflict ? "Force replaces the existing file." : "Scaffold writes AGENTS.md once."}</span>
          <span className="output-actions">
            <button type="button" className="ghost-btn small" onClick={close}>Cancel</button>
            <button type="button" className="btn" onClick={() => void run(dialog.conflict)}><FilePlus size={13} />{dialog.conflict ? "Replace file" : "Scaffold"}</button>
          </span>
        </footer>
      </>
    ) : null}
  </dialog>;
}
