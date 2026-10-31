// Word documents (.doc, .docx) are converted to PDF before Readr opens them. The best converter on the computer
// wins: Microsoft Word (Windows), then LibreOffice (any platform), then Readr's own, which lays the text, tables,
// and images out in a hidden window and prints them (.docx everywhere; .doc on macOS, through textutil).
const { app, BrowserWindow, session, utilityProcess } = require("electron");
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

// Settings for that profile: no macros, and no linked content fetched while converting (a document can link an image
// on the sender's server, which would then learn when and where it was opened).
const LIBREOFFICE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

async function withLibreOffice(soffice, source, dir) {
  // A profile of its own lets the conversion run while LibreOffice is open (which would otherwise take the job and
  // return straight away) and keeps the user's settings out of it.
  const profile = path.join(dir, "libreoffice-profile");
  fs.mkdirSync(path.join(profile, "user"), { recursive: true });
  fs.writeFileSync(path.join(profile, "user", "registrymodifications.xcu"), LIBREOFFICE_SETTINGS);
  await run(soffice, ["--headless", "--norestore", "--nolockcheck", `-env:UserInstallation=${pathToFileURL(profile).href}`, "--convert-to", "pdf", "--outdir", dir, source]);
  return path.join(dir, path.basename(source).replace(/\.[^.]+$/, ".pdf"));
}

// The built-in converter reads a .docx in a utility process (docx-worker.cjs) and stops it if it takes too long or
// grows past this: a few hundred kilobytes of .docx can unpack into more than Readr's memory.
const WORKER_MEMORY_LIMIT = 2 * 1024 ** 3;

function docxToHtml(source, output, title) {
  return new Promise((resolve, reject) => {
    const worker = utilityProcess.fork(path.join(__dirname, "docx-worker.cjs"), [], { serviceName: "Readr Word converter" });
    const stop = (error) => {
      clearTimeout(timer);
      clearInterval(watch);
      worker.kill();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => stop(new Error("timed out")), CONVERT_TIMEOUT_MS);
    const watch = setInterval(() => {
      const memory = app.getAppMetrics().find((metric) => metric.pid === worker.pid)?.memory.workingSetSize ?? 0; // KB
      if (memory * 1024 > WORKER_MEMORY_LIMIT) stop(Object.assign(new Error("ran out of memory"), { userMessage: "It's too large to convert." }));
    }, 250);
    worker.once("message", (result) => stop(result.error ? new Error(result.error) : null));
    worker.once("exit", (code) => stop(new Error(`stopped (exit code ${code})`)));
    worker.postMessage({ source, output, title });
  });
}

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

async function builtIn(source, dir, title) {
  const htmlFile = path.join(dir, "document.html");
  if (/\.docx$/i.test(source)) {
    await docxToHtml(source, htmlFile, title);
  } else if (process.platform === "darwin") {
    await run("/usr/bin/textutil", ["-convert", "html", "-output", htmlFile, source]);
    fs.writeFileSync(htmlFile, fs.readFileSync(htmlFile, "utf8").replace(/<head[^>]*>/i, (head) => `${head}<style>@page { margin: 1in; }</style>`));
  } else {
    throw Object.assign(new Error("no converter"), { userMessage: "Converting .doc files needs Microsoft Word or LibreOffice. Install either one, or save the document as .docx." });
  }
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
        fail("Readr", error);
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
