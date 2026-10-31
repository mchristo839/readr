// Shared by the Ask AI panel and Settings: the providers' pages, and the ChatGPT sign-in flow.
export type AiProvider = "chatgpt" | "claude" | "openrouter";

export const USAGE_URL = "https://chatgpt.com/settings/usage";
export const CLAUDE_CODE_URL = "https://claude.com/claude-code";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/settings/keys";
export const OPENROUTER_ACTIVITY_URL = "https://openrouter.ai/activity";
/** Cheap, long-context and long-lived, so a new install works before a model is picked. */
export const OPENROUTER_DEFAULT_MODEL = "openai/gpt-4o-mini";

/** Runs the ChatGPT sign-in (it opens the browser); resolves once it's over with the refreshed status. */
export async function signInChatGPT(ai: MarginaliaAi): Promise<{ status: AiStatus; error: string | null }> {
  const result = await ai.signInChatGPT();
  return { status: await ai.status(), error: result.ok ? null : result.error ?? "ChatGPT sign-in failed." };
}

export const dollars = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
