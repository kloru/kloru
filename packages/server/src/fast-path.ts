/**
 * The fast path (#27, store design step 4): a read the store can answer is answered in seconds,
 * before the PM starts. Two model calls, both cheap and fast:
 *
 *   1. A decision with a schema (decision-models skill): answer or file, and up to 3 lookups.
 *   2. A short spoken answer written from the looked-up items alone, or CANNOT.
 *
 * A simple change (move, rename, add or cancel an event; trash or archive some mail) takes a second
 * model call instead of the writer: it picks actions on numbered store items, and the ids, calendar
 * and account come from those items, never from the model. The desk weighs and runs them.
 *
 * Anything that sends or researches is filed; so is anything whose source is stale or whose items
 * don't answer it. Declining is always safe: the PM takes over, as before.
 */
import type { FastAnswer, FastChange, Issue } from "@kloru/desk";
import { chatCompletion } from "./openrouter.js";
import { formatItem, freshness, zoned, type Item, type Store } from "@kloru/store";

// Measured 2026-10-29: Flash Lite decides in ~1.3 s and writes in ~1.1 s (Luna ~3.0 and ~1.6). Flash decides
// ~0.5 s slower but found both copies of a trip that Lite missed half the time (live test), so it plans.
const DECISION_MODEL = "google/gemini-3.5-flash";
const WRITER_MODEL = "google/gemini-3.5-flash-lite";
// A change is worth a second more: Flash Lite missed one of two matching events and added events nobody asked for.
const CHANGE_MODEL = "google/gemini-3.5-flash";

interface Lookup {
  type: "calendar" | "search";
  query: string;
  kind: "email" | "event" | "any";
  from: string;
  to: string;
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "lookups"],
  properties: {
    decision: { type: "string", enum: ["answer", "change", "file"] },
    lookups: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "query", "kind", "from", "to"],
        properties: {
          type: { type: "string", enum: ["calendar", "search"] },
          query: { type: "string", description: "words to search for; empty for a calendar range" },
          kind: { type: "string", enum: ["email", "event", "any"] },
          from: { type: "string", description: "YYYY-MM-DD or empty" },
          to: { type: "string", description: "YYYY-MM-DD (exclusive) or empty" },
        },
      },
    },
  },
};

const PLAN_PROMPT =
  "Kloru keeps a synced copy of the caller's Gmail (all mail) and Google Calendar (every calendar, a year each way). " +
  "A question those can answer: answer. One simple change to the caller's own calendar or mail (move, rename, add or cancel " +
  "an event; trash or archive a few named emails): change. Anything that sends something, needs another app, the web, research, " +
  "a whole-inbox sweep or judgment beyond that: file. For answer or change, plan up to 3 lookups that find the items: a calendar " +
  "range (from/to dates) or a search (a few words, a kind, optional dates). To change something, find it as it is now (its current " +
  "dates, not the new ones). Adding an event needs no lookup. A question about what Kloru did or found earlier: answer from its earlier tasks (listed with the request), no lookup needed.";

const ACTIONS = ["update_event", "create_event", "delete_event", "trash_emails", "archive_emails"] as const;
type Action = (typeof ACTIONS)[number];

const CHANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["actions", "say"],
  properties: {
    actions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "items", "title", "start", "end", "all_day", "location", "description", "calendar"],
        properties: {
          action: { type: "string", enum: [...ACTIONS] },
          items: { type: "array", items: { type: "integer" }, description: "the [n] numbers of the items it acts on; empty for create_event" },
          title: { type: "string", description: "new title, or empty to keep it" },
          start: { type: "string", description: "YYYY-MM-DD (all day) or YYYY-MM-DDTHH:MM in the caller's timezone, or empty to keep it" },
          end: { type: "string", description: "same format; for all day, the last day (inclusive); empty to keep it" },
          all_day: { type: "boolean" },
          location: { type: "string", description: "or empty" },
          description: { type: "string", description: "or empty" },
          calendar: { type: "string", description: "for create_event: the account email to add it to, or empty for the caller's main calendar" },
        },
      },
    },
    say: { type: "string", description: "one short spoken sentence saying what was done, past tense" },
  },
};

const CHANGE_PROMPT =
  "You make one simple change for Kloru, the caller's assistant. Pick the actions on the numbered items that do exactly what " +
  "they asked, and the sentence they'll hear once it's done. Change every item the request covers (the same event can be on several calendars), and only what they asked: an all-day event stays all day unless they give it times, and nothing new is added unless they ask. Speak to the caller (\"your trip\"). If the request isn't clearly one of these actions on these items, " +
  "or it's unclear which item they mean, return no actions.";

const MAX_ITEMS = 25;

const WRITE_PROMPT =
  "You are Kloru, the caller's assistant, on a phone call. Answer their question in one to three short spoken sentences, " +
  "speaking to them about their own things (\"you have\", \"Cara emailed you\"), " +
  "from these items only: plain words, times said naturally in the caller's timezone, no lists, no links, no ids. " +
  "If the items don't answer it, reply exactly CANNOT.";

export interface FastPathOptions {
  store: Store;
  apiKey: string;
  timezone: string;
  log: (m: string) => void;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  decisionModel?: string;
  writerModel?: string;
  changeModel?: string;
  /** The accounts whose mail this caller may read (undefined: all). */
  mailAccounts?: (phone: string) => string[] | undefined;
  /** Calendar accounts this caller's answers may read; unset: every synced calendar. */
  calendarAccounts?: (phone: string) => string[] | undefined;
  /** What this caller asked Kloru for lately, each with what it found (Desk.recentTasks). */
  tasks?: (phone: string) => string[];
}

async function chat(o: FastPathOptions, body: Record<string, unknown>): Promise<string> {
  // Thinking costs seconds here (Flash took 9 to 16 s on a change with it); these are short, schema-shaped calls.
  return chatCompletion({ apiKey: o.apiKey, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) }, { ...(/^(openai|google)\//.test(String(body.model)) ? { reasoning: { effort: "minimal" } } : {}), ...body });
}

export function storeFastPath(o: FastPathOptions): (issue: Issue) => Promise<FastAnswer | undefined> {
  const now = o.now ?? (() => new Date());
  return async (issue) => {
    const t = now();
    const scope = issue.filedBy?.phone ? o.mailAccounts?.(issue.filedBy.phone) : undefined;
    const mail = scope ? { mailAccounts: scope } : {};
    const today = new Intl.DateTimeFormat("en-US", { timeZone: o.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(t);
    const tasks = issue.filedBy?.phone ? (o.tasks?.(issue.filedBy.phone) ?? []) : [];
    const earlier = tasks.length ? `\n\nKloru's earlier tasks for them (newest first):\n${tasks.map((x) => `- ${x}`).join("\n")}` : "";
    const raw = await chat(o, {
      model: o.decisionModel ?? DECISION_MODEL,
      messages: [
        { role: "system", content: `${PLAN_PROMPT}\nNow: ${today} (${o.timezone}).` },
        { role: "user", content: `${issue.request}${earlier}` },
      ],
      response_format: { type: "json_schema", json_schema: { name: "fast_path_plan", strict: true, schema: PLAN_SCHEMA } },
    });
    const plan = JSON.parse(raw) as { decision: "answer" | "change" | "file"; lookups: Lookup[] };
    if (plan.decision === "file" || (plan.decision === "answer" && !plan.lookups.length && !tasks.length)) {
      o.log(`fast path: #${issue.id} ${plan.decision}${plan.lookups.length ? "" : " with no lookups"}; to the PM`);
      return undefined;
    }

    const sources = new Set<string>();
    const items = new Map<string, Item>();
    for (const l of plan.lookups.slice(0, 3)) {
      const from = l.from ? zoned(l.from, o.timezone) : undefined;
      const to = l.to ? zoned(l.to, o.timezone) : undefined;
      if (l.type === "calendar") {
        sources.add("googlecalendar");
        const cals = issue.filedBy?.phone ? o.calendarAccounts?.(issue.filedBy.phone) : undefined;
        for (const i of o.store.calendar(from ?? t.toISOString(), to ?? new Date(t.getTime() + 86_400_000).toISOString())) if (!cals || cals.includes(i.account.toLowerCase())) items.set(i.id, i);
      } else {
        if (l.kind !== "event") sources.add("gmail");
        if (l.kind !== "email") sources.add("googlecalendar");
        for (const i of o.store.search({ ...(l.query ? { query: l.query } : {}), ...(l.kind !== "any" ? { kind: l.kind } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), ...mail, limit: 15 })) items.set(i.id, i);
      }
    }
    const fresh = freshness(o.store, [...sources], t);
    if (fresh.stale) return undefined;
    // A change's item may sit outside the dates the planner guessed (it often searches the new dates): look again without them.
    // Then word by word: every word of a search must match, and planners add words ("Evan Atlanta") the item lacks.
    for (const words of [false, true]) {
      if (plan.decision !== "change" || items.size) break;
      for (const l of plan.lookups) {
        if (l.type !== "search" || !l.query) continue;
        for (const q of words ? l.query.split(/\s+/).filter((w) => w.length > 2) : [l.query])
          for (const i of o.store.search({ query: q, ...(l.kind !== "any" ? { kind: l.kind } : {}), ...mail, limit: 10 })) items.set(i.id, i);
      }
    }
    if (plan.decision === "change") return change(o, issue, [...items.values()].slice(0, 40), today, `From the store (${fresh.text})`);
    const lines = [...[...items.values()].slice(0, 40).map((i) => formatItem(i, o.timezone)), ...tasks.map((x) => `- Earlier task ${x}`)];
    const answer = await chat(o, {
      model: o.writerModel ?? WRITER_MODEL,
      messages: [
        { role: "system", content: `${WRITE_PROMPT}\nNow: ${today} (${o.timezone}).` },
        { role: "user", content: `Question: ${issue.request}\n\nItems:\n${lines.join("\n") || "(none)"}` },
      ],
    });
    if (!answer || /^CANNOT\b/.test(answer)) return undefined;
    return { answer, note: `From the store (${fresh.text}) Items:\n${lines.join("\n").slice(0, 3000)}` };
  };
}

interface Picked {
  action: Action;
  items: number[];
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  description: string;
  calendar: string;
}

/** The change model picks actions on numbered items; the exact app actions are built here from those items. */
async function change(o: FastPathOptions, issue: Issue, found: Item[], today: string, source: string): Promise<FastAnswer | undefined> {
  const lines = found.map((i, n) => `[${n + 1}] ${formatItem(i, o.timezone).replace(/^- /, "")}`);
  const raw = await chat(o, {
    model: o.changeModel ?? CHANGE_MODEL,
    messages: [
      { role: "system", content: `${CHANGE_PROMPT}\nNow: ${today} (${o.timezone}).` },
      { role: "user", content: `Request: ${issue.request}\n\nItems:\n${lines.join("\n") || "(none)"}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "fast_path_change", strict: true, schema: CHANGE_SCHEMA } },
  });
  const picked = JSON.parse(raw) as { actions: Picked[]; say: string };
  const decline = (why: string) => (o.log(`fast path: #${issue.id} change declined (${why}); to the PM`), undefined);
  if (!picked.actions?.length || !picked.say?.trim()) return decline(`no actions among ${found.length} items`);
  const changes: FastChange[] = [];
  for (const a of picked.actions) {
    const targets = a.items.map((n) => found[n - 1]);
    if (targets.some((t) => !t)) return decline(`item ${a.items.join(",")} isn't there`);
    const built = build(a, targets as Item[], o.timezone);
    if (!built) return decline(`can't build ${JSON.stringify(a)}`);
    changes.push(...built);
  }
  if (!changes.length || changes.length > MAX_ITEMS) return decline(`${changes.length} actions`);
  return { changes, say: picked.say.trim(), note: `${source} Items:\n${lines.join("\n").slice(0, 3000)}` };
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isWall = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);

/** The day after a YYYY-MM-DD (Google's all-day ends are exclusive). */
function nextDay(d: string): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** "2026-11-04T10:00" in a timezone → "2026-11-04T10:00:00-08:00". */
export function withOffset(wall: string, tz: string): string {
  const guess = new Date(`${wall}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess);
  const get = (k: string) => Number(parts.find((p) => p.type === k)!.value);
  const minutes = Math.round((Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute")) - guess.getTime()) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${wall}:00${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function eventRef(i: Item): { calendar_id: string; event_id: string } | undefined {
  const d = (i.data ?? {}) as { eventId?: string; calendar?: string };
  const eventId = d.eventId ?? i.externalId.split(":").at(-1);
  return i.kind === "event" && eventId ? { calendar_id: d.calendar || "primary", event_id: eventId } : undefined;
}

/** Guests other than the account's owner hear about a change to their event. */
const updates = (i: Item) => (i.people.some((p) => !p.toLowerCase().includes(i.account.toLowerCase())) ? "all" : "none");

function times(a: Picked, tz: string): Record<string, string> | undefined {
  if (!a.start && !a.end) return {};
  if (a.all_day || isDate(a.start)) {
    if (!isDate(a.start)) return undefined;
    return { start_time: a.start, end_time: nextDay(isDate(a.end) ? a.end : a.start) };
  }
  if (!isWall(a.start) || !isWall(a.end)) return undefined;
  return { start_time: withOffset(a.start, tz), end_time: withOffset(a.end, tz) };
}

function build(a: Picked, items: Item[], tz: string): FastChange[] | undefined {
  const extra = { ...(a.title ? { summary: a.title } : {}), ...(a.location ? { location: a.location } : {}), ...(a.description ? { description: a.description } : {}) };
  switch (a.action) {
    case "update_event": {
      const when = times(a, tz);
      if (!when || !items.length || items.some((i) => !eventRef(i)) || (!Object.keys(when).length && !Object.keys(extra).length)) return undefined;
      return items.map((i) => ({ slug: "GOOGLECALENDAR_PATCH_EVENT", args: { ...eventRef(i)!, ...extra, ...when, send_updates: updates(i) }, account: i.account }));
    }
    case "delete_event":
      if (!items.length || items.some((i) => !eventRef(i))) return undefined;
      return items.map((i) => ({ slug: "GOOGLECALENDAR_DELETE_EVENT", args: { ...eventRef(i)!, send_updates: updates(i) }, account: i.account }));
    case "create_event": {
      if (!a.title) return undefined;
      const when = a.all_day || isDate(a.start) ? (isDate(a.start) ? { start_date: a.start, end_date: nextDay(isDate(a.end) ? a.end : a.start) } : undefined) : isWall(a.start) && isWall(a.end) ? { start_datetime: `${a.start}:00`, end_datetime: `${a.end}:00`, timezone: tz } : undefined;
      if (!when) return undefined;
      return [{ slug: "GOOGLECALENDAR_CREATE_EVENT", args: { calendar_id: "primary", summary: a.title, ...when, ...(a.location ? { location: a.location } : {}), ...(a.description ? { description: a.description } : {}), send_updates: "none" }, ...(a.calendar ? { account: a.calendar } : {}) }];
    }
    case "trash_emails":
      if (!items.length || items.some((i) => i.kind !== "email")) return undefined;
      return items.map((i) => ({ slug: "GMAIL_MOVE_TO_TRASH", args: { user_id: "me", message_id: i.externalId }, account: i.account }));
    case "archive_emails": {
      if (!items.length || items.some((i) => i.kind !== "email")) return undefined;
      const byAccount = new Map<string, string[]>();
      for (const i of items) byAccount.set(i.account, [...(byAccount.get(i.account) ?? []), i.externalId]);
      return [...byAccount].map(([account, ids]) => ({ slug: "GMAIL_BATCH_MODIFY_MESSAGES", args: { userId: "me", messageIds: ids, removeLabelIds: ["INBOX"] }, account }));
    }
    default:
      return undefined;
  }
}
