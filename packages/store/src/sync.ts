/**
 * Keeping the store fresh from Composio (store design, "Sync").
 *
 * Gmail: Composio has no history API, so new mail is fetched by time (`after:<cursor>`), the first
 * fill takes the last 30 days page by page, older mail (to a year back) backfills a page per run until done, and the
 * trash is re-checked so deletions show. Calendar: every calendar's events in a window, with
 * cancelled and vanished events marked deleted; a short window each run, a year each way daily.
 * Every source records its last success or error; a failure never throws out of a run.
 */
import type { ItemInput, Store } from "./store.js";

export type Execute = (slug: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>;

const DAY = 86_400_000;
const PAGE = 100;
const PAGES_PER_RUN = 10;
/** The first 4 KB answers almost anything asked about an email; whole bodies filled the volume (2026-10-29). */
export const BODY_MAX = 4000;

interface GmailMessage {
  messageId?: string;
  threadId?: string;
  messageTimestamp?: string;
  labelIds?: string[];
  sender?: string;
  to?: string;
  subject?: string;
  messageText?: string;
  preview?: { body?: string; subject?: string };
  display_url?: string;
  attachmentList?: Array<{ filename?: string }>;
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
  attendees?: Array<{ email?: string; displayName?: string }>;
  organizer?: { email?: string };
  recurringEventId?: string;
}

const stamp = (s: string | undefined) => {
  if (!s) return undefined;
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.000Z$/, "Z");
};

export function emailItem(account: string, m: GmailMessage): ItemInput | undefined {
  if (!m.messageId) return undefined;
  const labels = m.labelIds ?? [];
  const occurredAt = stamp(m.messageTimestamp);
  return {
    source: "gmail",
    account,
    kind: "email",
    externalId: m.messageId,
    title: m.subject ?? m.preview?.subject ?? "",
    body: (m.messageText ?? m.preview?.body ?? "").slice(0, BODY_MAX),
    people: [m.sender, m.to].filter((p): p is string => !!p),
    ...(occurredAt ? { occurredAt } : {}),
    ...(m.display_url ? { url: m.display_url.endsWith("/") ? `${m.display_url}${m.messageId}` : m.display_url } : {}),
    data: { threadId: m.threadId, labels, unread: labels.includes("UNREAD"), important: labels.includes("IMPORTANT"), attachments: (m.attachmentList ?? []).map((a) => a.filename).filter(Boolean) },
  };
}

export function eventItem(account: string, calendarId: string, calendarName: string | undefined, e: CalendarEvent): ItemInput | undefined {
  if (!e.id) return undefined;
  const startsAt = e.start?.dateTime ? stamp(e.start.dateTime) : e.start?.date;
  const endsAt = e.end?.dateTime ? stamp(e.end.dateTime) : e.end?.date;
  return {
    source: "googlecalendar",
    account,
    kind: "event",
    externalId: `${calendarId}:${e.id}`,
    title: e.summary ?? "(no title)",
    body: [e.location, e.description].filter(Boolean).join("\n").slice(0, BODY_MAX),
    people: (e.attendees ?? []).map((a) => a.email ?? a.displayName ?? "").filter(Boolean),
    ...(startsAt ? { startsAt, occurredAt: startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(e.htmlLink ? { url: e.htmlLink } : {}),
    data: { calendar: calendarId, calendarName, eventId: e.id, status: e.status, location: e.location, organizer: e.organizer?.email, recurring: !!e.recurringEventId, allDay: !e.start?.dateTime },
  };
}

export class Syncer {
  private account: string | undefined;
  private readonly store: Store;
  private readonly execute: Execute;
  private readonly log: (m: string) => void;
  private readonly now: () => Date;

  constructor(o: { store: Store; execute: Execute; log: (m: string) => void; now?: () => Date; account?: string }) {
    this.store = o.store;
    this.execute = o.execute;
    this.log = o.log;
    this.now = o.now ?? (() => new Date());
    this.account = o.account;
  }

  /** The connected Google account's address: what every item is filed under. */
  private async who(): Promise<string> {
    if (this.account) return this.account;
    const p = await this.execute("GMAIL_GET_PROFILE", {});
    const address = (p.data as { emailAddress?: string } | undefined)?.emailAddress;
    if (!p.ok || !address) throw new Error(`can't tell which account is connected: ${p.error ?? "no email address"}`);
    this.account = address;
    return address;
  }

  private async call(slug: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.execute(slug, args);
    if (!r.ok) throw new Error(r.error ?? `${slug} failed`);
    return (r.data ?? {}) as Record<string, unknown>;
  }

  private failed(source: string, account: string | undefined, error: unknown): void {
    const why = error instanceof Error ? error.message : String(error);
    this.log(`store: ${source} sync failed: ${why}`);
    if (account) this.store.setSyncState(source, account, { lastError: why, lastErrorAt: this.now().toISOString() });
  }

  /** New mail since the cursor (the first time: from now; gmailFill covers the past); with recheck, the trash too. */
  async gmail(o: { recheck?: boolean } = {}): Promise<number> {
    let account: string | undefined;
    try {
      account = await this.who();
      const state = this.store.syncState("gmail", account);
      const start = state?.cursor ? Number(state.cursor) : Math.floor(this.now().getTime() / 1000);
      let token: string | undefined;
      let newest = start;
      let saved = 0;
      for (let page = 0; page < PAGES_PER_RUN; page++) {
        const data = await this.call("GMAIL_FETCH_EMAILS", { query: `after:${start - 60}`, max_results: PAGE, include_payload: false, ...(token ? { page_token: token } : {}) });
        const items = ((data.messages ?? []) as GmailMessage[]).map((m) => emailItem(account!, m)).filter((i): i is ItemInput => !!i);
        saved += this.store.upsert(items);
        for (const i of items) if (i.occurredAt) newest = Math.max(newest, Math.floor(Date.parse(i.occurredAt) / 1000));
        token = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
        if (!token) break;
      }
      if (o.recheck) {
        const trash = await this.call("GMAIL_FETCH_EMAILS", { query: "in:trash newer_than:3d", ids_only: true, include_spam_trash: true, max_results: 500 });
        this.store.markDeleted("gmail", account, ((trash.messages ?? []) as GmailMessage[]).map((m) => m.messageId).filter((x): x is string => !!x));
      }
      this.store.setSyncState("gmail", account, { cursor: String(newest), lastOkAt: this.now().toISOString(), lastError: undefined, lastErrorAt: undefined });
      return saved;
    } catch (error) {
      this.failed("gmail", account, error);
      return 0;
    }
  }

  /**
   * The past, a few pages per run until the whole mailbox is in (kept forever): first the last 30
   * days (recent: the store is useful within minutes), then everything older. Resumable: the
   * cursor is "<phase>:<page token>", then "done".
   */
  async gmailFill(pages = PAGES_PER_RUN): Promise<number> {
    let account: string | undefined;
    try {
      account = await this.who();
      const key = "gmail-fill";
      const cursor = this.store.syncState(key, account)?.cursor ?? "recent:";
      if (cursor === "done") return 0;
      let [phase, token] = cursor.split(/:(.*)/s) as [string, string | undefined];
      let saved = 0;
      for (let page = 0; page < pages; page++) {
        const data = await this.call("GMAIL_FETCH_EMAILS", { query: phase === "recent" ? "newer_than:30d" : "older_than:30d newer_than:1y", max_results: PAGE, include_payload: false, ...(token ? { page_token: token } : {}) });
        saved += this.store.upsert(((data.messages ?? []) as GmailMessage[]).map((m) => emailItem(account!, m)).filter((i): i is ItemInput => !!i));
        token = typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
        if (token) continue;
        if (phase === "recent") {
          phase = "older";
          break; // the next run starts on older mail
        }
        phase = "done";
        break;
      }
      this.store.setSyncState(key, account, { cursor: phase === "done" ? "done" : `${phase}:${token ?? ""}`, lastOkAt: this.now().toISOString(), lastError: undefined, lastErrorAt: undefined });
      return saved;
    } catch (error) {
      this.failed("gmail-fill", account, error);
      return 0;
    }
  }

  /** Every calendar's events in a window: by default a day back to 60 ahead; full is a year each way. */
  async calendar(o: { full?: boolean } = {}): Promise<number> {
    let account: string | undefined;
    try {
      account = await this.who();
      const now = this.now().getTime();
      const from = new Date(now - (o.full ? 365 : 1) * DAY).toISOString();
      const to = new Date(now + (o.full ? 365 : 60) * DAY).toISOString();
      const data = await this.call("GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS", { time_min: from, time_max: to, single_events: true, show_deleted: true, response_detail: "full", max_results_per_calendar: 2500 });
      const rows = (data.events ?? []) as Array<{ event?: CalendarEvent; source_calendar_id?: string; source_calendar_summary?: string }>;
      const live: ItemInput[] = [];
      const cancelled: string[] = [];
      for (const r of rows) {
        const item = r.event ? eventItem(account, r.source_calendar_id ?? "primary", r.source_calendar_summary, r.event) : undefined;
        if (!item) continue;
        if (r.event?.status === "cancelled") cancelled.push(item.externalId);
        else live.push(item);
      }
      this.store.upsert(live);
      this.store.markDeleted("googlecalendar", account, cancelled);
      // Anything the store had in this window that the calendar no longer returns is gone.
      const seen = new Set([...live.map((i) => i.externalId), ...cancelled]);
      this.store.markDeleted("googlecalendar", account, this.store.idsIn("googlecalendar", account, "event", from, to).filter((id) => !seen.has(id)));
      this.store.setSyncState("googlecalendar", account, { cursor: o.full ? `full:${this.now().toISOString()}` : this.store.syncState("googlecalendar", account)?.cursor, lastOkAt: this.now().toISOString(), lastError: undefined, lastErrorAt: undefined });
      return live.length;
    } catch (error) {
      this.failed("googlecalendar", account, error);
      return 0;
    }
  }
}

/** One connected account, as the apps adapter lists it. */
export interface SyncAccount {
  id: string;
  toolkit: string;
  email?: string;
  status: "connected" | "expired";
}

/**
 * Several Google accounts (a personal and a work one): each Gmail and each Calendar account syncs
 * as itself, filed under its own address. The accounts are listed each run, so one connected on the
 * website syncs within a run. One account failing doesn't stop the rest.
 */
export class AccountsSyncer {
  constructor(
    private readonly o: {
      store: Store;
      accounts: () => Promise<SyncAccount[]>;
      execute: (slug: string, args: Record<string, unknown>, account: string) => ReturnType<Execute>;
      log: (m: string) => void;
      now?: () => Date;
    },
  ) {}

  private async each(toolkit: string, run: (s: Syncer) => Promise<number>): Promise<number> {
    let accounts: SyncAccount[];
    try {
      accounts = (await this.o.accounts()).filter((a) => a.toolkit === toolkit && a.status === "connected" && a.email);
    } catch (e) {
      this.o.log(`store: can't list accounts: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    }
    let n = 0;
    for (const a of accounts) {
      const execute: Execute = (slug, args) => this.o.execute(slug, args, a.id);
      n += await run(new Syncer({ store: this.o.store, execute, log: this.o.log, account: a.email!, ...(this.o.now ? { now: this.o.now } : {}) }));
    }
    return n;
  }

  calendar(o: { full?: boolean } = {}): Promise<number> {
    return this.each("googlecalendar", (s) => s.calendar(o));
  }

  gmail(o: { recheck?: boolean } = {}): Promise<number> {
    return this.each("gmail", (s) => s.gmail(o));
  }

  gmailFill(pages?: number): Promise<number> {
    return this.each("gmail", (s) => s.gmailFill(pages));
  }
}
