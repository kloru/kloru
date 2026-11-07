/**
 * The metrics' own database: SQLite on the machine's disk (node:sqlite, like the mail store), so
 * the metrics page is a few indexed sums instead of re-reading every session log.
 *
 * Model costs come in incrementally: for each session log, the database keeps how far it has read,
 * and each pass reads only the lines added since. A log that shrank was rewritten, so its costs are
 * dropped and it's read again from the start.
 *
 * A reply's cost is its tokens at the model's price on OpenRouter when that's known: Pi borrows a
 * listed model's prices for one it doesn't list (Terra was counted at twice its price).
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";

export interface CostRow {
  day: string;
  role: string;
  issue: number | null;
  call: string | null;
  usd: number;
}

/** USD per token, as OpenRouter lists them. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** Its tokens at this price, or what the session recorded when the price isn't known. */
export function costOf(usage: Usage, price: Price | undefined): number {
  if (!price) return usage.cost?.total ?? 0;
  return (usage.input ?? 0) * price.input + (usage.output ?? 0) * price.output + (usage.cacheRead ?? 0) * price.cacheRead + (usage.cacheWrite ?? 0) * price.cacheWrite;
}

/** Bumped when costs must be read again from the logs (2: priced from tokens). */
const COSTS_VERSION = 2;

export class MetricsDb {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 16777216;
      CREATE TABLE IF NOT EXISTS costs (
        file TEXT NOT NULL, at TEXT NOT NULL, day TEXT NOT NULL, role TEXT NOT NULL,
        issue INTEGER, call TEXT, usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS costs_day ON costs (day);
      CREATE INDEX IF NOT EXISTS costs_issue ON costs (issue) WHERE issue IS NOT NULL;
      CREATE INDEX IF NOT EXISTS costs_call ON costs (call) WHERE call IS NOT NULL;
      CREATE INDEX IF NOT EXISTS costs_file ON costs (file);
      CREATE TABLE IF NOT EXISTS ingested (file TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_readings (batch INTEGER NOT NULL, at TEXT NOT NULL, key TEXT NOT NULL, usage REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_at ON usage_readings (at);
      CREATE TABLE IF NOT EXISTS provider_days (provider TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY (provider, day));
      CREATE TABLE IF NOT EXISTS saved (issue INTEGER PRIMARY KEY, minutes REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const version = Number((this.db.prepare("SELECT value FROM meta WHERE key = 'costs_version'").get() as { value?: string } | undefined)?.value ?? 1);
    if (version < COSTS_VERSION) {
      this.db.exec("BEGIN; DELETE FROM costs; DELETE FROM ingested;");
      this.db.prepare("INSERT INTO meta (key, value) VALUES ('costs_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(COSTS_VERSION));
      this.db.exec("COMMIT");
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Read what's new in every session log under `dir`. `classify` names a file's role, issue and
   * call; `day` turns a timestamp into the family's local day; `price` is a model's price, when known.
   * Returns how many costs were added.
   */
  ingestSessions(dir: string, classify: (file: string) => { role: string; issue: number | null; call: string | null }, day: (ms: number) => string, price: (model: string) => Price | undefined = () => undefined): number {
    if (!existsSync(dir)) return 0;
    const getOffset = this.db.prepare("SELECT bytes FROM ingested WHERE file = ?");
    const setOffset = this.db.prepare("INSERT INTO ingested (file, bytes) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET bytes = excluded.bytes");
    const forget = this.db.prepare("DELETE FROM costs WHERE file = ?");
    const insert = this.db.prepare("INSERT INTO costs (file, at, day, role, issue, call, usd) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let added = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(dir, f);
      let fd: number;
      try {
        fd = openSync(path, "r");
      } catch {
        continue;
      }
      try {
        const size = fstatSync(fd).size;
        let from = Number((getOffset.get(f) as { bytes?: number } | undefined)?.bytes ?? 0);
        if (size === from) continue;
        this.db.exec("BEGIN");
        if (size < from) {
          // Rewritten (compacted): its costs are counted again from the start.
          forget.run(f);
          from = 0;
        }
        const buf = Buffer.alloc(size - from);
        readSync(fd, buf, 0, buf.length, from);
        // Only whole lines: a line still being written is read next time.
        const end = buf.lastIndexOf(10);
        if (end < 0) {
          this.db.exec("COMMIT");
          continue;
        }
        const { role, issue, call } = classify(f);
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
          if (!line.includes('"usage"')) continue;
          let o: { model?: string; usage?: Usage; timestamp?: number };
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (!o.usage || !o.timestamp) continue;
          const c = costOf(o.usage, o.model ? price(o.model) : undefined);
          if (!c) continue;
          insert.run(f, new Date(o.timestamp).toISOString(), day(o.timestamp), role, issue, call, c);
          added++;
        }
        setOffset.run(f, from + end + 1);
        this.db.exec("COMMIT");
      } catch (e) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* nothing open */
        }
        throw e;
      } finally {
        closeSync(fd);
      }
    }
    return added;
  }

  costsByDay(from: string): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT day, SUM(usd) AS usd FROM costs WHERE day >= ? GROUP BY day").all(from) as Array<{ day: string; usd: number }>).map((r) => [r.day, r.usd]));
  }

  costsByRole(from: string): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const r of this.db.prepare("SELECT day, role, SUM(usd) AS usd FROM costs WHERE day >= ? GROUP BY day, role").all(from) as Array<{ day: string; role: string; usd: number }>) (out[r.day] ??= {})[r.role] = r.usd;
    return out;
  }

  costsByIssue(): Record<number, number> {
    return Object.fromEntries((this.db.prepare("SELECT issue, SUM(usd) AS usd FROM costs WHERE issue IS NOT NULL GROUP BY issue").all() as Array<{ issue: number; usd: number }>).map((r) => [r.issue, r.usd]));
  }

  costsByCall(): Record<string, number> {
    return Object.fromEntries((this.db.prepare("SELECT call, SUM(usd) AS usd FROM costs WHERE call IS NOT NULL GROUP BY call").all() as Array<{ call: string; usd: number }>).map((r) => [r.call, r.usd]));
  }

  /** One reading of every key's running usage: one batch, so two taken at the same moment stay two. */
  addReading(at: string, usage: Record<string, number>): void {
    const batch = Number((this.db.prepare("SELECT COALESCE(MAX(batch), 0) + 1 AS n FROM usage_readings").get() as { n: number }).n);
    const insert = this.db.prepare("INSERT INTO usage_readings (batch, at, key, usage) VALUES (?, ?, ?, ?)");
    for (const [k, v] of Object.entries(usage)) insert.run(batch, at, k, v);
  }

  /** Every reading, oldest first, grouped by when it was taken. */
  readings(): Array<{ at: string; usage: Record<string, number> }> {
    const out: Array<{ batch: number; at: string; usage: Record<string, number> }> = [];
    for (const r of this.db.prepare("SELECT batch, at, key, usage FROM usage_readings ORDER BY batch, key").all() as Array<{ batch: number; at: string; key: string; usage: number }>) {
      if (out.at(-1)?.batch !== r.batch) out.push({ batch: r.batch, at: r.at, usage: {} });
      out.at(-1)!.usage[r.key] = r.usage;
    }
    return out.map(({ at, usage }) => ({ at, usage }));
  }

  setProviderDays(provider: string, days: Record<string, number>, fetchedAt: string): void {
    const put = this.db.prepare("INSERT INTO provider_days (provider, day, usd, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider, day) DO UPDATE SET usd = excluded.usd, fetched_at = excluded.fetched_at");
    this.db.exec("BEGIN");
    for (const [day, usd] of Object.entries(days)) put.run(provider, day, usd, fetchedAt);
    // A provider that answered counts as fetched even on a day with no use.
    put.run(provider, "_fetched", 0, fetchedAt);
    this.db.exec("COMMIT");
  }

  /** A provider's days, and when they were last fetched; undefined if it never answered. */
  providerDays(provider: string): { days: Record<string, number>; fetchedAt: string } | undefined {
    const rows = this.db.prepare("SELECT day, usd, fetched_at FROM provider_days WHERE provider = ?").all(provider) as Array<{ day: string; usd: number; fetched_at: string }>;
    const mark = rows.find((r) => r.day === "_fetched");
    if (!mark) return undefined;
    return { days: Object.fromEntries(rows.filter((r) => r.day !== "_fetched").map((r) => [r.day, r.usd])), fetchedAt: mark.fetched_at };
  }

  saved(): Record<number, number> {
    return Object.fromEntries((this.db.prepare("SELECT issue, minutes FROM saved").all() as Array<{ issue: number; minutes: number }>).map((r) => [r.issue, r.minutes]));
  }

  setSaved(issue: number, minutes: number): void {
    this.db.prepare("INSERT INTO saved (issue, minutes) VALUES (?, ?) ON CONFLICT(issue) DO UPDATE SET minutes = excluded.minutes").run(issue, minutes);
  }

  /** Bring in what the first version kept in files (openrouter.jsonl, saved.json), once; the files are renamed after. */
  importFiles(dir: string): void {
    const readingsFile = join(dir, "openrouter.jsonl");
    if (existsSync(readingsFile)) {
      for (const line of readFileSync(readingsFile, "utf8").split("\n").filter(Boolean)) {
        try {
          const r = JSON.parse(line) as { at: string; usage: Record<string, number> };
          this.addReading(r.at, r.usage);
        } catch {
          /* a torn line */
        }
      }
      renameSync(readingsFile, `${readingsFile}.imported`);
    }
    const savedFile = join(dir, "saved.json");
    if (existsSync(savedFile)) {
      try {
        for (const [k, v] of Object.entries(JSON.parse(readFileSync(savedFile, "utf8")) as Record<string, number>)) this.setSaved(Number(k), v);
      } catch {
        /* unreadable: estimates are made again */
      }
      renameSync(savedFile, `${savedFile}.imported`);
    }
  }
}
