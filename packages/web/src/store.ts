/**
 * The console's own records: who may sign in and which agent each person reaches.
 * Secrets never live here; an agent reference names the env vars that hold them.
 *
 * Two implementations behind one async interface:
 * - FileStore: console.json in a directory (local development), written 0600 through a
 *   temp file and rename so a crash never leaves half a file.
 * - PgStore: Postgres (Neon in the cloud), schema versioned by MIGRATIONS below.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizePhone } from "@kloru/core";

export type AgentRef =
  | { kind: "direct"; url: string; tokenEnv: string; secretEnv: string }
  | { kind: "maritime"; agentId: string };

export interface ConsoleUser {
  id: string;
  /** E.164; the identity people sign in with. */
  phone: string;
  name?: string;
  agent?: AgentRef;
  /** Whether they ticked the optional box for texts about their tasks, and when (A2P 10DLC opt-in record). */
  textsOptIn?: { yes: boolean; at: string };
  createdAt: string;
}

export interface Invite {
  phone: string;
  invitedBy: string;
  createdAt: string;
}

export interface StoreFile {
  version: 1;
  users: ConsoleUser[];
  invites: Invite[];
}

export type UserInput = Omit<ConsoleUser, "id" | "createdAt"> & { id?: string };

export interface ConsoleStore {
  users(): Promise<ConsoleUser[]>;
  user(id: string): Promise<ConsoleUser | undefined>;
  userByPhone(phone: string): Promise<ConsoleUser | undefined>;
  upsertUser(input: UserInput): Promise<ConsoleUser>;
  invites(): Promise<Invite[]>;
  isInvited(phone: string): Promise<boolean>;
  invite(phone: string, invitedBy: string): Promise<Invite>;
  removeInvite(phone: string): Promise<void>;
}

export const normPhone = (p: string): string => normalizePhone(p);

/** A number we would text: E.164, a country code plus 10 to 14 more digits. */
export const isPhone = (p: string): boolean => /^\+\d{11,15}$/.test(normPhone(p));

const newUserId = () => `u_${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// File
// ---------------------------------------------------------------------------

export class FileStore implements ConsoleStore {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, "console.json");
  }

  read(): StoreFile {
    if (!existsSync(this.file)) return { version: 1, users: [], invites: [] };
    const f = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
    return { version: 1, users: f.users ?? [], invites: f.invites ?? [] };
  }

  private write(f: StoreFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }

  async users(): Promise<ConsoleUser[]> {
    return this.read().users;
  }

  async user(id: string): Promise<ConsoleUser | undefined> {
    return this.read().users.find((u) => u.id === id);
  }

  async userByPhone(phone: string): Promise<ConsoleUser | undefined> {
    const p = normPhone(phone);
    return this.read().users.find((u) => u.phone === p);
  }

  async upsertUser(input: UserInput): Promise<ConsoleUser> {
    const f = this.read();
    const phone = normPhone(input.phone);
    const existing = f.users.find((u) => (input.id ? u.id === input.id : u.phone === phone));
    const user: ConsoleUser = existing
      ? { ...existing, ...input, id: existing.id, phone, createdAt: existing.createdAt }
      : { ...input, id: newUserId(), phone, createdAt: new Date().toISOString() };
    f.users = [...f.users.filter((u) => u.id !== user.id), user];
    this.write(f);
    return user;
  }

  async invites(): Promise<Invite[]> {
    return this.read().invites;
  }

  async isInvited(phone: string): Promise<boolean> {
    const p = normPhone(phone);
    return this.read().invites.some((i) => i.phone === p);
  }

  async invite(phone: string, invitedBy: string): Promise<Invite> {
    const f = this.read();
    const invite: Invite = { phone: normPhone(phone), invitedBy: normPhone(invitedBy), createdAt: new Date().toISOString() };
    f.invites = [...f.invites.filter((i) => i.phone !== invite.phone), invite];
    this.write(f);
    return invite;
  }

  async removeInvite(phone: string): Promise<void> {
    const f = this.read();
    const p = normPhone(phone);
    f.invites = f.invites.filter((i) => i.phone !== p);
    this.write(f);
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

/** What PgStore needs from a client: pg.Pool and PGlite both fit. */
export interface SqlClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** A pool hands out one connection, so a transaction's statements stay on it. */
export interface SqlPool extends SqlClient {
  connect(): Promise<{ query: SqlClient["query"]; release(): void }>;
}

const isPool = (db: SqlClient | SqlPool): db is SqlPool => typeof (db as SqlPool).connect === "function";

/** Applied in order, once each; never edit a shipped entry, add a new one. */
export const MIGRATIONS: ReadonlyArray<{ id: number; statements: readonly string[] }> = [
  {
    id: 1,
    statements: [
      `create table console_users (
        id text primary key,
        phone text not null unique,
        name text,
        agent jsonb,
        created_at timestamptz not null default now()
      )`,
      `create table console_invites (
        phone text primary key,
        invited_by text not null,
        created_at timestamptz not null default now()
      )`,
    ],
  },
  {
    id: 2,
    statements: [`alter table console_users add column texts_opt_in boolean`, `alter table console_users add column texts_opt_in_at timestamptz`],
  },
];

interface UserRow {
  id: string;
  phone: string;
  name: string | null;
  agent: AgentRef | string | null;
  texts_opt_in?: boolean | null;
  texts_opt_in_at?: Date | string | null;
  created_at: Date | string;
}

interface InviteRow {
  phone: string;
  invited_by: string;
  created_at: Date | string;
}

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

function toUser(r: UserRow): ConsoleUser {
  const agent = typeof r.agent === "string" ? (JSON.parse(r.agent) as AgentRef) : r.agent;
  const optIn = r.texts_opt_in != null && r.texts_opt_in_at ? { textsOptIn: { yes: r.texts_opt_in, at: iso(r.texts_opt_in_at) } } : {};
  return { id: r.id, phone: r.phone, ...(r.name ? { name: r.name } : {}), ...(agent ? { agent } : {}), ...optIn, createdAt: iso(r.created_at) };
}

const toInvite = (r: InviteRow): Invite => ({ phone: r.phone, invitedBy: r.invited_by, createdAt: iso(r.created_at) });

export class PgStore implements ConsoleStore {
  private constructor(private readonly db: SqlClient) {}

  /** Bring the schema up to date, then return a store. Safe to call on every start. */
  static async open(db: SqlClient | SqlPool): Promise<PgStore> {
    const conn = isPool(db) ? await db.connect() : undefined;
    try {
      await PgStore.migrate(conn ?? db);
    } finally {
      conn?.release();
    }
    return new PgStore(db);
  }

  private static async migrate(db: SqlClient): Promise<void> {
    await db.query("create table if not exists schema_migrations (id integer primary key, applied_at timestamptz not null default now())");
    const done = new Set((await db.query<{ id: number }>("select id from schema_migrations")).rows.map((r) => Number(r.id)));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await db.query("begin");
      try {
        for (const stmt of m.statements) await db.query(stmt);
        await db.query("insert into schema_migrations (id) values ($1)", [m.id]);
        await db.query("commit");
      } catch (err) {
        await db.query("rollback");
        throw err;
      }
    }
  }

  /** One-time import of a FileStore's console.json; rows already in the database win. */
  async importFile(f: StoreFile): Promise<void> {
    for (const u of f.users) {
      await this.db.query("insert into console_users (id, phone, name, agent, created_at) values ($1, $2, $3, $4, $5) on conflict do nothing", [
        u.id,
        normPhone(u.phone),
        u.name ?? null,
        u.agent ? JSON.stringify(u.agent) : null,
        u.createdAt,
      ]);
    }
    for (const i of f.invites) {
      await this.db.query("insert into console_invites (phone, invited_by, created_at) values ($1, $2, $3) on conflict do nothing", [
        normPhone(i.phone),
        normPhone(i.invitedBy),
        i.createdAt,
      ]);
    }
  }

  async users(): Promise<ConsoleUser[]> {
    return (await this.db.query<UserRow>("select * from console_users order by created_at")).rows.map(toUser);
  }

  async user(id: string): Promise<ConsoleUser | undefined> {
    const r = (await this.db.query<UserRow>("select * from console_users where id = $1", [id])).rows[0];
    return r ? toUser(r) : undefined;
  }

  async userByPhone(phone: string): Promise<ConsoleUser | undefined> {
    const r = (await this.db.query<UserRow>("select * from console_users where phone = $1", [normPhone(phone)])).rows[0];
    return r ? toUser(r) : undefined;
  }

  async upsertUser(input: UserInput): Promise<ConsoleUser> {
    const phone = normPhone(input.phone);
    const existing = input.id ? await this.user(input.id) : await this.userByPhone(phone);
    const merged = { ...existing, ...input, phone };
    const agent = merged.agent ? JSON.stringify(merged.agent) : null;
    if (existing) {
      const r = (await this.db.query<UserRow>("update console_users set phone = $2, name = $3, agent = $4, texts_opt_in = $5, texts_opt_in_at = $6 where id = $1 returning *", [existing.id, phone, merged.name ?? null, agent, merged.textsOptIn?.yes ?? null, merged.textsOptIn?.at ?? null])).rows[0]!;
      return toUser(r);
    }
    const r = (await this.db.query<UserRow>("insert into console_users (id, phone, name, agent, texts_opt_in, texts_opt_in_at) values ($1, $2, $3, $4, $5, $6) returning *", [newUserId(), phone, merged.name ?? null, agent, merged.textsOptIn?.yes ?? null, merged.textsOptIn?.at ?? null])).rows[0]!;
    return toUser(r);
  }

  async invites(): Promise<Invite[]> {
    return (await this.db.query<InviteRow>("select * from console_invites order by created_at")).rows.map(toInvite);
  }

  async isInvited(phone: string): Promise<boolean> {
    return (await this.db.query("select 1 from console_invites where phone = $1", [normPhone(phone)])).rows.length > 0;
  }

  async invite(phone: string, invitedBy: string): Promise<Invite> {
    const r = (await this.db.query<InviteRow>(
      "insert into console_invites (phone, invited_by) values ($1, $2) on conflict (phone) do update set invited_by = excluded.invited_by, created_at = now() returning *",
      [normPhone(phone), normPhone(invitedBy)],
    )).rows[0]!;
    return toInvite(r);
  }

  async removeInvite(phone: string): Promise<void> {
    await this.db.query("delete from console_invites where phone = $1", [normPhone(phone)]);
  }
}
