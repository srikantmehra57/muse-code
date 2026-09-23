import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useAppStore } from "../lib/store";

/**
 * App-level confirmation dialog — the in-app replacement for window.confirm.
 * The pending request lives in the store (`confirmDialog`); `confirm()` awaits
 * resolveConfirm(true|false). Enter confirms, Escape cancels.
 */
export function ConfirmDialog() {
  const dialog = useAppStore((s) => s.confirmDialog);
  const resolveConfirm = useAppStore((s) => s.resolveConfirm);
  const node = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    if (dialog) { if (!el.open) el.showModal(); }
    else if (el.open) el.close();
  }, [dialog]);

  useEffect(() => {
    if (!dialog) return;
    // Destructive prompts start on Cancel so Enter cannot destroy by accident.
    (dialog.danger ? cancelRef : confirmRef).current?.focus();
  }, [dialog]);

  if (!dialog) return null;
  const cancel = () => resolveConfirm(false);
  const accept = () => resolveConfirm(true);

  return <dialog ref={node} className="modal confirm-dialog" aria-labelledby="confirm-dialog-title" onCancel={(event) => { event.preventDefault(); cancel(); }} onClose={cancel} onClick={(event) => { if (event.target === event.currentTarget) cancel(); }} onKeyDown={(event) => {
      // Escape normally arrives via the dialog's cancel event; the explicit
      // branch keeps behaviour identical where that mapping is absent (jsdom).
      // Enter confirms, but a focused button keeps its own meaning: Enter on
      // Cancel must cancel, not destroy. Destructive prompts start focus on
      // Cancel precisely so Enter cannot destroy by accident, so the dialog
      // must never treat Enter-on-Cancel as a confirmation.
      if (event.key === "Enter") {
        event.preventDefault();
        const target = event.target;
        if (target instanceof HTMLButtonElement && target !== confirmRef.current) cancel();
        else accept();
      }
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
    }}>
    <header className="confirm-head">
      <div className="confirm-copy">
        <h2 id="confirm-dialog-title" title={dialog.title}>{dialog.title}</h2>
        {dialog.body ? <p>{dialog.body}</p> : null}
      </div>
      <button type="button" className="icon-btn confirm-close" aria-label="Cancel" onClick={cancel}><X size={17} /></button>
    </header>
    <footer className="confirm-foot">
      <button ref={cancelRef} type="button" className="secondary" onClick={cancel}>Cancel</button>
      <button ref={confirmRef} type="button" className={dialog.danger ? "secondary danger" : "primary"} onClick={accept}>{dialog.confirmLabel}</button>
    </footer>
  </dialog>;
}
