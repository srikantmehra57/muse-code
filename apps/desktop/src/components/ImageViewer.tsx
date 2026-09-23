import { useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useAppStore } from "../lib/store";

export function ImageViewer() {
  const viewer = useAppStore((state) => state.viewer);
  const closeViewer = useAppStore((state) => state.closeViewer);
  const stepViewer = useAppStore((state) => state.stepViewer);
  useEffect(() => {
    if (!viewer || viewer.images.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") stepViewer(1);
      else if (event.key === "ArrowLeft") stepViewer(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, stepViewer]);
  useEffect(() => {
    if (!viewer) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeViewer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, closeViewer]);
  if (!viewer) return null;
  const current = viewer.images[viewer.index];
  if (!current) return null;
  const multiple = viewer.images.length > 1;
  return (
    <div
      className="viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={current.name || "Image preview"}
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeViewer(); }}
    >
      <figure className="viewer-frame">
        <img src={`data:${current.mediaType};base64,${current.base64Data}`} alt={current.name} />
        <figcaption className="viewer-bar">
          <span className="viewer-name" title={current.name}>{current.name}</span>
          {multiple ? <span className="viewer-count">{viewer.index + 1} of {viewer.images.length}</span> : null}
        </figcaption>
      </figure>
      {multiple ? (
        <>
          <button type="button" className="viewer-nav prev" aria-label="Previous image" onClick={() => stepViewer(-1)}><ChevronLeft size={20} aria-hidden="true" /></button>
          <button type="button" className="viewer-nav next" aria-label="Next image" onClick={() => stepViewer(1)}><ChevronRight size={20} aria-hidden="true" /></button>
        </>
      ) : null}
      <button type="button" className="viewer-close" aria-label="Close preview" autoFocus onClick={closeViewer}><X size={16} aria-hidden="true" /></button>
    </div>
  );
}
