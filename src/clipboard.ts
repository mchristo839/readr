// The Copy buttons write through the browser clipboard API. Electron grants Readr's
// own page clipboard-sanitized-write (see the permission handler in electron/main.cjs),
// but a write can still be refused, and a refused write used to be swallowed so the
// button claimed success. These report whether the write really happened.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copyImage(blob: Blob): Promise<boolean> {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}
