import { useEffect, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";
import { keys } from "./platform";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="pill-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

const EDITIONS: Record<string, string> = {
  installed: "Installed",
  portable: "Portable - update manually",
  appimage: "AppImage",
  package: "Linux package (updates via apt)",
};

export function AboutDialog({ onClose, onOpenSettings }: { onClose: () => void; onOpenSettings: () => void }) {
  const desktop = window.folioDesktop;
  const [info, setInfo] = useState<Awaited<ReturnType<MarginaliaDesktop["getAppInfo"]>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    desktop?.getAppInfo().then(info => { if (!cancelled) setInfo(info); }).catch(() => {
      if (!cancelled) setError("Couldn't read application details.");
    });
    return () => { cancelled = true; };
  }, [desktop]);
  return <Modal title="About Marginalia" onClose={onClose}>
    <dl className="info-list">
      <div><dt>Version</dt><dd>{info?.version ?? (desktop ? "Loading..." : "Browser edition")}</dd></div>
      <div><dt>Edition</dt><dd>{EDITIONS[info?.mode ?? ""] ?? (desktop ? "Development" : "Web")}</dd></div>
      {info && <div><dt>Location</dt><dd className="installation-path">{info.location}</dd></div>}
    </dl>
    <div className="about-update">
      <p>{desktop ? "Updates, appearance, and Ask AI accounts are in Settings." : "Documents and reading preferences stay on this device."}</p>
      {info?.mode === "portable" && <p className="search-hint">Use the Setup installer for automatic updates and a single installed copy.</p>}
      {info?.mode === "package" && <p className="search-hint">New versions arrive with your system's software updates (apt).</p>}
      <div className="form-actions">
        {desktop && <button className="btn ghost" onClick={() => {
          void desktop.openInstallation().then(message => setError(message || null)).catch(() => setError("Couldn't open the installation folder."));
        }}>Open installation folder</button>}
        {desktop && <button className="btn primary" onClick={onOpenSettings}>Settings</button>}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  </Modal>;
}

function parsePdfDate(s?: string) {
  const m = s?.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const d = new Date(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0));
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function InfoDialog({ pdf, name, size, onClose }: { pdf: PDFDocumentProxy; name: string; size: number; onClose: () => void }) {
  const [rows, setRows] = useState<[string, string][]>([]);

  useEffect(() => {
    (async () => {
      const { info } = (await pdf.getMetadata()) as { info: Record<string, string> };
      const first = await pdf.getPage(1);
      const [, , w, h] = first.view;
      const inches = (pt: number) => (pt / 72).toFixed(2);
      setRows(
        [
          ["File", name],
          ["Title", info.Title],
          ["Author", info.Author],
          ["Subject", info.Subject],
          ["Pages", String(pdf.numPages)],
          ["Page size", `${inches(w)} × ${inches(h)} in`],
          ["File size", formatBytes(size)],
          ["Created", parsePdfDate(info.CreationDate)],
          ["Modified", parsePdfDate(info.ModDate)],
          ["Application", info.Creator],
          ["Producer", info.Producer],
          ["PDF version", info.PDFFormatVersion],
        ].filter((r): r is [string, string] => !!r[1]),
      );
    })();
  }, [pdf, name, size]);

  return (
    <Modal title="Document info" onClose={onClose}>
      <dl className="info-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Open file", "Ctrl O"],
  ["Open from URL", "Ctrl Shift O"],
  ["Highlight selection", "H"],
  ["Write a note on the selection", "N"],
  ["Remove a clicked highlight", "Delete"],
  ["Find", "Ctrl F"],
  ["Save / download", "Ctrl S"],
  ["Print", "Ctrl P"],
  ["Zoom in / out", "Ctrl + / −"],
  ["Reset zoom", "Ctrl 0"],
  ["Toggle sidebar", "Ctrl \\"],
  ["Select tool", "V"],
  ["Draw", "D"],
  ["Add text", "T"],
  ["Rotate pages", "R"],
  ["Two-page view", "2"],
  ["Focus mode", "F"],
  ["First / last page", "Home / End"],
  ["Settings", "Ctrl ,"],
  ["Shortcuts", "?"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <dl className="info-list shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              {keys(v).split(" ").map((key, i) => (key === "/" ? <span key={i}> / </span> : <kbd key={i}>{key}</kbd>))}
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

/** Returns the http(s) URL in `text`, or null if it isn't a single web link. */
export function parseWebUrl(text: string | null | undefined) {
  const value = (text ?? "").trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const explicit = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(explicit ? value : "https://" + value);
    // Without a scheme, only accept text that looks like a domain ("example.com/a.pdf").
    return (url.protocol === "http:" || url.protocol === "https:") && (explicit || url.hostname.includes(".")) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function OpenUrlDialog({ onSubmit, onClose }: { onSubmit: (url: string) => void; onClose: () => void }) {
  const [value, setValue] = useState("");
  const url = parseWebUrl(value);
  return (
    <Modal title="Open from URL" onClose={onClose}>
      <form
        className="password-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (url) onSubmit(url);
        }}
      >
        <p>Paste a link to a PDF or a webpage. Webpages become a PDF you can highlight and mark up. You can also drop or paste a link anywhere in Marginalia.</p>
        <input type="url" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://example.com/article" aria-label="PDF URL" />
        {value.trim() && !url && <p className="form-error">Enter an http:// or https:// address.</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!url}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PasswordDialog({
  name,
  error,
  onSubmit,
  onCancel,
}: {
  name: string;
  error?: string;
  onSubmit: (pw: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <Modal title="Password required" onClose={onCancel}>
      <form
        className="password-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(pw);
        }}
      >
        <p>
          “{name}” is protected. Enter its password to open it.
        </p>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!pw}>
            Open
          </button>
        </div>
      </form>
    </Modal>
  );
}
