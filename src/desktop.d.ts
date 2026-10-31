interface UpdateStatus {
  state: "idle" | "unsupported" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
}

// Present only when Readr runs as the desktop app (see electron/preload.cjs).
interface ReadrDesktop {
  /** `note` says where a converted Word document's PDF was saved. */
  onOpenFile(callback: (name: string, data: Uint8Array, note?: string) => void): () => void;
  onConverting(callback: (name: string) => void): () => void;
  onOpenFailed(callback: (message: string) => void): () => void;
  /** Converts a Word document (.doc, .docx) to PDF; the result arrives through onOpenFile. */
  openDocument(file: File): Promise<void>;
  ready(): Promise<boolean>;
  /** Null when the user declines to open an address on their computer or local network. */
  fetchPdf(url: string): Promise<{ name: string; data: Uint8Array } | null>;
  getAppInfo(): Promise<{ version: string; mode: "development" | "portable" | "installed" | "appimage" | "package"; location: string; platform: string;
    /** True when updates are announced with a download link instead of installed (unsigned macOS builds). */
    notifyOnly: boolean }>;
  /** "win32", "darwin", or "linux". */
  platform: string;
  /** Opens the releases page (macOS, where updates are downloaded manually). */
  openDownload(): Promise<void>;
  openInstallation(): Promise<string>;
  setTheme(theme: string): void;
  installUpdate(): void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
  getAutoUpdateEnabled(): Promise<boolean>;
  setAutoUpdateEnabled(enabled: boolean): Promise<boolean>;
  ai: ReadrAi;
}

interface AiStatus {
  chatgpt: { connected: boolean; email: string; name: string; welcomeSeen: boolean; encrypted: boolean };
  claude: { installed: boolean; loggedIn: boolean; version?: string; subscription?: boolean; authMethod?: string };
  openrouter: KeyStatus;
  anthropic: KeyStatus & { model: string };
}

type KeyProvider = "openrouter" | "anthropic";

interface KeyStatus {
  connected: boolean;
  encrypted: boolean;
  label: string;
  /** Dollars used and the key's own limit, when the provider reports them (OpenRouter does, Anthropic doesn't). */
  keyUsage: number | null;
  keyLimit: number | null;
  keyRemaining: number | null;
  /** Dollars spent through this app this month, and the limits set here (monthlyCap 0 means off). */
  monthSpend: number;
  maxTokens: number;
  monthlyCap: number;
}

interface OpenRouterModel {
  id: string;
  name: string;
  context: number | null;
  /** Dollars per million tokens. */
  promptPrice: number | null;
  completionPrice: number | null;
}

interface AiMessage {
  role: "user" | "assistant";
  content: string;
}

interface AiEvent {
  id: string;
  type: "delta" | "done" | "error";
  text?: string;
  message?: string;
  code?: string;
  link?: string;
}

interface ReadrAi {
  status(): Promise<AiStatus>;
  signInChatGPT(): Promise<{ ok: boolean; status?: AiStatus["chatgpt"]; error?: string }>;
  signOutChatGPT(): Promise<AiStatus["chatgpt"]>;
  chatgptWelcomeSeen(): Promise<boolean>;
  chatgptModels(): Promise<{ ok: boolean; models?: { id: string; name: string }[]; error?: string; code?: string }>;
  recheckClaude(): Promise<AiStatus["claude"]>;
  saveKey(provider: KeyProvider, key: string): Promise<{ ok: boolean; status?: KeyStatus; error?: string }>;
  clearKey(provider: KeyProvider): Promise<KeyStatus>;
  setLimits(provider: KeyProvider, limits: { maxTokens: number; monthlyCap: number }): Promise<{ ok: boolean; status?: KeyStatus; error?: string }>;
  openrouterModels(): Promise<{ ok: boolean; models?: OpenRouterModel[]; error?: string }>;
  ask(request: { id: string; provider: "chatgpt" | "claude" | "openrouter" | "anthropic"; model: string; instructions: string; messages: AiMessage[] }): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  onEvent(callback: (event: AiEvent) => void): () => void;
}

interface Window {
  folioDesktop?: ReadrDesktop;
}
