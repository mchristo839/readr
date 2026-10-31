// The first half of Readr's built-in Word converter (convert.cjs prints the result): turns a .docx into an HTML page.
// It runs in a utility process of its own, so a document built to exhaust memory or stall the parser (a small file
// can unpack into gigabytes) takes down only this process, not Readr.
const fs = require("node:fs");

// Readr's own layout: a printed page with Word's usual defaults.
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

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Listening keeps the process alive until convert.cjs has the answer and stops it.
process.parentPort.on("message", async ({ data: { source, output, title } }) => {
  try {
    // Images come out as data: URLs, so the page needs nothing else.
    const body = (await require("mammoth").convertToHtml({ path: source })).value;
    fs.writeFileSync(output, `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${DOCUMENT_CSS}</style></head><body>${body}</body></html>`);
    process.parentPort.postMessage({});
  } catch (error) {
    process.parentPort.postMessage({ error: String(error?.stack || error) });
  }
});
