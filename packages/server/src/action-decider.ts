/**
 * Weighs a change before a worker makes it (decision-models skill): do, ask or revise, as a
 * schema-shaped decision on a fast, cheap model (Jev once there's a key). Biased toward doing:
 * a draft or a question costs the caller too. Only a realistic, serious downside earns a question.
 */
import type { ActionCheck, ActionDecision } from "@kloru/desk";
import { chatCompletion } from "./openrouter.js";

// Measured 2026-10-29 on the live eval: Flash 15/15 every run (~3 s); Flash Lite 13-14/15 (~1.2 s).
const MODEL = "google/gemini-3.5-flash";

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
- Doing it only costs something if the worst realistic outcome hurts them: it reaches someone who shouldn't see it, embarrasses them, spends money they didn't mean to, or can't be undone.
- If the caller asked for this action, that's their yes. Asking to find, research or recommend something isn't asking to contact anyone, buy it, or delete what isn't clearly what they meant. Their guidelines win over these.
do: go ahead. ask: only when the worst case is serious and they didn't ask for this; write one short spoken question. revise: the action is right but part of it could hurt them; say what to change.
ask_owner: the caller isn't the family owner and the owner's words for them don't plainly allow this; booking a new meeting isn't moving or removing his.
Examples: an email to the caller: do. Sending the report the caller asked for to their wife: do. Deleting obvious promos: do; a bank statement while cleaning promos: ask. Ordering dinner when they asked what's good: ask. An email to their boss that mentions a job search: revise or ask.`;

export function actionDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (c: ActionCheck) => Promise<ActionDecision> {
  return async (c) => {
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
