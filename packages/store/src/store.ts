/**
 * The store (#27): a local copy of a family's connected accounts, searchable in milliseconds.
 *
 * One table for everything, `items`: any Composio app fits, and email, calendar and contacts are
 * just kinds. Full-text search (SQLite FTS5) over title, body and people. Kept forever: something
 * deleted at the source gets `deleted_at` and is hidden from agents unless asked for.
 *
 * Node's built-in SQLite (node:sqlite), so there is no native dependency to build.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ItemInput {
  /** The Composio toolkit, e.g. gmail, googlecalendar. */
  source: string;
  /** The connected account it came from (an email address); the connection's owner. */
  account: string;
  kind: string;
  /** The id at the source: what an app action needs to act on it. */
  externalId: string;
  title: string;
  body: string;
  people: string[];
  startsAt?: string;
  endsAt?: string;
  /** When it happened (sent, received, starts): what "newest first" sorts by. */
  occurredAt?: string;
  url?: string;
  data: unknown;
}

export interface Item extends ItemInput {
  id: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface SyncState {
  source: string;
  account: string;
  cursor?: string;
  lastOkAt?: string;
  lastError?: string;
  lastErrorAt?: string;
}

export interface SearchOptions {
  query?: string;
  kind?: string;
  source?: string;
  from?: string;
  to?: string;
  limit?: number;
  includeDeleted?: boolean;
  /** Email only from these accounts (the ones the caller may read); events and other kinds are unaffected. */
  mailAccounts?: string[];
}

const idOf = (i: { source: string; account: string; externalId: string }) => `${i.source}:${i.account}:${i.externalId}`;

/** Words only, each quoted, so nothing a caller says can be FTS syntax. The last word may be a prefix. */
export function ftsQuery(text: string): string | undefined {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return undefined;
  return words.map((w, i) => `"${w}"${i === words.length - 1 && w.length > 2 ? "*" : ""}`).join(" ");
}

/** Contentless: the index keeps only words (items holds the text), and rows can still be deleted. */
const FTS_COLUMNS = "title, body, people, content='', contentless_delete=1, tokenize = 'unicode61 remove_diacritics 2'";

interface Row {
  id: string;
  source: string;
  account: string;
  kind: string;
  external_id: string;
  title: string;
  body: string;
  people: string;
  starts_at: string | null;
  ends_at: string | null;
  occurred_at: string | null;
  url: string | null;
  data: string;
  updated_at: string;
  deleted_at: string | null;
}

function toItem(r: Row): Item {
  return {
    id: r.id,
    source: r.source,
    account: r.account,
    kind: r.kind,
    externalId: r.external_id,
    title: r.title,
    body: r.body,
    people: JSON.parse(r.people) as string[],
    ...(r.starts_at ? { startsAt: r.starts_at } : {}),
    ...(r.ends_at ? { endsAt: r.ends_at } : {}),
    ...(r.occurred_at ? { occurredAt: r.occurred_at } : {}),
    ...(r.url ? { url: r.url } : {}),
    data: JSON.parse(r.data) as unknown,
    updatedAt: r.updated_at,
    ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(readonly path: string, private readonly now: () => Date = () => new Date(), o: { readOnly?: boolean } = {}) {
    if (o.readOnly) {
      // Another process (the website) reading the agent's live store: no schema changes, no writes.
      this.db = new DatabaseSync(path, { readOnly: true });
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      -- A WAL is reused, never shrunk: without a limit one big write (a backfill) keeps it that size for good.
      PRAGMA journal_size_limit = 67108864;
      PRAGMA wal_checkpoint(TRUNCATE);
      CREATE TABLE IF NOT EXISTS items (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL, account TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', people TEXT NOT NULL DEFAULT '[]',
        starts_at TEXT, ends_at TEXT, occurred_at TEXT, url TEXT,
        data TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS items_kind_time ON items (kind, occurred_at);
      CREATE INDEX IF NOT EXISTS items_starts ON items (kind, starts_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(${FTS_COLUMNS});
      CREATE TABLE IF NOT EXISTS sync_state (
        source TEXT NOT NULL, account TEXT NOT NULL, cursor TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT,
        PRIMARY KEY (source, account)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** How the search index is declared (contentless since 2026-10-30; older stores until compact). */
  ftsSchema(): string {
    return (this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'items_fts'").get() as { sql?: string } | undefined)?.sql ?? "";
  }

  /**
   * Shrink the store (the 3 GB volume filled on 2026-10-29): trim bodies to bodyMax, drop mail older
   * than keepDays, rebuild the search index contentless (it kept a second copy of every body), and
   * give the space back. Minutes on a big store, and it locks writes meanwhile: run it at a quiet time.
   */
  compact(o: { bodyMax: number; keepDays: number }): { trimmed: number; dropped: number; reindexed: number } {
    const before = new Date(this.now().getTime() - o.keepDays * 86_400_000).toISOString();
    this.db.exec("BEGIN");
    let trimmed = 0;
    let dropped = 0;
    let reindexed = 0;
    try {
      trimmed = Number(this.db.prepare("UPDATE items SET body = substr(body, 1, ?) WHERE length(body) > ?").run(o.bodyMax, o.bodyMax).changes);
      dropped = Number(this.db.prepare("DELETE FROM items WHERE kind = 'email' AND occurred_at < ?").run(before).changes);
      this.db.exec(`DROP TABLE items_fts; CREATE VIRTUAL TABLE items_fts USING fts5(${FTS_COLUMNS});`);
      reindexed = Number(this.db.prepare("INSERT INTO items_fts (rowid, title, body, people) SELECT rowid, title, body, people FROM items").run().changes);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.exec("VACUUM");
    return { trimmed, dropped, reindexed };
  }

  /** Insert or replace, keeping search in step. Coming back (out of the trash) clears deleted_at. */
  upsert(items: ItemInput[]): number {
    if (!items.length) return 0;
    const at = this.now().toISOString();
    const find = this.db.prepare("SELECT rowid FROM items WHERE id = ?");
    const insert = this.db.prepare(
      `INSERT INTO items (id, source, account, kind, external_id, title, body, people, starts_at, ends_at, occurred_at, url, data, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title, body = excluded.body, people = excluded.people,
         starts_at = excluded.starts_at, ends_at = excluded.ends_at, occurred_at = excluded.occurred_at, url = excluded.url,
         data = excluded.data, updated_at = excluded.updated_at, deleted_at = NULL`,
    );
    const dropFts = this.db.prepare("DELETE FROM items_fts WHERE rowid = ?");
    const addFts = this.db.prepare("INSERT INTO items_fts (rowid, title, body, people) VALUES (?, ?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const i of items) {
        const id = idOf(i);
        const people = i.people.join(", ");
        insert.run(id, i.source, i.account, i.kind, i.externalId, i.title, i.body, JSON.stringify(i.people), i.startsAt ?? null, i.endsAt ?? null, i.occurredAt ?? null, i.url ?? null, JSON.stringify(i.data ?? {}), at);
        const { rowid } = find.get(id) as { rowid: number };
        dropFts.run(rowid);
        addFts.run(rowid, i.title, i.body, people);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return items.length;
  }

  markDeleted(source: string, account: string, externalIds: string[], at = this.now().toISOString()): number {
    const stmt = this.db.prepare("UPDATE items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL");
    let n = 0;
    for (const externalId of externalIds) n += Number(stmt.run(at, idOf({ source, account, externalId })).changes);
    return n;
  }

  get(id: string): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Row | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Best matches first with a query; newest first without one. */
  search(o: SearchOptions = {}): Item[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const match = o.query ? ftsQuery(o.query) : undefined;
    if (o.query && !match) return [];
    if (!o.includeDeleted) where.push("i.deleted_at IS NULL");
    if (o.kind) (where.push("i.kind = ?"), args.push(o.kind));
    if (o.source) (where.push("i.source = ?"), args.push(o.source));
    if (o.from) (where.push("i.occurred_at >= ?"), args.push(o.from));
    if (o.to) (where.push("i.occurred_at < ?"), args.push(o.to));
    if (o.mailAccounts) {
      where.push(o.mailAccounts.length ? `(i.kind != 'email' OR i.account IN (${o.mailAccounts.map(() => "?").join(", ")}))` : "i.kind != 'email'");
      args.push(...o.mailAccounts.map((a) => a.toLowerCase()));
    }
    const limit = Math.min(Math.max(o.limit ?? 20, 1), 200);
    const sql = match
      ? `SELECT i.* FROM items_fts f JOIN items i ON i.rowid = f.rowid WHERE items_fts MATCH ? ${where.length ? `AND ${where.join(" AND ")}` : ""} ORDER BY bm25(items_fts, 3.0, 1.0, 2.0), i.occurred_at DESC LIMIT ?`
      : `SELECT i.* FROM items i ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.occurred_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(match ? [match] : []), ...args, limit) as unknown as Row[];
    return rows.map(toItem);
  }

  /** Events that overlap [from, to), by start time. */
  calendar(from: string, to: string, includeDeleted = false): Item[] {
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE kind = 'event' AND starts_at < ? AND COALESCE(ends_at, starts_at) > ? ${includeDeleted ? "" : "AND deleted_at IS NULL"} ORDER BY starts_at`)
      .all(to, from) as unknown as Row[];
    return rows.map(toItem);
  }

  /** External ids of a source's items in a time window (to notice what vanished at the source). */
  idsIn(source: string, account: string, kind: string, from: string, to: string): string[] {
    const rows = this.db
      .prepare("SELECT external_id FROM items WHERE source = ? AND account = ? AND kind = ? AND starts_at >= ? AND starts_at < ? AND deleted_at IS NULL")
      .all(source, account, kind, from, to) as Array<{ external_id: string }>;
    return rows.map((r) => r.external_id);
  }

  counts(includeDeleted = false): Record<string, number> {
    const rows = this.db.prepare(`SELECT kind, COUNT(*) AS n FROM items ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} GROUP BY kind`).all() as Array<{ kind: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
  }

  syncState(source: string, account: string): SyncState | undefined {
    const r = this.db.prepare("SELECT * FROM sync_state WHERE source = ? AND account = ?").get(source, account) as
      | { source: string; account: string; cursor: string | null; last_ok_at: string | null; last_error: string | null; last_error_at: string | null }
      | undefined;
    if (!r) return undefined;
    return {
      source: r.source,
      account: r.account,
      ...(r.cursor ? { cursor: r.cursor } : {}),
      ...(r.last_ok_at ? { lastOkAt: r.last_ok_at } : {}),
      ...(r.last_error ? { lastError: r.last_error } : {}),
      ...(r.last_error_at ? { lastErrorAt: r.last_error_at } : {}),
    };
  }

  syncStates(): SyncState[] {
    const rows = this.db.prepare("SELECT source, account FROM sync_state ORDER BY source, account").all() as Array<{ source: string; account: string }>;
    return rows.map((r) => this.syncState(r.source, r.account)!);
  }

  /** Merge the given fields into a source's sync state. */
  setSyncState(source: string, account: string, patch: Partial<Omit<SyncState, "source" | "account">>): void {
    const cur = this.syncState(source, account) ?? { source, account };
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `INSERT INTO sync_state (source, account, cursor, last_ok_at, last_error, last_error_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, account) DO UPDATE SET cursor = excluded.cursor, last_ok_at = excluded.last_ok_at, last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
      )
      .run(source, account, next.cursor ?? null, next.lastOkAt ?? null, next.lastError ?? null, next.lastErrorAt ?? null);
  }
}
