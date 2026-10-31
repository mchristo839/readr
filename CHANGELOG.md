# Changelog

## 1.10.8

- Clicking a link in a PDF shows where it goes and asks before opening your browser or mail app. A PDF can make a link
  invisible and as large as the page, so any click could open a site.
- A pasted or dropped link fills in **Open from URL** instead of opening straight away, so you can check it first.
- Links and webpages can't reach your computer or local network (your router, a NAS, a dev server) unless you say so.
  Before, a web address that only pointed there by name got through.
- Word documents that Folio converts itself are read in a separate process. A document built to use up memory now
  fails with a message instead of closing Folio. LibreOffice converts with macros and linked content turned off.

## 1.10.7

- Highlighting keeps working after your first highlight. Before, it could stop until you reopened the document, and
  on a busy computer a highlight could be dropped.

## 1.10.6

- Open Word documents (.docx and .doc) in Folio: right-click and choose **Open with → Folio**, use **Open**, or drop
  one in. Folio converts it to a PDF, saves it next to the original ("Report.docx" gets "Report.pdf"), and opens it.
  It uses Microsoft Word or LibreOffice when installed, otherwise its own converter for .docx. Word stays the
  default app for double-clicking.

## 1.10.5

- Ask AI shows equations as math, in answers and in saved chats.
- Printing no longer marks unsaved highlights and signatures as saved, so Folio still asks before you open another
  document over them.
- Highlighting text on a page that's still loading works. Before, it could drop the highlight and your selection.
- Opening a PDF uses less memory by avoiding an extra copy of the document.
- Downloads include fewer unused resources without changing Folio's language or PDF support.
- The Ask AI welcome card stays inside its panel instead of covering the document.

## 1.10.3

- **Copy** buttons work in the desktop app. Copying selected text, **Copy all** in Notes, and **Copy image** said
  "Copied" but left the clipboard unchanged.
- Text boxes come back when you reopen a document. Before, they reopened empty and the next auto-save removed them.
- **Save a copy** and **Print** include every saved mark, not just the ones on pages you'd scrolled to since reopening.
- Opening another document over a placed signature, or over markup on a password-protected PDF, asks first instead of
  discarding it.

## 1.10.2

- **What's new** in Settings shows this changelog inside Folio.
- Opening, saving, or printing a document that fails now says so instead of doing nothing, and a Recent entry that
  can no longer be read is removed with a message. On the desktop, if printing fails, Folio saves a copy instead.
- Opening a PDF from your file manager no longer freezes Folio while it loads, and files over 300 MB are refused with
  a message (the same limit as links).
- PDFs over 50 MB still open normally but aren't kept in Recent, so it no longer stores gigabytes of copies on disk.
- Smaller fixes: downloaded and converted files never get a name Windows reserves (like `CON.pdf`); on macOS, opening
  the install folder shows the folder containing Folio rather than the inside of the app; the ChatGPT sign-in ignores
  malformed requests instead of failing; and the browser edition gets the same content security policy and 300 MB
  link limit as the desktop app.

## 1.10.1

- Drawing keeps the pointer captured during a stroke, including when it crosses the page boundary, and recovers
  cleanly when the window loses focus or a stroke is canceled.
- A redesigned signature dialog separates adding a signature from placing it on the page, with clearer camera and
  photo controls, a larger preview, keyboard placement, and an explicit approval footer that stays visible in small
  windows.
- The README now covers all current features, keyboard shortcuts, privacy, platform-specific updates, and limits,
  including saving a PDF copy to keep placed signatures.

## 1.10.0

- **Settings** in the ⋯ menu (Ctrl+,) gathers every preference in one place: theme, night reading, the default Ask AI
  provider, ChatGPT sign-in and Claude Code status, forgetting a remembered signature, and automatic updates. The
  separate theme and night-reading toggles, the update switch in About, the sign-out link in Ask AI, and Forget in the
  signature dialog moved there.

## 1.9.0

- **Linux .deb installs now update with the rest of your system.** The package adds Folio's signed apt repository,
  so new versions arrive through your regular software updates (or `sudo apt update && sudo apt upgrade`). Install
  this .deb once to switch over.
- Every release is checked to make sure Windows, macOS, and Linux all get the same version, before and after it's
  published and again every day.
- Release builds are ready to be signed for macOS (Developer ID, notarized, self-updating) and Windows (Azure Trusted
  Signing) as soon as the certificates are added.

## 1.8.2

- **Ask AI conversations stay with each document.** Your questions and answers are saved with the document on this
  computer, alongside its highlights and notes, and are there when you reopen it (even after restarting Folio). The **+**
  button starts a fresh conversation. Password-protected documents are never stored.
- Switching documents with the Ask AI panel open no longer carries the previous conversation over.

## 1.8.1

- A simpler toolbar without duplicate controls: highlighting happens by selecting text (or pressing H), so the separate
  Highlight tool is gone; notes live in the sidebar's **Notes** tab, so the extra notes button is gone; and **Sign**
  has its own icon instead of sharing Draw's pen.

## 1.8.0

- **Folio now runs on macOS and Linux.** Download a universal DMG for Mac (Apple Silicon and Intel), or a `.deb`
  (Ubuntu, Debian) or AppImage for Linux. Macs get native window buttons, ⌘ shortcuts, and "Open With" from Finder;
  Linux gets a desktop entry and PDF file association. AppImages update themselves; Macs show when a new version is out.
- Releases are now built and checked on GitHub Actions for all three platforms, and CI runs an end-to-end smoke test
  on Windows, macOS, and Linux.

## 1.7.0

- **Webpages look like the real site.** Converted pages keep their on-screen design (backgrounds, translucent and
  see-through panels, transparent images, and colors) instead of the site's print styles, at desktop width with no
  margins. Fade-in effects are captured finished, and sticky headers appear once instead of on every page.
- **Click an image** to **View larger** in a full-window viewer (sharp, with actual size and copy) or **Open in
  browser** when it has a web address. Images on converted webpages link to their original address.

## 1.6.0

- **Drop a webpage, get a PDF.** Drop, paste, or enter (Ctrl+Shift+O) a link to any webpage and Folio converts it to a
  PDF you can highlight, take notes on, and ask AI about, with the page's layout, images, and selectable text. PDF
  links still open directly.

## 1.5.1

- The sidebar keeps one width on every tab, so Pages, Outline, and Notes no longer change size when you switch between them.

## 1.5.0

- Selecting text shows a note box right away: type a note and press Enter to highlight with it (or click a color to
  highlight without one).
- Click any highlight to change its color, edit its note, ask AI about it, or **Remove** it in one click (or press Delete).
- Night reading keeps photos, figures, and other images in their true colors, on pages and thumbnails alike.
- A cleaner top bar: Notes, Ask AI, and Search stay visible; Save a copy, Print, Document info, Night reading, Focus
  mode, Dark theme, Keyboard shortcuts, and About Folio moved into the **⋯** menu.

## 1.4.0

- **Highlights and notes are first-class.** Select text and a toolbar pops up: click a color to highlight in one click
  (or press H), or choose Note (N) to highlight and write a note. Highlights, notes, drawings, and text boxes now save
  automatically and come back when you reopen a document.
- New **Notes** tab: every highlight with its note (click one to jump to it), a notes box for the whole document, and
  Copy all as Markdown.
- **Ask AI** about the whole document or a selected passage, with clickable page citations. Connect your ChatGPT plan
  with Sign in with ChatGPT, or use your Claude subscription through Claude Code. No API keys needed.
- Focus mode shows a discreet "Esc to exit focus mode" hint.

## 1.3.2

- Folio now lives in the Forward Future GitHub organization: source at github.com/Forward-Future/folio, downloads and
  updates at github.com/Forward-Future/folio-releases. Installed copies switch over automatically.

## 1.3.1

- Folio is now open source under the MIT License.
- Security hardening: a strict Content Security Policy, main-process calls accepted only from Folio's own page,
  locked-down subframes, Electron fuses (no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, or inspector flags; app code must
  load from an integrity-checked archive), XFA forms disabled, and Electron 45.1.0.
- Link downloads no longer follow redirects from a public site into local-network addresses; the size limit is now 300 MB.
- Password-protected PDFs are no longer kept in Recent. Added **Clear all** to the Recent list.
- New original sample document (replaces a third-party paper).

## 1.3.0

- Drop a PDF link anywhere in Folio, paste one with Ctrl+V outside a text field, or choose **Open from URL**
  (Ctrl+Shift+O). Folio downloads it and opens it automatically. Redirects are followed, the file name comes from the
  server or the final URL, and failed downloads show a clear error while keeping the current document open.
- Night reading remembers its on/off setting across documents and restarts, independently of the interface theme.

## 1.2.0

- Handwritten signatures: capture dark ink on white paper with your camera, or upload a PNG, JPEG, or WebP photo.
  Crop and adjust ink sensitivity to remove the paper background. Processing stays on your device.
- Folio checks each page for PDF signature fields and likely signature lines. Suggestions never sign automatically;
  you review and approve each placement. Signatures are embedded as visual stamp annotations, not cryptographic
  signatures.
- Remembering a signature is optional, and you can forget it at any time.
- **About Folio** has an Automatic updates toggle, saved across restarts. Manual checks remain available when it's off.
- Restart-to-update runs silently, without the Setup wizard.

## 1.1.1

- Faster thumbnails, zooming, reading-progress storage, and search snippets.

## 1.1.0

- Reopens the last document at startup and remembers each document's page, position, zoom, rotation, sidebar, and
  two-page mode.
- Find shows matching-page snippets and match counts.
- **About Folio** shows the version, edition, installation folder, and update status.
- Restores the window's size, position, and maximized state.

## 1.0.2

- Update status and a **Check for updates** button on the home screen.

## 1.0.1

- The toolbar's bottom border stays visible under the window controls.

## 1.0.0

- First release.
