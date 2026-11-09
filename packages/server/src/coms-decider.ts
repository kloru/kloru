/**
 * Coms: the check every message passes before it goes (decision-models skill). Jev, TypeSafe's
 * structured decision model, picks what to do with it and on which channel; it writes no words. The
 * agent that drafted the message sends it. Its criteria are guidelines it weighs, not rules in code.
 */
import type { MessageCheck, MessageDecision, NoticeChannel } from "@kloru/desk";

const URL = "https://openrouter.ai/api/alpha/decisions";
// Measured 2026-10-31: ~0.35 s and $0.00003 a decision; dropped #111's "I've emailed you" at 0.92.
const MODEL = "typesafe/jev-1.14";

const ACTIONS = {
  send: "Send it now: they'd want it and don't have it yet (new results, even on a page they already have), or they asked for it.",
  hold: "Not yet: more for them is still being worked on and this reads better together, it can wait for their next conversation, or their guidelines say not at this hour.",
  drop: "Don't send: they already have this news (it was said, emailed or texted already), it only says another message was sent, it reports routine work they didn't ask to hear about, or it isn't what they asked for.",
  ask: "Ask the caller first: their guidelines ask for that, or it could embarrass them, commit them to something, or cost money.",
};
/** Kloru's own message in its conversation with them: it's to them, so only whether and when (they're here: holding only waits for what's still running). */
const TALKER_ACTIONS = { send: ACTIONS.send, hold: "Not yet: more for them is still being worked on and this reads better together.", drop: ACTIONS.drop };
/** Its direct answer to their message: they're waiting, so it goes now or not at all. */
const REPLY_ACTIONS = { send: ACTIONS.send, drop: ACTIONS.drop };
const DRAFTED_BY: Record<MessageCheck["from"], string> = {
  worker: "the worker doing the task",
  pm: "the coordinator, after the conversation ended",
  talker: "Kloru, writing in its conversation with them",
};
const ASK_OWNER = "Ask the family owner: the caller isn't the owner and this goes beyond what he said they may do.";
const TEXT_INSTEAD = "Text it instead: this email to them should be a short text with the page's link, because they asked by text (or call) and didn't ask for email.";
const CONVERSATION: Record<string, string> = { voice: "by phone call", imessage: "by text (iMessage)", email: "by email", schedule: "an automation, nobody on the line" };
const CHANNELS: Record<NoticeChannel, string> = {
  imessage: "A text to their phone: a short summary, with a page link for anything longer.",
  email: "An email: when they asked by email, or asked for email.",
};

export function comsDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number; /** The family's timezone: their guidelines about when to text need the time. */ timezone?: string; now?: () => Date }): (c: MessageCheck) => Promise<MessageDecision> {
  const clock = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", hour: "numeric", minute: "2-digit" }).format((o.now ?? (() => new Date()))());
  return async (c) => {
    const questions: Record<string, unknown> = {
      action: {
        type: "choice",
        instructions: `What should Kloru, a family's assistant, do with this ${c.toCaller ? "message to the person who asked" : "message to someone else on the caller's behalf"}? Their guidelines win.`,
        criteria: c.from === "talker" ? (c.replyingTo || !c.running.length ? REPLY_ACTIONS : TALKER_ACTIONS) : { ...ACTIONS, ...(c.ownerGuidelines !== undefined ? { ask_owner: ASK_OWNER } : {}), ...(c.action && c.toCaller && c.defaultChannel === "imessage" ? { text_instead: TEXT_INSTEAD } : {}) },
      },
    };
    if (c.channels.length > 1) {
      questions.channel = { type: "choice", instructions: `If it's sent, which channel? Reply where they asked (${c.defaultChannel ?? "imessage"} here) unless their guidelines or words say otherwise.`, criteria: Object.fromEntries(c.channels.map((ch) => [ch, CHANNELS[ch]])) };
    }
    const state = {
      message: { to: c.toCaller ? "the person who asked" : c.to, ...(c.action ? { via: c.action } : {}), ...(c.subject ? { subject: c.subject } : {}), text: c.text, drafted_by: DRAFTED_BY[c.from] },
      ...(c.replyingTo ? { answers_their_message: c.replyingTo } : {}),
      what_they_asked: c.request,
      ...(c.conversation ? { conversation: CONVERSATION[c.conversation] ?? c.conversation } : {}),
      ...(c.defaultChannel ? { default_reply_channel: c.defaultChannel } : {}),
      what_was_said: c.call || "(none)",
      ...(o.timezone ? { their_time_now: `${clock(o.timezone)} (${o.timezone})` } : {}),
      their_guidelines: c.guidelines || "(none)",
      ...(c.ownerGuidelines !== undefined ? { owner_guidelines: c.ownerGuidelines } : {}),
      on_a_call_with_kloru_now: c.onCall,
      still_being_worked_on: c.running,
      already_sent_today: c.recent,
      ...(c.changedPages?.length ? { pages_changed_since_they_got_the_link: c.changedPages } : {}),
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
    if (action?.type !== "choice" || !action.choice || !(action.choice in ACTIONS || action.choice === "ask_owner" || action.choice === "text_instead")) throw new Error(`no action in ${JSON.stringify(data).slice(0, 200)}`);
    const channel = data.answers?.channel;
    const picked = channel?.type === "choice" && c.channels.includes(channel.choice as NoticeChannel) ? (channel.choice as NoticeChannel) : undefined;
    const p = action.probabilities?.[action.choice];
    return { action: action.choice as MessageDecision["action"], ...(picked ? { channel: picked } : {}), ...(p !== undefined ? { p } : {}) };
  };
}
