// Word documents (.doc, .docx) are converted to PDF before Marginalia opens them. The best converter on the computer
// wins: Microsoft Word (Windows), then LibreOffice (any platform), then Marginalia's own, which lays the text, tables,
// and images out in a hidden window and prints them (.docx everywhere; .doc on macOS, through textutil).
const { app, BrowserWindow, session } = require("electron");
const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");

const WORD_FILE = /\.docx?$/i;
const CONVERT_TIMEOUT_MS = 120_000;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...options },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout))));
  });
}

// Word is driven through COM. Macros are switched off, a password-protected file fails instead of asking for its
// password in a window nobody can see, and a Word the user already has open is left open, settings and all.
// (Quit takes no arguments here: Windows PowerShell can't pass its by-reference ones, and nothing is unsaved.)
const WORD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$own = -not $word.Visible
$security = $word.AutomationSecurity
$alerts = $word.DisplayAlerts
try {
  $word.AutomationSecurity = 3
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($env:FOLIO_SOURCE, $false, $true, $false, 'folio-no-password', 'folio-no-password')
  try { $doc.ExportAsFixedFormat($env:FOLIO_TARGET, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false) }
  finally { $doc.Close(0) }
} finally {
  try {
    $word.AutomationSecurity = $security
    $word.DisplayAlerts = $alerts
    if ($own -and $word.Documents.Count -eq 0) { $word.Quit() }
  } catch {}
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}`;

async function withWord(source, target) {
  // The paths travel in the environment, so no file name can break out of the script.
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WORD_SCRIPT],
    { env: { ...process.env, FOLIO_SOURCE: source, FOLIO_TARGET: target } });
}

function libreOffice() {
  const candidates = process.platform === "win32"
    ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map((dir) => path.join(dir, "LibreOffice", "program", "soffice.exe"))
    : process.platform === "darwin"
      ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice", path.join(os.homedir(), "Applications/LibreOffice.app/Contents/MacOS/soffice")]
      : ["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice", "/usr/lib/libreoffice/program/soffice", "/opt/libreoffice/program/soffice", "/snap/bin/libreoffice"];
  return candidates.find((file) => fs.existsSync(file));
}

async function withLibreOffice(soffice, source, dir) {
  // A profile of its own lets the conversion run while LibreOffice is open (which would otherwise take the job and
  // return straight away) and keeps the user's settings out of it.
  const profile = pathToFileURL(path.join(dir, "libreoffice-profile")).href;
  await run(soffice, ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${profile}`, "--convert-to", "pdf", "--outdir", dir, source]);
  return path.join(dir, path.basename(source).replace(/\.[^.]+$/, ".pdf"));
}

// Marginalia's own layout for the built-in converter: a printed page with Word's usual defaults.
const DOCUMENT_CSS = `
@page { margin: 1in; }
body { font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.4; color: #000; margin: 0; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.2; margin: 1.2em 0 0.4em; break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11pt; }
p { margin: 0 0 0.6em; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 0 0 0.8em; max-width: 100%; }
td, th { border: 1px solid #999; padding: 3pt 6pt; vertical-align: top; }
td > p:last-child, th > p:last-child { margin-bottom: 0; }
tr { break-inside: avoid; }
`;

// Most of the Americas print on Letter paper; everyone else on A4.
const LETTER_COUNTRIES = new Set(["US", "CA", "MX", "CL", "CO", "VE", "PH", "GT", "PR", "CR", "PA", "DO", "SV", "NI", "HN"]);

/** Prints the HTML file `htmlFile` (and only files from its folder: textutil's images) to a PDF. */
async function printHtml(htmlFile) {
  // Compared as real paths: the URL Chromium asks for can spell the folder differently (a short name like
  // C:\Users\RUNNER~1 written out in full, other letter case, percent-encoding).
  const folder = fs.realpathSync.native(path.dirname(htmlFile));
  const inFolder = (url) => {
    try {
      const relative = path.relative(folder, fs.realpathSync.native(fileURLToPath(url)));
      return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
    } catch { return false; }
  };
  const ses = session.fromPartition(`folio-convert-${crypto.randomUUID()}`); // in-memory only
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on("will-download", (event) => event.preventDefault());
  // A document can point at web images or other files on disk; nothing outside its own folder is loaded.
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith("data:") || (details.url.startsWith("file:") && inFolder(details.url))) }));
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  try {
    await win.loadFile(htmlFile);
    return await win.webContents.printToPDF({
      pageSize: LETTER_COUNTRIES.has(app.getLocaleCountryCode()) ? "Letter" : "A4",
      preferCSSPageSize: true,
      printBackground: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
  } finally {
    win.destroy();
    void ses.clearStorageData().catch(() => {});
  }
}

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function builtIn(source, dir, title) {
  const htmlFile = path.join(dir, "document.html");
  let body;
  if (/\.docx$/i.test(source)) {
    // Images come out as data: URLs, so the page needs nothing else.
    body = (await require("mammoth").convertToHtml({ path: source })).value;
  } else if (process.platform === "darwin") {
    await run("/usr/bin/textutil", ["-convert", "html", "-output", htmlFile, source]);
    body = fs.readFileSync(htmlFile, "utf8");
  } else {
    throw Object.assign(new Error("no converter"), { userMessage: "Converting .doc files needs Microsoft Word or LibreOffice. Install either one, or save the document as .docx." });
  }
  const page = /<html[\s>]/i.test(body) ? body.replace(/<head[^>]*>/i, (head) => `${head}<style>@page { margin: 1in; }</style>`)
    : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOCUMENT_CSS}</style></head><body>${body}</body></html>`;
  fs.writeFileSync(htmlFile, page);
  return printHtml(htmlFile);
}

/**
 * Converts the Word document `file` to PDF and resolves to its bytes. Rejects with an error whose `userMessage`
 * (when present) says what the user can do about it. `log` hears about each converter that didn't work.
 */
async function convertToPdf(file, log = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-convert-"));
  try {
    // Converters work on a copy: Word may have the original open, and odd file names can't confuse them.
    const source = path.join(dir, "source" + path.extname(file).toLowerCase());
    fs.copyFileSync(file, source);
    const title = path.basename(file).replace(/\.[^.]+$/, "");
    const only = !app.isPackaged ? process.env.FOLIO_TEST_CONVERTER : undefined; // tests pick one: word, libreoffice, builtin
    const failures = [];
    const started = Date.now();
    const fail = (converter, error) => {
      failures.push(`${converter}: ${error.stderr || error.message}`);
      log(`${converter} failed after ${Date.now() - started} ms: ${error.stderr || error.message}`);
    };
    if (process.platform === "win32" && (!only || only === "word")) {
      const target = path.join(dir, "word.pdf");
      try {
        await withWord(source, target);
        return fs.readFileSync(target);
      } catch (error) { fail("Word", error); }
    }
    const soffice = (!only || only === "libreoffice") && libreOffice();
    if (soffice) {
      try { return fs.readFileSync(await withLibreOffice(soffice, source, dir)); }
      catch (error) { fail("LibreOffice", error); }
    }
    if (!only || only === "builtin") {
      try { return await builtIn(source, dir, title); }
      catch (error) {
        if (error.userMessage) throw error;
        fail("Marginalia", error);
      }
    }
    throw Object.assign(new Error(failures.join("\n")), { userMessage: "The document may be damaged or protected with a password." });
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

/**
 * Where the PDF for `file` goes: "Report.pdf" next to "Report.docx". An existing PDF is never replaced. When one
 * is at least as new as the document, it's the document already converted, so `existing` is set and it opens as is.
 */
function pdfPathFor(file) {
  const stem = file.replace(/\.[^.\\/]+$/, "");
  const modified = fs.statSync(file).mtimeMs;
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? `${stem}.pdf` : `${stem} (${n}).pdf`;
    let stat;
    try { stat = fs.statSync(candidate); } catch { return { file: candidate, existing: false }; }
    if (stat.isFile() && stat.mtimeMs >= modified) return { file: candidate, existing: true };
  }
  return null;
}

module.exports = { WORD_FILE, convertToPdf, pdfPathFor };
