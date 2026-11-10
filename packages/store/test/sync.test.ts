import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import { AccountsSyncer, Syncer, type Execute } from "../src/sync.js";

const ACCOUNT = "ezra@example.com";
const NOW = new Date("2026-10-29T08:00:00Z");

const msg = (id: string, at: string, o: Record<string, unknown> = {}) => ({
  messageId: id,
  threadId: `t-${id}`,
  messageTimestamp: at,
  labelIds: ["INBOX", "UNREAD"],
  sender: "Cleo Vega <cleo@example.com>",
  to: ACCOUNT,
  subject: `Subject ${id}`,
  messageText: `Body of ${id}`,
  display_url: `https://mail.google.com/mail/u/0/#inbox/${id}`,
  ...o,
});
const ev = (id: string, start: string, o: Record<string, unknown> = {}) => ({
  source_calendar_id: "primary",
  source_calendar_summary: "Ezra",
  event: { id, summary: `Event ${id}`, status: "confirmed", start: { dateTime: start }, end: { dateTime: new Date(Date.parse(start) + 3_600_000).toISOString() }, htmlLink: `https://calendar/${id}`, location: "Maplewood", attendees: [{ email: "cleo@example.com" }], ...o },
});

/** A fake Composio: records calls, answers from scripted handlers. */
function fake(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const execute: Execute = async (slug, args) => {
    calls.push({ slug, args });
    const h = handlers[slug];
    return h ? { ok: true, data: h(args) } : { ok: false, error: `no handler for ${slug}` };
  };
  return { calls, execute };
}

function setup(handlers: Record<string, (args: Record<string, unknown>) => unknown>, now = () => NOW) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sync-")), "store.db"), now);
  const f = fake({ GMAIL_GET_PROFILE: () => ({ emailAddress: ACCOUNT }), ...handlers });
  const syncer = new Syncer({ store, execute: f.execute, log: () => {}, now });
  return { store, syncer, calls: f.calls };
}

describe("syncing Gmail", () => {
  it("the fill takes the last 30 days page by page, resumes where it stopped, then backfills older mail", async () => {
    const pages: Record<string, unknown> = {
      "newer_than:30d|": { messages: [msg("m3", "2026-10-28T10:00:00Z"), msg("m2", "2026-10-27T10:00:00Z")], nextPageToken: "p2" },
      "newer_than:30d|p2": { messages: [msg("m1", "2026-10-20T10:00:00Z", { subject: "Dinner Saturday?", messageText: "At my parents' at 6" })] },
      "older_than:30d newer_than:1y|": { messages: [msg("m0", "2025-06-01T10:00:00Z")] },
    };
    const { store, syncer } = setup({ GMAIL_FETCH_EMAILS: (a) => pages[`${a.query}|${a.page_token ?? ""}`] });
    await syncer.gmailFill(1); // one page per run: it must resume
    expect(store.counts()).toEqual({ email: 2 });
    expect(store.syncState("gmail-fill", ACCOUNT)!.cursor).toBe("recent:p2");
    await syncer.gmailFill(1);
    expect(store.syncState("gmail-fill", ACCOUNT)!.cursor).toBe("older:");
    await syncer.gmailFill(1);
    expect(store.syncState("gmail-fill", ACCOUNT)!.cursor).toBe("done");
    expect(store.counts()).toEqual({ email: 4 });
    const hit = store.search({ query: "dinner parents" })[0]!;
    expect(hit).toMatchObject({ externalId: "m1", account: ACCOUNT, title: "Dinner Saturday?", occurredAt: "2026-10-20T10:00:00Z", url: "https://mail.google.com/mail/u/0/#inbox/m1" });
    expect(hit.people).toEqual(["Cleo Vega <cleo@example.com>", ACCOUNT]);
    expect(hit.data).toMatchObject({ threadId: "t-m1", unread: true });
    expect(await syncer.gmailFill(1)).toBe(0); // done is done
  });

  it("keeps the first 4 KB of a long email: enough to answer from, a fifth of the space (the 3 GB volume filled)", async () => {
    const { store, syncer } = setup({ GMAIL_FETCH_EMAILS: () => ({ messages: [msg("big", "2026-10-28T10:00:00Z", { messageText: "x".repeat(50_000) })] }) });
    await syncer.gmailFill(1);
    expect(store.search({ kind: "email" })[0]!.body.length).toBe(4000);
  });

  it("the first incremental sync starts from now; the fill covers the past", async () => {
    let query = "";
    const { store, syncer } = setup({ GMAIL_FETCH_EMAILS: (a) => ((query = String(a.query)), { messages: [] }) });
    await syncer.gmail();
    expect(query).toBe(`after:${NOW.getTime() / 1000 - 60}`);
    expect(store.syncState("gmail", ACCOUNT)!.cursor).toBe(String(NOW.getTime() / 1000));
  });

  it("later syncs only ask for what's newer, with a minute of overlap", async () => {
    let query = "";
    const { store, syncer } = setup({
      GMAIL_FETCH_EMAILS: (a) => {
        query = String(a.query);
        return { messages: [msg("m4", "2026-10-29T07:00:00Z")] };
      },
    });
    store.setSyncState("gmail", ACCOUNT, { cursor: "1761645600" });
    await syncer.gmail();
    expect(query).toContain(`after:${1761645600 - 60}`);
    expect(store.counts()).toEqual({ email: 1 });
  });

  it("mail moved to the trash is marked deleted, kept forever", async () => {
    const { store, syncer } = setup({
      GMAIL_FETCH_EMAILS: (a) => (String(a.query).includes("in:trash") ? { messages: [{ messageId: "m1" }] } : { messages: [] }),
    });
    store.setSyncState("gmail", ACCOUNT, { cursor: "1761645600" });
    store.upsert([{ source: "gmail", account: ACCOUNT, kind: "email", externalId: "m1", title: "promo", body: "", people: [], data: {} }]);
    await syncer.gmail({ recheck: true });
    expect(store.search({ kind: "email" })).toEqual([]);
    expect(store.search({ kind: "email", includeDeleted: true })).toHaveLength(1);
  });

  it("a failure is recorded, not thrown, and the cursor stays put", async () => {
    const { store, syncer } = setup({ GMAIL_FETCH_EMAILS: () => undefined });
    store.setSyncState("gmail", ACCOUNT, { cursor: "1761645600" });
    const failing = new Syncer({ store, execute: async (slug) => (slug === "GMAIL_GET_PROFILE" ? { ok: true, data: { emailAddress: ACCOUNT } } : { ok: false, error: "rate limited" }), log: () => {}, now: () => NOW });
    await failing.gmail();
    expect(store.syncState("gmail", ACCOUNT)).toMatchObject({ cursor: "1761645600", lastError: "rate limited" });
    void syncer;
  });
});

describe("syncing Calendar", () => {
  it("fills every calendar's events in a window, with ids to act on and who's invited", async () => {
    let args: Record<string, unknown> = {};
    const { store, syncer } = setup({
      GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: (a) => {
        args = a;
        return { events: [ev("e1", "2026-10-30T16:00:00Z"), ev("e2", "2026-10-30T22:00:00Z", { summary: "Nora dentist" })] };
      },
    });
    await syncer.calendar({ full: true });
    expect(args).toMatchObject({ single_events: true, show_deleted: true, response_detail: "full" });
    const day = store.calendar("2026-10-30T07:00:00Z", "2026-10-31T07:00:00Z");
    expect(day.map((e) => e.title)).toEqual(["Event e1", "Nora dentist"]);
    expect(day[1]).toMatchObject({ externalId: "primary:e2", url: "https://calendar/e2", people: ["cleo@example.com"] });
    expect(day[1]!.body).toContain("Maplewood");
  });

  it("an event cancelled or gone from the window is marked deleted", async () => {
    let round = 0;
    const { store, syncer } = setup({
      GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: () =>
        round++ === 0 ? { events: [ev("e1", "2026-10-30T16:00:00Z"), ev("e2", "2026-10-30T22:00:00Z"), ev("e3", "2026-10-31T16:00:00Z")] } : { events: [ev("e1", "2026-10-30T16:00:00Z", { status: "cancelled" }), ev("e3", "2026-10-31T16:00:00Z")] },
    });
    await syncer.calendar({ full: true });
    await syncer.calendar({ full: true });
    expect(store.calendar("2026-10-30T00:00:00Z", "2026-11-01T00:00:00Z").map((e) => e.externalId)).toEqual(["primary:e3"]);
  });

  it("all-day events are kept as dates", async () => {
    const { store, syncer } = setup({ GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS: () => ({ events: [{ source_calendar_id: "primary", event: { id: "a1", summary: "Tucson trip", status: "confirmed", start: { date: "2026-11-03" }, end: { date: "2026-11-06" } } }] }) });
    await syncer.calendar({ full: true });
    expect(store.calendar("2026-11-04T00:00:00Z", "2026-11-05T00:00:00Z")[0]).toMatchObject({ title: "Tucson trip", startsAt: "2026-11-03", endsAt: "2026-11-06" });
  });
});

describe("several accounts", () => {
  it("syncs each account's mail and calendar under its own address, as that account", async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "multi-")), "store.db"));
    const calls: Array<{ slug: string; account: string }> = [];
    const execute = async (slug: string, _args: Record<string, unknown>, account: string) => {
      calls.push({ slug, account });
      if (slug === "GMAIL_FETCH_EMAILS") return { ok: true, data: { messages: [msg(`m-${account}`, "2026-10-29T07:00:00Z")] } };
      return { ok: true, data: { events: [ev(`e-${account}`, "2026-10-29T17:00:00Z")] } };
    };
    const accounts = async () => [
      { id: "ca_home_mail", toolkit: "gmail", email: "ezra@gmail.example", status: "connected" as const },
      { id: "ca_work_mail", toolkit: "gmail", email: "ezra@work.example.com", status: "connected" as const },
      { id: "ca_old", toolkit: "gmail", status: "expired" as const },
      { id: "ca_work_cal", toolkit: "googlecalendar", email: "ezra@work.example.com", status: "connected" as const },
    ];
    const s = new AccountsSyncer({ store, accounts, execute, log: () => {}, now: () => NOW });
    await s.calendar();
    await s.gmailFill(1);
    expect(calls.filter((c) => c.slug.startsWith("GOOGLECALENDAR")).map((c) => c.account)).toEqual(["ca_work_cal"]);
    expect(new Set(calls.filter((c) => c.slug === "GMAIL_FETCH_EMAILS").map((c) => c.account))).toEqual(new Set(["ca_home_mail", "ca_work_mail"]));
    expect(store.syncStates().map((st) => `${st.source} ${st.account}`).sort()).toEqual(["gmail-fill ezra@gmail.example", "gmail-fill ezra@work.example.com", "googlecalendar ezra@work.example.com"]);
  });

  it("one account failing doesn't stop the others", async () => {
    const store = new Store(join(mkdtempSync(join(tmpdir(), "multi-")), "store.db"));
    const execute = async (_slug: string, _args: Record<string, unknown>, account: string) =>
      account === "ca_a" ? { ok: false, error: "token expired" } : { ok: true, data: { events: [ev("e1", "2026-10-29T17:00:00Z")] } };
    const accounts = async () => [
      { id: "ca_a", toolkit: "googlecalendar", email: "a@x.example", status: "connected" as const },
      { id: "ca_b", toolkit: "googlecalendar", email: "b@x.example", status: "connected" as const },
    ];
    const s = new AccountsSyncer({ store, accounts, execute, log: () => {}, now: () => NOW });
    expect(await s.calendar()).toBe(1);
    expect(store.syncState("googlecalendar", "a@x.example")?.lastError).toContain("token expired");
  });
});
