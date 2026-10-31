// Ask-AI providers, run in the main process so credentials never reach the page.
//
// - ChatGPT: OpenAI's "Sign in with ChatGPT" for open-source apps (OAuth 2.0 + PKCE with a loopback
//   redirect). Requests use the person's own ChatGPT plan through the public Responses API.
//   https://developers.openai.com/siwc/token-sharing-open-source/sign-in
// - Claude: the person's own, unmodified Claude Code CLI, signed in with their Claude subscription
//   through Anthropic's own flow. Readr never sees or stores Claude credentials; it runs `claude -p`
//   with every tool disabled and reads the streamed answer.
const { app, net, safeStorage, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const AUTH_ISSUER = "https://auth.openai.com";
const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const API = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const USAGE_URL = "https://chatgpt.com/settings/usage";
const REFRESH_FAILURES = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
  "refresh_token_invalidated", "refresh_token_reused"]);

const dir = () => path.join(app.getPath("userData"), "ai");
const file = (name) => path.join(dir(), name);
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function writeAtomic(name, contents) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name) + ".tmp", contents, { mode: 0o600 });
  fs.renameSync(file(name) + ".tmp", file(name));
}

// ── ChatGPT credentials (encrypted with Windows' per-user data protection) ──────────────────
function loadHost() {
  try {
    const host = JSON.parse(fs.readFileSync(file("chatgpt-host.json"), "utf8"));
    if (typeof host.hostId === "string") return host;
  } catch {}
  const host = { hostId: `urn:uuid:${crypto.randomUUID()}`, clientId: null, welcomeSeen: false };
  writeAtomic("chatgpt-host.json", JSON.stringify(host));
  return host;
}
function saveHost(host) {
  writeAtomic("chatgpt-host.json", JSON.stringify(host));
}

let session = null; // { accessToken, refreshToken, idToken, expiresAt, scopes, email, name }
async function loadSession() {
  if (session) return session;
  try {
    if (!fs.existsSync(file("chatgpt-session.bin")) || !(await safeStorage.isAsyncEncryptionAvailable())) return null;
    const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file("chatgpt-session.bin")));
    session = JSON.parse(result);
  } catch { session = null; }
  return session;
}
async function saveSession(next) {
  session = next;
  if (!next) {
    try { fs.rmSync(file("chatgpt-session.bin"), { force: true }); } catch {}
    return;
  }
  // Without OS encryption, keep the session in memory only (sign in again next launch).
  if (await safeStorage.isAsyncEncryptionAvailable()) writeAtomic("chatgpt-session.bin", await safeStorage.encryptStringAsync(JSON.stringify(next)));
}

async function postForm(url, params) {
  const response = await net.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: response.ok, status: response.status, json, text };
}

let openIdConfig = null;
async function getOpenIdConfig() {
  if (openIdConfig) return openIdConfig;
  const response = await net.fetch(`${AUTH_ISSUER}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error("Couldn't reach OpenAI's sign-in service.");
  openIdConfig = await response.json();
  return openIdConfig;
}

/** Verifies the ID token's RS256 signature and claims; returns its payload. */
async function verifyIdToken(idToken, clientId, nonce) {
  const [h, p, sig] = String(idToken).split(".");
  const header = JSON.parse(Buffer.from(h, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  const config = await getOpenIdConfig();
  const jwks = await (await net.fetch(config.jwks_uri)).json();
  const jwk = jwks.keys?.find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new Error("Unexpected sign-in token.");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"));
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const authorizedParty = audience.length > 1 ? payload.azp === clientId : payload.azp === undefined || payload.azp === clientId;
  if (!valid || payload.iss !== AUTH_ISSUER || !audience.includes(clientId) || !authorizedParty || payload.nonce !== nonce
    || !Number.isFinite(payload.exp) || payload.exp * 1000 < Date.now()) {
    throw new Error("The sign-in response couldn't be verified. Please try again.");
  }
  return payload;
}

const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Readr</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:90vh;color:#222">
<p>You can close this tab and return to Readr.</p></body>`;

let signInInProgress = null;

async function signInChatGPT() {
  if (signInInProgress) return signInInProgress;
  signInInProgress = (async () => {
    const host = loadHost();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));

    // Loopback redirect on 127.0.0.1; only the port may differ between sign-ins.
    const server = http.createServer();
    const callback = new Promise((resolve, reject) => {
      server.on("request", (req, res) => {
        try {
          const url = new URL(req.url, "http://127.0.0.1");
          // Only a response carrying this attempt's state counts; anything else is ignored, so stray
          // requests from other local software or web pages can't end the sign-in.
          if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) { res.writeHead(404).end(); return; }
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(CALLBACK_PAGE);
          if (url.searchParams.get("error")) return reject(new Error(url.searchParams.get("error") === "access_denied" ? "Sign-in was cancelled." : "ChatGPT sign-in failed."));
          resolve(url.searchParams);
        } catch {
          // A malformed request line shouldn't be able to take the app down.
          res.writeHead(400).end();
        }
      });
    });
    callback.catch(() => {}); // handled by the race below; avoids an early unhandled rejection
    let waitTimer;
    try {
      let listenTimer;
      await new Promise((resolve, reject) => {
        let fellBack = false;
        server.on("error", (error) => {
          // Port 1455 is the documented default; any free loopback port also works.
          if (!fellBack && error.code === "EADDRINUSE") { fellBack = true; server.listen(0, "127.0.0.1", resolve); }
          else reject(new Error("Couldn't start sign-in."));
        });
        server.listen(1455, "127.0.0.1", resolve);
        listenTimer = setTimeout(() => reject(new Error("Couldn't start sign-in.")), 5000);
      }).finally(() => clearTimeout(listenTimer));
      const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const timeout = new Promise((_, reject) => {
        waitTimer = setTimeout(() => reject(new Error("Sign-in timed out. Please try again.")), 5 * 60_000);
      });
      timeout.catch(() => {});

      const params = {
        response_type: "code",
        client_id: host.clientId || "dynamic_agent_client",
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: API,
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ext_agent_host_id: host.hostId,
      };
      if (!host.clientId) params.agent_name_hint = "Readr";
      await shell.openExternal(`${AUTHORIZE_URL}?${new URLSearchParams(params)}`);

      const query = await Promise.race([callback, timeout]);
      const clientId = query.get("client_id") || host.clientId;
      if (!clientId) throw new Error("ChatGPT didn't finish registering Readr. Please try again.");
      // Keep the issued client ID for every later sign-in on this computer, even if the rest fails.
      if (host.clientId !== clientId) saveHost({ ...host, clientId });
      const exchange = await postForm(TOKEN_URL, {
        grant_type: "authorization_code", client_id: clientId, code: query.get("code"), code_verifier: verifier, redirect_uri: redirectUri, resource: API,
      });
      if (!exchange.ok || !exchange.json?.access_token) throw new Error("ChatGPT sign-in failed. Please try again.");
      const tokens = exchange.json;
      const claims = await verifyIdToken(tokens.id_token, clientId, nonce);
      const scopes = String(tokens.scope || query.get("scope") || "").split(/[\s+]+/);
      if (!scopes.includes("chatgpt.tokens.use.direct")) {
        throw new Error("ChatGPT plan usage wasn't granted. Sign in again and allow Readr to use your plan.");
      }
      await saveSession({
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token,
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000, scopes, email: claims.email ?? "", name: claims.name ?? "",
      });
      return await chatgptStatus();
    } finally {
      clearTimeout(waitTimer);
      server.close();
    }
  })();
  try { return await signInInProgress; } finally { signInInProgress = null; }
}

let refreshing = null;
async function accessToken(force = false) {
  const current = await loadSession();
  if (!current) throw Object.assign(new Error("Continue with ChatGPT to use your plan in Readr."), { code: "signed_out" });
  if (!force && current.expiresAt - 60_000 > Date.now()) return current.accessToken;
  // Refresh tokens rotate: never run two refreshes at once.
  refreshing ??= (async () => {
    const { clientId } = loadHost();
    const result = await postForm(TOKEN_URL, { grant_type: "refresh_token", client_id: clientId, refresh_token: current.refreshToken, resource: API });
    if (!result.ok) {
      const code = result.json?.error;
      if (REFRESH_FAILURES.has(code)) {
        await saveSession(null);
        throw Object.assign(new Error("Your ChatGPT sign-in has ended. Continue with ChatGPT to reconnect."), { code: "signed_out" });
      }
      throw new Error("Couldn't refresh your ChatGPT sign-in. Check your connection and try again.");
    }
    const t = result.json;
    // Signed out while this refresh was in flight: don't bring the session back.
    if (!session || session.refreshToken !== current.refreshToken) {
      throw Object.assign(new Error("Continue with ChatGPT to use your plan in Readr."), { code: "signed_out" });
    }
    await saveSession({ ...current, accessToken: t.access_token, refreshToken: t.refresh_token ?? current.refreshToken,
      idToken: t.id_token ?? current.idToken, expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000 });
    return session.accessToken;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function signOutChatGPT() {
  // Let an in-flight refresh finish first, so the newest refresh token is the one revoked.
  await refreshing?.catch(() => {});
  const current = await loadSession();
  await saveSession(null);
  if (!current?.refreshToken) return chatgptStatus();
  try {
    const { revocation_endpoint } = await getOpenIdConfig();
    if (revocation_endpoint) {
      await postForm(revocation_endpoint, { token: current.refreshToken, token_type_hint: "refresh_token", client_id: loadHost().clientId });
    }
  } catch {
    /* tokens are already cleared locally; the person can also disconnect Readr in ChatGPT settings */
  }
  return chatgptStatus();
}

async function chatgptStatus() {
  const current = await loadSession();
  const host = loadHost();
  return { connected: !!current, email: current?.email ?? "", name: current?.name ?? "", welcomeSeen: !!host.welcomeSeen,
    encrypted: await safeStorage.isAsyncEncryptionAvailable() };
}

async function chatgptModels() {
  const token = await accessToken();
  const response = await net.fetch(`${API}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Couldn't load ChatGPT models (${response.status}).`);
  const json = await response.json();
  const list = Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : [];
  return list.filter((m) => m.visibility === undefined || m.visibility === "list")
    .map((m) => ({ id: m.slug ?? m.id, name: m.display_name ?? m.slug ?? m.id }))
    .filter((m) => typeof m.id === "string");
}

async function askChatGPT({ model, instructions, messages }, emit, signal) {
  const body = JSON.stringify({
    model,
    instructions,
    input: messages.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    store: false,
    stream: true,
  });
  const send = (token) => net.fetch(`${API}/responses`, {
    method: "POST", signal, body,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
  });
  let response = await send(await accessToken());
  if (response.status === 401) response = await send(await accessToken(true));
  if (!response.ok) {
    let code = "";
    try { const j = await response.json(); code = j.error?.code ?? j.code ?? ""; } catch {}
    throw usageError(code, response.status);
  }
  // Server-sent events: blank-line separated blocks of "event:" / "data:" lines.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") emit(event.delta);
      else if (event.type === "response.completed") completed = true;
      else if (event.type === "response.failed" || event.type === "error") {
        throw usageError(event.response?.error?.code ?? event.error?.code ?? event.code ?? "", 0);
      } else if (event.type === "response.incomplete") {
        throw new Error("The answer was cut short. Try a shorter question or a smaller selection.");
      }
    }
  }
  if (!completed) throw new Error("The connection to ChatGPT ended early. Please try again.");
}

function usageError(code, status) {
  if (code === "subscription_sharing_usage_limit_exceeded" || status === 429) {
    return Object.assign(new Error("You've reached a ChatGPT usage limit."), { code: "usage_limit", link: USAGE_URL });
  }
  if (code === "subscription_sharing_usage_unavailable" || status === 503) {
    return new Error("ChatGPT is temporarily unavailable. Please try again in a moment.");
  }
  if (code === "subscription_sharing_invalid_user" || status === 401) {
    return Object.assign(new Error("ChatGPT couldn't confirm your plan. Continue with ChatGPT to reconnect."), { code: "signed_out" });
  }
  return new Error(`ChatGPT couldn't answer${status ? ` (${status})` : ""}. Please try again.`);
}

// ── Claude Code ────────────────────────────────────────────────────────────────────────────
function run(cmd, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, env: claudeEnv() }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

function claudeEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

let claudePath;
async function findClaude() {
  if (claudePath) return claudePath;
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  // Search absolute PATH entries ourselves (never the current folder, which `where.exe` checks first),
  // with Claude Code's default install location first. Only native executables: .cmd/.bat shims would need a shell.
  const dirs = [path.join(os.homedir(), ".local", "bin"), ...String(process.env.PATH ?? "").split(path.delimiter)]
    .map((d) => d.trim().replace(/^"|"$/g, ""))
    .filter((d) => d && path.isAbsolute(d));
  claudePath = dirs.map((d) => path.join(d, name)).find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) ?? null;
  return claudePath;
}

// Checking Claude Code runs two short processes; reuse the answer for a little while.
let claudeStatusCache = null;
async function claudeStatus(fresh = false) {
  if (!fresh && claudeStatusCache && Date.now() - claudeStatusCache.at < 30_000) return claudeStatusCache.value;
  const exe = await findClaude();
  let value = { installed: false, loggedIn: false };
  if (exe) {
    const version = (await run(exe, ["--version"]))?.trim().split(/\s/)[0] ?? "";
    let auth = null;
    try { auth = JSON.parse((await run(exe, ["auth", "status"])) ?? "null"); } catch {}
    value = { installed: true, version, loggedIn: !!auth?.loggedIn, subscription: auth?.authMethod === "claude.ai", authMethod: auth?.authMethod ?? "" };
  }
  claudeStatusCache = { at: Date.now(), value };
  return value;
}

const CLAUDE_MODELS = new Set(["", "sonnet", "opus", "haiku"]);
const CLAUDE_TIMEOUT_MS = 5 * 60_000;

/** Removes prompt folders left behind if Readr or Claude Code exited mid-answer. */
function cleanStaleClaudeFolders() {
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith("folio-claude-")) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
    }
  } catch {}
}

async function askClaude({ model, instructions, messages }, emit, signal) {
  const exe = await findClaude();
  if (!exe) throw new Error("Claude Code isn't installed.");
  if (signal.aborted) return;
  // An empty working folder, no settings, MCP servers, slash commands, or tools: Claude only reads and answers.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "folio-claude-"));
  const cleanup = () => { try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {} };
  const promptFile = path.join(cwd, "system.txt");
  try {
    fs.writeFileSync(promptFile, instructions, { mode: 0o600 });
  } catch (error) {
    cleanup();
    throw error;
  }
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "",
    "--system-prompt-file", promptFile, "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence"];
  if (model && CLAUDE_MODELS.has(model)) args.push("--model", model);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, env: claudeEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      cleanup();
      return reject(error);
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, CLAUDE_TIMEOUT_MS);
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    let buffer = "";
    let streamed = false;
    let result = null;
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") {
          streamed = true;
          emit(event.event.delta.text);
        } else if (event.type === "result") result = event;
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.stdin.on("error", () => {}); // the process may exit before reading everything
    child.on("error", (error) => { clearTimeout(timer); cleanup(); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      cleanup();
      if (signal.aborted) return resolve();
      if (timedOut) return reject(new Error("Claude took too long to answer. Please try again."));
      if (result && !result.is_error) {
        if (!streamed && result.result) emit(result.result);
        return resolve();
      }
      const message = String(result?.result || stderr || "");
      if (/log ?in|logged in|authenticat/i.test(message)) return reject(new Error("Claude Code isn't signed in. Open a terminal, run `claude`, and sign in with your Claude account."));
      if (/limit|usage/i.test(message)) return reject(Object.assign(new Error("You've reached your Claude usage limit. " + message.split("\n")[0]), { code: "usage_limit" }));
      reject(new Error(message.split("\n")[0] || "Claude Code couldn't answer."));
    });
    child.stdin.end(transcript(messages));
  });
}

/** Claude Code reads one prompt, so earlier turns are included as a transcript. */
function transcript(messages) {
  if (messages.length === 1) return messages[0].content;
  const earlier = messages.slice(0, -1).map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`).join("\n\n");
  return `${earlier}\n\nContinue the conversation. Reply to this latest message:\n\n${messages[messages.length - 1].content}`;
}

// ── API-key providers (OpenRouter, Anthropic) ──────────────────────────────────────────────
// The person's own API keys, kept encrypted in the main process and never sent to the page. Spend is limited three
// ways: a hard limit on the provider's side (an OpenRouter key's credit limit, an Anthropic workspace's spend
// limit), a monthly cap tracked here from what each answer cost, and a cap on the length of each answer.
const LIMIT_DEFAULTS = { maxTokens: 2000, monthlyCap: 5 };
const keysInMemory = new Map(); // used only when the system has no secret store
const monthKey = () => new Date().toISOString().slice(0, 7);

function keyStore(name) {
  const keyFile = `${name}-key.bin`, settingsFile = `${name}-settings.json`, ledgerFile = `${name}-ledger.json`;
  const store = {
    async read() {
      if (keysInMemory.has(name)) return keysInMemory.get(name);
      try {
        if (!fs.existsSync(file(keyFile)) || !(await safeStorage.isAsyncEncryptionAvailable())) return null;
        const { result } = await safeStorage.decryptStringAsync(fs.readFileSync(file(keyFile)));
        return typeof result === "string" && result ? result : null;
      } catch { return null; }
    },
    async write(key) {
      if (await safeStorage.isAsyncEncryptionAvailable()) {
        writeAtomic(keyFile, await safeStorage.encryptStringAsync(key));
        keysInMemory.delete(name);
      } else {
        keysInMemory.set(name, key); // never written to disk unencrypted: added again next launch
      }
    },
    clear() {
      keysInMemory.delete(name);
      try { fs.rmSync(file(keyFile), { force: true }); } catch {}
    },
    limits() {
      try {
        const saved = JSON.parse(fs.readFileSync(file(settingsFile), "utf8"));
        const maxTokens = Number.isInteger(saved.maxTokens) && saved.maxTokens >= 200 && saved.maxTokens <= 32000 ? saved.maxTokens : LIMIT_DEFAULTS.maxTokens;
        const monthlyCap = typeof saved.monthlyCap === "number" && saved.monthlyCap >= 0 && saved.monthlyCap <= 10000 ? saved.monthlyCap : LIMIT_DEFAULTS.monthlyCap;
        return { maxTokens, monthlyCap };
      } catch { return { ...LIMIT_DEFAULTS }; }
    },
    setLimits(next) {
      const maxTokens = Math.round(Number(next?.maxTokens));
      const monthlyCap = Math.round(Number(next?.monthlyCap) * 100) / 100;
      if (!(maxTokens >= 200 && maxTokens <= 32000)) throw new Error("Answer length must be between 200 and 32,000 tokens.");
      if (!(monthlyCap >= 0 && monthlyCap <= 10000)) throw new Error("The monthly limit must be between 0 and 10,000 dollars. Use 0 to turn it off.");
      writeAtomic(settingsFile, JSON.stringify({ maxTokens, monthlyCap }));
    },
    spent() {
      try {
        const ledger = JSON.parse(fs.readFileSync(file(ledgerFile), "utf8"));
        return ledger.month === monthKey() && typeof ledger.cost === "number" ? ledger.cost : 0;
      } catch { return 0; }
    },
    addSpend(cost) {
      if (!(typeof cost === "number" && cost > 0 && cost < 1000)) return;
      try { writeAtomic(ledgerFile, JSON.stringify({ month: monthKey(), cost: store.spent() + cost })); } catch {}
    },
    async base() {
      return { connected: false, encrypted: await safeStorage.isAsyncEncryptionAvailable(), label: "", keyUsage: null,
        keyLimit: null, keyRemaining: null, monthSpend: store.spent(), ...store.limits() };
    },
    /** Throws before any request is made once this month's cap is reached. */
    checkCap() {
      const { monthlyCap } = store.limits();
      if (monthlyCap > 0 && store.spent() >= monthlyCap) {
        throw Object.assign(new Error(`You've reached your monthly limit of $${monthlyCap.toFixed(2)}. Raise it in Limits to keep asking.`), { code: "cap" });
      }
    },
  };
  return store;
}

/** Reads a server-sent event stream, calling onData with each parsed JSON payload. */
async function readEvents(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      // Lines starting with ":" are keep-alive comments; "event:" lines are redundant with each payload's type.
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") { onData(null); continue; }
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      onData(event);
    }
  }
}

// ── OpenRouter ─────────────────────────────────────────────────────────────────────────────
const OPENROUTER = "https://openrouter.ai/api/v1";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";
const openrouter = keyStore("openrouter");

async function openrouterStatus() {
  const base = await openrouter.base();
  const key = await openrouter.read();
  if (!key) return base;
  try {
    const response = await net.fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${key}` } });
    if (response.status === 401 || response.status === 403) { openrouter.clear(); return base; }
    if (response.ok) {
      const data = (await response.json()).data ?? {};
      const num = (v) => (typeof v === "number" ? v : null);
      return { ...base, connected: true, label: typeof data.label === "string" ? data.label : "",
        keyUsage: num(data.usage), keyLimit: num(data.limit), keyRemaining: num(data.limit_remaining) };
    }
  } catch {}
  return { ...base, connected: true }; // offline: keep the key, skip the live numbers
}

async function saveOpenRouterKey(raw) {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!/^sk-or-[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error("That doesn't look like an OpenRouter key. Keys start with sk-or-.");
  const check = await net.fetch(`${OPENROUTER}/key`, { headers: { Authorization: `Bearer ${key}` } });
  if (check.status === 401 || check.status === 403) throw new Error("OpenRouter rejected that key. Check that you copied all of it.");
  if (!check.ok) throw new Error(`Couldn't reach OpenRouter to check the key (${check.status}). Try again.`);
  await openrouter.write(key);
}

async function openrouterModels() {
  const response = await net.fetch(`${OPENROUTER}/models`);
  if (!response.ok) throw new Error(`Couldn't load OpenRouter models (${response.status}).`);
  const list = (await response.json()).data;
  if (!Array.isArray(list)) return [];
  const perMillion = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 1e8) / 100 : null; };
  return list
    .filter((m) => typeof m?.id === "string" && (!m.architecture?.output_modalities || m.architecture.output_modalities.includes("text")))
    .map((m) => ({ id: m.id, name: typeof m.name === "string" ? m.name : m.id,
      context: Number.isFinite(m.context_length) ? m.context_length : null,
      promptPrice: perMillion(m.pricing?.prompt), completionPrice: perMillion(m.pricing?.completion) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function openrouterError(status, body) {
  const detail = String(body?.error?.message ?? "").split("\n")[0].slice(0, 200);
  if (status === 401) return Object.assign(new Error("OpenRouter rejected your key. Add it again."), { code: "signed_out" });
  if (status === 402) return Object.assign(new Error("Your OpenRouter key or credit balance is used up. Raise the key's limit or add credit on OpenRouter."), { code: "usage_limit", link: OPENROUTER_KEYS_URL });
  if (status === 429) return new Error("OpenRouter is rate limiting this model. Wait a moment or pick another model.");
  if (status === 404) return new Error(detail || "OpenRouter doesn't have that model, or it isn't available to your key. Pick another model.");
  return new Error(detail || `OpenRouter couldn't answer${status ? ` (${status})` : ""}. Please try again.`);
}

async function askOpenRouter({ model, instructions, messages }, emit, signal) {
  if (!model) throw new Error("Pick a model first.");
  const key = await openrouter.read();
  if (!key) throw Object.assign(new Error("Add your OpenRouter key to ask questions."), { code: "signed_out" });
  openrouter.checkCap();
  const response = await net.fetch(`${OPENROUTER}/chat/completions`, {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "text/event-stream", "X-Title": "Readr" },
    body: JSON.stringify({
      model, stream: true, max_tokens: openrouter.limits().maxTokens, usage: { include: true },
      messages: [{ role: "system", content: instructions }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
    }),
  });
  if (!response.ok) {
    let body = null;
    try { body = await response.json(); } catch {}
    throw openrouterError(response.status, body);
  }
  let finished = false, cutShort = false, cost = 0;
  try {
    await readEvents(response, (event) => {
      if (event === null) { finished = true; return; }
      if (event.error) throw openrouterError(Number(event.error.code) || 0, event);
      const choice = event.choices?.[0];
      if (typeof choice?.delta?.content === "string" && choice.delta.content) emit(choice.delta.content);
      if (choice?.finish_reason === "length") cutShort = true;
      if (typeof event.usage?.cost === "number") cost = event.usage.cost;
    });
  } finally {
    openrouter.addSpend(cost); // counts a stopped answer too, when OpenRouter reported its cost
  }
  if (cutShort) emit("\n\n*The answer hit the length limit. Raise it in Limits if you want longer answers.*");
  if (!finished && !cutShort && !signal.aborted) throw new Error("The connection to OpenRouter ended early. Please try again.");
}

// ── Anthropic (Claude API, Haiku only) ─────────────────────────────────────────────────────
// Anthropic keys can't be restricted to a model, so the app pins every request to Haiku 5.5. The hard stop is the
// spend limit of the Console workspace the key belongs to.
const ANTHROPIC = "https://api.anthropic.com/v1";
const ANTHROPIC_LIMITS_URL = "https://platform.claude.com/settings/workspaces";
const ANTHROPIC_MODEL = "claude-haiku-5-5";
// Dollars per million tokens, from platform.claude.com/docs/en/about-claude/pricing (checked 31-10-2026). The higher
// rates apply to a whole request once its prompt is over 100,000 tokens.
const HAIKU_PRICES = { tierTokens: 100_000, low: { input: 0.1, output: 0.5 }, high: { input: 0.5, output: 2.5 } };
const anthropic = keyStore("anthropic");
const anthropicHeaders = (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" });

function haikuCost(inputTokens, outputTokens) {
  const rate = inputTokens > HAIKU_PRICES.tierTokens ? HAIKU_PRICES.high : HAIKU_PRICES.low;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1e6;
}

async function anthropicStatus() {
  const base = { ...(await anthropic.base()), model: ANTHROPIC_MODEL };
  const key = await anthropic.read();
  return key ? { ...base, connected: true } : base;
}

async function saveAnthropicKey(raw) {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) throw new Error("That doesn't look like an Anthropic API key. Keys start with sk-ant-.");
  // Looking up the model checks the key and that it can use Haiku 5.5, without spending anything.
  const check = await net.fetch(`${ANTHROPIC}/models/${ANTHROPIC_MODEL}`, { headers: anthropicHeaders(key) });
  if (check.status === 401 || check.status === 403) throw new Error("Anthropic rejected that key. Check that you copied all of it.");
  if (check.status === 404) throw new Error("That key can't use Claude Haiku 5.5.");
  if (!check.ok) throw new Error(`Couldn't reach Anthropic to check the key (${check.status}). Try again.`);
  await anthropic.write(key);
}

function anthropicError(status, body) {
  const type = String(body?.error?.type ?? "");
  const detail = String(body?.error?.message ?? "").split("\n")[0].slice(0, 200);
  if (status === 401 || type === "authentication_error") return Object.assign(new Error("Anthropic rejected your key. Add it again."), { code: "signed_out" });
  if (/credit balance|usage limit|spend limit|billing/i.test(detail) || type === "billing_error") {
    return Object.assign(new Error(`Anthropic stopped this request: ${detail || "your spend limit or credit is used up."}`), { code: "usage_limit", link: ANTHROPIC_LIMITS_URL });
  }
  if (status === 429 || type === "rate_limit_error") return new Error("Anthropic is rate limiting your key. Wait a moment and try again.");
  if (status === 529 || type === "overloaded_error") return new Error("Claude is busy right now. Please try again in a moment.");
  return new Error(detail || `Anthropic couldn't answer${status ? ` (${status})` : ""}. Please try again.`);
}

async function askAnthropic({ instructions, messages }, emit, signal) {
  const key = await anthropic.read();
  if (!key) throw Object.assign(new Error("Add your Anthropic API key to ask questions."), { code: "signed_out" });
  anthropic.checkCap();
  const response = await net.fetch(`${ANTHROPIC}/messages`, {
    method: "POST", signal,
    headers: { ...anthropicHeaders(key), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL, stream: true, max_tokens: anthropic.limits().maxTokens, system: instructions,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  if (!response.ok) {
    let body = null;
    try { body = await response.json(); } catch {}
    throw anthropicError(response.status, body);
  }
  let finished = false, cutShort = false, inputTokens = 0, outputTokens = 0, streamedChars = 0;
  try {
    await readEvents(response, (event) => {
      if (!event) return;
      if (event.type === "error") throw anthropicError(0, event);
      if (event.type === "message_start") {
        const u = event.message?.usage ?? {};
        inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        streamedChars += event.delta.text.length;
        emit(event.delta.text);
      } else if (event.type === "message_delta") {
        if (typeof event.usage?.output_tokens === "number") outputTokens = event.usage.output_tokens;
        if (event.delta?.stop_reason === "max_tokens") cutShort = true;
      } else if (event.type === "message_stop") {
        finished = true;
      }
    });
  } finally {
    // A stopped answer never gets its final token count, so estimate it from the text received. English runs about
    // 4 characters per token, so dividing by 3 errs on the high side rather than counting the answer as free.
    anthropic.addSpend(haikuCost(inputTokens, outputTokens || Math.ceil(streamedChars / 3)));
  }
  if (cutShort) emit("\n\n*The answer hit the length limit. Raise it in Limits if you want longer answers.*");
  if (!finished && !signal.aborted) throw new Error("The connection to Anthropic ended early. Please try again.");
}

// ── IPC surface ────────────────────────────────────────────────────────────────────────────
const active = new Map();
const MAX_CHARS = 1_500_000;

function validRequest(req) {
  return req && typeof req.id === "string" && req.id.length < 100 && ["chatgpt", "claude", "openrouter", "anthropic"].includes(req.provider)
    && typeof req.instructions === "string" && typeof req.model === "string" && req.model.length < 100
    && Array.isArray(req.messages) && req.messages.length > 0 && req.messages.length < 200
    && req.messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    && req.instructions.length + req.messages.reduce((n, m) => n + m.content.length, 0) < MAX_CHARS;
}

const MAX_ACTIVE = 2;

function register(handle, send) {
  cleanStaleClaudeFolders();
  handle("folio:ai-status", async () => ({ chatgpt: await chatgptStatus(), claude: await claudeStatus(),
    openrouter: await openrouterStatus(), anthropic: await anthropicStatus() }));
  // Shared by the API-key providers: the provider name picks the store, and anything else is refused.
  const keyed = { openrouter: { store: openrouter, save: saveOpenRouterKey, status: openrouterStatus },
    anthropic: { store: anthropic, save: saveAnthropicKey, status: anthropicStatus } };
  const pick = (name) => { const p = Object.hasOwn(keyed, name) ? keyed[name] : null; if (!p) throw new Error("Invalid provider"); return p; };
  handle("folio:ai-key-save", async (_event, name, key) => {
    const p = pick(name);
    try { await p.save(key); return { ok: true, status: await p.status() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle("folio:ai-key-clear", async (_event, name) => { const p = pick(name); p.store.clear(); return p.status(); });
  handle("folio:ai-key-limits", async (_event, name, next) => {
    const p = pick(name);
    try { p.store.setLimits(next); return { ok: true, status: await p.status() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle("folio:ai-openrouter-models", async () => {
    try { return { ok: true, models: await openrouterModels() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle("folio:ai-chatgpt-signin", async () => {
    try { return { ok: true, status: await signInChatGPT() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle("folio:ai-chatgpt-signout", () => signOutChatGPT());
  handle("folio:ai-chatgpt-welcome-seen", () => { saveHost({ ...loadHost(), welcomeSeen: true }); return true; });
  handle("folio:ai-chatgpt-models", async () => {
    try { return { ok: true, models: await chatgptModels() }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
  });
  let lastRecheck = 0;
  handle("folio:ai-claude-recheck", async () => {
    if (Date.now() - lastRecheck < 2000) return claudeStatus();
    lastRecheck = Date.now();
    claudePath = undefined;
    return claudeStatus(true);
  });
  handle("folio:ai-ask", (_event, req) => {
    if (!validRequest(req) || active.has(req.id)) throw new Error("Invalid request");
    if (active.size >= MAX_ACTIVE) throw new Error("Another answer is still in progress.");
    const controller = new AbortController();
    active.set(req.id, controller);
    const emit = (text) => send("folio:ai-event", { id: req.id, type: "delta", text });
    const ask = { chatgpt: askChatGPT, openrouter: askOpenRouter, anthropic: askAnthropic, claude: askClaude }[req.provider];
    Promise.resolve(ask(req, emit, controller.signal))
      .then(() => send("folio:ai-event", { id: req.id, type: "done" }))
      .catch((e) => send("folio:ai-event", controller.signal.aborted ? { id: req.id, type: "done" }
        : { id: req.id, type: "error", message: e.message || "Something went wrong.", code: e.code ?? "", link: e.link ?? "" }))
      .finally(() => active.delete(req.id));
    return true;
  });
  handle("folio:ai-cancel", (_event, id) => { active.get(id)?.abort(); return true; });
}

module.exports = { register };
