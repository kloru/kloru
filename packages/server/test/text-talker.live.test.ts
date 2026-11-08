/**
 * The text talker on the real model. Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/text-talker.live.test.ts
 */
import { describe, expect, it } from "vitest";
import { textTalker, type TalkerTools } from "../src/text-talker.js";

const key = process.env.OPENROUTER_API_KEY;
const BRIEF = "Caller: Evan. Lives in Oakland. People: Maya: Evan's daughter, 3 | Cara: Evan's wife";

function tools() {
  const calls: string[] = [];
  const t: TalkerTools = {
    fileIssue: (r) => (calls.push(`file: ${r}`), "Filed #7."),
    updateIssue: (n, x) => (calls.push(`update ${n}: ${x}`), "Updated."),
    confirm: (n, d) => (calls.push(`confirm ${n} ${d}`), "Confirmed; it's running."),
    remember: (x) => (calls.push(`remember: ${x}`), "Noted."),
    react: (r) => (calls.push(`react ${r}`), "Reacted."),
  };
  return { t, calls };
}

describe.skipIf(!key)("the text talker, live", () => {
  const talk = textTalker({ apiKey: key ?? "" });

  it("a request in a text is filed and acknowledged with eyes, no words", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }], tools: t, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(calls.some((c) => c.startsWith("file:"))).toBe(true);
    expect(calls).toContain("react eyes");
    expect(reply).toBe("");
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
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }, { role: "kloru", text: "Checking now, a few seconds." }], event: "<info>Tomorrow (Fri Oct 31): daycare drop-off 8 AM; Maya dentist 3 PM at Rockridge Kids Dental (event id e1).</info>", tools: t, timezone: "America/Los_Angeles" });
    console.log(reply);
    expect(calls).toEqual([]);
    expect(reply).toMatch(/3/);
    expect(reply).not.toMatch(/e1|event id/);
  }, 60_000);

  it("an email result is as short as a text", async () => {
    const { t } = tools();
    delete t.react;
    const reply = await talk({ brief: BRIEF, channel: "email", thread: [{ role: "caller", text: "What's on my calendar tomorrow?" }, { role: "kloru", text: "On it, a few seconds." }], event: "<info>Tomorrow (Fri Oct 31): daycare drop-off 8 AM; Maya dentist 3 PM at Rockridge Kids Dental; team sync 10 AM; Cara's flight lands 6:40 PM at OAK.</info>", tools: t, timezone: "America/Los_Angeles" });
    console.log(reply);
    expect(reply.length).toBeLessThan(220);
    expect(reply).not.toMatch(/^\s*[-*•]/m);
  }, 60_000);

  it("'be more concise' is remembered, as Nov 1's thread should have been", async () => {
    const { t, calls } = tools();
    const reply = await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "Is Uber good in Atlanta? I'd prefer that." }, { role: "kloru", text: "Yes, Uber is excellent in Atlanta. It's highly active, reliable, and usually much faster than rental car lines." }, { role: "caller", text: "Can you be more concise with all of your messages and writing?" }], tools: t, timezone: "America/Los_Angeles" });
    console.log(reply, calls);
    expect(calls.some((c) => /^remember: .*concise/i.test(c))).toBe(true);
    expect(reply.length).toBeLessThan(120);
  }, 60_000);

  it("a clear yes confirms the draft it asked about", async () => {
    const { t, calls } = tools();
    await talk({ brief: BRIEF, channel: "imessage", thread: [{ role: "caller", text: "Email Cara that I'll pick up Maya" }, { role: "kloru", text: "Needs your yes: email Cara \"I'll pick up Maya at 4:30.\" Send it?" }, { role: "caller", text: "Yes send it" }], pending: ['issue 7, draft ab12cd34: email Cara "I\'ll pick up Maya at 4:30."'], tools: t, timezone: "America/Los_Angeles" });
    console.log(calls);
    expect(calls).toContain("confirm 7 ab12cd34");
  }, 60_000);
});
