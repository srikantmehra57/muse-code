import { useEffect, useRef } from "react";
import { LoaderCircle, ShieldCheck, X } from "lucide-react";
import { useAppStore } from "../lib/store";

/**
 * Explicit workspace trust decision. Shows exactly what trusting loads —
 * the workspace's project skills and its rules file — before the host
 * restarts with `--trust-workspace`.
 */
export function TrustModal() {
  const dialog = useAppStore((s) => s.trustDialog);
  const close = useAppStore((s) => s.closeTrustDialog);
  const confirm = useAppStore((s) => s.confirmTrust);
  const workspaces = useAppStore((s) => s.workspaces);
  const node = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    if (dialog) { if (!el.open) el.showModal(); }
    else if (el.open) el.close();
  }, [dialog]);

  const workspace = workspaces.find((item) => item.id === dialog?.workspaceId);
  const preview = dialog?.preview ?? null;

  if (!dialog) return null;

  return <dialog ref={node} className="modal preview-dialog" aria-labelledby="trust-title" aria-hidden={!dialog} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="settings-header">
      <div>
        <h2 id="trust-title">Trust {workspace?.name ?? "workspace"}?</h2>
        <p>Trusting loads this folder's skills and rules into every session. The host restarts to apply it.</p>
      </div>
      <button type="button" className="icon-btn settings-close" aria-label="Close trust dialog" onClick={close}><X size={17} /></button>
    </header>
    {!dialog ? null : dialog.loading ? (
      <p className="review-note"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Reading project skills and rules…</p>
    ) : dialog.error ? (
      <p className="review-note" role="alert">{dialog.error}</p>
    ) : preview ? (
      <>
        <div className="monitor-heading trust-head"><span>Project skills · {preview.skills.length}</span></div>
        {preview.skills.length ? (
          <ul className="trust-skills">
            {preview.skills.map((skill) => (
              <li key={skill.name}><strong>{skill.name}</strong>{skill.description ? <span> — {skill.description}</span> : null}</li>
            ))}
          </ul>
        ) : <p className="review-note">No project skills in this workspace.</p>}
        <div className="monitor-heading trust-head"><span>Workspace rules</span></div>
        {preview.rules ? (
          <pre className="trust-rules" title={preview.rules.path}>{preview.rules.excerpt}{preview.rules.truncated ? "\n…" : ""}</pre>
        ) : <p className="review-note">No AGENTS.md in this workspace.</p>}
        <footer className="preview-foot">
          <span className="preview-note">Untrusted workspaces load neither.</span>
          <span className="output-actions">
            <button type="button" className="ghost-btn small" onClick={close}>Cancel</button>
            <button type="button" className="btn" onClick={() => void confirm()}><ShieldCheck size={13} />Trust workspace</button>
          </span>
        </footer>
      </>
    ) : null}
  </dialog>;
}
