import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { PDFDocumentProxy } from "./pdf";
import type { ImageRegion } from "./nightImages";

export interface ImageTarget {
  pageNumber: number;
  region: ImageRegion;
  rotation: number;
  /** The web address behind the image, if it has one (a link, or a converted webpage's original image). */
  href: string | null;
}

const MAX_OUTPUT_PX = 2600;
const MAX_RENDER_PIXELS = 48_000_000;

/** Renders just the image's area of the page at high resolution. */
async function renderRegion(pdf: PDFDocumentProxy, target: ImageTarget, signal: AbortSignal) {
  const page = await pdf.getPage(target.pageNumber);
  const base = page.getViewport({ scale: 1, rotation: (page.rotate + target.rotation) % 360 });
  const { region } = target;
  const regionWidth = (region.right - region.left) * base.width;
  const regionHeight = (region.bottom - region.top) * base.height;
  let scale = Math.min(8, Math.max(1, MAX_OUTPUT_PX / Math.max(regionWidth, regionHeight)));
  scale = Math.min(scale, Math.sqrt(MAX_RENDER_PIXELS / (base.width * base.height)));
  const viewport = page.getViewport({ scale, rotation: (page.rotate + target.rotation) % 360 });
  const full = document.createElement("canvas");
  full.width = Math.floor(viewport.width);
  full.height = Math.floor(viewport.height);
  const task = page.render({ canvas: full, viewport });
  signal.addEventListener("abort", () => task.cancel(), { once: true });
  await task.promise;
  const sx = Math.floor(region.left * full.width);
  const sy = Math.floor(region.top * full.height);
  const sw = Math.max(1, Math.ceil(region.right * full.width) - sx);
  const sh = Math.max(1, Math.ceil(region.bottom * full.height) - sy);
  const out = document.createElement("canvas");
  out.width = sw;
  out.height = sh;
  out.getContext("2d")!.drawImage(full, sx, sy, sw, sh, 0, 0, sw, sh);
  full.width = full.height = 0;
  return out;
}

/** A small menu next to a clicked image. */
export function ImageMenu({ x, y, stageWidth, href, onView, onOpen }: {
  x: number;
  y: number;
  stageWidth: number;
  href: string | null;
  onView: () => void;
  onOpen: () => void;
}) {
  const width = href ? 300 : 150;
  const left = Math.min(Math.max(8, x - width / 2), Math.max(8, stageWidth - width - 8));
  return (
    <div className="selection-popover" role="toolbar" aria-label="Image" style={{ left, top: Math.max(8, y - 54) }}>
      <div className="pop-row">
        <button className="pop-btn" onClick={onView} title="View larger in Readr">
          <Icon name="expand" size={15} /> View larger
        </button>
        {href && (
          <button className="pop-btn" onClick={onOpen} title={href}>
            <Icon name="link" size={15} /> Open in browser
          </button>
        )}
      </div>
    </div>
  );
}

/** A full-window view of one image: fit to the window, click to see it at full size. */
export function ImageViewer({ pdf, target, onClose }: { pdf: PDFDocumentProxy; target: ImageTarget; onClose: () => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [actual, setActual] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    renderRegion(pdf, target, controller.signal).then(setImage).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [pdf, target]);

  useEffect(() => {
    const el = holder.current;
    if (!el || !image) return;
    image.className = "image-viewer-canvas";
    el.replaceChildren(image);
  }, [image]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const copy = () => {
    image?.toBlob((blob) => {
      if (!blob) return;
      navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }, () => {});
    }, "image/png");
  };

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label="Image" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="image-viewer-bar">
        <span className="image-viewer-title">Page {target.pageNumber}{image ? ` · ${image.width} × ${image.height}` : ""}</span>
        <button className="pop-btn" onClick={() => setActual(!actual)} disabled={!image}>
          <Icon name={actual ? "fitPage" : "plus"} size={15} /> {actual ? "Fit to window" : "Actual size"}
        </button>
        <button className="pop-btn" onClick={copy} disabled={!image}>
          <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy image"}
        </button>
        {target.href && (
          <a className="pop-btn" href={target.href} target="_blank" rel="noreferrer" title={target.href}>
            <Icon name="link" size={15} /> Open in browser
          </a>
        )}
        <button className="pop-btn icon-only" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className={`image-viewer-stage ${actual ? "actual" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {failed ? <p className="image-viewer-msg">Couldn't show this image.</p> : !image && <p className="image-viewer-msg">Loading…</p>}
        <div ref={holder} className="image-viewer-holder" onClick={() => image && setActual(!actual)} />
      </div>
    </div>
  );
}
