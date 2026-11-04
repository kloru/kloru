/**
 * The admin metrics on kloru.com: what Kloru costs a day, what it did, how much time that saved,
 * and who uses it. Every number says where it came from.
 *
 * - Models: OpenRouter's own usage for Kloru's keys, recorded hourly (it keeps no daily history for
 *   an ordinary key), and before that the cost each desk session recorded per reply.
 * - Phone: Twilio's daily usage. Browser: Steel session minutes. Speech: voice minutes at a set rate.
 *   Hosting: a set amount a day. A provider that can't be reached shows as not available, never $0.
 * - Time saved: Jev estimates once, per finished request, how long it would have taken them by hand.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Issue, LedgerEntry } from "@kloru/desk";

const DECISIONS = "https://openrouter.ai/api/alpha/decisions";
const JEV = "typesafe/jev-1.14";
const FINISHED = new Set(["done", "resolved", "merged"]);
const HOUR = 3_600_000;

export interface MetricsOptions {
  /** /data/instinct: sessions/, repo/ (issues, calls, ledger), metrics/ (what this keeps). */
  dataDir: string;
  issues: () => Issue[];
  ledger: () => LedgerEntry[];
  nameOf: (phone: string) => string | undefined;
  timezone: string;
  /** OpenRouter keys whose usage is Kloru's, by name (main, voice). */
  openrouterKeys: Record<string, string>;
  /** For Jev's time-saved estimates. */
  decisionKey?: string;
  twilio?: { sid: string; token: string };
  steelKey?: string;
  steelUsdPerHour?: number;
  hostingUsdPerDay?: number;
  speechUsdPerMinute?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (m: string) => void;
}

export interface DayMetrics {
  date: string;
  cost: { models: number; phone: number | null; browser: number | null; speech: number; hosting: number };
  modelSource: "openrouter" | "sessions";
  desk: Record<string, number>;
  requests: { filed: number; finished: number; failed: number };
  actions: Record<string, number>;
  minutesSaved: number;
}

export interface MetricsReport {
  generatedAt: string;
  days: DayMetrics[];
  totals: { today: number; week: number; month: number; requestsFinished: number; minutesSaved: number; activePeople: number };
  people: Array<{ name: string; phone: string; conversations: number; requests: number; minutesSaved: number; costUsd: number }>;
  recent: Array<{ id: number; at: string; who: string; request: string; outcome: string; costUsd: number; minutes: number | null }>;
  sources: string[];
}

/** An action in the ledger, by what a person would call it. */
function actionKind(e: LedgerEntry): string | undefined {
  if (!e.ok) return undefined;
  if (e.slug.startsWith("GMAIL_")) return e.slug === "GMAIL_SEND_EMAIL" ? "emails sent" : "emails handled";
  if (e.slug.startsWith("GOOGLECALENDAR_")) return "calendar changes";
  if (e.slug === "MESSAGE") return "messages";
  if (e.slug === "REACTION") return "reactions";
  if (e.slug === "PURCHASE") return "purchases";
  return undefined;
}

export class Metrics {
  private readonly now: () => Date;
  private readonly fetch: typeof fetch;
  private readonly dir: string;
  private cache: { at: number; twilio?: Record<string, number>; steel?: Record<string, number> } = { at: 0 };

  constructor(private readonly o: MetricsOptions) {
    this.now = o.now ?? (() => new Date());
    this.fetch = o.fetchImpl ?? fetch;
    this.dir = join(o.dataDir, "metrics");
  }

  private day(iso: string | number | Date): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.o.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  }

  /** Record each OpenRouter key's running usage; run hourly. */
  async snapshot(): Promise<void> {
    const usage: Record<string, number> = {};
    // The same key under two names (voice and main can share one) would count its spend twice.
    const keys = [...new Map(Object.entries(this.o.openrouterKeys).map(([name, key]) => [key, name])).entries()].map(([key, name]) => [name, key] as const);
    for (const [name, key] of keys) {
      const r = await this.fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      const d = r?.ok ? ((await r.json()) as { data?: { usage?: number } }).data : undefined;
      if (typeof d?.usage === "number") usage[name] = d.usage;
    }
    if (!Object.keys(usage).length) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "openrouter.jsonl"), `${JSON.stringify({ at: this.now().toISOString(), usage })}\n`);
  }

  /** Model spend by day from the hourly snapshots: each interval's increase, counted on the day it ended. */
  private openrouterByDay(): Record<string, number> {
    const file = join(this.dir, "openrouter.jsonl");
    if (!existsSync(file)) return {};
    const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { at: string; usage: Record<string, number> });
    const out: Record<string, number> = {};
    for (let i = 1; i < rows.length; i++) {
      let spent = 0;
      for (const [k, v] of Object.entries(rows[i]!.usage)) {
        const before = rows[i - 1]!.usage[k];
        if (before !== undefined && v >= before) spent += v - before;
      }
      const d = this.day(rows[i]!.at);
      out[d] = (out[d] ?? 0) + spent;
    }
    return out;
  }

  /** What each desk session recorded per model reply: by day, by role, and by issue. */
  private sessions(): { byDay: Record<string, number>; byRole: Record<string, Record<string, number>>; byIssue: Record<number, number>; byCall: Record<string, number> } {
    const out = { byDay: {} as Record<string, number>, byRole: {} as Record<string, Record<string, number>>, byIssue: {} as Record<number, number>, byCall: {} as Record<string, number> };
    const dir = join(this.o.dataDir, "sessions");
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      const key = decodeURIComponent(f.replace(/\.jsonl$/, ""));
      const m = /^desk:issue:(\d+):(\w+)/.exec(key);
      const role = m ? m[2]! : key.startsWith("chat:voice:") ? "voice" : key.startsWith("scheduled:") ? "automations" : "other";
      const call = /^chat:voice:(CA\w+)/.exec(key)?.[1];
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.includes('"usage"')) continue;
        let o: { usage?: { cost?: { total?: number } }; timestamp?: number };
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const c = o.usage?.cost?.total;
        if (!c || !o.timestamp) continue;
        const d = this.day(o.timestamp);
        out.byDay[d] = (out.byDay[d] ?? 0) + c;
        (out.byRole[d] ??= {})[role] = (out.byRole[d]![role] ?? 0) + c;
        if (m) out.byIssue[Number(m[1])] = (out.byIssue[Number(m[1])] ?? 0) + c;
        if (call) out.byCall[call] = (out.byCall[call] ?? 0) + c;
      }
    }
    return out;
  }

  /** Twilio's daily spend, and Steel's browser time at its hourly rate; null where the provider can't be reached. */
  private async providers(from: string): Promise<{ twilio?: Record<string, number>; steel?: Record<string, number> }> {
    if (Date.now() - this.cache.at < HOUR) return this.cache;
    const fresh: { at: number; twilio?: Record<string, number>; steel?: Record<string, number> } = { at: Date.now() };
    if (this.o.twilio) {
      const auth = Buffer.from(`${this.o.twilio.sid}:${this.o.twilio.token}`).toString("base64");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.o.twilio.sid}/Usage/Records/Daily.json?Category=totalprice&StartDate=${from}&PageSize=100`;
      const r = await this.fetch(url, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
      if (r?.ok) {
        const d = (await r.json()) as { usage_records?: Array<{ start_date: string; price: string }> };
        fresh.twilio = Object.fromEntries((d.usage_records ?? []).map((x) => [x.start_date, Math.abs(Number(x.price) || 0)]));
      } else this.o.log?.(`metrics: Twilio usage unavailable (${r?.status ?? "no answer"})`);
    }
    if (this.o.steelKey) {
      const rate = this.o.steelUsdPerHour ?? 0.1;
      const steel: Record<string, number> = {};
      let cursor = "";
      for (let page = 0; page < 20; page++) {
        const r = await this.fetch(`https://api.steel.dev/v1/sessions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: { "steel-api-key": this.o.steelKey }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
        if (!r?.ok) break;
        const d = (await r.json()) as { sessions?: Array<{ createdAt: string; duration?: number }>; nextCursor?: string };
        for (const s of d.sessions ?? []) if (s.createdAt.slice(0, 10) >= from) steel[this.day(s.createdAt)] = (steel[this.day(s.createdAt)] ?? 0) + ((s.duration ?? 0) / HOUR) * rate;
        const oldest = d.sessions?.at(-1)?.createdAt.slice(0, 10) ?? "";
        if (!d.nextCursor || oldest < from) {
          fresh.steel = steel;
          break;
        }
        cursor = d.nextCursor;
      }
    }
    this.cache = fresh;
    return fresh;
  }

  private calls(): Array<{ id: string; callSid: string; phone: string; channel: string; startedAt: string; endedAt?: string }> {
    const dir = join(this.o.dataDir, "repo", "calls");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((d) => {
      const f = join(dir, d, "call.json");
      try {
        return existsSync(f) ? [JSON.parse(readFileSync(f, "utf8"))] : [];
      } catch {
        return [];
      }
    });
  }

  private savedFile(): string {
    return join(this.dir, "saved.json");
  }

  private saved(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.savedFile(), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  /** Estimate time saved for finished requests that don't have one yet (a few at a time). */
  async estimate(limit = 100): Promise<number> {
    if (!this.o.decisionKey) return 0;
    const saved = this.saved();
    const ledger = this.o.ledger();
    const todo = this.o.issues().filter((i) => !i.purpose && FINISHED.has(i.status) && saved[i.id] === undefined).slice(-limit);
    for (const i of todo) {
      const actions: Record<string, number> = {};
      for (const e of ledger) if (e.issue === i.id) { const k = actionKind(e); if (k && k !== "messages" && k !== "reactions") actions[k] = (actions[k] ?? 0) + 1; }
      const result = i.prs.at(-1)?.body ?? i.thread.at(-1)?.text ?? "";
      const minutes = await this.jevMinutes(i.request, result, actions).catch((e: Error) => (this.o.log?.(`metrics: estimate for #${i.id} failed: ${e.message}`), undefined));
      if (minutes !== undefined) saved[i.id] = minutes;
    }
    mkdirSync(dirname(this.savedFile()), { recursive: true });
    writeFileSync(this.savedFile(), JSON.stringify(saved));
    return todo.length;
  }

  private async jevMinutes(request: string, result: string, actions: Record<string, number>): Promise<number> {
    const criteria = {
      "0": "Nothing they'd have spent time on: it failed, was a duplicate, or only repeated something they knew.",
      "1": "About a minute: a quick look-up or a one-tap change.",
      "5": "About 5 minutes: a few steps (find an email, add an event, check a page).",
      "15": "About 15 minutes: a small errand (a booking, a short comparison, an email or two written).",
      "30": "About half an hour: a real errand (research, a purchase with checking, several emails).",
      "60": "About an hour: a lot of steps or reading (a detailed comparison, a cleanup of many emails).",
      "120": "Two hours or more: a project-sized job.",
    };
    const r = await this.fetch(DECISIONS, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.o.decisionKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model: JEV, state: { request, result: result.slice(0, 1500), actions_done: actions }, questions: { minutes: { type: "choice", instructions: "How long would this have taken the person to do themselves, by hand?", criteria } } }),
    });
    if (!r.ok) throw new Error(`decision model ${r.status}`);
    const d = (await r.json()) as { answers?: { minutes?: { choice?: string } } };
    const n = Number(d.answers?.minutes?.choice);
    if (!Number.isFinite(n)) throw new Error("no estimate");
    return n;
  }

  async report(daysBack = 30): Promise<MetricsReport> {
    const now = this.now();
    const dates = Array.from({ length: daysBack }, (_, k) => this.day(now.getTime() - (daysBack - 1 - k) * 86_400_000));
    const from = dates[0]!;
    const [prov, sess] = [await this.providers(from), this.sessions()];
    const or = this.openrouterByDay();
    const issues = this.o.issues().filter((i) => !i.purpose);
    const ledger = this.o.ledger();
    const saved = this.saved();
    const calls = this.calls();
    const hosting = this.o.hostingUsdPerDay ?? 0.52;
    const speechRate = this.o.speechUsdPerMinute ?? 0.03;
    const voiceMin: Record<string, number> = {};
    for (const c of calls) if (c.channel === "voice" && c.endedAt) voiceMin[this.day(c.startedAt)] = (voiceMin[this.day(c.startedAt)] ?? 0) + (Date.parse(c.endedAt) - Date.parse(c.startedAt)) / 60_000;

    const days: DayMetrics[] = dates.map((date) => {
      const sessions = sess.byDay[date] ?? 0;
      const fromOr = or[date];
      const useOr = fromOr !== undefined && fromOr >= sessions;
      const actions: Record<string, number> = {};
      for (const e of ledger) if (this.day(e.at) === date) { const k = actionKind(e); if (k) actions[k] = (actions[k] ?? 0) + 1; }
      const finishedToday = issues.filter((i) => FINISHED.has(i.status) && this.day(i.updatedAt) === date);
      return {
        date,
        cost: { models: useOr ? fromOr! : sessions, phone: prov.twilio ? (prov.twilio[date] ?? 0) : null, browser: prov.steel ? (prov.steel[date] ?? 0) : null, speech: (voiceMin[date] ?? 0) * speechRate, hosting },
        modelSource: useOr ? "openrouter" : "sessions",
        desk: sess.byRole[date] ?? {},
        requests: { filed: issues.filter((i) => this.day(i.createdAt) === date).length, finished: finishedToday.length, failed: issues.filter((i) => i.status === "failed" && this.day(i.updatedAt) === date).length },
        actions,
        minutesSaved: finishedToday.reduce((n, i) => n + (saved[i.id] ?? 0), 0),
      };
    });
    const total = (d: DayMetrics) => d.cost.models + (d.cost.phone ?? 0) + (d.cost.browser ?? 0) + d.cost.speech + d.cost.hosting;
    const today = days.at(-1)!;
    const week = days.slice(-7);

    const byPhone = new Map<string, { conversations: number; requests: number; minutesSaved: number; costUsd: number }>();
    const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);
    const person = (p: string) => {
      const k = last10(p);
      if (!byPhone.has(k)) byPhone.set(k, { conversations: 0, requests: 0, minutesSaved: 0, costUsd: 0 });
      return byPhone.get(k)!;
    };
    for (const c of calls) if (this.day(c.startedAt) >= from && c.phone) { const p = person(c.phone); p.conversations++; p.costUsd += sess.byCall[c.callSid] ?? 0; }
    for (const i of issues) if (this.day(i.createdAt) >= from) { const p = person(i.filedBy.phone); p.requests++; p.minutesSaved += saved[i.id] ?? 0; p.costUsd += sess.byIssue[i.id] ?? 0; }
    const active = new Set(calls.filter((c) => this.day(c.startedAt) >= week[0]!.date).map((c) => last10(c.phone)));

    return {
      generatedAt: now.toISOString(),
      days,
      totals: {
        today: total(today),
        week: week.reduce((n, d) => n + total(d), 0),
        month: days.reduce((n, d) => n + total(d), 0),
        requestsFinished: days.reduce((n, d) => n + d.requests.finished, 0),
        minutesSaved: days.reduce((n, d) => n + d.minutesSaved, 0),
        activePeople: active.size,
      },
      people: [...byPhone.entries()].map(([phone, v]) => ({ name: this.o.nameOf(`+1${phone}`) ?? this.o.nameOf(phone) ?? `…${phone.slice(-4)}`, phone: `…${phone.slice(-4)}`, ...v })).sort((a, b) => b.requests - a.requests),
      recent: issues
        .filter((i) => FINISHED.has(i.status) || i.status === "failed")
        .slice(-25)
        .reverse()
        .map((i) => ({ id: i.id, at: i.updatedAt, who: this.o.nameOf(i.filedBy.phone) ?? `…${last10(i.filedBy.phone).slice(-4)}`, request: i.request.slice(0, 140), outcome: i.status, costUsd: sess.byIssue[i.id] ?? 0, minutes: saved[i.id] ?? null })),
      sources: [
        `Models: OpenRouter's usage for Kloru's keys, recorded hourly; days before that (or partly covered) use the cost each desk session recorded, which leaves out texting and Jev.`,
        prov.twilio ? "Phone: Twilio's daily usage." : "Phone: Twilio usage not available.",
        prov.steel ? `Browser: Steel session time at $${(this.o.steelUsdPerHour ?? 0.1).toFixed(2)} an hour.` : "Browser: Steel usage not available.",
        `Speech: voice call minutes at $${speechRate.toFixed(2)} a minute (estimate for Deepgram and Cartesia).`,
        `Hosting: $${hosting.toFixed(2)} a day (estimate for the Fly machine and volume).`,
        "Time saved: Jev's estimate, once per finished request, of how long it would have taken by hand.",
      ],
    };
  }
}
