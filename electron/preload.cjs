// Minimal bridge between the Readr page and the desktop shell.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("folioDesktop", {
  /** Called with (name, data, note?) whenever a PDF is opened from Explorer, or a Word document has been converted. */
  onOpenFile(callback) {
    const listener = (_e, file) => callback(file.name, new Uint8Array(file.data), file.note ?? undefined);
    ipcRenderer.on("folio:open-file", listener);
    return () => ipcRenderer.removeListener("folio:open-file", listener);
  },
  /** Called with the file name when a Word document starts converting, and with a message if it fails. */
  onConverting(callback) {
    const listener = (_e, file) => callback(file.name);
    ipcRenderer.on("folio:converting", listener);
    return () => ipcRenderer.removeListener("folio:converting", listener);
  },
  onOpenFailed(callback) {
    const listener = (_e, failure) => callback(failure.message);
    ipcRenderer.on("folio:open-failed", listener);
    return () => ipcRenderer.removeListener("folio:open-failed", listener);
  },
  /** Converts a picked or dropped Word document; it arrives through onOpenFile. */
  openDocument: (file) => ipcRenderer.invoke("folio:open-document", webUtils.getPathForFile(file)),
  ready: () => ipcRenderer.invoke("folio:ready"),
  platform: process.platform,
  openDownload: () => ipcRenderer.invoke("folio:open-download"),
  /** Downloads a PDF from an http(s) link; resolves to { name, data: Uint8Array }, or null if the user said no. */
  async fetchPdf(url) {
    const file = await ipcRenderer.invoke("folio:fetch-pdf", url);
    if (file.cancelled) return null;
    if (file.error) throw new Error(file.error);
    return { name: file.name, data: new Uint8Array(file.data) };
  },
  getAppInfo: () => ipcRenderer.invoke("folio:app-info"),
  openInstallation: () => ipcRenderer.invoke("folio:open-installation"),
  setTheme: (theme) => ipcRenderer.send("folio:theme", theme),
  installUpdate: () => ipcRenderer.send("folio:install-update"),
  /** Called with the updater state ({ state, version?, percent?, message? }) now and whenever it changes. */
  onUpdateStatus(callback) {
    const listener = (_e, status) => callback(status);
    ipcRenderer.on("folio:update-status-changed", listener);
    ipcRenderer.invoke("folio:update-state").then(callback);
    return () => ipcRenderer.removeListener("folio:update-status-changed", listener);
  },
  checkForUpdates: () => ipcRenderer.send("folio:check-update"),
  getAutoUpdateEnabled: () => ipcRenderer.invoke("folio:auto-update-setting"),
  setAutoUpdateEnabled: (enabled) => ipcRenderer.invoke("folio:set-auto-update-setting", enabled),
  ai: {
    status: () => ipcRenderer.invoke("folio:ai-status"),
    signInChatGPT: () => ipcRenderer.invoke("folio:ai-chatgpt-signin"),
    signOutChatGPT: () => ipcRenderer.invoke("folio:ai-chatgpt-signout"),
    chatgptWelcomeSeen: () => ipcRenderer.invoke("folio:ai-chatgpt-welcome-seen"),
    chatgptModels: () => ipcRenderer.invoke("folio:ai-chatgpt-models"),
    recheckClaude: () => ipcRenderer.invoke("folio:ai-claude-recheck"),
    saveOpenRouterKey: (key) => ipcRenderer.invoke("folio:ai-openrouter-save-key", key),
    clearOpenRouterKey: () => ipcRenderer.invoke("folio:ai-openrouter-clear-key"),
    setOpenRouterSettings: (settings) => ipcRenderer.invoke("folio:ai-openrouter-settings", settings),
    openrouterModels: () => ipcRenderer.invoke("folio:ai-openrouter-models"),
    ask: (request) => ipcRenderer.invoke("folio:ai-ask", request),
    cancel: (id) => ipcRenderer.invoke("folio:ai-cancel", id),
    /** Called with { id, type: "delta" | "done" | "error", text?, message?, code?, link? } for every answer. */
    onEvent(callback) {
      const listener = (_e, event) => callback(event);
      ipcRenderer.on("folio:ai-event", listener);
      return () => ipcRenderer.removeListener("folio:ai-event", listener);
    },
  },
});
