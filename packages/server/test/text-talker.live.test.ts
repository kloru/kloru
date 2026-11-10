/**
 * The text talker on the real model. Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/text-talker.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { textTalker, type TalkerTools } from "../src/text-talker.js";

const key = process.env.OPENROUTER_API_KEY;
const BRIEF = "Caller: Ezra. Lives in Portland. People: Nora: Ezra's daughter, 3 | Cleo: Ezra's wife";

function tools() {
  const calls: string[] = [];
  const t: TalkerTools = {
    fileIssue: (r) => (calls.push(`file: ${r}`), "Filed #7."),
    updateIssue: (n, x) => (calls.push(`update ${n}: ${x}`), "Updated."),
    confirm: (n, d) => (calls.push(`confirm ${n} ${d}`), "Confirmed; it's running."),
    remember: (x) => (calls.push(`remember: ${x}`), "Noted."),
    remind: (x, at) => (calls.push(`remind ${at}: ${x}`), `Set for ${at}.`),
    outboxList: () => "Nothing is waiting to be sent to them.",
    outboxCancel: (id) => (calls.push(`cancel ${id}`), "Cancelled; it won't be sent."),
    react: (r) => (calls.push(`react ${r}`), "Reacted."),
  };
  return { t, calls };
}

describe.skipIf(!key)("the text talker, live", () => {
  // TEXT_MODEL tries another model (the model-selection skill); unset, production's.
  const talk = textTalker({ apiKey: key ?? "", ...(process.env.TEXT_MODEL ? { model: process.env.TEXT_MODEL } : {}) });

  it("a request in a text is filed and acknowledged with eyes, no words", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }], tools: t, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(calls.some((c) => c.startsWith("file:"))).toBe(true);
    expect(calls).toContain("react eyes");
    expect(reply).toBe("");
  }, 60_000);

  // Nov 10: the reminder was set with only a reaction; the next text set it again, a minute later.
  it("a reminder already set isn't set again when their next text arrives", async () => {
    const { t, calls } = tools();
    // Their local time four minutes from now, as remind takes it.
    const at = new Date(Date.now() + 4 * 60_000).toLocaleString("sv-SE", { timeZone: "America/Los_Angeles" }).slice(0, 16).replace(" ", "T");
    const reply = await talk({
      brief: BRIEF,
      channel: "imessage",
      thread: [
        { role: "caller", text: "Remind me in 5 min to call Dr. Lee" },
        { role: "did", text: `remind {"text":"Call Dr. Lee.","at":"${at}"} → Set for ${at}.; react {"reaction":"like"} → Reacted.` },
        { role: "caller", text: "Also the email alerts are too noisy. Only tell me about the very important ones." },
      ],
      tools: t,
      timezone: "America/Los_Angeles",
    });
    console.log(reply, calls);
    expect(calls.filter((c) => c.startsWith("remind"))).toEqual([]);
  }, 60_000);

  // Nov 9: with the reply shape at emoji, a new request got 👀 and was never filed.
  it("a new request with an emoji reply shape is still filed, then acknowledged with eyes", async () => {
    const { t, calls } = tools();
    const text = "Everytime I get an email can you mark it as read? If it requires an action or is from someone important like my wife, leave it unread and text me a quick summary";
    // As on Nov 9: his guidelines mention email alerts, and the spam cleanup (#515) waits on his yes.
    const brief = `How they want Kloru to work (their guidelines, which win):
- Be eager: do the whole thing. Check with me first only before something reaches another person, spends money, or can't be undone.
- For email response alerts, do not text before 7 AM or at or after 7 PM Pacific; continue checking email every 15 minutes.
- Keep all messages and writing concise; say each thing once and don't recap work I already know about.
- Delete clearly promotional email without asking; show borderline messages and ask.
${BRIEF}
Recent tasks (newest first; what each found):
- Daily spam cleanup of the inbox: cleaned the work inbox; asked for a yes to read the personal Gmail.`;
    const reply = await talk({ brief, channel: "imessage", thread: [{ role: "caller", text }], tools: t, shape: { form: "emoji", link: false }, pending: ["issue 515, draft d1: May I read your personal Gmail (ezra.vega@gmail.example) for the daily spam cleanup too?"], open: ["issue 515, waiting for their yes, 15 h: Every day, clean spam out of my inboxes"], timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(calls.some((c) => c.startsWith("file:"))).toBe(true);
    expect(calls).toContain("react eyes");
  }, 60_000);

  it("asked again after an 'on it' with nothing filed, it files", async () => {
    const { t, calls } = tools();
    const { react: _r, ...noReact } = t;
    const text = "Everytime I get an email can you mark it as read? If it requires an action or is from someone important like my wife, leave it unread and text me a quick summary";
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text }], tools: noReact, shape: { form: "emoji", link: false }, redraft: { draft: "(only the eyes reaction)", why: "You reacted eyes (on it) but filed nothing, so nothing will happen. file_issue what they asked, or if there's nothing to do, say so in words." }, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(calls.some((c) => c.startsWith("file:"))).toBe(true);
  }, 60_000);

  // Nov 9, 08:11: the GitHub sign-in link came back from the desk; the reply offered to email it instead,
  // then said Kloru was "blocked from sending links over text" (the shape line said "No link.").
  it("a sign-in link in a result is texted, not swapped for an offer to email it", async () => {
    const { t, calls } = tools();
    const reply = await talk({
      brief: BRIEF,
      channel: "imessage",
      thread: [{ role: "caller", text: "Can you connect to my GitHub?" }],
      event: "<info>GitHub isn't connected yet. You can connect it here: https://connect.composio.dev/link/lk_M9yuh9Thv23J. Just sign in and authorize the connection.</info>",
      tools: t,
      shape: { form: "short" },
      timezone: "America/Los_Angeles",
    });
    console.log(reply, calls);
    expect(reply).toContain("https://connect.composio.dev/link/lk_M9yuh9Thv23J");
    expect(reply).not.toMatch(/email|blocked/i);
  }, 60_000);

  // Nov 8: "Did you do it?" and "Is it done yet?" about research stuck for 13 hours got only 👀, then "still working on it".
  const STUCK = ["issue 493, in progress for 13 h, its worker got stuck 26 times: Research how divorce probability changes with jobs where you travel 4+ months a year"];
  it("'is it done yet?' about stuck work gets an honest answer in words, nothing filed again", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "Did you do the divorce analysis thing I asked for?" }, { role: "caller", text: "Is it done yet?" }], open: STUCK, tools: t, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).toMatch(/stuck|delay|roadblock|trouble|problem|snag|longer than|sorry|restart/i);
    expect(calls.some((c) => c.startsWith("file:"))).toBe(false);
  }, 60_000);

  it("an email is acknowledged in a few words, a bigger job in a minute or two", async () => {
    const { t } = tools();
    delete t.react;
    const reply = await talk({ brief: BRIEF, channel: "email", thread: [{ role: "caller", text: "I bought flights and a hotel for my work trip this week. I still need to figure out if I should rent a car and where to park near SFO." }], tools: t, timezone: "America/Los_Angeles" });
    console.log(reply);
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).not.toMatch(/\b(1[0-9]|[2-9][0-9]|[5-9]) ?min|quarter|half an hour|hour/i);
  }, 60_000);

  // Nov 1: the sales-spam job got an ack, a progress text and a done text; only the done text was wanted
  // (the progress came from the PM's merge, which pm.live covers).
  const SPAM = [{ role: "caller" as const, text: "Can you create a reoccurring job to delete sales spam in my email once a day in the morning?" }];

  it("the job done is one short text", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: SPAM, event: '<events issue="193">I\'ve set up the daily sales-spam cleanup automation to run every morning at 7:00 AM for both of your emails.</events>', tools: t, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(reply).toMatch(/7/);
    expect(reply.length).toBeLessThan(200);
  }, 60_000);

  it("a result becomes one short text, with no ids", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }, { role: "kloru", text: "Checking now, a few seconds." }], event: "<info>Tomorrow (Fri Oct 31): daycare drop-off 8 AM; Nora dentist 3 PM at Maplewood Kids Dental (event id e1).</info>", tools: t, timezone: "America/Los_Angeles" });
    console.log(reply);
    expect(calls).toEqual([]);
    expect(reply).toMatch(/3/);
    expect(reply).not.toMatch(/e1|event id/);
  }, 60_000);

  it("an email result is as short as a text", async () => {
    const { t } = tools();
    delete t.react;
    const reply = await talk({ brief: BRIEF, channel: "email", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }, { role: "kloru", text: "On it, a few seconds." }], event: "<info>Tomorrow (Fri Oct 31): daycare drop-off 8 AM; Nora dentist 3 PM at Maplewood Kids Dental; team sync 10 AM; Cleo's flight lands 6:40 PM at OAK.</info>", tools: t, timezone: "America/Los_Angeles" });
    console.log(reply);
    expect(reply.length).toBeLessThan(220);
    expect(reply).not.toMatch(/^\s*[-*•]/m);
  }, 60_000);

  it("'be more concise' is remembered, as Nov 1's thread should have been", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "Is Uber good in Tucson? I'd prefer that." }, { role: "kloru", text: "Yes, Uber is excellent in Tucson. It's highly active, reliable, and usually much faster than rental car lines." }, { role: "caller", text: "Can you be more concise with all of your messages and writing?" }], tools: t, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(calls.some((c) => /^remember: .*concise/i.test(c))).toBe(true);
    expect(reply.length).toBeLessThan(120);
  }, 60_000);

  it("a clear yes confirms the draft it asked about", async () => {
    const { t, calls } = tools();
    await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "Email Cleo that I'll pick up Nora" }, { role: "kloru", text: "Needs your yes: email Cleo \"I'll pick up Nora at 4:30.\" Send it?" }, { role: "caller", text: "Yes send it" }], pending: ['issue 7, draft ab12cd34: email Cleo "I\'ll pick up Nora at 4:30."'], tools: t, timezone: "America/Los_Angeles" });
    console.log(calls);
    expect(calls).toContain("confirm 7 ab12cd34");
  }, 60_000);
});
