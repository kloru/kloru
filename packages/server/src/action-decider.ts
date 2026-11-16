/**
 * Weighs a change before a worker makes it (decision-models skill): do, ask or revise. Biased
 * toward doing: a draft or a question costs the caller too. Only a realistic, serious downside
 * earns a question.
 *
 * Jev, TypeSafe's structured decision model, looks first (~0.3 s) and writes no words. A "do" it is
 * sure of goes ahead. Anything else needs words (the question the caller hears, what to change),
 * so the writing model decides it and writes them (~3.5 s, three quarters of it thinking; with its
 * thinking off it is ~1.8 s and lets through one or two of the eval's asks every run).
 * Measured 2026-11-15 on the live eval: 23/23 either way, the clear ones in ~0.3 s.
 */
import type { ActionCheck, ActionDecision } from "@kloru/desk";
import { chatCompletion } from "./openrouter.js";

// Measured 2026-10-29 on the live eval: Flash 15/15 every run (~3 s); Flash Lite 13-14/15 (~1.2 s).
const MODEL = "google/gemini-3.5-flash";

const FAST_URL = "https://openrouter.ai/api/alpha/decisions";
const FAST_MODEL = "typesafe/jev-1.14";
/** A "do" Jev is less sure of than this is weighed again by the writing model: a wrong "do" can't be taken back. */
const SURE_DO = 0.8;

const CHOICES = {
  do: "Go ahead: the caller asked for this action (or one it's a clear part of), or its worst realistic outcome doesn't hurt them. An email or an event for the caller themselves, sending what they asked to the person they named, deleting obvious promos.",
  ask: "Ask the caller first: they didn't ask for this, and the worst realistic outcome is serious: it reaches someone who shouldn't see it, puts something public under their name, embarrasses them, spends money they didn't mean to, or can't be undone. Contacting a business when they asked for research, ordering when they asked what's good, a public repo or site in their account to hold an app they asked for.",
  revise: "The action is right, but part of it could hurt them and should change first.",
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reaches", "reversible", "worst_case", "asked_for", "decision", "reason", "ask", "fix"],
  properties: {
    reaches: { type: "string", description: "who sees or is affected by this, and how close they are to the caller" },
    reversible: { type: "boolean" },
    worst_case: { type: "string", description: "the worst realistic outcome for the caller if this goes ahead" },
    asked_for: { type: "boolean", description: "the caller asked for this action (or one it's a clear part of)" },
    decision: { type: "string", enum: ["do", "ask", "revise", "ask_owner"] },
    reason: { type: "string", description: "one short sentence" },
    ask: { type: "string", description: "for ask: the one question the caller hears; else empty" },
    fix: { type: "string", description: "for revise: what to change; else empty" },
  },
};

export const DECIDE_PROMPT = `You decide whether Kloru, a family's assistant, takes an action now. Lean hard toward doing it.
Ask yourself: what happens if I do this, and what happens if I don't?
- Not doing it has a cost: a draft or a question means the caller does the work.
- Doing it only costs something if the worst realistic outcome hurts them: it reaches someone who shouldn't see it, puts something public under their name, embarrasses them, spends money they didn't mean to, or can't be undone.
- If the caller asked for this action, that's their yes; how Kloru planned the work isn't. Asking to find, research or recommend something isn't asking to contact anyone, buy it, or delete what isn't clearly what they meant. Their guidelines win over these.
do: go ahead. ask: only when the worst case is serious and they didn't ask for this; write one short spoken question. revise: the action is right but part of it could hurt them; say what to change.
ask_owner: the caller isn't the family owner and the owner's words for them don't plainly allow this; booking a new meeting isn't moving or removing his.
Examples: an email to the caller: do. Sending the report the caller asked for to their wife: do. Deleting obvious promos: do; a bank statement while cleaning promos: ask. Ordering dinner when they asked what's good: ask. A public repo or site in their account to hold an app they asked for: ask. An email to their boss that mentions a job search: revise or ask.`;

export function actionDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; /** "off": the writing model decides every one. */ fastModel?: string; fastTimeoutMs?: number; sureDo?: number; log?: (m: string) => void }): (c: ActionCheck) => Promise<ActionDecision> {
  return async (c) => {
    // The owner's words about someone else are the writing model's to read: Jev let a stranger move his meetings.
    if (o.fastModel !== "off" && c.ownerGuidelines === undefined) {
      try {
        const sure = await fastDo(o, c);
        if (sure !== undefined && sure >= (o.sureDo ?? SURE_DO)) return { decision: "do", reason: `clearly fine (${sure.toFixed(2)})` };
      } catch (error) {
        o.log?.(`action check: the fast look failed, the writing model decides: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const content = await chatCompletion({ apiKey: o.apiKey, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), timeoutMs: o.timeoutMs ?? 8000 }, {
        model: o.model ?? MODEL,
        messages: [
          { role: "system", content: DECIDE_PROMPT },
          { role: "user", content: describe(c) },
        ],
        response_format: { type: "json_schema", json_schema: { name: "decide_action", strict: true, schema: SCHEMA } },
      });
    const d = JSON.parse(content || "{}") as { decision?: string; reason?: string; ask?: string; fix?: string };
    if (d.decision !== "do" && d.decision !== "ask" && d.decision !== "revise" && d.decision !== "ask_owner") throw new Error(`no decision in ${JSON.stringify(d).slice(0, 200)}`);
    return { decision: d.decision, reason: d.reason ?? "", ...(d.ask ? { ask: d.ask } : {}), ...(d.fix ? { fix: d.fix } : {}) };
  };
}

/** Jev's look: how sure it is this is a "do", or undefined when it picked anything else. */
async function fastDo(o: { apiKey: string; fetchImpl?: typeof fetch; fastModel?: string; fastTimeoutMs?: number }, c: ActionCheck): Promise<number | undefined> {
  const state = {
    action: { name: c.action, details: JSON.stringify(c.args).slice(0, 4000) },
    what_they_asked: c.request,
    ...(c.target ? { done_when: c.target.doneWhen } : {}),
    ...(c.spec ? { how_kloru_planned_the_work: c.spec } : {}),
    callers_own_email: c.ownEmails,
    their_guidelines: c.guidelines || "(none)",
    what_kloru_knows_about_them: c.known.slice(0, 4000) || "(nothing)",
    what_was_said: c.call || "(none)",
  };
  const questions = {
    decision: {
      type: "choice",
      instructions: "Should Kloru, a family's assistant, take this action now? Lean hard toward doing it: a question means the caller does the work. If the caller asked for this action, that's their yes; how Kloru planned the work isn't. Asking to find, research or recommend something isn't asking to contact anyone, buy it, or delete what isn't clearly what they meant. Their guidelines win.",
      criteria: CHOICES,
    },
  };
  const res = await (o.fetchImpl ?? fetch)(FAST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(o.fastTimeoutMs ?? 3000),
    body: JSON.stringify({ model: o.fastModel ?? FAST_MODEL, provider: { zdr: true }, state, questions }),
  });
  if (!res.ok) throw new Error(`decision model ${res.status}`);
  const data = (await res.json()) as { answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }> };
  const d = data.answers?.decision;
  if (d?.type !== "choice" || !d.choice) throw new Error(`no decision in ${JSON.stringify(data).slice(0, 200)}`);
  return d.choice === "do" ? (d.probabilities?.do ?? 1) : undefined;
}

function describe(c: ActionCheck): string {
  return [
    `Action: ${c.action}\n${JSON.stringify(c.args, null, 1).slice(0, 4000)}`,
    `The request: ${c.request}`,
    c.target ? `Done when: ${c.target.doneWhen}` : "",
    c.spec ? `As assigned: ${c.spec}` : "",
    c.ownEmails.length ? `The caller's own email: ${c.ownEmails.join(", ")}` : "",
    c.guidelines ? `The caller's guidelines (these win):\n${c.guidelines}` : "",
    c.ownerGuidelines ? `The caller isn't the family owner. The owner's policies for them (these bound what the caller may do; outside them, ask):\n${c.ownerGuidelines}` : "",
    c.known ? `What Kloru knows about the caller and their people:\n${c.known.slice(0, 4000)}` : "",
    c.call ? `The call:\n${c.call}` : "",
  ].filter(Boolean).join("\n\n");
}
