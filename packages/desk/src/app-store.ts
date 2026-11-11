/**
 * What people put into Kloru's apps (a grocery list's items, a sign-up's names): SQLite on the
 * website's disk (node:sqlite, like the metrics). Records are any JSON object, in collections an
 * app names as it goes; there is no schema, so an app that gains a field needs no migration.
 * The website writes it for the people using an app; the agent opens the same file for a worker's
 * app_data, so both wait for each other's writes (busy_timeout).
 *
 * Every change bumps the app's `rev`, which open pages poll to know when to draw again. Script
 * errors that people's browsers report are kept per version, for the engineer's next look.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const RECORD_MAX = 16 * 1024;
export const RECORDS_PER_APP = 5_000;
export const ERRORS_PER_VERSION = 20;
export const COLLECTION = /^[a-z0-9_-]{1,40}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A record as an app sees it: its own fields, plus the id, who added it and when. */
export type AppRecord = Record<string, unknown> & { id: string; by: string; at: string };
export type Stored = { ok: true; record: AppRecord } | { ok: false; status: number; error: string };
/** Who is writing: the name shown on the record, and the key that makes a record "theirs". */
export interface Writer {
  by: string;
  owner: string;
}

interface Row {
  id: string;
  data: string;
  by_who: string;
  owner: string;
  at: string;
}

export class AppStore {
  private readonly db: DatabaseSync;

  constructor(path: string, o: { readOnly?: boolean } = {}) {
    if (o.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA journal_size_limit = 16777216;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        app TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
        by_who TEXT NOT NULL, owner TEXT NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY (app, collection, id));
      CREATE TABLE IF NOT EXISTS app_rev (app TEXT PRIMARY KEY, rev INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS app_errors (
        app TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL, message TEXT NOT NULL,
        PRIMARY KEY (app, version, message));
    `);
  }

  /** The store when its file is there, read-only (the agent reads what the website wrote). */
  static openReadOnly(path: string): AppStore | undefined {
    return existsSync(path) ? new AppStore(path, { readOnly: true }) : undefined;
  }

  private shape(r: Row): AppRecord {
    return { ...(JSON.parse(r.data) as Record<string, unknown>), id: r.id, by: r.by_who, at: r.at };
  }

  /** A collection's records, oldest first; only one owner's when `owner` is given. */
  list(app: string, collection: string, owner?: string): AppRecord[] {
    const rows = (owner === undefined
      ? this.db.prepare("SELECT id, data, by_who, owner, at FROM records WHERE app = ? AND collection = ? ORDER BY rowid").all(app, collection)
      : this.db.prepare("SELECT id, data, by_who, owner, at FROM records WHERE app = ? AND collection = ? AND owner = ? ORDER BY rowid").all(app, collection, owner)) as unknown as Row[];
    return rows.map((r) => this.shape(r));
  }

  /**
   * Add a record, or replace the one with its id (who added it, and when, stay). With `own`, only
   * the writer's own record can be replaced.
   */
  put(app: string, collection: string, record: unknown, who: Writer, o: { own?: boolean; now?: Date } = {}): Stored {
    if (!COLLECTION.test(collection)) return { ok: false, status: 400, error: "a collection's name is lowercase letters, digits, - or _ (at most 40)" };
    if (!record || typeof record !== "object" || Array.isArray(record)) return { ok: false, status: 400, error: "a record is an object" };
    const { id: given, by: _by, at: _at, ...fields } = record as Record<string, unknown>;
    if (given !== undefined && (typeof given !== "string" || !RECORD_ID.test(given))) return { ok: false, status: 400, error: "a record's id is letters, digits, - or _ (at most 64)" };
    const data = JSON.stringify(fields);
    if (data.length > RECORD_MAX) return { ok: false, status: 413, error: `a record is at most ${RECORD_MAX / 1024} KB` };
    const id = given ?? randomBytes(9).toString("base64url");
    const old = this.db.prepare("SELECT id, data, by_who, owner, at FROM records WHERE app = ? AND collection = ? AND id = ?").get(app, collection, id) as unknown as Row | undefined;
    if (old) {
      if (o.own && old.owner !== who.owner) return { ok: false, status: 403, error: "that entry isn't yours to change" };
      this.db.prepare("UPDATE records SET data = ? WHERE app = ? AND collection = ? AND id = ?").run(data, app, collection, id);
      this.bump(app);
      return { ok: true, record: this.shape({ ...old, data }) };
    }
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM records WHERE app = ?").get(app) as { n: number }).n;
    if (count >= RECORDS_PER_APP) return { ok: false, status: 413, error: `this app is full (${RECORDS_PER_APP} entries)` };
    const row: Row = { id, data, by_who: who.by, owner: who.owner, at: (o.now ?? new Date()).toISOString() };
    this.db.prepare("INSERT INTO records (app, collection, id, data, by_who, owner, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(app, collection, id, data, row.by_who, row.owner, row.at);
    this.bump(app);
    return { ok: true, record: this.shape(row) };
  }

  /** Remove a record; with `owner`, only that owner's. True when one was removed. */
  remove(app: string, collection: string, id: string, owner?: string): boolean {
    const done = owner === undefined
      ? this.db.prepare("DELETE FROM records WHERE app = ? AND collection = ? AND id = ?").run(app, collection, id)
      : this.db.prepare("DELETE FROM records WHERE app = ? AND collection = ? AND id = ? AND owner = ?").run(app, collection, id, owner);
    if (Number(done.changes) > 0) this.bump(app);
    return Number(done.changes) > 0;
  }

  /** An app's collections and how many records each holds. */
  collections(app: string): Array<{ collection: string; records: number }> {
    return this.db.prepare("SELECT collection, COUNT(*) AS records FROM records WHERE app = ? GROUP BY collection ORDER BY collection").all(app) as unknown as Array<{ collection: string; records: number }>;
  }

  /** Remove everything an app holds (a worker starting its scratch data over). How many records went. */
  clear(app: string): number {
    const done = this.db.prepare("DELETE FROM records WHERE app = ?").run(app);
    if (Number(done.changes) > 0) this.bump(app);
    return Number(done.changes);
  }

  /** How many times the app's data has changed. */
  rev(app: string): number {
    return (this.db.prepare("SELECT rev FROM app_rev WHERE app = ?").get(app) as { rev: number } | undefined)?.rev ?? 0;
  }

  private bump(app: string): void {
    this.db.prepare("INSERT INTO app_rev (app, rev) VALUES (?, 1) ON CONFLICT(app) DO UPDATE SET rev = rev + 1").run(app);
  }

  /** Keep a script error a browser reported: once each, the first few per version. */
  reportError(app: string, version: number, message: string, now = new Date()): void {
    const text = message.replace(/\s+/g, " ").trim().slice(0, 300);
    if (!text) return;
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM app_errors WHERE app = ? AND version = ?").get(app, version) as { n: number }).n;
    if (count >= ERRORS_PER_VERSION) return;
    this.db.prepare("INSERT OR IGNORE INTO app_errors (app, version, at, message) VALUES (?, ?, ?, ?)").run(app, version, now.toISOString(), text);
  }

  errors(app: string, version: number): string[] {
    return (this.db.prepare("SELECT message FROM app_errors WHERE app = ? AND version = ? ORDER BY at, rowid").all(app, version) as Array<{ message: string }>).map((r) => r.message);
  }

  close(): void {
    this.db.close();
  }
}
