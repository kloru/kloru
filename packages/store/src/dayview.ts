/**
 * The day view (store design step 5): what's on today and tomorrow and what mail is unread, in
 * the brief before the first word, so "what's on tomorrow?" needs no lookup at all.
 */
import { zoned } from "./tools.js";
import type { Store } from "./store.js";

/** Gmail's categories that aren't news to anyone. */
const NOISE = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "CATEGORY_UPDATES", "SPAM"]);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `scope`: only this caller's accounts (unset: every account). */
export function dayView(store: Store, timezone: string, now = new Date(), scope?: { mail?: string[]; events?: string[] }): string {
  const mine = (accounts: string[] | undefined, a: string) => !accounts || accounts.includes(a.toLowerCase());
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const label = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });
  const today = ymd.format(now);
  const tomorrow = ymd.format(new Date(now.getTime() + 86_400_000));
  const after = ymd.format(new Date(now.getTime() + 2 * 86_400_000));
  const day = (from: string, to: string, name: string) => {
    const events = store.calendar(zoned(from, timezone), zoned(to, timezone)).filter((e) => mine(scope?.events, e.account)).slice(0, 12);
    if (!events.length) return "";
    const parts = events.map((e) => `${e.startsAt && !/^\d{4}-\d{2}-\d{2}$/.test(e.startsAt) ? `${time.format(new Date(e.startsAt))} ` : "all day: "}${clip(e.title, 40)}`);
    return `${name} (${label.format(new Date(zoned(from, timezone)))}): ${parts.join("; ")}`;
  };
  const unread = store
    .search({ kind: "email", from: new Date(now.getTime() - 2 * 86_400_000).toISOString(), ...(scope?.mail ? { mailAccounts: scope.mail } : {}), limit: 50 })
    .filter((i) => {
      const d = i.data as { unread?: boolean; labels?: string[] };
      return d.unread && !(d.labels ?? []).some((l) => NOISE.has(l));
    })
    .sort((a, b) => Number(((b.data as { important?: boolean }).important ?? false)) - Number(((a.data as { important?: boolean }).important ?? false)))
    .slice(0, 5)
    .map((i) => `${(i.people[0] ?? "").replace(/\s*<.*>$/, "")}: ${clip(i.title, 50)}`);
  return [day(today, tomorrow, "Today"), day(tomorrow, after, "Tomorrow"), unread.length ? `Unread mail (2 days): ${unread.join("; ")}` : ""].filter(Boolean).join("\n");
}
