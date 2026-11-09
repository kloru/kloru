/**
 * Whether something a person told Kloru to remember is about how they want Kloru to work ("be more
 * concise", "text me, don't email"), as a yes/no on Jev (decision-models skill). Yes: it goes into
 * their guidelines at once, which every agent is given.
 */
const URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.14";

export function guidelineCheck(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (text: string) => Promise<boolean> {
  return async (text) => {
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({
        model: o.model ?? MODEL,
        provider: { zdr: true },
        state: { what_they_said: text },
        questions: {
          guideline: {
            type: "noul",
            instructions: "Is this about how they want their assistant to work for them from now on (how it writes, which channel it uses, what it asks first, what to do or avoid), rather than a fact about them, their people or their plans?",
            criteria: { true: "A standing instruction for the assistant: be concise, text me, don't email, always ask before X, stop doing Y.", false: "A fact or a one-time request: a birthday, a routine, a plan, a person, something to do once." },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const a = ((await res.json()) as { answers?: Record<string, { type?: string; noul?: unknown }> }).answers?.guideline;
    if (a?.type !== "noul" || typeof a.noul !== "number") throw new Error("no answer from the decision model");
    return a.noul >= 0.5;
  };
}
