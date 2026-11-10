import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyncRunner } from "../src/runner.js";
import { Store } from "../src/store.js";
import { storeTools } from "../src/tools.js";

class FakeSyncer {
  log: string[] = [];
  async calendar(o: { full?: boolean } = {}) {
    this.log.push(o.full ? "calendar:full" : "calendar");
    return 0;
  }
  async gmail(o: { recheck?: boolean } = {}) {
    this.log.push(o.recheck ? "gmail:recheck" : "gmail");
    return 0;
  }
  async gmailFill() {
    this.log.push("fill");
    return 0;
  }
}

describe("keeping it fresh", () => {
  it("a run does calendar and mail, the full calendar and the trash recheck only when due, and the fill until done", async () => {
    const syncer = new FakeSyncer();
    let now = Date.parse("2026-10-29T08:00:00Z");
    const runner = new SyncRunner(syncer, () => {}, () => new Date(now));
    await runner.runOnce();
    expect(syncer.log).toEqual(["calendar:full", "gmail:recheck", "fill"]);
    syncer.log = [];
    now += 2 * 60_000;
    await runner.runOnce();
    expect(syncer.log).toEqual(["calendar", "gmail", "fill"]);
    syncer.log = [];
    now += 15 * 60_000;
    await runner.runOnce();
    expect(syncer.log).toEqual(["calendar", "gmail:recheck", "fill"]);
  });

  it("after Kloru changes something, that source is refreshed at once (write-through)", async () => {
    const syncer = new FakeSyncer();
    const runner = new SyncRunner(syncer, () => {}, () => new Date("2026-10-29T08:00:00Z"));
    await runner.runOnce();
    syncer.log = [];
    await runner.kick("GOOGLECALENDAR_CREATE_EVENT");
    await runner.kick("GMAIL_MOVE_TO_TRASH");
    await runner.kick("SLACK_SEND_MESSAGE");
    expect(syncer.log).toEqual(["calendar", "gmail:recheck"]);
  });
});

describe("reading it: the store tools", () => {
  function store() {
    const s = new Store(join(mkdtempSync(join(tmpdir(), "tools-")), "store.db"), () => new Date("2026-10-29T08:00:00Z"));
    s.upsert([
      { source: "gmail", account: "ezra@example.com", kind: "email", externalId: "m1", title: "Dinner Saturday?", body: "At my parents' at 6", people: ["Cleo <cleo@example.com>"], occurredAt: "2026-10-28T15:00:00Z", url: "https://mail/m1", data: { unread: true, threadId: "t1" } },
      { source: "googlecalendar", account: "ezra@example.com", kind: "event", externalId: "primary:e1", title: "Nora dentist", body: "Maplewood Kids Dental", people: [], startsAt: "2026-10-30T22:00:00Z", endsAt: "2026-10-30T23:00:00Z", occurredAt: "2026-10-30T22:00:00Z", data: { eventId: "e1", calendar: "primary" } },
    ]);
    s.setSyncState("gmail", "ezra@example.com", { lastOkAt: "2026-10-29T07:59:20Z" });
    s.setSyncState("googlecalendar", "ezra@example.com", { lastOkAt: "2026-10-29T07:20:00Z" });
    return s;
  }
  const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

  it("search returns compact lines with the ids ops needs, and says how fresh it is", async () => {
    const tools = Object.fromEntries(storeTools(store(), "America/Los_Angeles", () => new Date("2026-10-29T08:00:00Z")).map((t) => [t.spec.name, t]));
    const out = text(await tools.store_search!.spec.execute({ query: "dinner" }, {} as never));
    expect(out).toContain("Dinner Saturday?");
    expect(out).toContain("gmail message id m1");
    expect(out).toContain("thread t1");
    expect(out).toMatch(/email as of 40 s ago/);
  });

  it("the calendar view lists events in the owner's time, with event ids, and flags a stale source", async () => {
    const tools = Object.fromEntries(storeTools(store(), "America/Los_Angeles", () => new Date("2026-10-29T08:00:00Z")).map((t) => [t.spec.name, t]));
    const out = text(await tools.store_calendar!.spec.execute({ from: "2026-10-30", to: "2026-10-31" }, {} as never));
    expect(out).toContain("Fri, Oct 30, 3:00 PM");
    expect(out).toContain("Nora dentist");
    expect(out).toContain("event id e1 (calendar primary)");
    expect(out).toMatch(/calendar last synced 40 min ago; check the app/i);
  });

  it("get returns one item in full", async () => {
    const tools = Object.fromEntries(storeTools(store(), "America/Los_Angeles").map((t) => [t.spec.name, t]));
    expect(text(await tools.store_get!.spec.execute({ id: "gmail:ezra@example.com:m1" }, {} as never))).toContain("At my parents' at 6");
  });

  it("a caller who may not read an account's mail never sees it, by search or by id", async () => {
    const scope = (key: string) => (key.includes(":7:") ? [] : undefined); // issue 7 is Cleo's, with none of Ezra's mail
    const tools = Object.fromEntries(storeTools(store(), "America/Los_Angeles", () => new Date("2026-10-29T08:00:00Z"), scope).map((t) => [t.spec.name, t]));
    const cleo = { conversationKey: "desk:issue:7:ops" } as never;
    expect(text(await tools.store_search!.spec.execute({ query: "dinner" }, cleo))).not.toContain("Dinner Saturday?");
    expect(await tools.store_get!.spec.execute({ id: "gmail:ezra@example.com:m1" }, cleo)).toMatchObject({ isError: true });
    expect(text(await tools.store_search!.spec.execute({ query: "dinner" }, { conversationKey: "desk:issue:8:ops" } as never))).toContain("Dinner Saturday?");
  });

  it("a caller who may not see a calendar sees none of it, or only busy times where that's all they may see", async () => {
    const scope = (key: string) =>
      key.includes(":7:") ? { mail: [], events: [] } : key.includes(":8:") ? { mail: [], events: [], busy: ["ezra@example.com"] } : undefined;
    const tools = Object.fromEntries(storeTools(store(), "America/Los_Angeles", () => new Date("2026-10-29T08:00:00Z"), scope).map((t) => [t.spec.name, t]));
    const nothing = { conversationKey: "desk:issue:7:ops" } as never;
    const busy = { conversationKey: "desk:issue:8:ops" } as never;
    expect(text(await tools.store_calendar!.spec.execute({ from: "2026-10-30", to: "2026-10-31" }, nothing))).not.toContain("Nora dentist");
    expect(text(await tools.store_search!.spec.execute({ query: "dentist" }, nothing))).not.toContain("Nora dentist");
    const b = text(await tools.store_calendar!.spec.execute({ from: "2026-10-30", to: "2026-10-31" }, busy));
    expect(b).toContain("Busy");
    expect(b).toContain("3:00 PM");
    expect(b).not.toContain("Nora dentist");
    expect(b).not.toContain("Maplewood");
    expect(await tools.store_get!.spec.execute({ id: "googlecalendar:ezra@example.com:primary:e1" }, nothing)).toMatchObject({ isError: true });
  });
});
