/**
 * The outbox's fast pass (decision-models skill): Jev, TypeSafe's structured decision model, looks
 * at one message for a person and picks one of three: send it now, drop it, or leave it for the
 * organizer, the agent that sees their whole outbox. It writes no words. Its criteria are guidelines
 * it weighs, not rules in code; when it isn't sure, the organizer gets it.
 */
import type { FirstPassCheck, FirstPassChoice, OutboxItem } from "@kloru/desk";

const URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.14";

export const FIRST_PASS = {
  send: "Send it now, as written: they are waiting for exactly this (the answer to what they just wrote, a question the work is stopped on, a reminder at the time they chose, a result they asked for moments ago in a conversation they're still in, even new results on a page they already have), they don't have it yet, it is short, and nothing else waiting or still being worked on for them belongs with it.",
  drop: "Don't send it: they already have this news or this question, even in other words (it was said or sent already, and no page it links has changed since), or it only says that another message was sent.",
  organizer: "Leave it for the organizer: it could go at a better time for them, belongs together with other things waiting or still being worked on, is long, nobody asked for it by hand, their guidelines say something about when or how they get messages like it, or it isn't clear.",
};

const WHY: Record<OutboxItem["why"], string> = {
  reply: "Kloru's answer to what they just wrote",
  result: "the result of something they asked for",
  report: "a report from an automation or from Kloru's own work; nobody asked for it by hand just now",
  question: "a question the work waits on (it can't go on without their answer)",
  reminder: "a reminder they asked for, at the time they chose",
};
const WRITER: Record<OutboxItem["from"]["agent"], string> = {
  talker: "Kloru, in its conversation with them",
  worker: "the worker doing the task",
  pm: "the coordinator",
  organizer: "the outbox organizer",
  system: "Kloru's plumbing",
};

/** A drop the model isn't this sure of goes to the organizer instead: a wrong drop loses something they wanted. */
const SURE_DROP = 0.7;

const line = (i: OutboxItem) => `${WHY[i.why]}${i.sendAt ? `, set for ${i.sendAt}` : ""}: ${i.text.slice(0, 300)}`;

export function outboxDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; log?: (m: string) => void }): (c: FirstPassCheck) => Promise<FirstPassChoice> {
  return async (c) => {
    const p = c.person;
    const state = {
      message: {
        why_it_exists: WHY[c.item.why],
        text: c.item.text,
        written_by: WRITER[c.item.from.agent],
        waited_minutes: Math.round(c.waitedMinutes),
        ...(c.item.media?.length ? { attachments: c.item.media.length } : {}),
        ...(c.firing ? { its_time_has_come: c.item.why === "reminder" ? "yes: this is the time they chose" : "yes: it was held until now" } : {}),
      },
      ...(c.item.replyingTo ? { answers_their_message: c.item.replyingTo } : {}),
      what_they_asked: c.request || "(nothing by hand)",
      ...(c.changedPages.length ? { pages_it_links_that_changed_since_they_got_the_link: c.changedPages } : {}),
      their_time_now: p.localTime,
      in_a_conversation_with_kloru_now: p.inConversation ?? "no",
      their_guidelines: p.guidelines || "(none)",
      how_they_like_messages: p.preferences || "(nothing noted)",
      organizer_notes: p.notes || "(none)",
      last_turns_of_their_latest_conversation: p.turns,
      still_being_worked_on_for_them: p.running,
      also_waiting_in_their_outbox: c.queued.filter((i) => i.id !== c.item.id).map(line),
      scheduled_for_later: c.scheduled.filter((i) => i.id !== c.item.id).map(line),
      sent_or_dropped_in_the_last_day: c.recent,
    };
    const questions = {
      action: {
        type: "choice",
        instructions: `What should Kloru, a family's assistant, do right now with this one message for ${p.name}? The aim: they're glad to get each message, and nothing they need is late. Their guidelines win.`,
        criteria: FIRST_PASS,
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
    const action = data.answers?.action;
    if (action?.type !== "choice" || !action.choice || !(action.choice in FIRST_PASS)) throw new Error(`no action in ${JSON.stringify(data).slice(0, 200)}`);
    const sure = action.probabilities?.[action.choice];
    const unsure = action.choice === "drop" && sure !== undefined && sure < SURE_DROP;
    const choice = (unsure ? "organizer" : action.choice) as FirstPassChoice;
    o.log?.(`outbox ${c.item.id}: fast pass → ${choice}${sure !== undefined ? ` (${action.choice} ${sure.toFixed(2)})` : ""}`);
    return choice;
  };
}
