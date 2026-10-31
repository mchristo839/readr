// Tests the API-key providers in electron/ai.cjs (OpenRouter and Anthropic) against a fake local server: key checks,
// streaming, the Haiku pin, cost tracking at both price tiers, stopped answers, error mapping and spending caps.
// Runs in plain Node with Electron stubbed out: node scripts/test-ai-providers.cjs
const Module = require("node:module"), http = require("node:http"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keyed-"));
let mode = "ok", lastBody = null, lastHeaders = null, lastUrl = "";
const sse = (res, events) => { res.setHeader("content-type", "text/event-stream"); for (const e of events) res.write(e); res.end(); };
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    lastHeaders = req.headers; lastUrl = req.url;
    const json = (code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    // OpenRouter
    if (req.url === "/or/key") return json(200, { data: { label: "t", usage: 1.5, limit: 10, limit_remaining: 8.5 } });
    if (req.url === "/or/models") return json(200, { data: [{ id: "b/x", name: "X", context_length: 1000, pricing: { prompt: "0.0000001", completion: "0.0000004" }, architecture: { output_modalities: ["text"] } }, { id: "a/img", architecture: { output_modalities: ["image"] } }] });
    if (req.url === "/or/chat/completions") {
      lastBody = JSON.parse(b);
      if (mode === "402") return json(402, { error: { message: "no credit" } });
      return sse(res, [": OPENROUTER PROCESSING\n\n", 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        ...(mode === "midError" ? ['data: {"error":{"code":429,"message":"slow"}}\n\n'] :
        ['data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n', 'data: {"choices":[],"usage":{"cost":0.0123}}\n\n', "data: [DONE]\n\n"])]);
    }
    // Anthropic
    if (req.url.startsWith("/an/models/")) {
      if (req.headers["x-api-key"] === "sk-ant-api03-badbadbadbadbadbadbad") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      return req.url === "/an/models/claude-haiku-5-5" ? json(200, { id: "claude-haiku-5-5" }) : json(404, {});
    }
    if (req.url === "/an/messages") {
      lastBody = JSON.parse(b);
      if (mode === "an-credit") return json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
      if (mode === "an-401") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
      const inTok = mode === "an-big" ? 150000 : 1000;
      const start = `event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":${inTok},"output_tokens":1}}}\r\n\r\n`;
      const d = (t) => `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"${t}"}}\n\n`;
      if (mode === "an-hang") { res.setHeader("content-type", "text/event-stream"); res.write(start); res.write(d("partial answer text")); return; }
      if (mode === "an-overloaded") return sse(res, [start, d("Hi"), 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n']);
      return sse(res, [start, 'event: ping\ndata: {"type":"ping"}\n\n', d("Hel"), d("lo"),
        `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${mode === "an-max" ? "max_tokens" : "end_turn"}"},"usage":{"output_tokens":2000}}\n\n`,
        'event: message_stop\ndata: {"type":"message_stop"}\n\n']);
    }
    json(404, {});
  });
});
server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const orig = Module._load;
  Module._load = function (name, ...a) {
    if (name === "electron") return {
      app: { getPath: () => tmp },
      net: { fetch: (url, init) => fetch(String(url).replace("https://openrouter.ai/api/v1", base + "/or").replace("https://api.anthropic.com/v1", base + "/an"), init) },
      safeStorage: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s) => Buffer.from("enc:" + s), decryptStringAsync: async (b) => ({ result: b.toString().slice(4) }) },
      shell: {},
    };
    return orig.call(this, name, ...a);
  };
  const ai = require(process.argv[2] || path.join(__dirname, "..", "electron", "ai.cjs"));
  const H = {}; const events = []; let fails = 0;
  ai.register((ch, fn) => (H[ch] = fn), (ch, ev) => events.push(ev));
  const t = (n, ok) => { if (!ok) fails++; console.log((ok ? "PASS " : "FAIL ") + n); };
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const ask = async (id, provider, model = "b/x", wait = 300, cancelAfter) => {
    await H["folio:ai-ask"]({}, { id, provider, model, instructions: "sys", messages: [{ role: "user", content: "hi" }] });
    if (cancelAfter) { await new Promise((r) => setTimeout(r, cancelAfter)); await H["folio:ai-cancel"]({}, id); }
    await new Promise((r) => setTimeout(r, wait)); return events.filter((e) => e.id === id);
  };
  const text = (ev) => ev.filter((e) => e.type === "delta").map((e) => e.text).join("");
  const spent = async (p) => (await H["folio:ai-status"]())[p].monthSpend;

  // ── OpenRouter (regression after the refactor)
  t("OR rejects malformed key", !(await H["folio:ai-key-save"]({}, "openrouter", "nope")).ok);
  const good = await H["folio:ai-key-save"]({}, "openrouter", "sk-or-v1-abcdefghijklmnop1234");
  t("OR saves key and reads its limit", good.ok && good.status.connected && good.status.keyLimit === 10);
  const models = await H["folio:ai-openrouter-models"]();
  t("OR models filtered to text, priced per million", models.models.length === 1 && models.models[0].promptPrice === 0.1);
  let ev = await ask("o1", "openrouter");
  t("OR streams and finishes", text(ev) === "Hello" && ev.at(-1).type === "done");
  t("OR sends system message, max_tokens, usage", lastBody.messages[0].role === "system" && lastBody.max_tokens === 2000 && lastBody.usage.include === true);
  t("OR records reported cost", near(await spent("openrouter"), 0.0123));
  t("OR saves limits", (await H["folio:ai-key-limits"]({}, "openrouter", { maxTokens: 500, monthlyCap: 0.01 })).ok);
  ev = await ask("o2", "openrouter");
  t("OR blocks at monthly cap", ev.at(-1).code === "cap");
  t("rejects out-of-range limits", !(await H["folio:ai-key-limits"]({}, "openrouter", { maxTokens: 5, monthlyCap: 1 })).ok);
  await H["folio:ai-key-limits"]({}, "openrouter", { maxTokens: 2000, monthlyCap: 0 });
  mode = "402"; ev = await ask("o3", "openrouter");
  t("OR 402 maps to usage_limit", ev.at(-1).code === "usage_limit");
  mode = "midError"; ev = await ask("o4", "openrouter");
  t("OR mid-stream error surfaces", ev.at(-1).type === "error");
  let threw = false; try { await H["folio:ai-key-save"]({}, "__proto__", "x"); } catch { threw = true; }
  t("unknown provider name refused", threw);

  // ── Anthropic
  mode = "ok";
  t("AN starts disconnected, pinned to Haiku 5.5", (await H["folio:ai-status"]()).anthropic.connected === false && (await H["folio:ai-status"]()).anthropic.model === "claude-haiku-5-5");
  t("AN rejects malformed key", !(await H["folio:ai-key-save"]({}, "anthropic", "sk-or-v1-abcdefghijklmnop1234")).ok);
  const bad = await H["folio:ai-key-save"]({}, "anthropic", "sk-ant-api03-badbadbadbadbadbadbad");
  t("AN rejected key not saved", !bad.ok && /rejected/.test(bad.error) && !fs.existsSync(path.join(tmp, "ai", "anthropic-key.bin")));
  const ok = await H["folio:ai-key-save"]({}, "anthropic", "sk-ant-api03-goodgoodgoodgoodgood123");
  t("AN key checked against the Haiku model and saved", ok.ok && ok.status.connected && lastUrl === "/an/models/claude-haiku-5-5");
  t("AN key stored encrypted, separate from OpenRouter", fs.readFileSync(path.join(tmp, "ai", "anthropic-key.bin"), "utf8").startsWith("enc:"));
  ev = await ask("a1", "anthropic", "claude-opus-5-5");
  t("AN streams text and finishes (CRLF + ping handled)", text(ev) === "Hello" && ev.at(-1).type === "done");
  t("AN request pinned to Haiku even if another model is asked for", lastBody.model === "claude-haiku-5-5");
  t("AN uses x-api-key, version header, system field", lastHeaders["x-api-key"].startsWith("sk-ant-") && lastHeaders["anthropic-version"] === "2023-06-01" && lastBody.system === "sys" && lastBody.max_tokens === 2000);
  t("AN cost at standard tier: 1000 in + 2000 out = $0.0011", near(await spent("anthropic"), (1000 * 0.1 + 2000 * 0.5) / 1e6));
  t("AN spend kept apart from OpenRouter", near(await spent("openrouter"), 0.0123));
  mode = "an-big"; const before = await spent("anthropic"); await ask("a2", "anthropic");
  t("AN long-prompt tier: 150k in + 2000 out = $0.08", near((await spent("anthropic")) - before, (150000 * 0.5 + 2000 * 2.5) / 1e6));
  mode = "an-max"; ev = await ask("a3", "anthropic");
  t("AN max_tokens stop adds the length note", /length limit/.test(text(ev)) && ev.at(-1).type === "done");
  mode = "an-hang"; const b2 = await spent("anthropic"); ev = await ask("a4", "anthropic", "", 300, 200);
  t("AN stopped answer ends cleanly and is still charged", ev.at(-1).type === "done" && (await spent("anthropic")) - b2 > (1000 * 0.1) / 1e6);
  mode = "an-overloaded"; ev = await ask("a5", "anthropic");
  t("AN mid-stream overloaded error surfaces", ev.at(-1).type === "error" && /busy/.test(ev.at(-1).message));
  mode = "an-credit"; ev = await ask("a6", "anthropic");
  t("AN low credit maps to usage_limit with Console link", ev.at(-1).code === "usage_limit" && /platform\.claude\.com/.test(ev.at(-1).link));
  mode = "an-401"; ev = await ask("a7", "anthropic");
  t("AN 401 maps to signed_out", ev.at(-1).code === "signed_out");
  mode = "ok";
  await H["folio:ai-key-limits"]({}, "anthropic", { maxTokens: 800, monthlyCap: 0.01 });
  ev = await ask("a8", "anthropic");
  t("AN blocks at monthly cap without calling the API", ev.at(-1).code === "cap");
  await H["folio:ai-key-limits"]({}, "anthropic", { maxTokens: 800, monthlyCap: 0 }); await ask("a9", "anthropic");
  t("AN answer length limit applied", lastBody.max_tokens === 800);
  const cleared = await H["folio:ai-key-clear"]({}, "anthropic");
  t("AN remove key disconnects, OpenRouter untouched", !cleared.connected && (await H["folio:ai-status"]()).openrouter.connected);
  console.log(fails ? `${fails} FAILED` : "ALL PASSED");
  server.close(); process.exit(fails ? 1 : 0);
});
