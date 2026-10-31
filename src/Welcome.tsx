import { useEffect, useState } from "react";
import { clearRecent, listRecent, removeRecent, type RecentFile } from "./recent";
import { Icon } from "./icons";
import { keys } from "./platform";
import { formatBytes } from "./Dialogs";
import { updateSummary } from "./updates";

function timeAgo(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function UpdateLine({ status }: { status: UpdateStatus }) {
  const desktop = window.folioDesktop!;
  const check = (
    <button className="link version-action" onClick={() => desktop.checkForUpdates()}>
      Check for updates
    </button>
  );
  switch (status.state) {
    case "ready":
      return (
        <>
          {" · "}
          <button className="link version-action" onClick={() => desktop.installUpdate()}>
            Restart to update to {status.version}
          </button>
        </>
      );
    case "latest":
      return <> · Up to date · {check}</>;
    case "error":
      return (
        <>
          <span title={status.message}> · Couldn't check for updates</span> · {check}
        </>
      );
    case "available":
      return (
        <>
          {" · "}
          <button className="link version-action" onClick={() => void desktop.openDownload()}>
            Download Marginalia {status.version}
          </button>
        </>
      );
    case "idle":
      return <> · {check}</>;
    default:
      return <> · {updateSummary(status)}</>;
  }
}

interface Props {
  onPick: () => void;
  onOpenUrl: () => void;
  onOpenBytes: (name: string, data: Uint8Array) => void;
  onError: (message: string) => void;
  onSample: () => void;
  loading: boolean;
}

export function Welcome({ onPick, onOpenUrl, onOpenBytes, onError, onSample, loading }: Props) {
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [version, setVersion] = useState<string | null>(null);

  const [update, setUpdate] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    window.folioDesktop?.getAppInfo().then((info) => setVersion(info.version)).catch(() => {});
    return window.folioDesktop?.onUpdateStatus?.(setUpdate);
  }, []);

  useEffect(() => {
    listRecent().then(setRecent);
  }, []);

  // A stored blob that can't be read back is dead weight: drop the entry so it doesn't keep failing.
  const reopen = async (f: RecentFile) => {
    try {
      onOpenBytes(f.name, new Uint8Array(await f.data.arrayBuffer()));
    } catch {
      await forget(f.id);
      onError(`Couldn't reopen “${f.name}”. It was removed from Recent.`);
    }
  };

  const forget = async (id: string) => {
    await removeRecent(id);
    setRecent((r) => r.filter((f) => f.id !== id));
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="hero">
          <h1>Read beautifully.</h1>
          <p>A calm, fast PDF reader. Your files never leave this device.</p>
        </div>

        <button className="dropzone" onClick={onPick} disabled={loading}>
          <div className="dropzone-icon">
            <Icon name={loading ? "file" : "upload"} size={26} />
          </div>
          <div className="dropzone-text">
            <strong>{loading ? "Opening…" : "Open a PDF"}</strong>
            <span>{window.folioDesktop ? "Drop a PDF, a Word document, a link, or a webpage anywhere, or click to browse"
              : "Drop a PDF, a link, or a webpage anywhere, or click to browse"}</span>
          </div>
          <kbd>{keys("Ctrl O")}</kbd>
        </button>

        <div className="welcome-links">
          <button className="link" onClick={onOpenUrl} disabled={loading}>
            <Icon name="link" size={15} /> Open from URL
          </button>
          <button className="link" onClick={onSample}>
            <Icon name="book" size={15} /> Try a sample document
          </button>
        </div>

        {recent.length > 0 && (
          <section className="recent">
            <div className="recent-head">
              <h3>Recent</h3>
              <button
                className="link"
                onClick={async () => {
                  if (!confirm("Remove all recent files from Marginalia? The original files aren't affected.")) return;
                  await clearRecent();
                  setRecent([]);
                }}
              >
                Clear all
              </button>
            </div>
            <div className="recent-grid">
              {recent.map((f) => (
                <div key={f.id} className="recent-card" onClick={() => void reopen(f)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && void reopen(f)}>
                  <div className="recent-thumb">
                    {f.thumb ? <img src={f.thumb} alt="" /> : <Icon name="file" size={28} />}
                    {f.lastPage > 1 && (
                      <span className="recent-progress" style={{ width: `${(f.lastPage / f.pages) * 100}%` }} />
                    )}
                  </div>
                  <div className="recent-meta">
                    <strong title={f.name}>{f.name.replace(/\.pdf$/i, "")}</strong>
                    <span>
                      {timeAgo(f.openedAt)} · {f.pages} {f.pages === 1 ? "page" : "pages"} · {formatBytes(f.size)}
                    </span>
                  </div>
                  <button
                    className="recent-remove"
                    title="Remove from recent"
                    onClick={(e) => {
                      e.stopPropagation();
                      forget(f.id);
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {version && (
          <p className="version">
            Marginalia {version}
            {update && <UpdateLine status={update} />}
          </p>
        )}
      </div>
    </div>
  );
}
