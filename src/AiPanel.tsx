import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import type { PDFDocumentProxy } from "./pdf";
import { getAiHistory, saveAiHistory } from "./recent";
import { CLAUDE_CODE_URL, dollars, OPENROUTER_ACTIVITY_URL, OPENROUTER_DEFAULT_MODEL, OPENROUTER_KEYS_URL, signInChatGPT, USAGE_URL, type AiProvider } from "./ai";

const AiMarkdown = lazy(() => import("./AiMarkdown").then((module) => ({ default: module.AiMarkdown })));

export interface AiContext {
  text: string;
  page: number;
}

interface Message extends AiMessage {
  context?: AiContext;
  error?: { message: string; code?: string; link?: string };
}

const MAX_DOC_CHARS = 400_000;
const CLAUDE_MODELS = [
  { id: "", name: "Default model" },
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];

const savedModel = (provider: AiProvider) =>
  localStorage.getItem(`folio:ai-model:${provider}`) || (provider === "openrouter" ? OPENROUTER_DEFAULT_MODEL : "");

// ── Document text ───────────────────────────────────────────────────────────────────────
const textCache = new WeakMap<PDFDocumentProxy, Promise<{ text: string; truncated: boolean }>>();

function documentText(pdf: PDFDocumentProxy) {
  let cached = textCache.get(pdf);
  if (!cached) {
    cached = (async () => {
      let text = "";
      let truncated = false;
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        const page = content.items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "")).join("")
          .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        const block = `[Page ${n}]\n${page}\n\n`;
        if (text.length + block.length > MAX_DOC_CHARS) {
          truncated = true;
          break;
        }
        text += block;
      }
      return { text, truncated };
    })();
    textCache.set(pdf, cached);
  }
  return cached;
}

function instructions(name: string, doc: { text: string; truncated: boolean }) {
  const hasText = doc.text.replace(/\[Page \d+\]/g, "").trim().length > 0;
  return [
    `You are the reading assistant in Readr, a PDF reader. The user is reading "${name}".`,
    hasText
      ? `Its extracted text is below between <document> tags, with [Page N] markers.${doc.truncated ? " The document is long, so only the beginning is included; say so if a question may depend on later pages." : ""}`
      : "This PDF has no extractable text (it may be scanned images), so you can only answer from the passages the user quotes.",
    "Guidelines:",
    "- Answer from the document. If it doesn't contain the answer, say so plainly; you may add general knowledge if it helps, clearly labeled as such.",
    "- Cite page numbers like (p. 12) when you use specific information from the document.",
    "- When the user quotes a passage, focus on that passage and use the rest of the document as context.",
    "- Be concise. Use short paragraphs, and bullet lists where they help. Use light Markdown: **bold**, lists, and `code`.",
    "- Write mathematical notation in LaTeX: \\( ... \\) for inline math and \\[ ... \\] for display equations. Do not put equations in code blocks.",
    "",
    hasText ? `<document>\n${doc.text}</document>` : "",
  ].join("\n");
}

// ── Panel ─────────────────────────────────────────────────────────────────────────────────
const conversations = new Map<string, Message[]>();

interface Props {
  pdf: PDFDocumentProxy;
  docId: string;
  /** Save the conversation with the document (off for password-protected documents). */
  persist: boolean;
  docName: string;
  context: AiContext | null;
  onClearContext: () => void;
  onGoToPage: (n: number) => void;
  onClose: () => void;
}

export function AiPanel({ pdf, docId, persist, docName, context, onClearContext, onGoToPage, onClose }: Props) {
  const ai = window.folioDesktop?.ai;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [provider, setProviderState] = useState<AiProvider>(() => (localStorage.getItem("folio:ai-provider") as AiProvider) || "openrouter");
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [orModels, setOrModels] = useState<OpenRouterModel[]>([]);
  const [model, setModelState] = useState(() => savedModel(provider));
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [capInput, setCapInput] = useState("");
  const [tokensInput, setTokensInput] = useState("");
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const [messages, setMessages] = useState<Message[]>(() => conversations.get(docId) ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The panel is mounted per document (keyed by docId in App), so this conversation always belongs to docId.
  const [loaded, setLoaded] = useState(() => conversations.has(docId) || !persist);
  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    void getAiHistory(docId).then((saved) => {
      if (cancelled) return;
      if (saved.length) setMessages(saved);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [docId, loaded]);
  useEffect(() => {
    if (!loaded) return;
    conversations.set(docId, messages);
    // Save once an answer has finished (not on every streamed word); failed answers aren't kept.
    if (persist && !busy) {
      void saveAiHistory(docId, messages.filter((m) => !m.error && m.content).map(({ role, content, context }) => ({ role, content, ...(context ? { context } : {}) })));
    }
  }, [docId, messages, busy, loaded, persist]);
  useEffect(() => { void ai?.status().then(setStatus); }, [ai]);
  useEffect(() => { if (context) inputRef.current?.focus(); }, [context]);

  const setProvider = (next: AiProvider) => {
    setProviderState(next);
    localStorage.setItem("folio:ai-provider", next);
    setModelState(savedModel(next));
    setSetupError(null);
    setShowLimits(false);
  };
  const setModel = (id: string) => {
    setModelState(id);
    localStorage.setItem(`folio:ai-model:${provider}`, id);
  };

  // ChatGPT's model list depends on the signed-in account.
  const chatgptConnected = !!status?.chatgpt.connected;
  useEffect(() => {
    if (!ai || provider !== "chatgpt" || !chatgptConnected) return;
    void ai.chatgptModels().then((result) => {
      if (!result.ok) {
        if (result.code === "signed_out") void ai.status().then(setStatus);
        setSetupError(result.error ?? null);
        return;
      }
      const list = result.models ?? [];
      setModels(list);
      setModelState((current) => (list.some((m) => m.id === current) ? current : list[0]?.id ?? ""));
    });
  }, [ai, provider, chatgptConnected]);

  // OpenRouter's model list is public. It feeds the model box's suggestions and the price shown for the chosen model.
  const orConnected = !!status?.openrouter.connected;
  useEffect(() => {
    if (!ai || provider !== "openrouter" || !orConnected) return;
    void ai.openrouterModels().then((result) => {
      if (result.ok) setOrModels(result.models ?? []);
    });
  }, [ai, provider, orConnected]);

  const saveKey = async () => {
    if (!ai || savingKey) return;
    setSavingKey(true);
    setSetupError(null);
    const result = await ai.saveOpenRouterKey(keyInput);
    setSavingKey(false);
    if (result.ok && result.status) {
      setKeyInput("");
      setStatus((s) => (s ? { ...s, openrouter: result.status! } : s));
    } else {
      setSetupError(result.error ?? "Couldn't save the key.");
    }
  };
  const openLimits = () => {
    const or = status?.openrouter;
    if (or) { setCapInput(String(or.monthlyCap)); setTokensInput(String(or.maxTokens)); }
    setSetupError(null);
    setShowLimits((v) => !v);
  };
  const saveLimits = async () => {
    if (!ai) return;
    const result = await ai.setOpenRouterSettings({ maxTokens: Number(tokensInput), monthlyCap: Number(capInput) });
    if (result.ok && result.status) {
      setStatus((s) => (s ? { ...s, openrouter: result.status! } : s));
      setSetupError(null);
      setShowLimits(false);
    } else {
      setSetupError(result.error ?? "Couldn't save the limits.");
    }
  };
  const removeKey = async () => {
    if (!ai) return;
    const next = await ai.clearOpenRouterKey();
    setStatus((s) => (s ? { ...s, openrouter: next } : s));
    setShowLimits(false);
  };

  // Stream answers into the last assistant message.
  useEffect(() => {
    if (!ai) return;
    return ai.onEvent((event) => {
      if (event.id !== busyRef.current) return;
      setMessages((list) => {
        const next = list.slice();
        const last = next[next.length - 1];
        if (!last || last.role !== "assistant") return list;
        if (event.type === "delta") next[next.length - 1] = { ...last, content: last.content + (event.text ?? "") };
        if (event.type === "error") next[next.length - 1] = { ...last, error: { message: event.message ?? "Something went wrong.", code: event.code, link: event.link } };
        return next;
      });
      if (event.type !== "delta") {
        busyRef.current = null;
        setBusy(null);
        // OpenRouter reports what an answer cost, so refresh the spend shown under the composer.
        if (event.code === "signed_out" || providerRef.current === "openrouter") void ai.status().then(setStatus);
      }
    });
  }, [ai]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const ready = provider === "chatgpt" ? chatgptConnected
    : provider === "openrouter" ? orConnected
    : !!status?.claude.installed && status.claude.loggedIn;

  const send = useCallback(async (question: string) => {
    if (!ai || !question.trim() || busyRef.current || !ready) return;
    const doc = await documentText(pdf);
    const userContent = context
      ? `About this passage from page ${context.page}:\n"""\n${context.text}\n"""\n\n${question.trim()}`
      : question.trim();
    const history: Message[] = [...messages.filter((m) => !m.error && m.content), { role: "user", content: userContent }];
    const id = crypto.randomUUID();
    busyRef.current = id;
    setBusy(id);
    setMessages([...messages, { role: "user", content: question.trim(), context: context ?? undefined }, { role: "assistant", content: "" }]);
    setInput("");
    onClearContext();
    try {
      await ai.ask({ id, provider, model, instructions: instructions(docName, doc), messages: history.map(({ role, content }) => ({ role, content })) });
    } catch {
      busyRef.current = null;
      setBusy(null);
      setMessages((list) => {
        const next = list.slice();
        next[next.length - 1] = { role: "assistant", content: "", error: { message: "Readr couldn't send that question." } };
        return next;
      });
    }
  }, [ai, pdf, context, messages, provider, model, docName, onClearContext, ready]);

  const signIn = async () => {
    if (!ai) return;
    setSigningIn(true);
    setSetupError(null);
    const result = await signInChatGPT(ai);
    setSigningIn(false);
    setSetupError(result.error);
    setStatus(result.status);
  };

  const placeholder = !ready ? "Connect an AI provider to ask questions"
    : context ? "Ask about the selected passage…" : "Ask about this document…";

  return (
    <aside className="ai-panel" aria-label="Ask AI">
      <header className="ai-head">
        <div className="ai-title"><Icon name="sparkle" size={16} /> Ask AI</div>
        <div className="segmented small" role="tablist" aria-label="AI provider">
          <button role="tab" aria-selected={provider === "openrouter"} className={provider === "openrouter" ? "on" : ""} onClick={() => setProvider("openrouter")}>OpenRouter</button>
          <button role="tab" aria-selected={provider === "chatgpt"} className={provider === "chatgpt" ? "on" : ""} onClick={() => setProvider("chatgpt")}>ChatGPT</button>
          <button role="tab" aria-selected={provider === "claude"} className={provider === "claude" ? "on" : ""} onClick={() => setProvider("claude")}>Claude</button>
        </div>
        <div className="ai-head-actions">
          <button className="pill-btn" title="New conversation" aria-label="New conversation" disabled={!messages.length || !!busy} onClick={() => setMessages([])}>
            <Icon name="plus" size={15} />
          </button>
          <button className="pill-btn" title="Close" aria-label="Close Ask AI" onClick={onClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      <div className="ai-body" ref={listRef}>
        {!ai ? (
          <div className="ai-card"><p>Ask AI is available in the Readr desktop app.</p></div>
        ) : !status ? (
          <p className="ai-checking">Checking connections…</p>
        ) : provider === "openrouter" && !orConnected ? (
          <div className="ai-card">
            <h3>Use your OpenRouter key</h3>
            <p>Paste an OpenRouter API key to ask questions with any model. Set a credit limit on the key at OpenRouter, and it can never cost more than you allow.</p>
            <form className="ai-key-form" onSubmit={(e) => { e.preventDefault(); void saveKey(); }}>
              <input type="password" autoComplete="off" spellCheck={false} value={keyInput} placeholder="sk-or-…"
                aria-label="OpenRouter API key" onChange={(e) => setKeyInput(e.target.value)} />
              <button className="btn primary" type="submit" disabled={savingKey || !keyInput.trim()}>{savingKey ? "Checking…" : "Save key"}</button>
            </form>
            <div className="ai-card-actions">
              <a className="btn ghost" href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">Create or limit a key</a>
            </div>
            <p className="fine">
              The key is stored encrypted on this computer and never reaches the page. When you ask, your question and the document's text go to OpenRouter and the model you pick.
              {!status.openrouter.encrypted && " This system has no secret store, so you'll need to add the key again each time the app starts."}
            </p>
          </div>
        ) : provider === "chatgpt" && !chatgptConnected ? (
          <div className="ai-card">
            <h3>Use your ChatGPT plan</h3>
            <p>Sign in with ChatGPT to ask questions using your existing ChatGPT plan (Go, Plus, or Pro). No API key needed.</p>
            <button className="btn primary chatgpt-btn" onClick={signIn} disabled={signingIn}>
              {signingIn ? "Waiting for your browser…" : "Continue with ChatGPT"}
            </button>
            {signingIn && <p className="fine">Finish signing in in your browser, then come back here.</p>}
            <p className="fine">When you ask, Readr sends your question and the document's text to OpenAI. Nothing is sent otherwise.</p>
          </div>
        ) : provider === "claude" && !(status.claude.installed && status.claude.loggedIn) ? (
          <div className="ai-card">
            <h3>Use your Claude subscription</h3>
            {!status.claude.installed ? (
              <p>Readr uses Claude Code, Anthropic's official app, signed in with your own Claude Pro or Max account. Install Claude Code, sign in once, then check again.</p>
            ) : (
              <p>Claude Code is installed but not signed in. Open a terminal, run <code>claude</code>, and sign in with your Claude account.</p>
            )}
            <div className="ai-card-actions">
              {!status.claude.installed && <a className="btn ghost" href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">Get Claude Code</a>}
              <button className="btn primary" onClick={async () => setStatus({ ...status, claude: await ai.recheckClaude() })}>Check again</button>
            </div>
            <p className="fine">Readr never sees your Claude password or tokens. When you ask, it sends your question and the document's text to Anthropic through Claude Code.</p>
          </div>
        ) : (
          <>
            {provider === "openrouter" && showLimits && (
              <div className="ai-card ai-limits">
                <h3>Spending limits</h3>
                <label>Monthly limit in this app, in dollars (0 turns it off)
                  <input type="number" min="0" max="10000" step="0.5" value={capInput} onChange={(e) => setCapInput(e.target.value)} />
                </label>
                <label>Longest answer, in tokens
                  <input type="number" min="200" max="32000" step="100" value={tokensInput} onChange={(e) => setTokensInput(e.target.value)} />
                </label>
                <p className="fine">
                  {status.openrouter.keyLimit !== null
                    ? `This key has used ${dollars(status.openrouter.keyUsage ?? 0)} of its ${dollars(status.openrouter.keyLimit)} limit on OpenRouter. `
                    : "This key has no credit limit on OpenRouter. Set one there as a hard stop. "}
                  <a href={OPENROUTER_KEYS_URL} target="_blank" rel="noreferrer">Key settings</a> · <a href={OPENROUTER_ACTIVITY_URL} target="_blank" rel="noreferrer">Activity</a>
                </p>
                <div className="ai-card-actions">
                  <button className="btn ghost" onClick={() => void removeKey()}>Remove key</button>
                  <button className="btn primary" onClick={() => void saveLimits()}>Save</button>
                </div>
              </div>
            )}
            {provider === "chatgpt" && !status.chatgpt.welcomeSeen && (
              <div className="ai-card ai-welcome">
                <p><strong>You're connected{status.chatgpt.email ? ` as ${status.chatgpt.email}` : ""}.</strong> Questions you ask in Readr use your ChatGPT plan. You can manage usage in ChatGPT settings.</p>
                <div className="ai-card-actions">
                  <a className="btn ghost" href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                  <button className="btn primary" onClick={async () => { await ai.chatgptWelcomeSeen(); setStatus(await ai.status()); }}>Got it</button>
                </div>
              </div>
            )}
            {messages.length === 0 && (
              <div className="ai-empty">
                <p>Ask anything about <strong>{docName.replace(/\.pdf$/i, "")}</strong>, or select text in the document and choose <em>Ask AI</em>.</p>
                <div className="suggestions">
                  {(context ? ["Explain this in simple terms", "Why does this matter?", "Summarize this passage"]
                    : ["Summarize this document", "What are the key takeaways?", "What questions does this leave open?"]).map((q) => (
                    <button key={q} className="suggestion" onClick={() => void send(q)}>{q}</button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "user" ? (
                  <>
                    {m.context && <blockquote>p. {m.context.page}: {m.context.text.length > 220 ? m.context.text.slice(0, 220) + "…" : m.context.text}</blockquote>}
                    <p>{m.content}</p>
                  </>
                ) : m.error ? (
                  <div className="msg-error">
                    <p>{m.error.message}</p>
                    {m.error.code === "usage_limit" && provider === "chatgpt" && (
                      <a className="btn primary" href={m.error.link || USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>
                    )}
                    {(m.error.code === "usage_limit" || m.error.code === "cap") && provider === "openrouter" && (
                      <button className="btn primary" onClick={openLimits}>Spending limits</button>
                    )}
                    {m.error.code === "signed_out" && provider === "chatgpt" && (
                      <button className="btn primary" onClick={signIn}>Continue with ChatGPT</button>
                    )}
                  </div>
                ) : m.content ? (
                  <Suspense fallback={<p style={{ whiteSpace: "pre-wrap" }}>{m.content}</p>}>
                    <AiMarkdown text={m.content} onPage={onGoToPage} />
                  </Suspense>
                ) : (
                  <div className="typing" aria-label="Thinking"><span /><span /><span /></div>
                )}
              </div>
            ))}
          </>
        )}
        {setupError && <div className="msg-error"><p>{setupError}</p></div>}
      </div>

      <footer className="ai-foot">
        {context && (
          <div className="context-chip">
            <span>p. {context.page}: “{context.text.length > 90 ? context.text.slice(0, 90) + "…" : context.text}”</span>
            <button onClick={onClearContext} aria-label="Ask about the whole document instead" title="Ask about the whole document instead">
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            rows={2}
            disabled={!ready}
            placeholder={placeholder}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          {busy ? (
            <button type="button" className="send-btn" onClick={() => void ai?.cancel(busy)} title="Stop" aria-label="Stop">
              <Icon name="stop" size={15} />
            </button>
          ) : (
            <button type="submit" className="send-btn" disabled={!ready || !input.trim()} title="Send (Enter)" aria-label="Send">
              <Icon name="send" size={16} />
            </button>
          )}
        </form>
        {ready && (
          <div className="ai-meta">
            {provider === "openrouter" ? (
              <>
                <input className="or-model" list="or-models" value={model} spellCheck={false} aria-label="Model"
                  title={(() => {
                    const m = orModels.find((o) => o.id === model);
                    return m && m.promptPrice !== null && m.completionPrice !== null
                      ? `${m.name}: ${dollars(m.promptPrice)} in, ${dollars(m.completionPrice)} out per 1M tokens`
                      : "Type or pick an OpenRouter model id, like openai/gpt-4o-mini";
                  })()}
                  onChange={(e) => setModel(e.target.value.trim())} />
                <datalist id="or-models">
                  {orModels.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </datalist>
              </>
            ) : (
              <select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model">
                {(provider === "chatgpt" ? models : CLAUDE_MODELS).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            {provider === "openrouter" ? (
              <span>
                {dollars(status?.openrouter.monthSpend ?? 0)}{status && status.openrouter.monthlyCap > 0 ? ` of ${dollars(status.openrouter.monthlyCap)}` : ""} this month ·{" "}
                <button type="button" className="link-btn" onClick={openLimits}>Limits</button>
              </span>
            ) : provider === "chatgpt" ? (
              <span>Using ChatGPT plan · <a href={USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a></span>
            ) : (
              <span>{status?.claude.subscription ? "Using your Claude subscription via Claude Code" : "Using Claude Code"}</span>
            )}
          </div>
        )}
      </footer>
    </aside>
  );
}
