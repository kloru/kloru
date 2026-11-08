/**
 * The message-shape decision on Jev, against situations from real threads (decision-models skill:
 * a small labeled set, re-run when the prompt, schema or model changes). Each case names the shapes
 * a person would accept; a wrong-but-close answer still fails, so the set shows where it drifts.
 * Needs OPENROUTER_API_KEY (from .instinct.env); about $0.001 a run.
 */
import { describe, expect, it } from "vitest";
import { draftChecker, feedbackDecider, shapeDecider, type DraftInput, type DraftVerdict, type MessageForm, type ShapeInput } from "../src/message-shape.js";

const key = process.env.OPENROUTER_API_KEY;
const PAGE = "https://kloru.com/a/qS2bq3_CUrrP29j03oAT0w";

interface Case {
  name: string;
  input: Partial<ShapeInput> & Pick<ShapeInput, "kind" | "theirMessage">;
  forms: MessageForm[];
  link?: boolean;
}

const CASES: Case[] = [
  // Acknowledging their message: a reaction says "got it".
  { name: "a calendar question is acknowledged with a reaction", input: { kind: "their_message", theirMessage: "What's on my calendar tomorrow?" }, forms: ["emoji"] },
  { name: "a chore is acknowledged with a reaction", input: { kind: "their_message", theirMessage: "Add milk to the grocery list" }, forms: ["emoji"] },
  { name: "a booking request is acknowledged briefly", input: { kind: "their_message", theirMessage: "Can you help me book parking? I want long term" }, forms: ["emoji", "one_line"] },
  { name: "a thanks gets a reaction", input: { kind: "their_message", theirMessage: "Thanks!" }, forms: ["emoji"] },
  // Results.
  { name: "a chore done is a reaction", input: { kind: "result", theirMessage: "Add milk to the grocery list", content: "Added milk to the grocery list." }, forms: ["emoji", "one_line"] },
  { name: "a chore done, for someone who said a reaction is enough", input: { kind: "result", theirMessage: "Add eggs too", content: "Added eggs to the grocery list.", preferences: '- A reaction would have done for "add milk" (2026-11-03)' }, forms: ["emoji"] },
  { name: "tomorrow's calendar is a line or two", input: { kind: "result", theirMessage: "What's on my calendar tomorrow?", content: "Tomorrow: daycare drop-off 8 AM; Maya dentist 3 PM at Rockridge Kids Dental." }, forms: ["one_line", "short"] },
  { name: "festival dates are one line, no link", input: { kind: "result", theirMessage: "When is the Rhinebeck Sheep and Wool Festival?", content: `Oct 16–17, 2027, listed by a vendor; the organizer hasn't confirmed yet. Notes: ${PAGE}`, hasPage: true }, forms: ["one_line", "short"], link: false },
  { name: "a booking confirmation is short, the number is enough", input: { kind: "result", theirMessage: "Book SFO long-term parking for my trip", content: `Booked: SFO Long-Term, Nov 3 11 AM to Nov 6 1 AM, $78, confirmation SFO483920. Details: ${PAGE}`, hasPage: true }, forms: ["one_line", "short"], link: false },
  { name: "a comparison they asked for comes with its page", input: { kind: "result", theirMessage: "Compare the pediatric dentists near Rockridge", content: `Three options: Rockridge Kids Dental (openings Thu, in network), Piedmont Pediatric (4.9, out of network), Smile Lab (Sat hours). Full comparison: ${PAGE}`, hasPage: true }, forms: ["short", "detailed"], link: true },
  { name: "someone who wants the whole comparison gets it", input: { kind: "result", theirMessage: "Compare the pediatric dentists near Rockridge", content: `Three options: Rockridge Kids Dental (openings Thu, in network), Piedmont Pediatric (4.9, out of network), Smile Lab (Sat hours). Full comparison: ${PAGE}`, hasPage: true, preferences: '- Wanted more detail for "compare daycares" (2026-11-01)' }, forms: ["detailed"], link: true },
  { name: "'send me everything' gets everything", input: { kind: "result", theirMessage: "Send me everything you found about the anesthesia bill", content: "The bill is $1,240 from Bay Anesthesia for Oct 12; insurance paid $860; the balance is $380, due Nov 20; an itemized bill can be requested; two similar claims were appealed successfully on Reddit." }, forms: ["detailed"] },
  { name: "someone who wanted it shorter gets one line", input: { kind: "result", theirMessage: "Book SFO long-term parking", content: "Booked: SFO Long-Term, Nov 3 11 AM to Nov 6 1 AM, $78, confirmation SFO483920.", preferences: '- Wanted it shorter for "book parking" (2026-11-02)' }, forms: ["one_line"] },
  { name: "asked for the link, gets the link", input: { kind: "result", theirMessage: "Send me the link to the parking page", content: `Here's the SFO parking page: ${PAGE}`, hasPage: true }, forms: ["one_line", "short"], link: true },
  { name: "someone who doesn't want links for bookings gets none", input: { kind: "result", theirMessage: "Book a table at Nopa Friday 7pm", content: `Booked: Nopa, Friday 7 PM, 2 people, confirmation RSY-48KQ. Page: ${PAGE}`, hasPage: true, preferences: '- Didn\'t want the link for "book parking" (2026-11-03)' }, forms: ["one_line", "short"], link: false },
  // Asking about earlier work: a status gets words, never a reaction alone (2026-11-08).
  { name: "'did you do it?' about stuck work gets words", input: { kind: "their_message", theirMessage: "Did you do the divorce analysis thing I asked for? I turned down a very high paying job and this was my reasoning.", recent: ["Them: Research how divorce probability changes with jobs where you travel 4+ months a year"], open: ["issue 493, working on it for 12 h, its worker got stuck 24 times: Research how divorce probability changes with jobs where you travel 4+ months a year"] }, forms: ["one_line", "short"] },
  { name: "'is it done yet?' gets words", input: { kind: "their_message", theirMessage: "Is it done yet?", recent: ["Them: What's going on?", "Kloru: I'm still pulling together the studies on high-travel jobs and divorce."], open: ["issue 493, working on it for 13 h, its worker got stuck 26 times: Research how divorce probability changes with jobs where you travel 4+ months a year"] }, forms: ["one_line", "short"] },
  // Questions for them.
  { name: "a purchase question is short", input: { kind: "question", theirMessage: "Buy the lavender Lumos knitting light, use BLACK30", content: "Question for the caller: the total with BLACK30 is $38.33 shipped to Oakland. Buy it?" }, forms: ["one_line", "short"] },
  // Email reads like a text.
  { name: "an email result is short", input: { channel: "email", kind: "result", theirMessage: "What's on my calendar tomorrow?", content: "Tomorrow: daycare drop-off 8 AM; team sync 10 AM; Maya dentist 3 PM; Cara lands 6:40 PM at OAK." }, forms: ["one_line", "short"] },
];

describe.skipIf(!key)("message shape on Jev, real situations", () => {
  const decide = shapeDecider({ apiKey: key!, timeoutMs: 10_000 });
  for (const c of CASES) {
    it(c.name, async () => {
      const s = await decide({ channel: "imessage", hasPage: false, preferences: "", recent: [], ...c.input } as ShapeInput);
      // Unsure leaves it to the talker: a miss here, since each case has a clear answer.
      expect(c.forms, s ? `got ${s.form} (${s.p?.toFixed(2)})` : "unsure").toContain(s?.form);
      if (c.link !== undefined) expect(s?.link, `link ${s?.link}`).toBe(c.link);
    }, 20_000);
  }
});

describe.skipIf(!key)("what a reply teaches, on Jev", () => {
  const learn = feedbackDecider({ apiKey: key!, timeoutMs: 10_000 });
  const sent = { asked: "Find a pediatric dentist near Rockridge", sent: "Rockridge Kids Dental has Thursday openings and takes your plan.", shape: { form: "short" as const, link: false } };
  const cases: Array<[string, RegExp | undefined]> = [
    ["Can you send me the link?", /^Wanted the link/],
    ["That's way too long, just tell me the answer", /^Wanted it shorter/],
    ["Thanks!", undefined],
    ["What were the other options? Why that one?", /^Wanted more detail/],
    ["Book Thursday at 4 then", undefined],
  ];
  for (const [reply, want] of cases) {
    it(`"${reply}" → ${want ?? "nothing"}`, async () => {
      const line = await learn({ ...sent, reply });
      if (want) expect(line).toMatch(want);
      else expect(line).toBeUndefined();
    }, 20_000);
  }
});

describe.skipIf(!key)("does the draft fit, on Jev", () => {
  const check = draftChecker({ apiKey: key!, timeoutMs: 10_000 });
  const EVAN_PREFS = "- Texts very concise; emails as brief as texts (Evan, 2026-11-02)\n- An emoji reaction when that says it all; a sentence only when something needs clarifying (Evan, 2026-11-03)\n- No page link unless he'd want to open it (Evan, 2026-11-03)";
  const cases: Array<[string, Partial<DraftInput> & Pick<DraftInput, "kind" | "theirMessage" | "draft">, DraftVerdict[]]> = [
    ["a one-line booking confirmation fits", { kind: "result", theirMessage: "Book SFO long-term parking", content: "Booked: SFO Long-Term, Nov 3 11 AM to Nov 6 1 AM, $78, SFO483920.", draft: "Booked SFO Long-Term, Nov 3 11 AM–Nov 6 1 AM, $78. Confirmation SFO483920." }, ["fits"]],
    ["a paragraph about a simple booking is too long", { kind: "result", theirMessage: "Book SFO long-term parking", content: "Booked: SFO Long-Term, Nov 3 11 AM to Nov 6 1 AM, $78, SFO483920.", draft: "Great news! I was able to get your SFO Long-Term Parking booked for your trip. It runs from Tuesday, November 3 at 11:00 AM until Friday, November 6 at 1:00 AM, which gives you time after your late return flight. The total came to $78 and was charged to your Mastercard ending 4242. Your confirmation number is SFO483920, and you can scan the QR code at the entrance. Let me know if you need anything else for the trip!" }, ["too_long"]],
    ["a booking message without the confirmation number misses the fact", { kind: "result", theirMessage: "Book SFO long-term parking and send me the confirmation", content: "Booked: SFO Long-Term, Nov 3 11 AM to Nov 6 1 AM, $78, SFO483920.", draft: "All set, your parking is booked." }, ["missing_fact"]],
    ["an unwanted link on a simple answer", { kind: "result", theirMessage: "When is the Rhinebeck Sheep and Wool Festival?", content: `Oct 16–17, 2027. Notes: ${PAGE}`, draft: `It's Oct 16–17, 2027. Details: ${PAGE}` }, ["drop_link", "fits"]],
    ["a comparison without its page needs the link", { kind: "result", theirMessage: "Send me the comparison of the three dentists", content: `Three options compared: ${PAGE}`, draft: "I compared three dentists; Rockridge Kids Dental looks best." }, ["add_link"]],
    ["'I'm on it' words for a plain ask: a reaction would do", { kind: "their_message", theirMessage: "Add milk to the grocery list", draft: "I'm on it! I'll add milk to your grocery list right away.", canReact: true }, ["just_react", "too_long"]],
    ["a clarifying question is worth words", { kind: "their_message", theirMessage: "Book the usual place for Friday", draft: "Nopa or Flour + Water?", canReact: true }, ["fits"]],
    ["the whole answer they asked for is not too long", { kind: "result", theirMessage: "Send me everything you found about the anesthesia bill", content: "The bill is $1,240 from Bay Anesthesia for Oct 12; insurance paid $860; the balance is $380, due Nov 20; you can ask for an itemized bill; two similar claims were appealed.", draft: "Bay Anesthesia billed $1,240 for Oct 12. Insurance paid $860, so you owe $380 by Nov 20. You can ask for an itemized bill, and two similar claims were appealed successfully, so an appeal may be worth it." }, ["fits"]],
    ["an after-call note that retells the call is too long", { kind: "after_call", theirMessage: "Can you move my dentist appointment to Thursday?", draft: "Following up on our call: you asked me to move your dentist appointment. I looked at your calendar, found the appointment on Tuesday at 3 PM, checked Thursday availability with the office, and moved it to Thursday at 4 PM. Everything is updated in your calendar now.", channel: "imessage" }, ["too_long"]],
  ];
  for (const [name, input, want] of cases) {
    it(name, async () => {
      const v = await check({ channel: "imessage", preferences: EVAN_PREFS, thread: [`Them: ${input.theirMessage}`], canReact: false, ...input } as DraftInput);
      expect(want, `got ${v.verdict} (${v.p?.toFixed(2)})`).toContain(v.verdict);
    }, 20_000);
  }
});
