/**
 * How a written message should look for this person, decided before it's written (decision-models
 * skill): an emoji alone, one line, a sentence or two, or the whole answer; and whether they'd want
 * the page's link. Jev weighs their own preferences (messages.md, which it also helps fill) above
 * the defaults. A phone call isn't shaped here: it stays a conversation.
 *
 * After a message goes out, their next message is weighed too: did they want more, less, the link,
 * or just a reaction? A clear answer becomes a dated line in their messages.md.
 */

const URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.14";

export type MessageForm = "emoji" | "one_line" | "short" | "detailed";
export interface MessageShape {
  form: MessageForm;
  link: boolean;
  p?: number;
}

export interface ShapeInput {
  channel: "imessage" | "email";
  /** What they're getting: their own new message to acknowledge, a result, or a question for them. */
  kind: "their_message" | "result" | "question";
  /** Their words that this answers (their last message). */
  theirMessage: string;
  /** What's being passed on, when it's a result or a question. */
  content?: string;
  /** Whether there's a page for it. */
  hasPage: boolean;
  /** Their messages.md and guidelines. */
  preferences: string;
  /** The whole conversation so far, oldest first. */
  recent: string[];
  /** Their requests still open, with how they're going, so a status question is answered. */
  open?: string[];
}

const FORMS: Record<MessageForm, string> = {
  emoji: "Just a reaction on their message (👀 got it, 👍 done): a request Kloru is now on, a chore done, a thanks. Not for a question about earlier work: that gets an answer.",
  one_line: "One line: the outcome or the one fact they need (a time, a date, a confirmation number).",
  short: "A sentence or two: the outcome and the few details that matter.",
  detailed: "The whole answer: only when they asked for everything or for detail, or their preferences want detail.",
};
const LINKS = {
  yes: "Include the link: they asked for it, or it's a comparison or long result they'll want to open.",
  no: "No link: the message says it all (a date, a booking with its confirmation number), or their preferences say no links.",
};

/** The shape to write in; undefined when unsure, so the talker's own judgment decides. */
export function shapeDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (s: ShapeInput) => Promise<MessageShape | undefined> {
  return async (s) => {
    const questions: Record<string, unknown> = {
      form: {
        type: "choice",
        instructions: `How should Kloru, a family's assistant, write its next ${s.channel === "email" ? "email" : "text"} to this person? Their preferences come first. Otherwise as short as fits (an email as short as a text), and a reaction alone when that says it all.`,
        criteria: s.kind === "their_message" ? FORMS : { one_line: FORMS.one_line, short: FORMS.short, detailed: FORMS.detailed, ...(s.kind === "result" ? { emoji: FORMS.emoji } : {}) },
      },
      ...(s.hasPage ? { link: { type: "choice", instructions: "Should the message include the page's link?", criteria: LINKS } } : {}),
    };
    const state = {
      channel: s.channel === "email" ? "email (it reads like a text: short unless they want more)" : "text message",
      what_this_is: s.kind === "their_message" ? "acknowledging their new message (Kloru may still be working on it)" : s.kind === "result" ? "passing on a result" : "a question they must answer",
      their_message: s.theirMessage || "(none)",
      ...(s.content ? { to_pass_on: s.content } : {}),
      their_preferences_come_first: s.preferences || "(none yet)",
      conversation_so_far: s.recent,
      ...(s.open?.length ? { their_open_requests: s.open } : {}),
    };
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({ model: o.model ?? MODEL, provider: { zdr: true }, state, questions }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }> };
    const form = data.answers?.form;
    if (form?.type !== "choice" || !form.choice || !(form.choice in FORMS)) throw new Error(`no form in ${JSON.stringify(data).slice(0, 200)}`);
    const p = form.probabilities?.[form.choice];
    // Unsure: no shape, and the talker decides. A forced reaction left "Is it done yet?" with only 👀 (2026-11-08).
    if (p !== undefined && p < 0.5) return undefined;
    return { form: form.choice as MessageForm, link: data.answers?.link?.choice === "yes", ...(p !== undefined ? { p } : {}) };
  };
}

export interface FeedbackInput {
  /** What they asked, and what Kloru sent them. */
  asked: string;
  sent: string;
  shape: MessageShape;
  /** Their next message. */
  reply: string;
}

const LESSONS = {
  none: "Nothing about how the message was written: a new request, a thanks, an answer, or anything else.",
  more: "They wanted more than they got: asked for the other options, the rest, why, or more detail.",
  less: "It was too long or too many messages for them (said so, or 'just tell me', 'too much').",
  link: "They wanted the page or link and didn't get it (asked for the link, the page, where to see it).",
  no_link: "They didn't want the link or page (said so, or the link was clutter).",
  emoji: "A reaction or a word would have done (they said 'just a thumbs up', 'no need to reply').",
};
const LESSON_LINES: Record<Exclude<keyof typeof LESSONS, "none">, string> = {
  more: "Wanted more detail",
  less: "Wanted it shorter",
  link: "Wanted the link",
  no_link: "Didn't want the link",
  emoji: "A reaction would have done",
};

/** What their reply says about the last message's shape: a line for their messages.md, or nothing. */
export function feedbackDecider(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (f: FeedbackInput) => Promise<string | undefined> {
  return async (f) => {
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({
        model: o.model ?? MODEL,
        provider: { zdr: true },
        state: { they_asked: f.asked, kloru_sent: f.sent, how_it_was_written: `${FORMS[f.shape.form]} ${f.shape.link ? "With the page link." : "No link."}`, their_reply: f.reply },
        questions: { lesson: { type: "choice", instructions: "Does their reply say anything about how Kloru's last message was written?", criteria: LESSONS } },
      }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }> };
    const choice = data.answers?.lesson?.choice as keyof typeof LESSONS | undefined;
    const p = choice ? (data.answers?.lesson?.probabilities?.[choice] ?? 0) : 0;
    // Only a clear lesson is kept: a wrong one would shape every later message.
    if (!choice || choice === "none" || p < 0.75) return undefined;
    return `${LESSON_LINES[choice]} for "${f.asked.slice(0, 80)}"`;
  };
}

/** A written draft, weighed against how this person likes messages before it's sent. */
export interface DraftInput {
  channel: "imessage" | "email";
  /** What it is: acknowledging their message, a result, a question, or a note after a phone call. */
  kind: "their_message" | "result" | "question" | "after_call";
  theirMessage: string;
  /** What it had to pass on, when it carries a result or a question. */
  content?: string;
  /** The shape decided before writing, when there was one (text threads). */
  shape?: MessageShape;
  draft: string;
  preferences: string;
  /** The whole conversation so far, oldest first ("Them: …" / "Kloru: …"). */
  thread: string[];
  /** Whether a reaction is possible instead of words (an iMessage they sent). */
  canReact: boolean;
}

export type DraftVerdict = "fits" | "too_long" | "missing_fact" | "drop_link" | "add_link" | "just_react";
const VERDICTS: Record<DraftVerdict, string> = {
  fits: "It fits: the right length and content for them, with a link only if they'd want it.",
  too_long: "Longer than they wanted: more words, detail or messages than they asked for or like.",
  missing_fact: "It leaves out the fact they need (the time, the total, the confirmation number, the answer).",
  drop_link: "It has a link they wouldn't want: the message says it all.",
  add_link: "It needs the page's link: they'd want to open it, or asked for it.",
  just_react: "A reaction on their message would say it all; the words add nothing.",
};
/** What the writer is told when its draft goes back. */
export const REDRAFT: Record<Exclude<DraftVerdict, "fits">, string> = {
  too_long: "Too long for them: make it shorter.",
  missing_fact: "It leaves out the fact they need: put it in.",
  drop_link: "Drop the link: the message says it all.",
  add_link: "Include the page's link: they'll want to open it.",
  just_react: "A reaction says it all: react instead of writing.",
};

/** Whether a draft fits them; "fits" on anything unsure, so a doubt never holds a message up. */
export function draftChecker(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (d: DraftInput) => Promise<{ verdict: DraftVerdict; p?: number }> {
  return async (d) => {
    const words = d.draft.trim().split(/\s+/).filter(Boolean).length;
    const criteria = Object.fromEntries(Object.entries(VERDICTS).filter(([k]) => (k !== "just_react" || d.canReact) && (k !== "add_link" || /\/a\/[A-Za-z0-9_-]{22}/.test(d.content ?? ""))));
    const state = {
      channel: d.channel === "email" ? "email (it reads like a text: short unless they want more)" : "text message",
      what_this_is: { their_message: "acknowledging their new message", result: "passing on a result", question: "a question they must answer", after_call: "a note after a phone call with what got done" }[d.kind],
      their_message: d.theirMessage || "(none)",
      ...(d.content ? { what_it_had_to_pass_on: d.content } : {}),
      ...(d.shape ? { shape_decided_before_writing: `${d.shape.form.replace("_", " ")}, ${d.shape.link ? "with the page link" : "no link"}` } : {}),
      conversation_so_far: d.thread,
      draft: d.draft,
      draft_facts: `${words} words; ${/https?:\/\//.test(d.draft) ? "has a link" : "no link"}`,
      their_preferences_come_first: d.preferences || "(none yet)",
    };
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({ model: o.model ?? MODEL, provider: { zdr: true }, state, questions: { verdict: { type: "choice", instructions: "Does this draft fit this person? What they asked for in their message comes first (asked for everything: the full answer fits), then their preferences; otherwise as short as fits.", criteria } } }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, { choice?: string; probabilities?: Record<string, number> }> };
    const choice = data.answers?.verdict?.choice as DraftVerdict | undefined;
    if (!choice || !(choice in VERDICTS)) throw new Error(`no verdict in ${JSON.stringify(data).slice(0, 200)}`);
    const p = data.answers?.verdict?.probabilities?.[choice];
    // A redraft costs a second model call: only a clear miss sends it back.
    if (choice !== "fits" && p !== undefined && p < 0.6) return { verdict: "fits", p };
    return { verdict: choice, ...(p !== undefined ? { p } : {}) };
  };
}
