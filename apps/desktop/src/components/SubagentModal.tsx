import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, ScanSearch, X } from "lucide-react";
import { useAppStore } from "../lib/store";
import { role, snippet } from "./PreviewModal";

const CHILD_ITEMS = 40;

/**
 * Child drill-down: the subagent's result envelope plus its transcript read
 * without attaching (`session/read` on the child session). Consuming the
 * result is an explicit, state-changing gesture.
 */
export function SubagentModal() {
  const viewing = useAppStore((s) => s.childSession);
  const close = useAppStore((s) => s.closeChild);
  const consume = useAppStore((s) => s.consumeChild);
  const dialog = useRef<HTMLDialogElement>(null);
  const [consuming, setConsuming] = useState(false);
  const [consumeError, setConsumeError] = useState<string | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (viewing) { if (!node.open) node.showModal(); }
    else if (node.open) node.close();
  }, [viewing]);

  useEffect(() => {
    setConsuming(false);
    setConsumeError(null);
  }, [viewing?.itemId]);

  const items = viewing?.items ?? [];
  const shown = items.slice(-CHILD_ITEMS);
  const result = viewing?.result ?? null;

  if (!viewing) return null;

  return <dialog ref={dialog} className="modal preview-dialog" aria-labelledby="child-title" aria-hidden={!viewing} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="settings-header">
      <div>
        <h2 id="child-title">{viewing?.title ?? "Subagent"}</h2>
        <p>Read-only child session — nothing here attaches it.</p>
      </div>
      <button type="button" className="icon-btn settings-close" aria-label="Close child view" onClick={close}><X size={17} /></button>
    </header>
    {!viewing ? null : viewing.loading ? (
      <p className="review-note"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Reading child transcript…</p>
    ) : (
      <>
        {result ? (
          <section className="child-result" aria-label="Child result">
            <div className="monitor-heading"><span>Result</span>{viewing.consumed ? <span className="monitor-count">Consumed</span> : null}</div>
            <p className="child-summary">{result.summary}</p>
            {result.text ? <pre className="child-text">{result.text}</pre> : null}
            {result.errorKind ? <p className="review-note" role="alert">Failed: {result.errorKind}</p> : null}
            {result.artifactRefs.length || result.evidenceRefs.length ? (
              <ul className="child-refs">
                {result.artifactRefs.map((ref) => <li key={`a:${ref}`}>Artifact · {ref}</li>)}
                {result.evidenceRefs.map((ref) => <li key={`e:${ref}`}>Evidence · {ref}</li>)}
              </ul>
            ) : null}
            {!viewing.consumed ? (
              <div className="agent-buttons" role="toolbar" aria-label="Result controls">
                <button
                  type="button"
                  className="agent-btn primary"
                  disabled={consuming}
                  title="Consume the ready result (state-changing)"
                  onClick={() => {
                    setConsuming(true);
                    setConsumeError(null);
                    void consume()
                      .catch((cause) => setConsumeError(cause instanceof Error ? cause.message : String(cause)))
                      .finally(() => setConsuming(false));
                  }}
                >
                  <Check size={12} />Mark consumed
                </button>
              </div>
            ) : null}
            {consumeError ? <p className="monitor-error" role="alert">{consumeError}</p> : null}
          </section>
        ) : <p className="review-note">No result yet — the child has not finished one.</p>}
        <div className="monitor-heading child-transcript-head"><span>Transcript</span></div>
        {viewing.error ? <p className="review-note" role="alert">{viewing.error}</p>
          : shown.length ? (
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
          <span className="preview-note"><ScanSearch size={12} aria-hidden="true" />Point-in-time read — the child may still be writing.</span>
        </footer>
      </>
    )}
  </dialog>;
}
