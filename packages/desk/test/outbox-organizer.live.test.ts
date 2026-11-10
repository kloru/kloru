/**
 * The real organizer model on outbox situations. Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/outbox-organizer.live.test.ts
 * KLORU_PM_MODEL picks the model (the organizer runs on the PM's model in production).
 */
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { resolveModel } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { OutboxOrganizer } from "../src/outbox-organizer.js";
import type { OrganizerActions, OrganizerView, OutboxPerson } from "../src/outbox.js";
import type { OutboxItem } from "../src/outbox-store.js";

const key = process.env.OPENROUTER_API_KEY;
const EZRA = "+14155550190";
const TZ = "America/Los_Angeles";

type Act = { tool: string; items?: string[]; text?: string; at?: Date };

function item(id: string, why: OutboxItem["why"], text: string, minutesAgo: number, now: Date, from: OutboxItem["from"] = { agent: "pm", issue: 1 }): OutboxItem {
  const at = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  return { id, at, updatedAt: at, phone: EZRA, state: "queued", why, text, from };
}

function person(now: Date, over: Partial<OutboxPerson> = {}): OutboxPerson {
  const localTime = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(now);
  return { name: "Ezra", localTime, guidelines: "", preferences: "", notes: "", inConversation: undefined, turns: [], running: [], channels: ["imessage", "email"], ...over };
}

async function run(view: OrganizerView): Promise<Act[]> {
  const acts: Act[] = [];
  const act: OrganizerActions = {
    send: async (o) => (acts.push({ tool: "send", items: o.items, ...(o.text ? { text: o.text } : {}) }), "Sent."),
    page: () => "https://kloru.com/a/Qm9vZ2xlR29vZ2xlR29vZ2",
    schedule: (o) => (acts.push({ tool: "schedule", items: o.items, at: o.at }), "Scheduled."),
    drop: (o) => (acts.push({ tool: "drop", items: o.items }), "Dropped."),
    wake: (o) => (acts.push({ tool: "wake", at: o.at }), "Set."),
    note: () => "Saved.",
    ask: async () => (acts.push({ tool: "ask" }), "Asked."),
  };
  const model = resolveModel(process.env.KLORU_PM_MODEL ?? "openrouter/google/gemini-3.5-flash", process.env);
  const logs: string[] = [];
  await new OutboxOrganizer({ model, streamFn: streamSimple as unknown as StreamFn, getApiKey: () => key, timezone: TZ, log: (m) => logs.push(m) }).organize(view, act);
  if (process.env.SHOW) console.log(JSON.stringify(acts, null, 1), logs.join("\n"));
  return acts;
}

const view = (now: Date, queued: OutboxItem[], over: Partial<OrganizerView> = {}, who: Partial<OutboxPerson> = {}): OrganizerView => ({ phone: EZRA, now, person: person(now, who), queued, scheduled: [], recent: [], requests: {}, changed: {}, ...over });

describe.skipIf(!key)("the outbox organizer, live", () => {
  it("three results that finished minutes apart go as one message", async () => {
    const now = new Date("2026-11-10T14:05:00-08:00");
    const acts = await run(
      view(now, [
        item("o_a", "result", "Nora's dentist checkup is booked: Maplewood Dental, Thu Nov 12 at 3:30 PM.", 4, now, { agent: "pm", issue: 11 }),
        item("o_b", "result", "The Little Pines tuition receipt is in your email.", 3, now, { agent: "pm", issue: 12 }),
        item("o_c", "result", "Dad's birthday dinner is on the calendar: Sat Nov 14, 6 PM.", 2, now, { agent: "pm", issue: 13 }),
      ], { requests: { o_a: "Book Nora's dentist checkup", o_b: "Email me the Little Pines tuition receipt", o_c: "Put Dad's birthday dinner on the calendar" } }),
    );
    const sends = acts.filter((a) => a.tool === "send");
    expect(sends, JSON.stringify(acts)).toHaveLength(1);
    expect([...sends[0]!.items!].sort()).toEqual(["o_a", "o_b", "o_c"]);
    expect(sends[0]!.text ?? "").toMatch(/dentist|Maplewood/i);
  }, 120_000);

  it("a report at 2 AM waits for the morning when their guidelines ask for quiet nights", async () => {
    const now = new Date("2026-11-10T02:10:00-08:00");
    const acts = await run(
      view(now, [item("o_r", "report", "Your daily news rundown is ready: three stories on Portland transit, one on school funding.", 1, now)], {}, { guidelines: "No messages between 10 PM and 7 AM unless it's urgent." }),
    );
    expect(acts.filter((a) => a.tool === "send"), JSON.stringify(acts)).toEqual([]);
    const later = acts.find((a) => (a.tool === "schedule" || a.tool === "wake") && a.at);
    expect(later, JSON.stringify(acts)).toBeDefined();
    expect(later!.at!.getTime()).toBeGreaterThanOrEqual(new Date("2026-11-10T07:00:00-08:00").getTime());
  }, 120_000);

  it("a question the work waits on goes now, on its own", async () => {
    const now = new Date("2026-11-10T14:05:00-08:00");
    const acts = await run(
      view(now, [
        item("o_q", "question", "Which card should I use for the Little Pines tuition: the Visa or the checking account?", 2, now, { agent: "pm", issue: 21 }),
        item("o_n", "report", "Weekly inbox cleanup: 42 promotional emails archived.", 1, now, { agent: "pm", issue: 22 }),
      ], { requests: { o_q: "Pay the Little Pines tuition" } }),
    );
    const sends = acts.filter((a) => a.tool === "send");
    const q = sends.find((s) => s.items!.includes("o_q"));
    expect(q, JSON.stringify(acts)).toBeDefined();
    expect(q!.items).toEqual(["o_q"]);
  }, 120_000);

  it("news they already got is dropped", async () => {
    const now = new Date("2026-11-10T14:05:00-08:00");
    const acts = await run(
      view(now, [item("o_d", "result", "Done: Nora's dentist checkup is booked at Maplewood Dental for Thu Nov 12 at 3:30 PM.", 2, now, { agent: "worker", issue: 11 })], {
        recent: ["1:58 PM sent by imessage (result): Nora's dentist checkup is booked: Maplewood Dental, Thu Nov 12 at 3:30 PM."],
        requests: { o_d: "Book Nora's dentist checkup" },
      }),
    );
    expect(acts.filter((a) => a.tool === "send"), JSON.stringify(acts)).toEqual([]);
    expect(acts.find((a) => a.tool === "drop")?.items).toEqual(["o_d"]);
  }, 120_000);
});
