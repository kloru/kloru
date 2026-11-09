/**
 * One chat completion on OpenRouter, for the small model calls Kloru makes itself (fast path,
 * decisions, the after-call email, steering), always to zero-data-retention providers. A 429 or 5xx is tried once more after Retry-After,
 * capped at maxWaitMs, since a caller may be waiting (#22). Returns the message text.
 */
export interface ChatOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

export async function chatCompletion(o: ChatOptions, body: Record<string, unknown>): Promise<string> {
  return (await chatMessage(o, body)).content?.trim() ?? "";
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The whole reply message, for tool-using loops: its text and any tool calls. */
export async function chatMessage(o: ChatOptions, body: Record<string, unknown>): Promise<{ content?: string; tool_calls?: ToolCall[] }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const res = await (o.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      ...(o.timeoutMs ? { signal: AbortSignal.timeout(o.timeoutMs) } : {}),
      // Family data: zero-data-retention providers only.
      body: JSON.stringify({ ...body, provider: { ...(body.provider as Record<string, unknown> | undefined), zdr: true } }),
    });
    if (res.ok) {
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }> };
      return data.choices?.[0]?.message ?? {};
    }
    if (attempt > 0 || !RETRYABLE(res.status)) throw new Error(`model ${res.status}`);
    const after = Number(res.headers.get("Retry-After"));
    await sleep(Math.min(o.maxWaitMs ?? 2000, Number.isFinite(after) && after > 0 ? after * 1000 : 500));
  }
}
