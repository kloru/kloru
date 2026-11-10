import type { FirstPassCheck, OutboxItem } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { FIRST_PASS, outboxDecider } from "../src/outbox-decider.js";

const EZRA = "+14155550190";
const item = (o: Partial<OutboxItem> = {}): OutboxItem => ({ id: "o_1", at: "2026-11-10T22:00:00.000Z", updatedAt: "2026-11-10T22:00:00.000Z", phone: EZRA, state: "new", why: "result", text: "Maplewood Dental can see Nora on Friday at 3.", from: { agent: "worker", issue: 7 }, ...o });
const check = (o: Partial<FirstPassCheck> = {}): FirstPassCheck => ({
  item: item(),
  request: "Find a dentist for Nora",
  changedPages: [],
  waitedMinutes: 0,
  firing: false,
  person: { name: "Ezra", localTime: "Tue, Nov 10, 2:00 PM", guidelines: "Text me short updates.", preferences: "", notes: "", inConversation: undefined, turns: [], running: [], channels: ["imessage", "email"] },
  queued: [],
  scheduled: [],
  recent: [],
  now: new Date("2026-11-10T22:00:00Z"),
  ...o,
});

function fake(answers: unknown, seen: Array<{ url: string; body: Record<string, any> }>, status = 200): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers }), { status });
  }) as unknown as typeof fetch;
}
const choice = (c: string, p: number) => ({ action: { type: "choice", choice: c, probabilities: { [c]: p } } });

describe("the outbox's fast pass on Jev", () => {
  it("asks Jev, never the router, for one of three choices, with the whole picture as state", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = outboxDecider({ apiKey: "k", fetchImpl: fake(choice("send", 0.9), seen) });
    const other = item({ id: "o_2", text: "The weekly summary is ready.", why: "report" });
    expect(await decide(check({ queued: [other], recent: ["21:40 UTC sent (imessage to +14155550190): On it."], changedPages: ["Dentists"] }))).toBe("send");
    const { body } = seen[0]!;
    expect(body.model).toBe("typesafe/jev-1.14");
    expect(Object.keys(body.questions.action.criteria)).toEqual(["send", "drop", "organizer"]);
    expect(body.questions.action.criteria).toEqual(FIRST_PASS);
    expect(body.state.message).toMatchObject({ why_it_exists: "the result of something they asked for", text: "Maplewood Dental can see Nora on Friday at 3.", written_by: "the worker doing the task" });
    expect(body.state.what_they_asked).toBe("Find a dentist for Nora");
    expect(body.state.their_time_now).toBe("Tue, Nov 10, 2:00 PM");
    expect(body.state.their_guidelines).toBe("Text me short updates.");
    expect(body.state.also_waiting_in_their_outbox).toEqual([expect.stringContaining("The weekly summary is ready.")]);
    expect(body.state.sent_or_dropped_in_the_last_day).toEqual(["21:40 UTC sent (imessage to +14155550190): On it."]);
    expect(body.state.pages_it_links_that_changed_since_they_got_the_link).toEqual(["Dentists"]);
  });

  it("a reminder at its time says so", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    const decide = outboxDecider({ apiKey: "k", fetchImpl: fake(choice("send", 0.9), seen) });
    await decide(check({ firing: true, item: item({ why: "reminder", text: "Reminder: take the bins out.", from: { agent: "talker" }, sendAt: "2026-11-11T14:30:00.000Z" }), request: "" }));
    expect(seen[0]!.body.state.message.its_time_has_come).toMatch(/the time they chose/);
    expect(seen[0]!.body.state.what_they_asked).toBe("(nothing by hand)");
  });

  it("a drop it isn't sure of goes to the organizer; a sure one stays a drop", async () => {
    const unsure = outboxDecider({ apiKey: "k", fetchImpl: fake(choice("drop", 0.56), []) });
    const sure = outboxDecider({ apiKey: "k", fetchImpl: fake(choice("drop", 0.93), []) });
    expect(await unsure(check())).toBe("organizer");
    expect(await sure(check())).toBe("drop");
  });

  it("an answer that isn't one of the three, or a failed call, throws, so the outbox takes its safe path", async () => {
    await expect(outboxDecider({ apiKey: "k", fetchImpl: fake(choice("hold", 0.9), []) })(check())).rejects.toThrow(/no action/);
    await expect(outboxDecider({ apiKey: "k", fetchImpl: fake({}, [], 500) })(check())).rejects.toThrow(/500/);
  });

  it("logs every decision", async () => {
    const lines: string[] = [];
    await outboxDecider({ apiKey: "k", fetchImpl: fake(choice("organizer", 0.8), []), log: (m) => lines.push(m) })(check());
    expect(lines).toEqual(["outbox o_1: fast pass → organizer (organizer 0.80)"]);
  });
});
