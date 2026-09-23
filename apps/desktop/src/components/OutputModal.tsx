import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Download, LoaderCircle, X } from "lucide-react";
import { saveOutputText } from "../lib/bridge";
import { copyText, formatBytes } from "../lib/format";
import { useAppStore } from "../lib/store";

/** Media types safe to render as text after base64 decoding. */
function isTextMedia(mediaType: string): boolean {
  const type = mediaType.toLowerCase().split(";")[0].trim();
  return type.startsWith("text/") || type === "application/json" || type.endsWith("+json") || type.endsWith("+xml") || type === "application/xml" || type === "application/javascript" || type === "application/yaml" || type === "application/x-sh";
}

const SAVE_EXTENSIONS: Record<string, string> = {
  "application/json": "json",
  "application/xml": "xml",
  "application/javascript": "js",
  "application/yaml": "yaml",
  "application/x-sh": "sh",
  "text/html": "html",
  "text/markdown": "md",
  "text/csv": "csv",
};

function saveFileName(title: string, mediaType: string, binary: boolean): string {
  const stem = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "output";
  const type = mediaType.toLowerCase().split(";")[0].trim();
  const ext = SAVE_EXTENSIONS[type] ?? (type.startsWith("text/") ? "txt" : binary ? "bin" : "txt");
  return stem.endsWith(`.${ext}`) ? stem : `${stem}.${ext}`;
}

function decodeBase64Text(content: string): string | null {
  try {
    const raw = atob(content);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function OutputModal() {
  const viewer = useAppStore((s) => s.outputViewer);
  const close = useAppStore((s) => s.closeOutput);
  const dialog = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (viewer) { if (!node.open) node.showModal(); }
    else if (node.open) node.close();
  }, [viewer]);

  useEffect(() => {
    setCopied(false);
    setSaved(null);
    setSaveError(null);
  }, [viewer?.itemId]);

  const text = useMemo(() => {
    if (!viewer || viewer.loading || viewer.error) return null;
    if (viewer.encoding === "utf8") return viewer.content;
    if (isTextMedia(viewer.mediaType)) return decodeBase64Text(viewer.content);
    return null;
  }, [viewer]);

  const binary = Boolean(viewer && !viewer.loading && !viewer.error && text === null);

  if (!viewer) return null;

  return <dialog ref={dialog} className="modal output-dialog" aria-labelledby="output-title" aria-hidden={!viewer} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="settings-header">
      <div>
        <h2 id="output-title">{viewer?.title ?? "Full output"}</h2>
        <p>{viewer && !viewer.loading && !viewer.error ? `${formatBytes(viewer.byteLen)} stored · ${viewer.mediaType}${viewer.complete ? "" : " · showing the first pages"}` : "Full stored output"}</p>
      </div>
      <button type="button" className="icon-btn settings-close" aria-label="Close output" onClick={close}><X size={17} /></button>
    </header>
    {!viewer ? null : viewer.loading ? (
      <p className="review-note"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Reading full output…</p>
    ) : viewer.error ? (
      <p className="review-note" role="alert">{viewer.error}</p>
    ) : binary ? (
      <p className="review-note">Binary output ({viewer.mediaType}, {formatBytes(viewer.byteLen)}) — save it to inspect the bytes.</p>
    ) : (
      <pre className="output-body">{text}</pre>
    )}
    {viewer && !viewer.loading && !viewer.error ? (
      <footer className="output-foot">
        {saveError ? <span className="output-status bad" role="alert">{saveError}</span> : saved ? <span className="output-status" title={saved}>Saved to {saved.split(/[/\\]/).pop()}</span> : <span />}
        <span className="output-actions">
          {text !== null ? (
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                void copyText(text).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : "Copy"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setSaveError(null);
              const base64 = viewer.encoding === "base64";
              void saveOutputText(saveFileName(viewer.title, viewer.mediaType, text === null), viewer.content, base64)
                .then((path) => setSaved(path))
                .catch((error) => setSaveError(error instanceof Error ? error.message : String(error)));
            }}
          >
            <Download size={13} />Save
          </button>
        </span>
      </footer>
    ) : null}
  </dialog>;
}
