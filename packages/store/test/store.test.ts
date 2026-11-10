import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type ItemInput } from "../src/store.js";

const fresh = () => new Store(join(mkdtempSync(join(tmpdir(), "store-")), "store.db"));

const email = (id: string, o: Partial<ItemInput> = {}): ItemInput => ({
  source: "gmail",
  account: "ezra@example.com",
  kind: "email",
  externalId: id,
  title: "Dinner Saturday?",
  body: "Want to do dinner at my parents' on Saturday at 6? Love, Cleo",
  people: ["Cleo Vega <cleo@example.com>"],
  occurredAt: "2026-10-28T15:00:00Z",
  data: { threadId: "t1", labelIds: ["INBOX", "UNREAD"] },
  ...o,
});
const event = (id: string, starts: string, o: Partial<ItemInput> = {}): ItemInput => ({
  source: "googlecalendar",
  account: "ezra@example.com",
  kind: "event",
  externalId: id,
  title: "Nora dentist",
  body: "Maplewood Kids Dental",
  people: [],
  startsAt: starts,
  endsAt: new Date(Date.parse(starts) + 3_600_000).toISOString(),
  occurredAt: starts,
  data: {},
  ...o,
});

describe("the store", () => {
  it("email can be limited to the accounts a caller may read; events are shared", () => {
    const s = fresh();
    s.upsert([email("e1"), email("c1", { account: "cleo@example.com" }), event("ev1", "2026-10-30T17:00:00Z", { title: "Dinner at Nora's" })]);
    expect(s.search({ query: "dinner", mailAccounts: ["cleo@example.com"] }).map((i) => i.externalId).sort()).toEqual(["c1", "ev1"]);
    expect(s.search({ query: "dinner", mailAccounts: [] }).map((i) => i.externalId)).toEqual(["ev1"]);
    expect(s.search({ query: "dinner" })).toHaveLength(3);
  });

  it("finds things by any word, in milliseconds, with the source id to act on", () => {
    const s = fresh();
    s.upsert([email("m1"), email("m2", { title: "Your Amazon order shipped", body: "Package arrives Thursday", people: ["Amazon <ship@amazon.example>"] })]);
    const hits = s.search({ query: "dinner cleo" });
    expect(hits.map((h) => h.externalId)).toEqual(["m1"]);
    expect(hits[0]!.id).toBe("gmail:ezra@example.com:m1");
    expect(s.search({ query: "amazon" })[0]!.externalId).toBe("m2");
  });

  it("searching with odd characters never breaks the query", () => {
    const s = fresh();
    s.upsert([email("m1")]);
    for (const q of ['"', "dinner AND", "OR", "*", "parents'", "NEAR(", "-cleo"]) expect(() => s.search({ query: q })).not.toThrow();
  });

  it("an update replaces the item and its search text", () => {
    const s = fresh();
    s.upsert([email("m1")]);
    s.upsert([email("m1", { title: "Brunch Sunday?", body: "Brunch instead" })]);
    expect(s.search({ query: "dinner" })).toEqual([]);
    expect(s.search({ query: "brunch" })).toHaveLength(1);
    expect(s.counts()).toEqual({ email: 1 });
  });

  it("something deleted at the source is kept forever but hidden from agents by default", () => {
    const s = fresh();
    s.upsert([email("m1")]);
    s.markDeleted("gmail", "ezra@example.com", ["m1"], "2026-10-29T00:00:00Z");
    expect(s.search({ query: "dinner" })).toEqual([]);
    expect(s.search({ query: "dinner", includeDeleted: true })[0]!.deletedAt).toBe("2026-10-29T00:00:00Z");
    s.upsert([email("m1")]); // it came back (moved out of the trash)
    expect(s.search({ query: "dinner" })).toHaveLength(1);
  });

  it("the calendar view returns events overlapping a window, in order", () => {
    const s = fresh();
    s.upsert([event("e2", "2026-10-30T22:00:00Z"), event("e1", "2026-10-30T16:00:00Z", { title: "Daycare drop-off" }), event("e0", "2026-10-28T16:00:00Z")]);
    const day = s.calendar("2026-10-30T07:00:00Z", "2026-10-31T07:00:00Z");
    expect(day.map((e) => e.title)).toEqual(["Daycare drop-off", "Nora dentist"]);
  });

  it("filters by kind and time, newest first without a query", () => {
    const s = fresh();
    s.upsert([email("old", { occurredAt: "2026-01-01T00:00:00Z" }), email("new", { occurredAt: "2026-10-28T00:00:00Z" }), event("e1", "2026-10-30T16:00:00Z")]);
    expect(s.search({ kind: "email" }).map((i) => i.externalId)).toEqual(["new", "old"]);
    expect(s.search({ kind: "email", from: "2026-06-01T00:00:00Z" }).map((i) => i.externalId)).toEqual(["new"]);
  });

  it("remembers each source's sync cursor and when it last worked", () => {
    const s = fresh();
    expect(s.syncState("gmail", "ezra@example.com")).toBeUndefined();
    s.setSyncState("gmail", "ezra@example.com", { cursor: "1761600000", lastOkAt: "2026-10-29T06:00:00Z" });
    s.setSyncState("gmail", "ezra@example.com", { lastError: "rate limited" });
    expect(s.syncState("gmail", "ezra@example.com")).toMatchObject({ cursor: "1761600000", lastOkAt: "2026-10-29T06:00:00Z", lastError: "rate limited" });
    expect(s.syncStates()).toHaveLength(1);
  });

  it("survives a reopen: it's a file on the volume", () => {
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "store.db");
    new Store(path).upsert([email("m1")]);
    expect(new Store(path).search({ query: "dinner" })).toHaveLength(1);
  });
});

describe("keeping the store small", () => {
  it("search keeps no second copy of the text: the index is contentless, and replacing an item replaces its words", () => {
    const s = fresh();
    s.upsert([email("m1")]);
    s.upsert([email("m1", { title: "Lunch Friday?", body: "Noon at Zachary's" })]);
    expect(s.search({ query: "dinner" })).toEqual([]);
    expect(s.search({ query: "zachary" }).map((i) => i.externalId)).toEqual(["m1"]);
    expect(s.ftsSchema()).toContain("content=''");
  });

  it("compact trims long bodies, drops mail older than a year, moves an old index to contentless, and search still works", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-"));
    const path = join(dir, "store.db");
    const now = () => new Date("2026-10-29T12:00:00Z");
    // An older store: the index kept its own copy of every body.
    new Store(path, now).close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP TABLE items_fts; CREATE VIRTUAL TABLE items_fts USING fts5(title, body, people, tokenize = 'unicode61 remove_diacritics 2');");
    raw.close();
    const old = new Store(path, now);
    expect(old.ftsSchema()).not.toContain("content=''");
    old.upsert([email("big", { body: "y".repeat(30_000) + " needle" }), email("ancient", { occurredAt: "2024-01-01T00:00:00Z", title: "Old newsletter" }), email("m1"), event("e1", "2024-02-01T17:00:00Z")]);
    old.close();
    const s = new Store(path, now);
    const r = s.compact({ bodyMax: 4000, keepDays: 365 });
    expect(r).toMatchObject({ trimmed: 1, dropped: 1, reindexed: 3 });
    expect(s.search({ query: "dinner" }).map((i) => i.externalId).sort()).toEqual(["big", "m1"]);
    expect(s.search({ query: "needle" })).toEqual([]); // it was past the first 4 KB
    expect(s.search({ kind: "email" }).map((i) => i.externalId).sort()).toEqual(["big", "m1"]);
    expect(s.search({ kind: "email" }).find((i) => i.externalId === "big")!.body.length).toBe(4000);
    expect(s.search({ query: "nora" }).map((i) => i.externalId)).toEqual(["e1"]); // old events stay: a year each way
    expect(s.ftsSchema()).toContain("content=''");
  });
});

describe("the write-ahead log stays small", () => {
  it("a WAL left large by a big write is cut back when the store opens, and capped after", async () => {
    const { statSync } = await import("node:fs");
    const path = join(mkdtempSync(join(tmpdir(), "store-")), "store.db");
    new Store(path).upsert([email("m0")]);
    // Another connection that stays open (as the live agent does) writes a lot without checkpointing.
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA wal_autocheckpoint = 0; CREATE TABLE IF NOT EXISTS big (b BLOB);");
    const ins = raw.prepare("INSERT INTO big VALUES (?)");
    raw.exec("BEGIN");
    for (let i = 0; i < 200; i++) ins.run(Buffer.alloc(100_000, i));
    raw.exec("COMMIT; DELETE FROM big;");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(15_000_000);
    const store = new Store(path);
    expect(statSync(`${path}-wal`).size).toBeLessThan(1_000_000);
    expect(store.search({ query: "dinner" })).toHaveLength(1);
    raw.close();
  });
});
