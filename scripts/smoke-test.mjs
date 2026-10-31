// End-to-end smoke test, run in CI on Windows, macOS, and Linux (and locally with `npm run smoke`):
// launches the built app in Electron, opens the sample document, and checks that pages render, text is
// selectable and highlightable, text boxes survive reopening, and the window chrome matches the platform.
// Run `npm run build` first.
import { _electron as electron } from "playwright-core";
import { createRequire } from "node:module";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const executablePath = require("electron"); // path to the Electron binary
const shots = path.join(root, "release", "smoke");
mkdirSync(shots, { recursive: true });

// The window stays hidden so a local run doesn't pop up over other work; FOLIO_SMOKE_SHOW=1 shows it.
const env = { ...process.env, FOLIO_TEST_USER_DATA: mkdtempSync(path.join(tmpdir(), "folio-smoke-")),
  FOLIO_TEST_HIDDEN: process.env.FOLIO_SMOKE_SHOW === "1" ? "0" : "1" };
delete env.ELECTRON_RUN_AS_NODE;
// Containers often run as root, where Chromium's sandbox can't start. The made-up names stand in for web addresses
// that lead to this computer (see the local network checks below).
const args = [root, "--host-resolver-rules=MAP folio-local.test 127.0.0.1, MAP folio-rebind.test 127.0.0.1",
  ...(process.platform === "linux" && process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

// The smallest .docx Word opens: one paragraph of `text`.
async function wordDocument(text) {
  const JSZip = require("jszip"); // comes with mammoth
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

const app = await electron.launch({ executablePath, args, env, timeout: 60_000 });
const failures = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (e) => failures.push(String(e)));
  await page.getByRole("button", { name: /Try a sample/ }).waitFor({ timeout: 30_000 });

  const platformClass = await page.evaluate(() => [...document.documentElement.classList].find((c) => c.startsWith("platform-")));
  assert.equal(platformClass, `platform-${process.platform}`);
  console.log("ok  platform:", platformClass);

  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  assert.match(await page.locator(".textLayer").first().innerText(), /A short tour of Folio/);
  console.log("ok  sample rendered with a text layer");

  // Opening another document (here from the file manager) asks first when there's unsaved work, a placed signature,
  // and keeps it if the reader says no.
  const photo = await page.evaluate(() => {
    const canvas = Object.assign(document.createElement("canvas"), { width: 600, height: 200 });
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 600, 200);
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(40, 150);
    g.bezierCurveTo(150, 10, 250, 190, 350, 60);
    g.lineTo(560, 120);
    g.stroke();
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.getByTitle("Add a signature").click();
  await page.locator('input[aria-label="Upload signature photo"]').setInputFiles({ name: "signature.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
  await page.getByRole("button", { name: /Use this signature/ }).click();
  await page.locator('select[aria-label="Signature placement"]').selectOption("manual");
  await page.locator('[aria-label^="Place signature on page"]').click();
  await page.getByRole("button", { name: /Approve and add signature/ }).click();
  await page.locator(".dirty-dot").waitFor();

  // Printing saves nothing, so the signature stays marked as unsaved. The print frame is stubbed for the check, so no
  // system print dialog opens.
  await page.evaluate(() => {
    const frame = HTMLIFrameElement.prototype;
    const stub = { printed: 0, src: Object.getOwnPropertyDescriptor(frame, "src"), contentWindow: Object.getOwnPropertyDescriptor(frame, "contentWindow") };
    window.folioPrintStub = stub;
    Object.defineProperty(frame, "src", { configurable: true, set(url) { this.dataset.src = url; } });
    Object.defineProperty(frame, "contentWindow", { configurable: true, get: () => ({ focus() {}, print() { stub.printed++; } }) });
  });
  await page.keyboard.press("ControlOrMeta+p");
  await page.waitForFunction(() => window.folioPrintStub.printed === 1, null, { timeout: 15_000 });
  await page.evaluate(() => {
    Object.defineProperty(HTMLIFrameElement.prototype, "src", window.folioPrintStub.src);
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", window.folioPrintStub.contentWindow);
  });
  assert.ok(await page.locator(".dirty-dot").isVisible(), "printing cleared the unsaved marker");
  console.log("ok  printing keeps unsaved work marked as unsaved");

  const sample = await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch("sample.pdf")).arrayBuffer())));
  const openFromFileManager = () => app.evaluate(({ BrowserWindow }, data) =>
    BrowserWindow.getAllWindows()[0].webContents.send("folio:open-file", { name: "Another.pdf", data: Buffer.from(data) }), sample);
  let prompt = page.waitForEvent("dialog");
  await openFromFileManager();
  await (await prompt).dismiss();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".stampEditor").count(), 1);
  prompt = page.waitForEvent("dialog");
  await openFromFileManager();
  await (await prompt).accept();
  await page.waitForFunction(() => document.title.startsWith("Another.pdf"), null, { timeout: 15_000 });
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  console.log("ok  opening another document asks before discarding unsaved work");

  // Select a sentence and highlight it in one click.
  await page.evaluate(() => {
    const span = [...document.querySelectorAll(".textLayer span:not(.markedContent)")].find((s) => s.textContent.includes("A short tour"));
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator(".selection-popover").waitFor();

  // Copy puts the selection on the system clipboard (whose contents are put back afterwards). Clipboard writes
  // need a focused window, which a CI desktop doesn't always give the app. Only CI runs it: on someone's own
  // computer it would briefly replace what they've copied (and anything but plain text wouldn't come back).
  if (!process.env.CI) {
    console.log("--  clipboard check skipped: it only runs in CI, to leave your clipboard alone");
  } else if (await page.evaluate(() => document.hasFocus())) {
    const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText());
    await page.locator(".selection-popover").getByRole("button", { name: "Copy" }).click();
    await page.locator('.selection-popover button[title="Copied"]').waitFor({ timeout: 5_000 });
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore);
    assert.ok(/A short tour of Folio/.test(copied), "Copy didn't reach the clipboard");
    console.log("ok  selection copied to the clipboard");
  } else {
    console.log("--  clipboard check skipped: the window isn't focused");
  }

  // A refused clipboard write must be reported, not dressed up as a copy. The write is blocked here so the button's
  // failure path runs on every machine, not just where the OS happens to refuse it.
  await page.evaluate(() => {
    globalThis.__clipboardWriteText = navigator.clipboard.writeText;
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: () => Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
    });
  });
  await page.locator(".selection-popover").getByRole("button", { name: "Copy" }).click();
  await page.locator('.selection-popover button[title="Copy failed"]').waitFor({ timeout: 5_000 });
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value: globalThis.__clipboardWriteText,
    });
  });
  console.log("ok  a refused clipboard write is reported as Copy failed");

  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".highlightEditor").length === 1, null, { timeout: 15_000 });
  console.log("ok  highlight created");

  // A saved copy includes every saved mark, also on pages that haven't been drawn since the document was reopened.
  const lastPage = await page.locator(".page").count();
  // A page's text can be selected before pdf.js has built its highlight layer: it first waits for the page's links
  // and form fields from its worker, which can take a while on a busy computer. Hold that reply back so this
  // highlight always lands in the gap.
  await page.evaluate(() => {
    const post = Worker.prototype.postMessage;
    window.folioPostMessage = post;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.action !== "GetAnnotations") return post.call(this, message, ...rest);
      setTimeout(() => post.call(this, message, ...rest), 2500);
    };
  });
  await page.evaluate((n) => document.querySelector(`.page[data-page-number="${n}"]`).scrollIntoView(), lastPage);
  await page.locator(`.page[data-page-number="${lastPage}"] .textLayer span:not(.markedContent)`).first().evaluate((span) => {
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.locator(".selection-popover").waitFor();
  await page.getByRole("button", { name: "Highlight yellow" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".highlightEditor").length === 2, null, { timeout: 15_000 });
  await page.evaluate(() => { Worker.prototype.postMessage = window.folioPostMessage; });
  await page.evaluate(() => document.querySelector('.page[data-page-number="1"]').scrollIntoView());
  await page.waitForTimeout(800);
  await page.getByTitle("Back to library").click();
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
  const copy = path.join(env.FOLIO_TEST_USER_DATA, "copy.pdf");
  await app.evaluate(({ session }, file) => {
    globalThis.folioCopySaved = new Promise((resolve) => session.defaultSession.once("will-download", (_event, item) => {
      item.setSavePath(file);
      item.once("done", (_done, state) => resolve(state));
    }));
  }, copy);
  await page.keyboard.press("ControlOrMeta+s");
  assert.equal(await app.evaluate(() => globalThis.folioCopySaved), "completed");
  assert.equal(readFileSync(copy, "latin1").match(/\/Subtype\s*\/Highlight\b/g)?.length, 2);
  console.log("ok  saved copy includes marks on pages not drawn yet");

  // The More menu opens and closes.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: /About Readr/ }).waitFor();
  await page.keyboard.press("Escape");

  // Settings links to the bundled changelog, and closing it returns to Settings.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Comma" : "Control+Comma");
  await page.getByRole("button", { name: "View changelog" }).click();
  await page.getByRole("dialog", { name: "What's new" }).locator("h3").first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.keyboard.press("Escape");
  console.log("ok  changelog opens from Settings");

  // A text box is saved automatically and comes back, text and all, when the document is opened again.
  await page.locator('button[title^="Text ("]').click();
  // Clicked in the middle of the page's visible part: a fixed spot near the top lands under the toolbar's color
  // picker in a small window, as on CI runners.
  await page.locator('.page[data-page-number="1"] .annotationEditorLayer').click();
  // Filled in one go: pdf.js moves the caret while it focuses a new box, which can scramble key-by-key typing.
  await page.locator('.freeTextEditor .internal[contenteditable="true"]').fill("Saved text box");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByTitle("Back to library").click();
  await page.getByRole("button", { name: /Try a sample/ }).click();
  await page.locator(".freeTextEditor", { hasText: "Saved text box" }).waitFor({ timeout: 15_000 });
  console.log("ok  text box restored after reopening");

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `smoke-${process.platform}.png`) });

  // A Word document opens converted to PDF (by Word, LibreOffice, or Folio itself, whichever the computer has),
  // and the PDF is saved next to it. Opening the document again reuses that PDF.
  const folder = mkdtempSync(path.join(tmpdir(), "folio-word-"));
  const docx = path.join(folder, "Quarterly report.docx");
  writeFileSync(docx, await wordDocument("Quarterly report from Word"));
  const openWordDocument = async () => {
    await page.getByTitle("Back to library").click();
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /Open a PDF/ }).click();
    await (await chooser).setFiles(docx);
    // Stops at a conversion error too, and shows what each converter said.
    const settled = await page.waitForFunction(() => document.title.startsWith("Quarterly report.pdf")
      || document.querySelector(".toast.error")?.textContent, null, { timeout: 150_000 }).catch((error) => error);
    if (settled instanceof Error || !(await page.title()).startsWith("Quarterly report.pdf")) {
      const log = path.join(env.FOLIO_TEST_USER_DATA, "convert.log");
      console.log(await page.locator(".toast").textContent().catch(() => "(no message)"));
      console.log(existsSync(log) ? readFileSync(log, "utf8") : "(no convert.log)");
      throw settled instanceof Error ? settled : new Error("the Word document didn't convert");
    }
    await page.locator(".textLayer span:not(.markedContent)").first().waitFor({ timeout: 30_000 });
    assert.match(await page.locator(".textLayer").first().innerText(), /Quarterly report from Word/);
  };
  await openWordDocument();
  assert.ok(existsSync(path.join(folder, "Quarterly report.pdf")), "the converted PDF wasn't saved next to the document");
  await openWordDocument();
  assert.deepEqual(readdirSync(folder).sort(), ["Quarterly report.docx", "Quarterly report.pdf"]);
  console.log("ok  Word document converted to PDF, saved next to it, and reused");

  // A pasted link fills in Open from URL; nothing is contacted until the user presses Open.
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "https://example.com/paper.pdf");
    document.querySelector(".viewer-container").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  const urlDialog = page.getByRole("dialog", { name: "Open from URL" });
  assert.equal(await urlDialog.getByLabel("PDF URL").inputValue(), "https://example.com/paper.pdf");
  await page.keyboard.press("Escape");
  console.log("ok  a pasted link waits in Open from URL");

  // Questions Folio asks in the main process are answered here, and links are recorded instead of reaching the browser.
  await app.evaluate(({ dialog, shell }) => {
    const check = globalThis.folioCheck = { asked: [], opened: [], answer: 1 };
    dialog.showMessageBox = async (_window, options) => { check.asked.push(options.message); return { response: check.answer }; };
    shell.openExternal = async (url) => { check.opened.push(url); };
  });
  const answer = (response) => app.evaluate((_electron, response) => { globalThis.folioCheck.answer = response; }, response);
  const settled = async (count) => {
    for (let i = 0; i < 50 && (await app.evaluate(() => globalThis.folioCheck.asked.length)) < count; i++) await page.waitForTimeout(100);
    return app.evaluate(() => globalThis.folioCheck);
  };

  // A link from a document opens in the browser only after the user has seen where it goes; Folio's own links just open.
  await page.evaluate(() => window.open("https://example.com/invoice", "_blank"));
  assert.deepEqual(await settled(1), { asked: ["Open example.com in your browser?"], opened: [], answer: 1 });
  await answer(0);
  await page.evaluate(() => window.open("https://example.com/invoice", "_blank"));
  assert.deepEqual((await settled(2)).opened, ["https://example.com/invoice"]);
  await page.evaluate(() => window.open("https://claude.com/claude-code", "_blank"));
  await page.waitForTimeout(300);
  const linkCheck = await settled(2);
  assert.deepEqual([linkCheck.asked.length, linkCheck.opened.at(-1)], [2, "https://claude.com/claude-code"]);
  console.log("ok  links from documents ask before opening");

  // Addresses on this computer or the local network are reached only once the user agrees, also when the page asks
  // directly (as a document that took over the page might) and when a name only resolves there.
  const served = [];
  const server = http.createServer((req, res) => { served.push(req.url); res.writeHead(200, { "content-type": "application/pdf" }); res.end(Buffer.from(sample)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const fetchPdf = (url) => page.evaluate((url) => window.folioDesktop.fetchPdf(url).then((file) => file?.name ?? null, (error) => error.message), url);
  try {
    await answer(1);
    assert.equal(await fetchPdf(`http://127.0.0.1:${port}/local.pdf`), null);
    assert.equal(await fetchPdf(`http://folio-local.test:${port}/named.pdf`), null);
    assert.deepEqual(served, []);
    assert.deepEqual((await settled(4)).asked.slice(2), [`Open 127.0.0.1:${port}?`, `Open folio-local.test:${port}?`]);
    await answer(0);
    assert.equal(await fetchPdf(`http://folio-local.test:${port}/named.pdf`), "named.pdf");
    assert.deepEqual(served, ["/named.pdf"]);
    // A name that looks public when Folio checks it but leads here when Chromium connects (DNS rebinding) is refused.
    await app.evaluate(({ session }) => {
      const sessions = Object.getPrototypeOf(session.defaultSession);
      const resolveHost = sessions.resolveHost;
      sessions.resolveHost = function (host, options) {
        return host === "folio-rebind.test" ? Promise.resolve({ endpoints: [{ address: "93.184.215.14", family: "ipv4" }] }) : resolveHost.call(this, host, options);
      };
    });
    assert.match(await fetchPdf(`http://folio-rebind.test:${port}/rebound.pdf`), /local network address/);
    assert.equal((await settled(5)).asked.length, 5);
  } finally {
    server.close();
  }
  console.log("ok  local network addresses need the user's OK");

  assert.deepEqual(failures, []);
  console.log(`PASS (${process.platform})`);
} finally {
  await app.close();
}
