import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dayView } from "../src/dayview.js";
import { Store } from "../src/store.js";

const NOW = new Date("2026-10-29T15:00:00Z"); // Thu 8 AM in Oakland

it("today, tomorrow and recent unread mail, short enough to read before every call", () => {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "day-")), "store.db"), () => NOW);
  const ev = (id: string, start: string, title: string) => ({ source: "googlecalendar", account: "e", kind: "event", externalId: id, title, body: "", people: [], startsAt: start, endsAt: start, occurredAt: start, data: {} });
  s.upsert([
    ev("a", "2026-10-29T15:00:00Z", "Drop-off at day care"),
    ev("b", "2026-10-29T23:30:00Z", "Pickup Maya"),
    ev("c", "2026-10-30T22:00:00Z", "Maya dentist"),
    ev("d", "2026-11-02T22:00:00Z", "Next week thing"),
    { source: "gmail", account: "e", kind: "email", externalId: "m1", title: "Dinner Saturday?", body: "", people: ["Cara Marshall <cara@example.com>"], occurredAt: "2026-10-29T13:00:00Z", data: { unread: true } },
    { source: "gmail", account: "e", kind: "email", externalId: "m2", title: "Read already", body: "", people: ["X <x@example.com>"], occurredAt: "2026-10-29T13:00:00Z", data: { unread: false } },
    { source: "gmail", account: "e", kind: "email", externalId: "m3", title: "50% off today", body: "", people: ["Shop <s@example.com>"], occurredAt: "2026-10-29T14:00:00Z", data: { unread: true, labels: ["UNREAD", "CATEGORY_PROMOTIONS"] } },
  ]);
  s.setSyncState("googlecalendar", "e", { lastOkAt: "2026-10-29T14:59:00Z" });
  const v = dayView(s, "America/Los_Angeles", NOW);
  expect(v).toContain("Today (Thu, Oct 29): 8:00 AM Drop-off at day care; 4:30 PM Pickup Maya");
  expect(v).toContain("Tomorrow (Fri, Oct 30): 3:00 PM Maya dentist");
  expect(v).not.toContain("Next week thing");
  expect(v).toContain("Unread mail (2 days): Cara Marshall: Dinner Saturday?");
  expect(v).not.toContain("Read already");
  expect(v).not.toContain("50% off"); // promotions, social, forums and updates aren't news
  expect(v.length).toBeLessThan(500);
});

describe("empty or stale", () => {
  it("says nothing when the store has nothing", () => {
    const s = new Store(":memory:", () => NOW);
    expect(dayView(s, "America/Los_Angeles", NOW)).toBe("");
  });
});

it("Evan's day shows only his accounts: Cara's mail and calendar stay hers", () => {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "day-")), "store.db"), () => NOW);
  const ev = (id: string, account: string, title: string) => ({ source: "googlecalendar", account, kind: "event", externalId: id, title, body: "", people: [], startsAt: "2026-10-29T18:00:00Z", endsAt: "2026-10-29T19:00:00Z", occurredAt: "2026-10-29T18:00:00Z", data: {} });
  const mail = (id: string, account: string, title: string) => ({ source: "gmail", account, kind: "email", externalId: id, title, body: "", people: ["X <x@example.com>"], occurredAt: "2026-10-29T13:00:00Z", data: { unread: true } });
  s.upsert([ev("a", "evan@x.com", "Board prep"), ev("b", "cara@x.com", "Cara's therapist"), mail("m1", "evan@x.com", "Deck notes"), mail("m2", "cara@x.com", "Cara's private note")]);
  const v = dayView(s, "America/Los_Angeles", NOW, { mail: ["evan@x.com"], events: ["evan@x.com"] });
  expect(v).toContain("Board prep");
  expect(v).toContain("Deck notes");
  expect(v).not.toContain("Cara's therapist");
  expect(v).not.toContain("Cara's private note");
});
