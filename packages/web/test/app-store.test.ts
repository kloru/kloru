import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppStore, ERRORS_PER_VERSION, RECORDS_PER_APP } from "../src/app-store.js";

const APP = "Qm9vZ2xlR29vZ2xlR29vZ3";
const CLEO = { by: "Cleo", owner: "u:+14155550191" };
const EZRA = { by: "Ezra", owner: "u:+14155550190" };
const GUEST = { by: "visitor", owner: "v:abc" };

describe("app store (2026-11-09)", () => {
  it("keeps records per app and collection, oldest first, stamped with who added them and when", () => {
    const s = new AppStore(":memory:");
    const milk = s.put(APP, "items", { name: "Milk", done: false }, CLEO, { now: new Date("2026-11-09T18:00:00Z") });
    s.put(APP, "items", { name: "Eggs" }, EZRA);
    s.put("another-app-another-app", "items", { name: "Theirs" }, EZRA);
    expect(milk).toMatchObject({ ok: true, record: { name: "Milk", done: false, by: "Cleo", at: "2026-11-09T18:00:00.000Z" } });
    expect(s.list(APP, "items").map((r) => r.name)).toEqual(["Milk", "Eggs"]);
    expect(s.list(APP, "other")).toEqual([]);
  });

  it("a record with an id replaces that one in place: someone else ticking it off doesn't change who added it", () => {
    const s = new AppStore(":memory:");
    const milk = s.put(APP, "items", { name: "Milk" }, CLEO);
    if (!milk.ok) throw new Error(milk.error);
    s.put(APP, "items", { name: "Eggs" }, CLEO);
    const ticked = s.put(APP, "items", { ...milk.record, done: true, by: "Mallory" }, EZRA);
    expect(ticked).toMatchObject({ ok: true, record: { id: milk.record.id, name: "Milk", done: true, by: "Cleo", at: milk.record.at } });
    expect(s.list(APP, "items").map((r) => r.name)).toEqual(["Milk", "Eggs"]);
  });

  it("every change bumps the app's rev; reading doesn't", () => {
    const s = new AppStore(":memory:");
    expect(s.rev(APP)).toBe(0);
    const a = s.put(APP, "items", { name: "Milk" }, CLEO);
    s.put(APP, "items", { id: (a as { record: { id: string } }).record.id, name: "Oat milk" }, CLEO);
    s.list(APP, "items");
    expect(s.rev(APP)).toBe(2);
    expect(s.remove(APP, "items", "nope")).toBe(false);
    expect(s.remove(APP, "items", (a as { record: { id: string } }).record.id)).toBe(true);
    expect(s.rev(APP)).toBe(3);
    expect(s.rev("another-app-another-app")).toBe(0);
  });

  it("a guest's own records: listed alone, and only theirs to replace or remove", () => {
    const s = new AppStore(":memory:");
    const family = s.put(APP, "rsvps", { name: "Cleo" }, CLEO) as { record: { id: string } };
    const mine = s.put(APP, "rsvps", { name: "Sam" }, GUEST) as { record: { id: string } };
    expect(s.list(APP, "rsvps", GUEST.owner).map((r) => r.name)).toEqual(["Sam"]);
    expect(s.put(APP, "rsvps", { id: family.record.id, name: "Hacked" }, GUEST, { own: true })).toMatchObject({ ok: false, status: 403 });
    expect(s.put(APP, "rsvps", { id: mine.record.id, name: "Sam +1" }, GUEST, { own: true })).toMatchObject({ ok: true });
    expect(s.remove(APP, "rsvps", family.record.id, GUEST.owner)).toBe(false);
    expect(s.remove(APP, "rsvps", mine.record.id, GUEST.owner)).toBe(true);
    expect(s.list(APP, "rsvps").map((r) => r.name)).toEqual(["Cleo"]);
  });

  it("refuses what isn't a record, a bad name or id, a record over 16 KB, and more than an app holds", () => {
    const s = new AppStore(":memory:");
    expect(s.put(APP, "items", "milk", CLEO)).toMatchObject({ ok: false, status: 400 });
    expect(s.put(APP, "items", [1], CLEO)).toMatchObject({ ok: false, status: 400 });
    expect(s.put(APP, "Items!", { a: 1 }, CLEO)).toMatchObject({ ok: false, status: 400 });
    expect(s.put(APP, "items", { id: "../x" }, CLEO)).toMatchObject({ ok: false, status: 400 });
    expect(s.put(APP, "items", { note: "x".repeat(17_000) }, CLEO)).toMatchObject({ ok: false, status: 413 });
    for (let i = 0; i < RECORDS_PER_APP; i++) s.put(APP, "items", { i }, CLEO);
    expect(s.put(APP, "items", { i: "one more" }, CLEO)).toMatchObject({ ok: false, status: 413, error: expect.stringMatching(/full/) });
    expect(s.put(APP, "items", { id: s.list(APP, "items")[0]!.id, i: "changed" }, CLEO)).toMatchObject({ ok: true });
  });

  it("keeps each script error once per version, the first few only", () => {
    const s = new AppStore(":memory:");
    s.reportError(APP, 1, "TypeError: items.map is not a function\n  (line 6)");
    s.reportError(APP, 1, "TypeError: items.map is not a function (line 6)");
    s.reportError(APP, 2, "ReferenceError: qty is not defined");
    expect(s.errors(APP, 1)).toEqual(["TypeError: items.map is not a function (line 6)"]);
    expect(s.errors(APP, 2)).toEqual(["ReferenceError: qty is not defined"]);
    for (let i = 0; i < 40; i++) s.reportError(APP, 3, `error ${i}`);
    expect(s.errors(APP, 3)).toHaveLength(ERRORS_PER_VERSION);
  });

  it("the agent opens the website's file read-only, or nothing when it isn't there yet", () => {
    const path = join(mkdtempSync(join(tmpdir(), "apps-db-")), "apps.db");
    expect(AppStore.openReadOnly(path)).toBeUndefined();
    const s = new AppStore(path);
    s.reportError(APP, 1, "boom");
    const reader = AppStore.openReadOnly(path)!;
    expect(reader.errors(APP, 1)).toEqual(["boom"]);
    s.reportError(APP, 1, "later");
    expect(reader.errors(APP, 1)).toEqual(["boom", "later"]);
    expect(() => reader.reportError(APP, 1, "x")).toThrow();
    reader.close();
    s.close();
  });
});
