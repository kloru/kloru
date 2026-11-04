/**
 * The CISO's review (decision-models skill): one Jev call per request, one question per need on
 * someone else's things, each allow, ask them, or deny. It reads that person's own policy.md; it
 * writes no words. Code decides the floor and the open cases, and enforces the answer
 * (packages/desk/src/access.ts).
 */
import { describeNeed, type AccessCheck, type AccessChoice, type AccessDecision } from "@kloru/desk";

const URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.14";

const CHOICES: Record<AccessChoice, string> = {
  allow: "Allow: their policy gives this person this, or doesn't mention it (anything it doesn't mention is open to the family).",
  ask_owner: "Ask them first: their policy says to ask them about this.",
  deny: "Deny: their policy rules this out for this person.",
};

export function accessDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; ownerName?: string }): (c: AccessCheck) => Promise<AccessDecision> {
  const owner = o.ownerName ?? "the owner";
  return async (c) => {
    const questions = Object.fromEntries(
      c.needs.map((n, i) => [
        `need_${i}`,
        {
          type: "choice",
          instructions: `May ${c.who.name} have Kloru ${describeNeed(n, owner).replace(/\btheir\b/, `${c.who.name}'s own`)} for this request? ${n.account}'s policy, in their words: "${(c.policies?.[n.account] ?? "").trim() || "(nothing)"}". Only its lines about ${c.who.name} or about everyone apply.`,
          criteria: CHOICES,
        },
      ]),
    );
    const state = {
      who: { name: c.who.name, role: c.who.role === "owner" ? "an owner of the family" : c.who.role === "member" ? "a family member" : "someone who isn't in the family" },
      policies_of_whose_things_these_are: c.policies ?? {},
      ...(c.ownerWords ? { what_an_owner_said_about_them: c.ownerWords } : {}),
      their_guidelines: c.guidelines || "(none)",
      request: c.request,
      spec: c.spec,
      ...(c.target ? { goal: c.target.goal } : {}),
    };
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({ model: o.model ?? MODEL, state, questions }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }> };
    const choices: AccessChoice[] = [];
    const p: number[] = [];
    c.needs.forEach((_, i) => {
      const a = data.answers?.[`need_${i}`];
      if (a?.type !== "choice" || !a.choice || !(a.choice in CHOICES)) throw new Error(`no answer for need ${i} in ${JSON.stringify(data).slice(0, 200)}`);
      choices.push(a.choice as AccessChoice);
      // No probability is no confidence: the desk sends it to an owner.
      p.push(a.probabilities?.[a.choice] ?? 0);
    });
    return { choices, p };
  };
}
