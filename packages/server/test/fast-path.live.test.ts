/**
 * The fast path on real models, with a store shaped like Evan's: does it pick the right path
 * (answer, change, file) and the right exact actions? Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/fast-path.live.test.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@kloru/store";
import { describe, expect, it } from "vitest";
import { storeFastPath } from "../src/fast-path.js";

const key = process.env.OPENROUTER_API_KEY;
const NOW = new Date("2026-10-29T23:06:00Z"); // Thursday 4:06 PM in Oakland
const ME = "evan@personal.example.com";

function store() {
  const s = new Store(join(mkdtempSync(join(tmpdir(), "fast-live-")), "store.db"), () => NOW);
  const ev = (id: string, title: string, startsAt: string, endsAt: string, calendar = ME, people: string[] = [], account = ME) => ({ source: "googlecalendar", account, kind: "event", externalId: `${calendar}:${id}`, title, body: "", people, startsAt, endsAt, occurredAt: startsAt.length === 10 ? `${startsAt}T08:00:00Z` : startsAt, data: { eventId: id, calendar } });
  const mail = (id: string, from: string, title: string, at: string, account = ME) => ({ source: "gmail", account, kind: "email", externalId: id, title, body: title, people: [from], occurredAt: at, data: {} });
  s.upsert([
    ev("atl1", "Atlanta trip", "2026-11-03", "2026-11-07"),
    ev("atl2", "Atlanta trip — fly out evening Nov 3", "2026-11-03", "2026-11-07", "evan@work.example.com", [], "evan@work.example.com"),
    ev("dc1", "No day care", "2026-10-30", "2026-10-31", "cara@personal.example.com"),
    ev("ped1", "PEDIATRICIAN 9 month well visit", "2026-11-04T22:00:00Z", "2026-11-04T23:00:00Z", "cara@personal.example.com"),
    ev("board1", "Board meeting", "2026-11-02T17:00:00Z", "2026-11-02T18:00:00Z", "evan@work.example.com", ["evan@work.example.com", "jordan@work.example.com", "investor@vc.com"], "evan@work.example.com"),
    ev("sam1", "Coffee with Sam", "2026-10-30T17:00:00Z", "2026-10-30T17:30:00Z"),
    mail("p1", "Old Navy <deals@oldnavy.com>", "50% off everything this weekend!", "2026-10-29T18:00:00Z"),
    mail("p2", "Wayfair <shop@wayfair.com>", "Your cart misses you", "2026-10-29T17:00:00Z"),
    mail("c1", "Cara <cara@personal.example.com>", "Dinner Saturday at my parents?", "2026-10-29T16:00:00Z"),
  ]);
  for (const a of [ME, "evan@work.example.com"]) {
    s.setSyncState("gmail", a, { lastOkAt: "2026-10-29T23:05:30Z" });
    s.setSyncState("googlecalendar", a, { lastOkAt: "2026-10-29T23:05:30Z" });
  }
  return s;
}

describe.skipIf(!key)("the fast path on real models", () => {
  const fast = () => storeFastPath({ store: store(), apiKey: key!, timezone: "America/Los_Angeles", now: () => NOW, log: (m) => console.log(m) });
  const ask = (request: string) => fast()({ id: 1, request } as never);

  it("moves both Atlanta trip events to Nov 4 to 5 on both calendars, all day", async () => {
    const got = await ask("Update Evan's Atlanta trip: the trip is November 4–5, 2026, flying out the evening of Tuesday, November 3. Update his calendar events accordingly.");
    console.log(JSON.stringify(got?.changes), got?.say);
    // "The trip is Nov 4 to 5, flying out the evening of Nov 3": starting it on the 3rd is a fair reading too.
    expect(got?.changes?.map((c) => c.args.event_id).sort()).toEqual(["atl1", "atl2"]);
    for (const c of got!.changes!) expect(c).toMatchObject({ slug: "GOOGLECALENDAR_PATCH_EVENT", args: { start_time: expect.stringMatching(/^2026-11-0[34]$/), end_time: "2026-11-06" } });
  }, 30_000);

  it("adds an event at the right time", async () => {
    const got = await ask("Add lunch with Jordan tomorrow, Friday October 30, at noon for an hour");
    console.log(JSON.stringify(got?.changes), got?.say);
    expect(got?.changes).toMatchObject([{ slug: "GOOGLECALENDAR_CREATE_EVENT", args: { summary: expect.stringMatching(/Jordan/), start_datetime: "2026-10-30T12:00:00", end_datetime: "2026-10-30T13:00:00" } }]);
  }, 30_000);

  it("cancels coffee with Sam", async () => {
    const got = await ask("Cancel my coffee with Sam tomorrow");
    console.log(JSON.stringify(got?.changes), got?.say);
    expect(got?.changes).toMatchObject([{ slug: "GOOGLECALENDAR_DELETE_EVENT", args: { event_id: "sam1" } }]);
  }, 30_000);

  it("trashes the two named promos, not Cara's email", async () => {
    const got = await ask("Delete the Old Navy and Wayfair emails from today");
    console.log(JSON.stringify(got?.changes), got?.say);
    expect(got?.changes?.map((c) => c.args.message_id).sort()).toEqual(["p1", "p2"]);
  }, 30_000);

  it("answers a read, and files what it can't do", async () => {
    const read = await ask("When is the pediatrician visit?");
    console.log(read?.answer);
    expect(read?.answer).toMatch(/Nov|4th|Wednesday/);
    expect(await ask("Email Sam that I'm running ten minutes late")).toBeUndefined();
    expect(await ask("Go through my whole inbox and delete all the promotional emails")).toBeUndefined();
  }, 60_000);

  it("going through mail: what came in is a read, a named delete is a change", async () => {
    const list = await ask("What emails did I get today?");
    console.log("LIST", list?.answer);
    expect(list?.answer).toMatch(/Old Navy|Wayfair|Cara/);
    const del = await ask("Delete that Old Navy one");
    console.log("DEL", JSON.stringify(del?.changes));
    expect(del?.changes?.map((c) => c.args.message_id)).toEqual(["p1"]);
  }, 60_000);
});
