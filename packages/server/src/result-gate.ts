/**
 * The result gate (decision-models skill): when an engineer finishes work that changed an app, Jev
 * says whether someone should use the app before the PM reviews the result. Its criteria are
 * guidelines it weighs, not rules in code. The desk tries the app when this is unsure, slow or broken.
 */
import type { ResultCheck, ResultDecision } from "@kloru/desk";

const URL = "https://openrouter.ai/api/alpha/decisions";
// Measured 2026-11-10 on 16 invented cases, three runs each: ~0.18 s a decision; every miss was an extra check.
const MODEL = "typesafe/jev-1.14";
/** How sure "none" has to be before an app goes on untried. */
const SURE = 0.6;

const CHECKS = {
  none: "No check: a small change to an app that already works (wording, a label, a color), which they will see at once if it is wrong.",
  tried: "Someone uses the app in a browser first: it is new, or what it does or how it keeps its data changed in a way that could break it.",
  unsure: "Can't tell from this.",
};

export function resultGate(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (c: ResultCheck) => Promise<ResultDecision> {
  return async (c) => {
    const state = {
      what_they_asked: c.request,
      spec: { goal: c.goal ?? "(none)", done_when: c.doneWhen ?? "(none)", deliverable: c.deliverable ?? "(none)" },
      engineers_result: c.result,
      what_changed: c.changed,
      changes_made_elsewhere: c.ledger,
    };
    const questions = {
      check: {
        type: "choice",
        instructions: "Kloru is a family's assistant. An engineer finished this work on an app. Before the coordinator reviews it and the person hears, does the app need an independent check?",
        criteria: CHECKS,
      },
    };
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({ model: o.model ?? MODEL, provider: { zdr: true }, state, questions }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }> };
    const a = data.answers?.check;
    if (a?.type !== "choice" || !a.choice || !(a.choice in CHECKS)) throw new Error(`no check in ${JSON.stringify(data).slice(0, 200)}`);
    const p = a.probabilities?.[a.choice];
    return { check: a.choice === "none" && p !== undefined && p >= SURE ? "none" : "tried", ...(p !== undefined ? { p } : {}) };
  };
}
