/**
 * The store, for workers: search, a calendar view and one item in full. Every answer carries the
 * ids an app action needs (#29) and how fresh each source is; past 10 minutes it says to check
 * the app instead.
 */
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import type { Item, Store } from "./store.js";

export const STORE_TOOLS: ReadonlySet<string> = new Set(["store_search", "store_calendar", "store_get"]);
const STALE_MS = 10 * 60_000;
const SOURCE_NAMES: Record<string, string> = { gmail: "email", googlecalendar: "calendar" };

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** One item as a compact line: when, who or where, the title, and the ids an app action needs. */
export function formatItem(i: Item, timezone: string): string {
  const when = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const show = (iso: string | undefined) => (!iso ? "" : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${day.format(new Date(`${iso}T12:00:00Z`))} (all day)` : when.format(new Date(iso)));
  const d = (i.data ?? {}) as Record<string, unknown>;
  if (i.kind === "email") {
    return `- ${show(i.occurredAt)} | ${i.people[0] ?? ""} | ${i.title}${d.unread ? " (unread)" : ""} | gmail message id ${i.externalId}${d.threadId ? `, thread ${String(d.threadId)}` : ""} | store id ${i.id}\n  ${i.body.replace(/\s+/g, " ").slice(0, 200)}`;
  }
  if (i.kind === "event") {
    return `- ${show(i.startsAt)}${i.endsAt && i.startsAt && !/^\d{4}-\d{2}-\d{2}$/.test(i.startsAt) ? ` to ${show(i.endsAt).split(", ").at(-1)}` : ""} | ${i.title}${d.location ? ` @ ${String(d.location)}` : ""}${d.calendarName ? ` [${String(d.calendarName)}]` : ""} | event id ${String(d.eventId ?? i.externalId)} (calendar ${String(d.calendar ?? "")})${i.people.length ? ` | with ${i.people.slice(0, 5).join(", ")}` : ""}`;
  }
  return `- ${show(i.occurredAt)} | ${i.kind} | ${i.title} | store id ${i.id}`;
}

/** How fresh each source is, and whether any is too old to answer from (10 minutes). */
export function freshness(store: Store, sources: string[], now: Date): { text: string; stale: boolean } {
  let stale = false;
  const text = sources
    .map((src) => {
      const st = store.syncStates().find((x) => x.source === src);
      const name = SOURCE_NAMES[src] ?? src;
      if (!st?.lastOkAt) {
        stale = true;
        return `${name} hasn't synced yet; check the app.`;
      }
      const age = now.getTime() - Date.parse(st.lastOkAt);
      if (age > STALE_MS) {
        stale = true;
        return `${name} last synced ${ago(age)}; check the app for anything newer.`;
      }
      return `${name} as of ${ago(age)}.`;
    })
    .join(" ");
  return { text, stale };
}

/** What one caller may see in the store (undefined fields: no limit). */
export interface StoreScope {
  /** Accounts whose mail they may read. */
  mail?: string[];
  /** Accounts whose events they may see in full; events from any other account are hidden... */
  events?: string[];
  /** ...except these, shown only as busy times. */
  busy?: string[];
}

/**
 * `callerScope`: for a conversation, the accounts whose mail its caller may read (undefined: all).
 * A family member's worker sees only hers, plus the owner's when he gave her his email.
 */
export function storeTools(store: Store, timezone: string, now: () => Date = () => new Date(), callerScope: (conversationKey: string) => StoreScope | string[] | undefined = () => undefined): RegisteredTool[] {
  const line = (i: Item) => formatItem(i, timezone);
  /** The caller's view: mail from their accounts; events in full from theirs, as busy from busy ones, none from others. */
  const scopeOf = (key: string): StoreScope | undefined => {
    const s = callerScope(key);
    return Array.isArray(s) ? { mail: s } : s;
  };
  const view = (i: Item, s: StoreScope | undefined): Item | undefined => {
    if (!s) return i;
    const account = i.account.toLowerCase();
    if (i.kind === "email") return !s.mail || s.mail.includes(account) ? i : undefined;
    if (i.kind !== "event" || !s.events) return i;
    if (s.events.includes(account)) return i;
    return s.busy?.includes(account) ? { ...i, title: "Busy", body: "", people: [], data: {} } : undefined;
  };
  const shown = (items: Item[], s: StoreScope | undefined) => items.flatMap((i) => view(i, s) ?? []);
  const fresh = (sources: string[]) => freshness(store, sources, now()).text;
  return [
    defineTool({
      name: "store_search",
      label: "Search the store",
      description:
        "Search Kloru's synced copy of the family's email and calendar (milliseconds; use this before the app tools). Words match subject, body and people; filter by kind (email, event) and time. Results carry the ids app actions need.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "words to find, e.g. 'daycare invoice' or a person's name; omit for newest first" })),
        kind: Type.Optional(Type.String({ description: "email or event" })),
        from: Type.Optional(Type.String({ description: "ISO date/time: only items at or after" })),
        to: Type.Optional(Type.String({ description: "ISO date/time: only items before" })),
        limit: Type.Optional(Type.Number({ description: "default 20, at most 200" })),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ query, kind, from, to, limit }, ctx) => {
        const scope = scopeOf(ctx?.conversationKey ?? "");
        // Busy-only events never match by their words: search only what the caller may read in full.
        const hits = shown(store.search({ ...(query ? { query } : {}), ...(kind ? { kind } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...(scope?.mail ? { mailAccounts: scope.mail } : {}), limit: limit ?? 20 }), scope && { ...scope, busy: [] });
        const sources = kind === "event" ? ["googlecalendar"] : kind === "email" ? ["gmail"] : ["gmail", "googlecalendar"];
        return textResult(`${hits.length ? hits.map(line).join("\n") : "Nothing in the store matches."}\n(${fresh(sources)})`);
      },
    }),
    defineTool({
      name: "store_calendar",
      label: "Calendar from the store",
      description: "Every event across the family's calendars between two dates, in order, from Kloru's synced copy (milliseconds). Event ids are what calendar actions need.",
      parameters: Type.Object({
        from: Type.String({ description: "ISO date or date/time, e.g. 2026-10-30" }),
        to: Type.String({ description: "ISO date or date/time (exclusive)" }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ from, to }, ctx) => {
        const scope = scopeOf(ctx?.conversationKey ?? "");
        const start = /^\d{4}-\d{2}-\d{2}$/.test(from) ? zoned(from, timezone) : from;
        const end = /^\d{4}-\d{2}-\d{2}$/.test(to) ? zoned(to, timezone) : to;
        const events = shown(store.calendar(start, end), scope);
        return textResult(`${events.length ? events.map(line).join("\n") : "No events in that range."}\n(${fresh(["googlecalendar"])})`);
      },
    }),
    defineTool({
      name: "store_get",
      label: "One item from the store",
      description: "One email or event in full, by its store id (from store_search or store_calendar).",
      parameters: Type.Object({ id: Type.String() }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id }, ctx) => {
        const found = store.get(id);
        const i = found && view(found, scopeOf(ctx?.conversationKey ?? ""));
        if (!i) return { content: [{ type: "text" as const, text: `No item ${id}.` }], isError: true };
        return textResult(`${line(i)}\n\n${i.body}\n\n${JSON.stringify(i.data)}`);
      },
    }),
  ];
}

/** Midnight of a calendar date in a timezone, as an ISO instant. */
export function zoned(date: string, tz: string): string {
  const utcMidnight = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(utcMidnight);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asLocal = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(utcMidnight.getTime() - (asLocal - utcMidnight.getTime())).toISOString();
}
