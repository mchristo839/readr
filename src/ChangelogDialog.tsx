import { Fragment, type ReactNode } from "react";
import { Modal } from "./Dialogs";
import changelog from "../CHANGELOG.md?raw";

/** CHANGELOG.md, bundled at build time so it works offline and always matches this build. */
interface Release {
  version: string;
  items: string[];
}

// CHANGELOG.md only uses "## version" headings and "- " bullets (wrapped onto indented lines), so a full
// Markdown parser isn't needed.
function parse(text: string): Release[] {
  const releases: Release[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) releases.push({ version: heading[1].trim(), items: [] });
    const current = releases[releases.length - 1];
    if (!current || heading) continue;
    if (line.startsWith("- ")) current.items.push(line.slice(2).trim());
    else if (line.trim() && current.items.length) current.items[current.items.length - 1] += " " + line.trim();
  }
  return releases;
}

// **bold** and `code` are the only inline styles the changelog uses.
function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong>
    : part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code>
    : <Fragment key={i}>{part}</Fragment>);
}

const RELEASES = parse(changelog);

export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="What's new" onClose={onClose}>
      <div className="changelog">
        {RELEASES.map((r) => (
          <section key={r.version}>
            <h3>Readr {r.version}</h3>
            <ul>
              {r.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
