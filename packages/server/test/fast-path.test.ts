import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@kloru/store";
import { describe, expect, it } from "vitest";
import { storeFastPath } from "../src/fast-path.js";

const NOW = new Date("2026-10-29T15:00:00Z"); // 8 AM in Oakland

function store() {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "fast-")), "store.db"), () => NOW);
  s.upsert([
    { source: "googlecalendar", account: "evan@example.com", kind: "event", externalId: "primary:e1", title: "Maya dentist", body: "Rockridge Kids Dental", people: [], startsAt: "2026-10-30T22:00:00Z", endsAt: "2026-10-30T23:00:00Z", occurredAt: "2026-10-30T22:00:00Z", data: { eventId: "e1", calendar: "primary" } },
    { source: "gmail", account: "evan@example.com", kind: "email", externalId: "m1", title: "Dinner Saturday?", body: "At my parents' at 6", people: ["Cara <cara@example.com>"], occurredAt: "2026-10-28T15:00:00Z", data: { unread: true } },
  ]);
  s.setSyncState("gmail", "evan@example.com", { lastOkAt: "2026-10-29T14:59:30Z" });
  s.setSyncState("googlecalendar", "evan@example.com", { lastOkAt: "2026-10-29T14:59:30Z" });
  return s;
}

/** A fake OpenRouter: the decision call gets the plan, the change call the change, the writing call the answer. */
function models(plan: unknown, answer: string, change?: unknown) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    const schema = (body.response_format as { json_schema?: { name?: string } } | undefined)?.json_schema?.name;
    const content = schema === "fast_path_change" ? JSON.stringify(change) : schema ? JSON.stringify(plan) : answer;
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const issue = (request: string) => ({ id: 1, request }) as never;

describe("answering a read from the store", () => {
  it("a caller who may not read Evan's mail never gets it from the store", async () => {
    const m = models({ decision: "answer", lookups: [{ type: "search", query: "dinner", kind: "any", from: "", to: "" }] }, "CANNOT");
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {}, mailAccounts: (phone) => (phone === "+14155550191" ? [] : undefined) });
    await fast({ id: 1, request: "Anything about dinner?", filedBy: { phone: "+14155550191", call: "c" } } as never);
    expect(JSON.stringify(m.bodies.at(-1)!.messages)).not.toContain("Dinner Saturday?");
    await fast({ id: 2, request: "Anything about dinner?", filedBy: { phone: "+14155550190", call: "c" } } as never);
    expect(JSON.stringify(m.bodies.at(-1)!.messages)).toContain("Dinner Saturday?");
  });

  it("plans lookups with a structured decision, reads the store, and speaks a short answer from those items", async () => {
    const m = models({ decision: "answer", lookups: [{ type: "calendar", query: "", kind: "event", from: "2026-10-30", to: "2026-10-31" }] }, "Tomorrow Maya has the dentist at 3 at Rockridge Kids Dental.");
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    const got = await fast(issue("What's on my calendar tomorrow?"));
    expect(got!.answer).toBe("Tomorrow Maya has the dentist at 3 at Rockridge Kids Dental.");
    expect(got!.note).toContain("event id e1");
    const [decision, writing] = m.bodies;
    expect(decision!.response_format).toMatchObject({ type: "json_schema" });
    expect(JSON.stringify(decision!.messages)).toContain("Thursday, October 29, 2026");
    expect(JSON.stringify(writing!.messages)).toContain("Maya dentist");
  });

  it("anything that changes, sends or researches is filed: the decision says so and nothing is read", async () => {
    const m = models({ decision: "file", lookups: [] }, "unused");
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    expect(await fast(issue("Email Sam that I'm late"))).toBeUndefined();
    expect(m.bodies).toHaveLength(1);
  });

  it("if the items don't answer it, the writer says so and the PM takes over", async () => {
    const m = models({ decision: "answer", lookups: [{ type: "search", query: "plumber invoice", kind: "email", from: "", to: "" }] }, "CANNOT");
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    expect(await fast(issue("Did the plumber send an invoice?"))).toBeUndefined();
  });

  it("a stale source is never answered from: the app is checked instead", async () => {
    const s = store();
    s.setSyncState("googlecalendar", "evan@example.com", { lastOkAt: "2026-10-29T13:00:00Z" });
    const m = models({ decision: "answer", lookups: [{ type: "calendar", query: "", kind: "event", from: "2026-10-30", to: "2026-10-31" }] }, "unused");
    const fast = storeFastPath({ store: s, apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    expect(await fast(issue("What's on tomorrow?"))).toBeUndefined();
  });
});

describe("a simple change, named exactly from the store's items", () => {
  const changeStore = () => {
    const s = store();
    s.upsert([
      { source: "googlecalendar", account: "evan@example.com", kind: "event", externalId: "primary:atl1", title: "Atlanta trip", body: "", people: [], startsAt: "2026-11-03", endsAt: "2026-11-06", occurredAt: "2026-11-03T08:00:00Z", data: { eventId: "atl1", calendar: "evan@example.com" } },
      { source: "gmail", account: "work@example.com", kind: "email", externalId: "p1", title: "50% off everything", body: "Sale", people: ["Shop <deals@shop.com>"], occurredAt: "2026-10-29T10:00:00Z", data: {} },
      { source: "gmail", account: "work@example.com", kind: "email", externalId: "p2", title: "Last chance!", body: "Sale", people: ["Shop <deals@shop.com>"], occurredAt: "2026-10-29T11:00:00Z", data: {} },
    ]);
    return s;
  };
  const plan = { decision: "change", lookups: [{ type: "search", query: "Atlanta", kind: "event", from: "", to: "" }] };
  const blank = { items: [], title: "", start: "", end: "", all_day: false, location: "", description: "", calendar: "" };

  it("moves an all-day event: ids, calendar and account come from the store item, never from the model", async () => {
    const m = models(plan, "unused", { actions: [{ ...blank, action: "update_event", items: [1], start: "2026-11-04", end: "2026-11-05", all_day: true }], say: "Done: your Atlanta trip is now the 4th and 5th." });
    const fast = storeFastPath({ store: changeStore(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    const got = await fast(issue("Move my Atlanta trip to November 4th and 5th"));
    expect(got!.say).toBe("Done: your Atlanta trip is now the 4th and 5th.");
    // The end of an all-day range is inclusive for people and exclusive for Google.
    expect(got!.changes).toEqual([{ slug: "GOOGLECALENDAR_PATCH_EVENT", args: { calendar_id: "evan@example.com", event_id: "atl1", start_time: "2026-11-04", end_time: "2026-11-06", send_updates: "none" }, account: "evan@example.com" }]);
    expect(JSON.stringify(m.bodies[1]!.messages)).toContain("[1]");
  });

  it("a timed move is said in the caller's wall time and sent with the right offset (after daylight saving ends)", async () => {
    const m = models(plan, "unused", { actions: [{ ...blank, action: "update_event", items: [1], start: "2026-11-04T10:00", end: "2026-11-04T11:30" }], say: "Moved." });
    const fast = storeFastPath({ store: changeStore(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    const got = await fast(issue("Make the Atlanta thing 10 to 11:30 on the 4th"));
    expect(got!.changes![0]!.args).toMatchObject({ start_time: "2026-11-04T10:00:00-08:00", end_time: "2026-11-04T11:30:00-08:00" });
  });

  it("trashes emails one action each, on the account each came from", async () => {
    const m = models({ decision: "change", lookups: [{ type: "search", query: "sale", kind: "email", from: "", to: "" }] }, "unused", { actions: [{ ...blank, action: "trash_emails", items: [1, 2] }], say: "Trashed both sale emails." });
    const fast = storeFastPath({ store: changeStore(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    const got = await fast(issue("Delete those two sale emails"));
    expect(got!.changes!.map((c) => [c.slug, c.args.message_id, c.account])).toEqual([
      ["GMAIL_MOVE_TO_TRASH", "p2", "work@example.com"],
      ["GMAIL_MOVE_TO_TRASH", "p1", "work@example.com"],
    ]);
  });

  it("creates an event with no item to find", async () => {
    const m = models({ decision: "change", lookups: [] }, "unused", { actions: [{ ...blank, action: "create_event", title: "Coffee with Sam", start: "2026-10-30T15:00", end: "2026-10-30T15:30" }], say: "Added coffee with Sam tomorrow at 3." });
    const fast = storeFastPath({ store: changeStore(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    const got = await fast(issue("Add coffee with Sam tomorrow at 3 for half an hour"));
    expect(got!.changes).toEqual([{ slug: "GOOGLECALENDAR_CREATE_EVENT", args: { calendar_id: "primary", summary: "Coffee with Sam", start_datetime: "2026-10-30T15:00:00", end_datetime: "2026-10-30T15:30:00", timezone: "America/Los_Angeles", send_updates: "none" } }]);
  });

  it("declines (the PM takes over) when the change model picks nothing or names an item that isn't there", async () => {
    for (const change of [{ actions: [], say: "" }, { actions: [{ ...blank, action: "delete_event", items: [9] }], say: "Deleted." }]) {
      const m = models(plan, "unused", change);
      const fast = storeFastPath({ store: changeStore(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
      expect(await fast(issue("Do something to the Atlanta trip"))).toBeUndefined();
    }
  });

  it("an event with other guests tells them (send_updates all); the decision model weighs that before it runs", async () => {
    const s = changeStore();
    s.upsert([{ source: "googlecalendar", account: "evan@example.com", kind: "event", externalId: "primary:m1", title: "Board meeting", body: "", people: ["evan@example.com", "jordan@example.com"], startsAt: "2026-11-02T17:00:00Z", endsAt: "2026-11-02T18:00:00Z", occurredAt: "2026-11-02T17:00:00Z", data: { eventId: "m1", calendar: "evan@example.com" } }]);
    const m = models({ decision: "change", lookups: [{ type: "search", query: "Board", kind: "event", from: "", to: "" }] }, "unused", { actions: [{ ...blank, action: "delete_event", items: [1] }], say: "Cancelled the board meeting." });
    const fast = storeFastPath({ store: s, apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {} });
    const got = await fast(issue("Cancel the board meeting"));
    expect(got!.changes).toEqual([{ slug: "GOOGLECALENDAR_DELETE_EVENT", args: { calendar_id: "evan@example.com", event_id: "m1", send_updates: "all" }, account: "evan@example.com" }]);
  });
});

describe("earlier tasks are part of what the fast path knows", () => {
  const TASKS = ["2026-10-31 #111 Look up Oakland bulky-item pickup (merged): Done. I emailed the Oakland bulky-item pickup instructions and scheduling link to evan@personal.example.com."];
  const evan = (request: string) => ({ id: 5, request, filedBy: { phone: "+14155550190", call: "c" } }) as never;

  it("a question about what Kloru found earlier is answered from its tasks, with no lookup", async () => {
    const m = models({ decision: "answer", lookups: [] }, "I emailed you Oakland's bulky-item pickup instructions and the scheduling link.");
    const asked: string[] = [];
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {}, tasks: (phone) => (asked.push(phone), TASKS) });
    const got = await fast(evan("What did you find about bulky pickup?"));
    expect(got!.answer).toContain("bulky-item");
    expect(asked).toEqual(["+14155550190"]);
    const [decision, writing] = m.bodies;
    expect(JSON.stringify(decision!.messages)).toContain("#111");
    expect(JSON.stringify(writing!.messages)).toContain("scheduling link");
  });

  it("with no earlier tasks, an answer with nothing to look up still goes to the PM", async () => {
    const m = models({ decision: "answer", lookups: [] }, "unused");
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {}, tasks: () => [] });
    expect(await fast(evan("What did you find about bulky pickup?"))).toBeUndefined();
    expect(m.bodies).toHaveLength(1);
  });

  it("store lookups and earlier tasks go to the writer together", async () => {
    const m = models({ decision: "answer", lookups: [{ type: "calendar", query: "", kind: "event", from: "2026-10-30", to: "2026-10-31" }] }, "Maya has the dentist tomorrow.");
    const fast = storeFastPath({ store: store(), apiKey: "k", timezone: "America/Los_Angeles", now: () => NOW, fetchImpl: m.fetchImpl, log: () => {}, tasks: () => TASKS });
    await fast(evan("What's tomorrow?"));
    const writing = JSON.stringify(m.bodies.at(-1)!.messages);
    expect(writing).toContain("Maya dentist");
    expect(writing).toContain("#111");
  });
});
