/**
 * The message check (Jev) on real cases, each with the call Evan would want. Runs only with
 * OPENROUTER_API_KEY:  OPENROUTER_API_KEY=… npx vitest run test/coms-decider.live.test.ts
 */
import type { MessageCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { comsDecider } from "../src/coms-decider.js";

const key = process.env.OPENROUTER_API_KEY;
const EVAN = "+14155550190";
const GUIDELINES = "- Be eager: do the whole thing.\n- Text me (iMessage) for short updates; email for long things with links.";
const base = (o: Partial<MessageCheck> & Pick<MessageCheck, "text" | "request">): MessageCheck => ({
  to: EVAN, toCaller: true, from: "worker", channels: ["imessage", "email"], call: `Caller: ${o.request}`, guidelines: GUIDELINES, onCall: false, running: [], recent: [], conversation: "voice", defaultChannel: "imessage", ...o,
});

// [name, check, actions Evan would accept, channel he'd want if sent]
const CASES: Array<[string, MessageCheck, string[], string?]> = [
  [
    "Nov 1 SFO: 'On it' answering his text",
    base({ from: "talker", conversation: "imessage", channels: ["imessage"], request: "What's the link to the parking at SFO?", replyingTo: "What's the link to the parking at SFO?", text: "On it. I'll have that link in a few seconds.", call: "Caller: What's the link to the parking at SFO?" }),
    ["send"],
  ],
  [
    "Nov 1 SFO: the page link again, 24 s after it was sent",
    base({ from: "talker", conversation: "imessage", channels: ["imessage"], request: "What's the link to the parking at SFO?", text: "Thanks. I've updated the SFO parking and transportation page with those direct booking and garage links for you: https://kloru.com/a/RZMnGyW_5lc7hGGUD_5bdA", call: "Caller: What's the link to the parking at SFO?\nKloru: In the meantime, here is the link to the SFO parking and Atlanta transportation details: https://kloru.com/a/RZMnGyW_5lc7hGGUD_5bdA", recent: ["20:41 UTC sent (imessage to +14155550190): In the meantime, here is the link to the SFO parking and Atlanta transportation details: https://kloru.com/a/RZMnGyW_5lc7hGGUD_5bdA"] }),
    ["drop"],
  ],
  [
    "Nov 1 Cara: 'here's the link' right after the worker texted it",
    base({ to: "+14155550191", from: "talker", conversation: "imessage", channels: ["imessage"], request: "Text me the shared to-do list link", text: "Here's the link to your shared to-do list: https://kloru.com/a/llPuul8On25zNUCQvAaI0w", call: "Kloru: Hi Cara, here's your shared to-do list: https://kloru.com/a/llPuul8On25zNUCQvAaI0w", recent: ["19:06 UTC sent (imessage to +14155550191): Hi Cara, here's your shared to-do list: https://kloru.com/a/llPuul8On25zNUCQvAaI0w"] }),
    ["drop"],
  ],
  [
    "Nov 1 mailbox: the plan he asked for, first time",
    base({ from: "talker", conversation: "imessage", channels: ["imessage"], request: "Can you also make a plan for replacing my mailbox?", text: "I drafted your mailbox post replacement plan: https://kloru.com/a/4Ih9H7BOpCs1IOME5xzewA", call: "Caller: Can you also make a plan for replacing my mailbox? I just need a post and to install it\nKloru: I'm on it." }),
    ["send"],
  ],
  [
    "Nov 1 add Cara: 'Cara has been added' a second time",
    base({ from: "talker", conversation: "imessage", channels: ["imessage"], request: "Add my wife Cara, she can see and do everything", text: "Cara has been added with full access.", call: "Caller: Add my wife Cara, (415) 555-0191, she can see and do everything.\nKloru: Cara has been added with full access.", recent: ["18:48 UTC sent (imessage to +14155550190): Cara has been added with full access."] }),
    ["drop"],
  ],
  [
    "Nov 2 laundry: the same page link, but the page has new options he asked for",
    base({ from: "talker", conversation: "imessage", channels: ["imessage"], request: "Find lightweight, inexpensive laundry baskets on Amazon that are more stylish", text: "I updated the page with cleaner, more modern designs she might like better: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g", call: "Caller: I need a new laundry basket… my wife shouldn't think it's ugly\nKloru: I found a few great, cheap, and lightweight options on Amazon: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g\nCaller: She thinks all of those are ugly", recent: ["03:46 UTC sent (imessage to +14155550190): I found a few great, cheap, and lightweight options on Amazon: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g"], changedPages: ["Lightweight Amazon laundry baskets"] }),
    ["send"],
  ],
  [
    "Nov 2 laundry: the $100 options, the last thing he's waiting on",
    base({ from: "talker", conversation: "imessage", channels: ["imessage"], request: "Find stylish, high-quality laundry baskets on Amazon up to $100", text: "I updated the page with four design-forward options up to $100, including a $62 Brabantia and a $90 Joseph Joseph: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g", call: "Caller: She thinks all of those are ugly\nCaller: Are you suggesting more?\nKloru: I'm on it.\nCaller: You can spend up to $100", recent: ["03:46 UTC sent (imessage to +14155550190): I found a few great, cheap, and lightweight options on Amazon: https://kloru.com/a/csPIoxrcJKN7qOiH-9xN5g", "03:55 UTC sent (imessage to +14155550190): I filed a request to find more stylish laundry baskets up to $100."], changedPages: ["Lightweight Amazon laundry baskets"] }),
    ["send"],
  ],
  [
    "#111: 'I've emailed you' right after the email went out",
    base({ from: "pm", request: "Email me the Oakland bulky-item pickup instructions", text: "I've emailed the Oakland bulky-item pickup instructions and scheduling link to your personal inbox.", recent: ["17:35 UTC sent (GMAIL_SEND_EMAIL to evan@personal.example.com): Oakland bulky-item pickup: Here are the instructions and the scheduling link…"] }),
    ["drop"],
  ],
  [
    "the email to Anthony Evan asked for",
    base({ to: "anthony_george@pacificadvisors.com", toCaller: false, channels: [], action: "GMAIL_SEND_EMAIL", subject: "Moving forward with the $5M policy", request: "Email Anthony that I want to go ahead with the $5M coverage and ask for next steps", text: "Hi Anthony, I'd like to proceed with the $5M coverage. What are the next steps? Thanks, Evan" }),
    ["send", "ask"],
  ],
  [
    "a second 'still working' note",
    base({ from: "pm", request: "Research summer camps", text: "Still working on the summer camp research; I'll send another note when it's done.", recent: ["18:02 UTC sent (imessage to +14155550190): Still working on the summer camp research."] }),
    ["drop", "hold"],
  ],
  [
    "'text me the link' as asked",
    base({ request: "Find a good gift for Cara and text me the link", text: "Here's the one: Casa de Chocolates bonbons, https://casadechocolates.com/bonbons", call: "Caller: Find a good gift for Cara and text me the link" }),
    ["send"],
    "imessage",
  ],
  [
    "a result he asked for, after the call ended",
    base({ from: "pm", request: "Move my dentist appointment to Friday", text: "I moved your dentist appointment to Friday at 3 PM." }),
    ["send"],
    "imessage",
  ],
  [
    "an email to his boss mentioning the Acme interview he asked to keep quiet",
    base({ to: "dan@work.example.com", toCaller: false, channels: [], action: "GMAIL_SEND_EMAIL", subject: "Weekly update", request: "Send Dan my weekly update", text: "Hi Dan, weekly update attached. Also, I'll be out Thursday for my Acme interview.", guidelines: `${GUIDELINES}\n- I'm quietly interviewing at Acme; nobody at work knows.` }),
    ["ask", "drop", "hold"],
  ],
  [
    "Oct 31 thread 2: flight links asked for by text are emailed from his Gmail",
    base({ conversation: "imessage", onCall: true, to: "evan@personal.example.com", channels: [], action: "GMAIL_SEND_EMAIL", subject: "Atlanta flight links: Nov 3–5", request: "Give me the links for these flights", text: "Hi Evan, here are flight information links and airline booking searches for your Atlanta trip. OUTBOUND — Tue Nov 3: Delta 2:08 PM SFO→ATL https://delta.com/…", call: "Caller: When I text you, just text me unless I explicitly ask. Can you give me the links for these flights?", guidelines: "- When I text you, reply by text unless I explicitly ask for another channel; a request for links alone is not a request to email." }),
    ["text_instead"],
  ],
  [
    "Oct 31 thread 3: a brief asked for by text ('Yes please') is emailed to his work address",
    base({ conversation: "imessage", onCall: true, to: "evan@work.example.com", channels: [], action: "GMAIL_SEND_EMAIL", subject: "Atlanta meeting brief: Northwind leadership and team", request: "Put together a brief on who I'm meeting in Atlanta", text: "Hi Evan, here is a briefing for your Nov 4–5 Atlanta visit with Northwind. MEETING CONTEXT …", call: "Kloru: Would you like me to put together a brief on them?\nCaller: Yes please", guidelines: "- When I text you, reply by text unless I explicitly ask for another channel." }),
    ["text_instead"],
  ],
  [
    "Oct 31 #140: the flights page link after the text thread ended, when only the flights were said",
    base({ conversation: "imessage", from: "pm", request: "Look up flights for my Atlanta trip next week", text: "Here's the page with your Atlanta flight options: https://kloru.com/a/BBX_W8zn1Ps1lu8CSM7HLQ", call: "Caller: Can you look up flights for my atl trip next week?\nKloru: I found a nonstop Delta flight leaving SFO on Tuesday at 2:08 p.m.…" }),
    ["send", "hold"],
    "imessage",
  ],
  [
    "a report he asked for by email, emailed back",
    base({ conversation: "email", defaultChannel: "email", to: "evan@personal.example.com", channels: [], action: "GMAIL_REPLY_TO_THREAD", subject: "Re: Daycare options", request: "Research daycares near Rockridge", text: "Here are the three daycares with openings: …", call: "Caller (by email): Can you research daycares near Rockridge with infant openings?" }),
    ["send"],
  ],
];

describe.skipIf(!key)("the message check on Jev, live", () => {
  const decide = comsDecider({ apiKey: key ?? "", timeoutMs: 8000 });
  for (const [name, c, ok, channel] of CASES) {
    it(name, async () => {
      const d = await decide(c);
      console.log(`${name}: ${d.action}${d.channel ? ` by ${d.channel}` : ""} (${d.p?.toFixed(2)})`);
      expect(ok).toContain(d.action);
      if (channel && d.action === "send") expect(d.channel).toBe(channel);
    }, 15_000);
  }
});
