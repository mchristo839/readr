// Turns a webpage into a PDF: load it in a hidden, locked-down window, then print it with Chromium.
// The page runs in its own throwaway session (no cookies or storage shared with Readr or other
// captures), sandboxed, with no Node.js, no permissions, no pop-ups, and no downloads.
const { BrowserWindow, session } = require("electron");
const crypto = require("node:crypto");
const { safePdfName } = require("./filenames.cjs");

const TOTAL_TIMEOUT_MS = 60_000;
// Pages are laid out like a desktop browser window: 1280 CSS px wide, no margins.
const PAGE_WIDTH_PX = 1280;
const PAGE_HEIGHT_PX = 1664;
const CSS_PX_PER_INCH = 96;

// Print exactly what the screen shows: every background, color, and translucent layer.
// (User-origin !important rules beat the site's own, including print-only overrides.)
const FIDELITY_CSS = `
*, *::before, *::after { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
@page { margin: 0 !important; }
`;
const SCROLL_TIMEOUT_MS = 15_000;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(timer));
}

// Scrolls through the page so lazy-loaded images load, then back to the top.
const PREPARE_PAGE = `(async () => {
  const pause = () => new Promise((r) => setTimeout(r, 120));
  document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = "eager"; });
  for (let y = 0; y < document.documentElement.scrollHeight && y < 60000; y += Math.max(400, innerHeight * 0.8)) {
    scrollTo(0, y);
    await pause();
  }
  scrollTo(0, 0);
  await pause();
  // Fade-ins and reveal effects end in their final state (as a reader would see them), not mid-way.
  for (const animation of document.getAnimations()) {
    try {
      const timing = animation.effect?.getComputedTiming?.();
      if (timing && Number.isFinite(timing.endTime)) animation.finish();
      else animation.pause();
    } catch {}
  }
  // Blend modes (grain and glow overlays) don't survive printing: they flatten into a grey wash.
  // Purely decorative blended layers (no text or media inside) are left out instead.
  for (const el of document.querySelectorAll("body *")) {
    if (getComputedStyle(el).mixBlendMode === "normal") continue;
    if (el.textContent.trim() || el.querySelector("img, svg, video, canvas, picture") || /^(IMG|SVG|VIDEO|CANVAS|PICTURE)$/i.test(el.tagName)) continue;
    el.style.setProperty("visibility", "hidden", "important");
  }
  // Fixed and sticky bars would repeat on every printed page; place them once, where they appear on screen.
  for (const el of document.querySelectorAll("body *")) {
    const position = getComputedStyle(el).position;
    if (position === "fixed") el.style.setProperty("position", "absolute", "important");
    else if (position === "sticky") el.style.setProperty("position", "relative", "important");
  }
  // Images that aren't already links link to their own web address, so Readr can offer "Open in browser".
  for (const img of document.querySelectorAll("img")) {
    const src = img.currentSrc || img.src;
    if (!/^https?:/i.test(src) || img.closest("a[href]")) continue;
    const target = img.parentElement?.tagName === "PICTURE" ? img.parentElement : img;
    const link = document.createElement("a");
    link.href = src;
    target.replaceWith(link);
    link.append(target);
  }
  return true;
})()`;

/**
 * Loads `rawUrl` and prints it to PDF. `isLocalHost(hostname)` identifies loopback/private hosts:
 * a public page may not make requests into the local network.
 * Resolves to { name, data } or { error }.
 */
async function captureWebpage(rawUrl, isLocalHost) {
  const url = new URL(rawUrl);
  const ses = session.fromPartition(`folio-webpage-${crypto.randomUUID()}`); // in-memory only
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  const publicPage = !isLocalHost(url.hostname);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let target;
    try { target = new URL(details.url); } catch { return callback({ cancel: true }); }
    const web = target.protocol === "http:" || target.protocol === "https:";
    if (!web && target.protocol !== "data:" && target.protocol !== "blob:") return callback({ cancel: true });
    if (web && publicPage && isLocalHost(target.hostname)) return callback({ cancel: true });
    callback({});
  });

  const win = new BrowserWindow({
    show: false,
    width: PAGE_WIDTH_PX,
    height: PAGE_HEIGHT_PX,
    useContentSize: true,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const contents = win.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, next) => { if (!/^https?:/i.test(next)) event.preventDefault(); });

  try {
    // Lay the page out with its screen styles, not its print stylesheet. (Emulation needs a loaded
    // document first: setting it on a fresh window crashes Electron 45.)
    try {
      await contents.loadURL("about:blank");
      contents.debugger.attach("1.3");
      await contents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "screen" });
    } catch {
      /* falls back to print styles */
    }
    return await withTimeout((async () => {
      try {
        await contents.loadURL(url.toString());
      } catch (error) {
        // Pages that keep redirecting or abort a subresource can reject even though they loaded.
        if (!contents.getURL() || contents.getURL() === "about:blank") throw error;
      }
      await contents.insertCSS(FIDELITY_CSS, { cssOrigin: "user" }).catch(() => {});
      await delay(800);
      await withTimeout(contents.executeJavaScript(PREPARE_PAGE, true), SCROLL_TIMEOUT_MS, "scroll").catch(() => {});
      await delay(600);
      const data = await contents.printToPDF({
        printBackground: true,
        pageSize: { width: PAGE_WIDTH_PX / CSS_PX_PER_INCH, height: PAGE_HEIGHT_PX / CSS_PX_PER_INCH },
        margins: { marginType: "none" },
        preferCSSPageSize: false,
        generateDocumentOutline: true,
        generateTaggedPDF: true,
      });
      return { name: safePdfName(contents.getTitle(), new URL(contents.getURL() || url.toString()).hostname), data };
    })(), TOTAL_TIMEOUT_MS, "timeout");
  } catch (error) {
    if (error?.message === "timeout") return { error: "The webpage took too long to load." };
    return { error: `Couldn't load that webpage${error?.code ? ` (${error.code})` : ""}.` };
  } finally {
    win.destroy();
    void ses.clearStorageData().catch(() => {});
  }
}

module.exports = { captureWebpage };
