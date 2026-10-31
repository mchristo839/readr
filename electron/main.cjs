// Readr desktop shell: one window, PDFs (and Word documents, converted) opened from Explorer / "Open with",
// files served over app://.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, screen, session } = require("electron");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { autoUpdater } = require("electron-updater");
const ai = require("./ai.cjs");
const { captureWebpage } = require("./webpage.cjs");
const { guardSession, isLocalHost } = require("./network.cjs");
const { safePdfName } = require("./filenames.cjs");
const { csp } = require("./csp.cjs");
const { WORD_FILE, convertToPdf, pdfPathFor } = require("./convert.cjs");

if (!app.isPackaged && process.env.FOLIO_TEST_USER_DATA) app.setPath("userData", process.env.FOLIO_TEST_USER_DATA);
// Automated tests drive a window that never appears, so a local run doesn't take over the screen or focus.
const TEST_HIDDEN = !app.isPackaged && process.env.FOLIO_TEST_HIDDEN === "1";

const DIST = path.join(__dirname, "..", "dist");
// Development only (e.g. http://localhost:5173); ignored by installed builds.
const DEV_URL = !app.isPackaged && process.env.FOLIO_DEV_URL ? new URL(process.env.FOLIO_DEV_URL).origin : null;
const isAppUrl = (url) => {
  try { return url.startsWith("app://folio/") || (!!DEV_URL && new URL(url).origin === DEV_URL); } catch { return false; }
};

// Sent as a response header on app:// (see csp.cjs). The page never needs the network here: PDFs are
// read from disk, and "Open a link" downloads happen in this process.
const CSP = csp({ connect: "'self' data: blob:" });

function isTrustedSender(event) {
  if (!win || event.sender !== win.webContents) return false;
  const url = event.senderFrame?.url ?? "";
  return isAppUrl(url);
}

// Title bar colours follow the app theme (see src/styles.css --bg). Height is one pixel short of
// --topbar-h so the toolbar's bottom border runs underneath the window controls.
const TITLEBAR = {
  dark: { color: "#171717", symbolColor: "#edece9", height: 51 },
  light: { color: "#f5f4f1", symbolColor: "#1c1b19", height: 51 },
};

const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";
const RELEASES_PAGE = "https://github.com/mchristo839/readr/releases/latest";

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
const OPENABLE = /\.(pdf|docx?)$/i;
let pendingFile = fileFromArgs(process.argv);
let rendererReady = false;

// macOS hands files to the app through "open-file" (Finder, the Dock, "Open With") rather than argv.
// It can fire before the app is ready, so register it right away.
app.on("open-file", (event, file) => {
  event.preventDefault();
  if (!OPENABLE.test(file)) return;
  if (win && rendererReady) {
    if (win.isMinimized()) win.restore();
    win.focus();
    void sendFile(file);
  } else {
    pendingFile = file;
    if (app.isReady() && !win) createWindow();
  }
});

function fileFromArgs(argv) {
  const file = argv.slice(1).find((a) => !a.startsWith("-") && OPENABLE.test(a) && fs.existsSync(a));
  return file ? path.resolve(file) : null;
}

// The read is async and size-capped like URL downloads: a huge file or a slow network
// share shouldn't freeze the main process or balloon memory in two processes.
async function sendFile(file) {
  const target = win;
  if (!file || !target) return;
  if (WORD_FILE.test(file)) return sendWordFile(file, target);
  try {
    if ((await fs.promises.stat(file)).size > MAX_URL_PDF_BYTES) {
      dialog.showErrorBox("Couldn't open file", `${file}\n\nThat PDF is larger than 300 MB.`);
      return;
    }
    const data = await fs.promises.readFile(file);
    if (!target.isDestroyed()) target.webContents.send("folio:open-file", { name: path.basename(file), data });
  } catch (err) {
    dialog.showErrorBox("Couldn't open file", `${file}\n\n${err.message}`);
  }
}

// A Word document opens as a PDF, saved next to it ("Report.docx" gets "Report.pdf") so it's there to share
// afterwards. A folder Readr can't write to (a read-only share) just means the PDF isn't kept.
async function sendWordFile(file, target) {
  const send = (channel, payload) => { if (!target.isDestroyed()) target.webContents.send(channel, payload); };
  const original = path.basename(file);
  send("folio:converting", { name: original });
  try {
    if ((await fs.promises.stat(file)).size > MAX_URL_PDF_BYTES) throw Object.assign(new Error("too large"), { userMessage: "It's larger than 300 MB." });
    const output = pdfPathFor(file);
    if (output?.existing) {
      const data = await fs.promises.readFile(output.file);
      return send("folio:open-file", { name: path.basename(output.file), data });
    }
    const data = await convertToPdf(file, (msg) => logConvert(`${file}: ${msg}`));
    let name = original.replace(/\.[^.]+$/, ".pdf");
    let note = null;
    if (output) {
      try {
        await fs.promises.writeFile(output.file, data, { flag: "wx" });
        name = path.basename(output.file);
        note = `Saved ${name} next to ${original}.`;
      } catch {}
    }
    send("folio:open-file", { name, data, note });
  } catch (error) {
    logConvert(`${file}: ${error?.stack || error}`);
    send("folio:open-failed", { message: `Couldn't convert “${original}” to PDF. ${error?.userMessage ?? ""}`.trim() });
  }
}

function logConvert(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "convert.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

// ── Auto-update ──────────────────────────────────────────────────────
// Installed copies check GitHub Releases (mchristo839/readr, see "publish" in package.json)
// on launch and every few hours, download new versions in the background, and install them on quit
// or when the user clicks "Restart" in the update banner. Progress is shown on the home screen and
// logged to update.log in the app's user-data folder.
let updateReady = null;
let updateStatus = { state: "idle" };
let updatesEnabled = false;
let automaticUpdates = true;
let activeUpdate = null;
let autoInstallOnQuit = true;
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;

function loadUpdatePreference() {
  try {
    automaticUpdates = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "update-settings.json"), "utf8")).enabled !== false;
  } catch { automaticUpdates = true; }
}

function saveUpdatePreference(enabled) {
  if (typeof enabled !== "boolean") throw new Error("Invalid auto-update preference");
  const filename = path.join(app.getPath("userData"), "update-settings.json");
  fs.writeFileSync(filename + ".tmp", JSON.stringify({ enabled }));
  fs.renameSync(filename + ".tmp", filename);
  automaticUpdates = enabled;
  autoUpdater.autoInstallOnAppQuit = enabled && autoInstallOnQuit;
  if (!enabled && activeUpdate && !activeUpdate.manual) activeUpdate.token?.cancel();
  if (enabled) void checkForUpdates();
  return enabled;
}

function logUpdate(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "update.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

function setUpdateStatus(status) {
  updateStatus = status;
  win?.webContents.send("folio:update-status-changed", status);
}

async function checkForUpdates(manual = false) {
  // Keep the reason (e.g. "system" for apt-managed copies) when a manual check finds updates unsupported.
  if (!updatesEnabled) return setUpdateStatus(updateStatus.state === "unsupported" ? updateStatus : { state: "unsupported" });
  if ((!manual && !automaticUpdates) || updateReady || activeUpdate) return;
  const operation = { manual, token: null };
  activeUpdate = operation;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.isUpdateAvailable && NOTIFY_ONLY) {
      setUpdateStatus({ state: "available", version: result.updateInfo.version });
    } else if (result?.isUpdateAvailable && (manual || automaticUpdates)) {
      operation.token = result.cancellationToken;
      setUpdateStatus({ state: "downloading", version: result.updateInfo.version, percent: 0 });
      await autoUpdater.downloadUpdate(result.cancellationToken);
      if (operation.token?.cancelled && !updateReady) setUpdateStatus({ state: "idle" });
    } else if (result?.isUpdateAvailable) setUpdateStatus({ state: "idle" });
  } catch (error) {
    if (operation.token?.cancelled) setUpdateStatus({ state: "idle" });
    else setUpdateStatus({ state: "error", message: String(error?.message || error).split("\n")[0] });
  } finally { activeUpdate = null; }
}

/** How this copy was installed, which decides how it can be updated. */
function installKind() {
  if (!app.isPackaged) return "development";
  if (process.env.PORTABLE_EXECUTABLE_FILE) return "portable";
  if (IS_LINUX) return process.env.APPIMAGE ? "appimage" : "package";
  return "installed";
}

function installLocation() {
  if (process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE) {
    return path.dirname(process.env.PORTABLE_EXECUTABLE_FILE || process.env.APPIMAGE);
  }
  const exeDir = path.dirname(app.getPath("exe"));
  // Inside a packaged .app the exe lives in Contents/MacOS; the install folder is where the .app sits.
  return IS_MAC && /\.app[\/\\]Contents[\/\\]MacOS$/.test(exeDir) ? path.resolve(exeDir, "..", "..", "..") : exeDir;
}

// macOS only installs updates signed with an Apple Developer ID. Release builds made with the Developer ID
// certificate set folioMacSigned (see .github/workflows/release-build.yml); other Mac builds are told about
// new versions and download them from the releases page.
const MAC_SIGNED = !!require("../package.json").folioMacSigned;
const NOTIFY_ONLY = IS_MAC && !MAC_SIGNED;

/** "deb" when this copy was installed from Readr's .deb (electron-builder writes resources/package-type). */
function packageType() {
  try { return fs.readFileSync(path.join(process.resourcesPath, "package-type"), "utf8").trim(); } catch { return ""; }
}

function setupAutoUpdate() {
  loadUpdatePreference();
  // Installed Windows builds, Linux AppImages and .debs, and Macs check for updates. Dev runs and the portable
  // Windows exe don't. Readr has no apt repository, so a .deb downloads its update from GitHub Releases (checked
  // against the SHA-512 in latest-linux.yml) and installs it with dpkg through a password prompt.
  // FOLIO_UPDATE_TEST lets the unpacked build be tested.
  const kind = installKind();
  const deb = kind === "package" ? packageType() === "deb" : process.env.FOLIO_UPDATE_TEST === "deb";
  if (kind === "package" && !deb) {
    updateStatus = { state: "unsupported" };
    return;
  }
  if ((kind === "development" && !process.env.FOLIO_UPDATE_TEST) || kind === "portable") {
    updateStatus = { state: "unsupported" };
    return;
  }
  updatesEnabled = true;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true; // reads dev-app-update.yml
  autoUpdater.autoDownload = false;
  // Installing a .deb asks for a password, so it only happens when the user clicks Restart, never on quit.
  autoInstallOnQuit = !deb;
  autoUpdater.autoInstallOnAppQuit = automaticUpdates && autoInstallOnQuit;
  autoUpdater.logger = { info: logUpdate, warn: logUpdate, error: logUpdate, debug() {} };
  autoUpdater.on("checking-for-update", () => setUpdateStatus({ state: "checking" }));
  autoUpdater.on("update-not-available", () => setUpdateStatus({ state: "latest", checkedAt: Date.now() }));
  autoUpdater.on("download-progress", (p) =>
    setUpdateStatus({ state: "downloading", version: updateStatus.version, percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    updateReady = info.version;
    setUpdateStatus({ state: "ready", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    logUpdate(`error: ${err?.stack || err}`);
    setUpdateStatus({ state: "error", message: String(err?.message || err).split("\n")[0] });
  });
  logUpdate(`Readr ${app.getVersion()} (${process.arch}) starting update checks`);
  checkForUpdates();
  setInterval(() => void checkForUpdates(), UPDATE_INTERVAL_MS);
}

function createWindow() {
  let savedWindow = null;
  const windowStatePath = path.join(app.getPath("userData"), "window-state.json");
  try {
    const saved = JSON.parse(fs.readFileSync(windowStatePath, "utf8"));
    const bounds = saved.bounds;
    if (bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width >= 600 && bounds.height >= 400) {
      const area = screen.getDisplayMatching(bounds).workArea;
      savedWindow = { bounds: { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height),
        x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - Math.min(bounds.width, area.width))),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - Math.min(bounds.height, area.height))) }, maximized: saved.maximized === true };
    }
  } catch {}
  const theme = "dark"; // the page reports its real theme on load via folio:theme
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    ...(savedWindow?.bounds ?? {}),
    minWidth: 420,
    minHeight: 480,
    show: false,
    backgroundColor: TITLEBAR[theme].color,
    title: "Readr",
    icon: path.join(__dirname, "icon.png"),
    titleBarStyle: "hidden",
    // macOS keeps its traffic lights (inset into the top bar); Windows and Linux draw their window
    // buttons as an overlay on the right.
    ...(IS_MAC ? { trafficLightPosition: { x: 18, y: 18 } } : { titleBarOverlay: TITLEBAR[theme] }),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      plugins: true, // Chromium's PDF viewer, used for printing
      // A hidden window is throttled like a background tab; tests need it to render at full speed.
      ...(TEST_HIDDEN ? { backgroundThrottling: false } : {}),
    },
  });

  const cameraOwner = win.webContents;
  const trustedCameraOrigin = isAppUrl;
  // Readr's own page may write (never read) the clipboard, for its Copy buttons.
  const clipboardWrite = (contents, permission, url) =>
    contents === cameraOwner && permission === "clipboard-sanitized-write" && isAppUrl(url ?? "");
  cameraOwner.session.setPermissionCheckHandler((contents, permission, origin, details) =>
    contents === cameraOwner && permission === "media" && trustedCameraOrigin(details.requestingUrl || origin) && details.mediaType === "video");
  cameraOwner.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (clipboardWrite(contents, permission, details.requestingUrl)) return callback(true);
    if (contents !== cameraOwner || permission !== "media" || !details.isMainFrame
      || !trustedCameraOrigin(details.requestingUrl) || !details.mediaTypes?.length
      || details.mediaTypes.some(type => type !== "video")) return callback(false);
    dialog.showMessageBox(win, { type: "question", title: "Use camera for signature?", message: "Allow Readr to use your camera to capture a signature?",
      detail: "Camera images are processed on this device. No microphone is requested.", buttons: ["Allow camera", "Cancel"], defaultId: 1, cancelId: 1 })
      .then(result => callback(result.response === 0)).catch(() => callback(false));
  });

  win.once("ready-to-show", () => {
    // A never-shown window doesn't paint, so tests couldn't screenshot it. Show it off-screen instead,
    // without taking focus or adding a taskbar button.
    if (TEST_HIDDEN) {
      win.setSkipTaskbar(true);
      win.setPosition(-32000, -32000);
      win.showInactive();
      return;
    }
    if (savedWindow?.maximized) win.maximize();
    win.show();
  });
  const saveWindow = () => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    try {
      fs.writeFileSync(windowStatePath, JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {}
  };
  let windowTimer;
  const scheduleWindowSave = () => { clearTimeout(windowTimer); windowTimer = setTimeout(saveWindow, 300); };
  win.on("resize", scheduleWindowSave);
  win.on("move", scheduleWindowSave);
  win.on("close", saveWindow);
  win.loadURL(DEV_URL ? DEV_URL + "/" : "app://folio/index.html");

  // Links inside PDFs open in the default browser, never in-app (see openLink).
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openLink(url);
    return { action: "deny" };
  });
  // Subframes (the print frame) may only show Readr pages, local blob: PDFs, and Chromium's built-in PDF viewer.
  const PDF_VIEWER = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
  win.webContents.on("will-frame-navigate", (e) => {
    const allowed = isAppUrl(e.url) || e.url.startsWith("blob:app://folio/") || e.url.startsWith(PDF_VIEWER) || e.url === "about:blank";
    if (!e.isMainFrame && !allowed) e.preventDefault();
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) void openLink(url);
    }
  });

  // The page blocks unload while annotations are unsaved; ask instead of silently refusing to close.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Close without saving", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved annotations",
      message: "You have highlights or notes that haven't been saved.",
      detail: "Press Ctrl+S in Readr to save a copy with your annotations.",
    });
    if (choice === 0) e.preventDefault();
  });

  win.on("closed", () => { clearTimeout(windowTimer); win = null; rendererReady = false; });
}

const MAX_URL_PDF_BYTES = 300 * 1024 * 1024;

// Shown in dialogs: long enough to see where a link goes, short enough that the dialog stays readable.
const shortUrl = (url) => (url.href.length > 300 ? url.href.slice(0, 300) + "…" : url.href);

// Readr's own links (src/ai.ts) open without asking.
const FOLIO_LINKS = new Set(["https://chatgpt.com/settings/usage", "https://claude.com/claude-code",
  "https://openrouter.ai/settings/keys", "https://openrouter.ai/activity",
  "https://platform.claude.com/settings/keys", "https://platform.claude.com/settings/workspaces", "https://platform.claude.com/usage"]);
let askingAboutLink = false;

// Links open in the browser (mailto: in the mail app), never in Readr, and only once the user has seen where they go:
// a PDF decides both a link's address and its clickable area, which can be invisible and cover the whole page.
async function openLink(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return; }
  if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "mailto:") return;
  if (!FOLIO_LINKS.has(url.href)) {
    if (askingAboutLink || !win) return; // one question at a time
    askingAboutLink = true;
    const mail = url.protocol === "mailto:";
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "Open link?",
      message: mail ? "Open this email link in your mail app?" : `Open ${url.host} in your browser?`,
      detail: shortUrl(url),
      buttons: [mail ? "Open mail app" : "Open link", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    }).finally(() => { askingAboutLink = false; });
    if (response !== 0) return;
  }
  await shell.openExternal(url.href);
}

// Asked before Readr opens an address on this computer or the local network, here rather than in the page: a document
// that managed to run code in the page could otherwise use Readr to reach them.
async function confirmLocalAddress(url) {
  const { response } = await dialog.showMessageBox(win, {
    type: "warning",
    title: "Open a local address?",
    message: `Open ${url.host}?`,
    detail: `This address is on your computer or local network.\n\n${shortUrl(url)}`,
    buttons: ["Open", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

// The name a download gets: from Content-Disposition when the server sends one, else the URL's last segment.
function pdfNameFromResponse(url, disposition) {
  const match = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(disposition || "");
  let name = (match?.[1] || match?.[2] || "").trim();
  try { name = decodeURIComponent(name || url.pathname.split("/").filter(Boolean).pop() || ""); } catch {}
  return safePdfName(name, url.hostname);
}

// Downloads a PDF link in the main process, so cross-origin URLs work without CORS. Unless `allowLocal`, neither the
// link nor a redirect may lead into this computer or the local network.
// Resolves to { name, data } or { error } (error text is shown to the user as-is).
function downloadPdf(url, allowLocal) {
  const ses = session.fromPartition(`folio-download-${crypto.randomUUID()}`); // in-memory only
  const refusedLocal = guardSession(ses, allowLocal);
  return new Promise((resolve) => {
    let done = false;
    const request = net.request({ url: url.toString(), redirect: "manual", session: ses, cache: "no-store" });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (result.error) request.abort();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "The download timed out." }), 60_000);
    let hops = 0;
    request.setHeader("Accept", "application/pdf,*/*;q=0.8");
    // Track redirects ourselves: the final address usually carries the real file name.
    request.on("redirect", (_status, _method, redirectUrl) => {
      const next = new URL(redirectUrl, url);
      if (++hops > 10) return finish({ error: "That link redirects too many times." });
      if (next.protocol !== "http:" && next.protocol !== "https:") return finish({ error: "That link redirects somewhere Readr can't open." });
      url = next;
      request.followRedirect();
    });
    request.on("error", () => finish({ error: refusedLocal()
      ? "That link leads to a local network address, so Readr didn't follow it." : `Couldn't reach ${url.hostname}.` }));
    request.on("response", (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        return finish({ error: `The server responded with ${response.statusCode}${response.statusMessage ? " " + response.statusMessage : ""}.` });
      }
      const header = (key) => [].concat(response.headers[key] ?? [])[0];
      // A webpage: stop downloading and let the caller render it to PDF instead.
      if (/\b(text\/html|application\/xhtml\+xml)\b/i.test(header("content-type") ?? "")) {
        request.abort();
        return finish({ webpage: url.toString() });
      }
      const tooBig = { error: "That PDF is larger than 300 MB." };
      if (Number(header("content-length")) > MAX_URL_PDF_BYTES) return finish(tooBig);
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.byteLength;
        if (size > MAX_URL_PDF_BYTES) finish(tooBig);
        else chunks.push(chunk);
      });
      response.on("error", () => finish({ error: "The download was interrupted." }));
      response.on("end", () => {
        const data = Buffer.concat(chunks);
        if (data.subarray(0, 1024).indexOf("%PDF-") < 0) {
          // Some servers don't label HTML; recognize it by its start.
          if (/^\s*(<!doctype html|<html|<head|<body)/i.test(data.subarray(0, 512).toString("latin1"))) return finish({ webpage: url.toString() });
          return finish({ error: "That link isn't a PDF or a webpage." });
        }
        finish({ name: pdfNameFromResponse(url, header("content-disposition")), data });
      });
    });
    request.end();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch (e.g. double-clicking another PDF) hands its file to the running window.
  app.on("second-instance", (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    void sendFile(fileFromArgs(argv));
  });

  app.whenReady().then(() => {
    protocol.handle("app", async (req) => {
      const { pathname } = new URL(req.url);
      let file;
      try { file = path.normalize(path.join(DIST, decodeURIComponent(pathname))); } catch { return new Response("Bad request", { status: 400 }); }
      if (!file.startsWith(DIST + path.sep)) return new Response("Forbidden", { status: 403 });
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", CSP);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    });

    // Only Readr's own page may call into the main process.
    const handle = (channel, listener) => ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted sender");
      return listener(event, ...args);
    });
    const on = (channel, listener) => ipcMain.on(channel, (event, ...args) => {
      if (isTrustedSender(event)) listener(event, ...args);
    });

    ai.register(handle, (channel, payload) => win?.webContents.send(channel, payload));

    handle("folio:ready", () => {
      rendererReady = true;
      const file = pendingFile;
      pendingFile = null;
      if (file) setTimeout(() => void sendFile(file), 0);
      return !!file;
    });
    // Word documents picked or dropped in Readr (PDFs are read by the page itself).
    handle("folio:open-document", (_event, file) => {
      if (typeof file !== "string" || !WORD_FILE.test(file) || !path.isAbsolute(file)) throw new Error("Not a Word document");
      void sendFile(file);
    });
    // PDF links open directly; webpages are converted to a PDF first. An address on this computer or the local
    // network opens only once the user agrees (cancelling resolves to { cancelled: true }).
    handle("folio:fetch-pdf", async (_event, rawUrl) => {
      let url;
      try { url = new URL(typeof rawUrl === "string" && rawUrl.length <= 8192 ? rawUrl.trim() : ""); }
      catch { return { error: "That isn't a valid web address." }; }
      if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "Only http:// and https:// links can be opened." };
      const local = await isLocalHost(url.hostname, session.defaultSession);
      if (local && !(await confirmLocalAddress(url))) return { cancelled: true };
      const result = await downloadPdf(url, local);
      if (!result.webpage) return result;
      // A local page that redirected to the web is held to the same rules as any other webpage.
      return captureWebpage(result.webpage, local && await isLocalHost(new URL(result.webpage).hostname, session.defaultSession));
    });
    handle("folio:app-info", () => ({ version: app.getVersion(), mode: installKind(), location: installLocation(), platform: process.platform,
      notifyOnly: NOTIFY_ONLY }));
    handle("folio:open-installation", () => shell.openPath(installLocation()));
    handle("folio:open-download", () => shell.openExternal(RELEASES_PAGE));
    handle("folio:update-state", () => updateStatus);
    handle("folio:auto-update-setting", () => automaticUpdates);
    handle("folio:set-auto-update-setting", (_event, enabled) => saveUpdatePreference(enabled));
    on("folio:check-update", () => void checkForUpdates(true));
    on("folio:install-update", () => {
      if (updateReady) autoUpdater.quitAndInstall(true, true);
    });
    on("folio:theme", (_e, theme) => {
      if (win && Object.hasOwn(TITLEBAR, theme)) {
        if (!IS_MAC) win.setTitleBarOverlay(TITLEBAR[theme]);
        win.setBackgroundColor(TITLEBAR[theme].color);
      }
    });

    createWindow();
    setupAutoUpdate();
  });

  // macOS apps stay running with no windows; clicking the Dock icon opens a new one.
  app.on("window-all-closed", () => { if (!IS_MAC) app.quit(); });
  app.on("activate", () => { if (app.isReady() && !win) createWindow(); });
}
