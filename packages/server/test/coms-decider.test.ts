import type { MessageCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { comsDecider } from "../src/coms-decider.js";

const check: MessageCheck = {
  to: "+14155550190",
  toCaller: true,
  from: "pm",
  text: "I've emailed the bulky-item pickup instructions to your personal inbox.",
  channels: ["imessage", "email"],
  request: "Email me the bulky-item pickup instructions",
  call: "Caller: Email me the bulky-item pickup instructions",
  guidelines: "Text me short updates.",
  onCall: false,
  running: [],
  recent: ["17:35 UTC sent (GMAIL_SEND_EMAIL to evan@personal.example.com): Bulky pickup: Instructions…"],
  conversation: "imessage",
  defaultChannel: "imessage",
};

function fake(answers: unknown, seen: Array<{ url: string; body: Record<string, any> }>, status = 200): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers }), { status });
  }) as unknown as typeof fetch;
}

describe("the message check on Jev", () => {
  it("a talker draft is offered only send, hold or drop; a direct answer to them only send or drop", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "send", probabilities: { send: 0.9 } } }, seen) });
    await decide({ ...check, from: "talker", text: "Here's what I found.", channels: ["imessage"], running: ["Find a cheaper hotel"] });
    await decide({ ...check, from: "talker", text: "On it.", channels: ["imessage"], replyingTo: "What's the link to the parking at SFO?" });
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).toEqual(["send", "hold", "drop"]);
    expect(seen[0]!.body.state.message.drafted_by).toMatch(/conversation/);
    expect(Object.keys(seen[1]!.body.questions.action.criteria)).toEqual(["send", "drop"]);
    expect(seen[1]!.body.state.answers_their_message).toBe("What's the link to the parking at SFO?");
  });

  it("in its conversation with them, hold is offered only while more for them is still running (Nov 2)", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "send", probabilities: { send: 0.9 } } }, seen) });
    await decide({ ...check, from: "talker", text: "I updated the page with four options up to $100.", channels: ["imessage"], running: [] });
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).toEqual(["send", "drop"]);
  });

  it("the note after a conversation is offered no hold when nothing else is running", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "send", probabilities: { send: 0.9 } } }, seen) });
    await decide({ ...check, from: "pm", running: [] });
    await decide({ ...check, from: "pm", running: ["Find a cheaper hotel"] });
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).not.toContain("hold");
    expect(Object.keys(seen[1]!.body.questions.action.criteria)).toContain("hold");
  });

  it("tells Jev which linked pages changed since they got the link", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "send", probabilities: { send: 0.9 } } }, seen) });
    await decide({ ...check, changedPages: ["Lightweight Amazon laundry baskets"] });
    await decide(check);
    expect(seen[0]!.body.state.pages_changed_since_they_got_the_link).toEqual(["Lightweight Amazon laundry baskets"]);
    expect(seen[1]!.body.state.pages_changed_since_they_got_the_link).toBeUndefined();
  });

  it("asks Jev's decisions endpoint what to do and where, and reads its choice", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "drop", probabilities: { drop: 0.92 } }, channel: { type: "choice", choice: "imessage", probabilities: { imessage: 0.7 } } }, seen) });
    expect(await decide(check)).toEqual({ action: "drop", channel: "imessage", p: 0.92 });
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(seen[0]!.body.model).toBe("typesafe/jev-1.14");
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).toEqual(["send", "drop", "ask"]);
    expect(seen[0]!.body.state).toMatchObject({ message: { text: check.text }, already_sent_today: check.recent, their_guidelines: "Text me short updates." });
  });

  it("asks about the channel only when there's a choice, and about the owner only for someone who isn't him", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "send", probabilities: { send: 0.8 } } }, seen) });
    expect(await decide({ ...check, channels: [], toCaller: false, to: "boss@work.example.com", ownerGuidelines: "Cara may email anyone." })).toEqual({ action: "send", p: 0.8 });
    expect(seen[0]!.body.questions.channel).toBeUndefined();
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).toContain("ask_owner");
  });

  it("an answer that isn't a choice, or an error status, throws (the desk then falls back)", async () => {
    await expect(comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "noul", noul: 0.5 } }, []) })(check)).rejects.toThrow();
    await expect(comsDecider({ apiKey: "k", fetchImpl: fake({}, [], 503) })(check)).rejects.toThrow(/503/);
  });

  it("knows the conversation and its default reply channel, and offers text_instead for an email to the caller from their own account", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = comsDecider({ apiKey: "k", fetchImpl: fake({ action: { type: "choice", choice: "text_instead", probabilities: { text_instead: 0.8 } } }, seen) });
    expect(await decide({ ...check, action: "GMAIL_SEND_EMAIL", channels: [] })).toEqual({ action: "text_instead", p: 0.8 });
    expect(seen[0]!.body.state).toMatchObject({ conversation: "by text (iMessage)", default_reply_channel: "imessage" });
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).toContain("text_instead");
    seen.length = 0;
    await decide({ ...check, action: "GMAIL_SEND_EMAIL", channels: [], conversation: "email", defaultChannel: "email" });
    expect(Object.keys(seen[0]!.body.questions.action.criteria)).not.toContain("text_instead");
  });
});
