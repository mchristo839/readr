// Which operating system Readr is running on, and shortcut labels written its way.
// navigator.platform is deprecated; userAgentData covers Chromium, the old API is the fallback.
const uaPlatform =
  (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
const platform =
  window.folioDesktop?.platform ??
  (/Mac|iPhone|iPad/i.test(uaPlatform) ? "darwin" : /Linux/i.test(uaPlatform) ? "linux" : "win32");

const IS_MAC = platform === "darwin";

/** Writes a shortcut the way this platform does: "Ctrl S" stays on Windows/Linux, becomes "⌘ S" on macOS. */
export function keys(label: string) {
  return IS_MAC ? label.replace(/Ctrl\+/g, "⌘").replace(/Ctrl/g, "⌘").replace(/Shift/g, "⇧") : label;
}
