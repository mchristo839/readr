let appImage: boolean | null = null;
void window.folioDesktop?.getAppInfo().then((info) => { appImage = info.mode === "appimage"; });
const isAppImage = () => appImage === true;

/** One line about the updater's state, shared by the start screen and Settings. */
export function updateSummary(status: UpdateStatus): string {
  switch (status.state) {
    case "checking": return "Checking for updates…";
    case "downloading": return `Downloading ${status.version} (${status.percent ?? 0}%)`;
    case "ready": return `Version ${status.version} is ready to install.${window.folioDesktop?.platform === "linux" && !isAppImage() ? " Restarting asks for your password." : ""}`;
    case "available": return `Readr ${status.version} is available to download.`;
    case "latest": return "You're up to date.";
    case "error": return `Couldn't check for updates. ${status.message ?? "Try again."}`;
    case "unsupported":
      return status.message === "system" ? "Updates arrive with your system's software updates (apt)." : "This copy doesn't update itself.";
    default: return "";
  }
}
