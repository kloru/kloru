/**
 * The outbox's fast pass (Jev) on labeled cases, each with the choices Ezra would accept. Runs only
 * with OPENROUTER_API_KEY:  OPENROUTER_API_KEY=… npx vitest run test/outbox-decider.live.test.ts
 */
import type { FirstPassCheck, FirstPassChoice, OutboxItem } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { outboxDecider } from "../src/outbox-decider.js";

const key = process.env.OPENROUTER_API_KEY;
const EZRA = "+14155550190";
const GUIDELINES = "- Be eager: do the whole thing.\n- Text me (iMessage) for short updates; email for long things with links.";
const item = (o: Partial<OutboxItem> & Pick<OutboxItem, "text" | "why">): OutboxItem => ({ id: "o_1", at: "2026-11-10T22:00:00.000Z", updatedAt: "2026-11-10T22:00:00.000Z", phone: EZRA, state: "new", from: { agent: "worker", issue: 7 }, ...o });
const base = (i: OutboxItem, o: Partial<Omit<FirstPassCheck, "person">> & { person?: Partial<FirstPassCheck["person"]> } = {}): FirstPassCheck => ({
  item: i,
  request: "",
  changedPages: [],
  waitedMinutes: 0,
  firing: false,
  queued: [],
  scheduled: [],
  recent: [],
  now: new Date("2026-11-10T22:00:00Z"),
  ...o,
  person: { name: "Ezra", localTime: "Tue, Nov 10, 2:00 PM", guidelines: GUIDELINES, preferences: "", notes: "", inConversation: undefined, turns: [], running: [], channels: ["imessage", "email"], ...o.person },
});

// [name, check, the choices Ezra would accept]
const CASES: Array<[string, FirstPassCheck, FirstPassChoice[]]> = [
  [
    "#42: the 6:30 AM reminder he asked for, at 6:30 AM",
    base(item({ why: "reminder", text: "Reminder: take the bins out.", from: { agent: "talker" }, sendAt: "2026-11-11T14:30:00.000Z" }), { firing: true, person: { localTime: "Wed, Nov 11, 6:30 AM" } }),
    ["send"],
  ],
  [
    "Nov 10: the same reminder set twice, a minute after the first one went",
    base(item({ why: "reminder", text: "Call Dr. Lee.", from: { agent: "talker" }, sendAt: "2026-11-10T22:38:00.000Z" }), {
      firing: true,
      request: "Remind me in 5 min to call Dr. Lee",
      recent: ["22:37 UTC sent (imessage to +14155550190): Call Dr. Lee."],
      person: { localTime: "Tue, Nov 10, 2:38 PM", inConversation: "imessage", turns: ["Them: Remind me in 5 min to call Dr. Lee", "Kloru: Set for 2:37 PM.", "Kloru: Call Dr. Lee."] },
    }),
    ["drop", "organizer"],
  ],
  [
    "'On it' answering his text",
    base(item({ why: "reply", text: "On it. I'll have that link in a few seconds.", from: { agent: "talker" }, replyingTo: "What's the link to the parking at SFO?" }), { request: "What's the link to the parking at SFO?", person: { inConversation: "imessage", turns: ["Them: What's the link to the parking at SFO?"] } }),
    ["send"],
  ],
  [
    "a short result he asked for a minute ago, in the thread he's in",
    base(item({ why: "result", text: "Maplewood Dental can see Nora on Friday at 3.", from: { agent: "talker", issue: 7 } }), { request: "Find a dentist who can see Nora this week", person: { inConversation: "imessage", turns: ["Them: Find a dentist who can see Nora this week", "Kloru: On it."] } }),
    ["send"],
  ],
  [
    "a question the booking is stopped on, mid-afternoon",
    base(item({ why: "question", text: "Morning or afternoon for Nora's dentist visit?", from: { agent: "pm", issue: 7 } }), { request: "Book Nora's dentist visit" }),
    ["send"],
  ],
  [
    "'I've emailed it' right after the email went",
    base(item({ why: "result", text: "I've emailed the bulky-item pickup instructions to your personal inbox." }), { request: "Email me the bulky-item pickup instructions", recent: ["21:58 UTC sent (email to +14155550190): Bulky-item pickup: put items at the curb by 6 AM Thursday; mattresses need a bag."] }),
    ["drop", "organizer"],
  ],
  [
    "the same page link again, a minute after it went",
    base(item({ why: "result", text: "Here's the SFO parking page again: https://kloru.com/a/RZMnGyW_5lc7hGGUD_5bdA", from: { agent: "talker", issue: 7 } }), { request: "What's the link to the parking at SFO?", recent: ["21:59 UTC sent (imessage to +14155550190): SFO parking and transport: https://kloru.com/a/RZMnGyW_5lc7hGGUD_5bdA"], person: { inConversation: "imessage" } }),
    ["drop", "organizer"],
  ],
  [
    "the same page link, but the page has the new options he asked for",
    base(item({ why: "result", text: "I added four options up to $100: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g", from: { agent: "talker", issue: 7 } }), { request: "Find stylish laundry baskets up to $100", changedPages: ["Laundry baskets"], recent: ["21:40 UTC sent (imessage to +14155550190): A few cheap, light options: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g"], person: { inConversation: "imessage", turns: ["Them: Cleo thinks all of those are ugly", "Them: You can spend up to $100"] } }),
    ["send", "organizer"],
  ],
  [
    "an automation's report at 11:40 PM that nobody asked for by hand",
    base(item({ why: "report", text: "Nightly inbox check: 3 newsletters archived, nothing needs you.", from: { agent: "pm", issue: 9 } }), { person: { localTime: "Tue, Nov 10, 11:40 PM" } }),
    ["organizer", "drop"],
  ],
  [
    "a result at 10:15 PM when his guidelines say nothing after 9 unless it's urgent",
    base(item({ why: "result", text: "The plumber can come Thursday between 1 and 3." }), { request: "Find a plumber for the kitchen sink this week", waitedMinutes: 0, person: { localTime: "Tue, Nov 10, 10:15 PM", guidelines: `${GUIDELINES}\n- No messages after 9 PM unless it's urgent; send them in the morning.` } }),
    ["organizer"],
  ],
  [
    "one of three results from the same ask, the other two still running",
    base(item({ why: "result", text: "Flights: Alaska nonstop PDX to TUS, $318 round trip, leaves 8:05 AM." }), { request: "Plan the Tucson trip: flights, a hotel and a rental car", person: { running: ["Find a hotel in Tucson for Nov 20-23", "Find a rental car in Tucson for Nov 20-23"] } }),
    ["organizer"],
  ],
  [
    "a second update while another already waits for him",
    base(item({ id: "o_2", why: "result", text: "The hotel is booked: Hotel Congress, Nov 20-23." }), { request: "Plan the Tucson trip: flights, a hotel and a rental car", queued: [item({ why: "result", text: "Flights: Alaska nonstop PDX to TUS, $318 round trip, leaves 8:05 AM." })] }),
    ["organizer"],
  ],
  [
    "a long write-up",
    base(item({ why: "result", text: `Here is the full comparison of the three dentists near Maplewood.\n${"Maplewood Dental: open weekdays 8 to 5, takes your plan, two pediatric dentists, 4.8 stars over 212 reviews, next opening Friday at 3. ".repeat(8)}` }), { request: "Compare the three dentists near us" }),
    ["organizer"],
  ],
];

describe.skipIf(!key)("the outbox's fast pass on labeled cases (live)", () => {
  const decide = outboxDecider({ apiKey: key ?? "", timeoutMs: 15_000, log: (m) => console.log(m) });
  for (const [name, check, accepted] of CASES) {
    it(name, async () => {
      expect(accepted).toContain(await decide(check));
    }, 30_000);
  }
});
