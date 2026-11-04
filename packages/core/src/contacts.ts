/**
 * People the owner knows, with their trust tier and the addresses that identify
 * them. Stored as a plain JSON array in contacts.json so the owner can edit it.
 */
import fs from "node:fs";
import path from "node:path";
import type { StateDir } from "./state.js";
import { isReservedHandle, normalizeEmail, normalizeHandle, normalizePhone } from "./principal.js";
import { TIER_ORDER } from "./types.js";
import type { Contact, Tier } from "./types.js";

const FILE = "contacts.json";

/** "Sam Lee" -> "sam-lee". Ids are stable and readable because they appear in grants. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "contact";
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/** Callers get deep copies so a mutated result can never leak back into the cache. */
function copy(c: Contact): Contact {
  return structuredClone(c);
}

/**
 * Tiers a contact may hold. `owner` is a co-owner: the trust tools and the owner API refuse it, so
 * it only gets here through set_member with an owner's yes (Kloru's desk), and it survives a restart.
 */
const CONTACT_TIERS: ReadonlySet<Tier> = new Set(TIER_ORDER);

/** Thrown when someone tries to put a contact without an agent handle in the staff tier. */
export class StaffNeedsAgentError extends Error {
  constructor(name: string) {
    super(
      `Tier "staff" is only for agents, and ${name} has no agent handle. ` +
        `Save their agent's Inkbox handle first (instinct invite "${name}" --tier staff --handle <handle>), or pick partner or lower.`,
    );
    this.name = "StaffNeedsAgentError";
  }
}

/** Throws StaffNeedsAgentError when `tier` is staff and there is no agent handle. */
export function assertStaffHasAgent(name: string, tier: Tier | undefined, agentHandle: string | undefined): void {
  if (tier === "staff" && !(agentHandle && normalizeHandle(agentHandle))) throw new StaffNeedsAgentError(name);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Turn one raw entry from contacts.json into a Contact, or undefined when it has no usable
 * id or name. Missing address lists become [], and an unknown tier (or `owner`) becomes
 * stranger, so a hand edit can only ever lower someone's access.
 */
function sanitize(raw: unknown): Contact | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  const name = typeof r.name === "string" && r.name.trim() ? r.name : id;
  if (!id || !name) return undefined;
  const tier = typeof r.tier === "string" && CONTACT_TIERS.has(r.tier as Tier) ? (r.tier as Tier) : "stranger";
  const now = new Date(0).toISOString();
  const c: Contact = {
    id,
    name,
    tier,
    phones: stringList(r.phones),
    emails: stringList(r.emails),
    createdAt: typeof r.createdAt === "string" ? r.createdAt : now,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : now,
  };
  if (typeof r.agentHandle === "string" && normalizeHandle(r.agentHandle) && !isReservedHandle(r.agentHandle)) c.agentHandle = r.agentHandle;
  if (typeof r.notes === "string") c.notes = r.notes;
  if (typeof r.policy === "string") c.policy = r.policy;
  return c;
}

export interface ContactStoreOptions {
  /** Where load problems are reported. Defaults to console.warn. */
  warn?: (message: string) => void;
}

export class ContactStore {
  private readonly state: StateDir;
  private readonly warn: (message: string) => void;
  private cache: Contact[] | undefined;
  /** Identity of contacts.json (inode, mtime, size) when the cache was filled, or "" when absent. */
  private cacheStamp: string | undefined;
  /** Why the last load failed. While set, the cache is stale and saving is refused. */
  private loadError: string | undefined;

  constructor(state: StateDir, opts: ContactStoreOptions = {}) {
    this.state = state;
    this.warn = opts.warn ?? ((m) => console.warn(`[instinct] ${m}`));
  }

  private static stampOf(st: fs.Stats): string {
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  }

  /** The file's current stamp, or "" when it does not exist. */
  private stamp(): string {
    try {
      return ContactStore.stampOf(fs.statSync(this.state.path(FILE)));
    } catch {
      return "";
    }
  }

  /**
   * Re-read the file when something else wrote it (the owner in an editor, a host that
   * seeds teammates), so a change applies without restarting the agent. A file that does
   * not parse keeps the previous cache (empty only on a cold start) and blocks saves until
   * it is fixed, so a typo can never wipe the list.
   */
  private load(): Contact[] {
    const stamp = this.stamp();
    if (this.cache && stamp === this.cacheStamp) return this.cache;
    this.cacheStamp = stamp;
    if (!stamp) {
      this.cache = [];
      this.loadError = undefined;
      return this.cache;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.state.path(FILE), "utf8"));
      if (!Array.isArray(raw)) throw new Error("expected a JSON array of contacts");
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      this.warn(`${FILE} could not be read (${this.loadError}); keeping the ${this.cache ? "previous" : "empty"} contact list and refusing to save until it is fixed.`);
      this.cache ??= [];
      return this.cache;
    }
    const list: Contact[] = [];
    raw.forEach((entry, i) => {
      const c = sanitize(entry);
      if (c) list.push(c);
      else this.warn(`${FILE}: skipped entry ${i}, it has no id or name.`);
    });
    this.cache = list;
    this.loadError = undefined;
    return this.cache;
  }

  /** load() for a mutation: refuses while contacts.json is unreadable, before anything changes. */
  private loadForWrite(): Contact[] {
    const list = this.load();
    if (this.loadError !== undefined) {
      throw new Error(`${FILE} could not be read (${this.loadError}). Fix or remove the file before changing contacts, so the existing list is not overwritten.`);
    }
    return list;
  }

  private save(list: Contact[]): void {
    const file = this.state.path(FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write a sibling and rename, recording the stamp of the file we wrote. rename keeps the
    // inode, mtime and size, so a later external write is always seen as a change.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", "utf8");
    const stamp = ContactStore.stampOf(fs.statSync(tmp));
    fs.renameSync(tmp, file);
    this.cache = list;
    this.cacheStamp = stamp;
    this.loadError = undefined;
  }

  all(): Contact[] {
    return this.load().map(copy);
  }

  get(id: string): Contact | undefined {
    const found = this.load().find((c) => c.id === id);
    return found ? copy(found) : undefined;
  }

  findByPhone(phone: string): Contact | undefined {
    const n = normalizePhone(phone);
    if (!n) return undefined;
    const found = this.load().find((c) => c.phones.some((p) => normalizePhone(p) === n));
    return found ? copy(found) : undefined;
  }

  findByEmail(email: string): Contact | undefined {
    const n = normalizeEmail(email);
    if (!n) return undefined;
    const found = this.load().find((c) => c.emails.some((e) => normalizeEmail(e) === n));
    return found ? copy(found) : undefined;
  }

  findByHandle(handle: string): Contact | undefined {
    const n = normalizeHandle(handle);
    if (!n) return undefined;
    const found = this.load().find((c) => c.agentHandle && normalizeHandle(c.agentHandle) === n);
    return found ? copy(found) : undefined;
  }

  /** Case-insensitive substring search over name, id, addresses, handle and notes. */
  search(q: string): Contact[] {
    const needle = q.trim().toLowerCase();
    if (!needle) return this.all();
    const digits = needle.replace(/\D/g, "");
    return this.load()
      .filter((c) => {
        const hay = [c.name, c.id, c.agentHandle ?? "", c.notes ?? "", ...c.emails].join(" ").toLowerCase();
        if (hay.includes(needle)) return true;
        return digits.length >= 4 && c.phones.some((p) => p.replace(/\D/g, "").includes(digits));
      })
      .map(copy);
  }

  /**
   * Create or update. Matching order: explicit id, then any shared phone, email or
   * agent handle, then the slug of the name. Addresses are merged, not replaced.
   */
  upsert(input: Partial<Contact> & { name: string }): Contact {
    const list = this.loadForWrite();
    const now = new Date().toISOString();
    const phones = uniq((input.phones ?? []).map(normalizePhone));
    const emails = uniq((input.emails ?? []).map(normalizeEmail));
    const handle = input.agentHandle ? normalizeHandle(input.agentHandle) : undefined;
    if (handle !== undefined && isReservedHandle(handle)) {
      throw new Error(`"${handle}" is a reserved handle and cannot belong to a contact's agent`);
    }

    const existing =
      (input.id ? list.find((c) => c.id === input.id) : undefined) ??
      list.find(
        (c) =>
          c.phones.some((p) => phones.includes(normalizePhone(p))) ||
          c.emails.some((e) => emails.includes(normalizeEmail(e))) ||
          (handle !== undefined && c.agentHandle !== undefined && normalizeHandle(c.agentHandle) === handle),
      ) ??
      (input.id === undefined ? list.find((c) => c.id === slugify(input.name)) : undefined);

    // Check before touching the cached entry, so a refused change leaves nothing behind.
    assertStaffHasAgent(existing?.name ?? input.name, input.tier, handle ?? existing?.agentHandle);

    if (existing) {
      existing.name = input.name;
      if (input.tier) existing.tier = input.tier;
      existing.phones = uniq([...existing.phones.map(normalizePhone), ...phones]);
      existing.emails = uniq([...existing.emails.map(normalizeEmail), ...emails]);
      if (handle) existing.agentHandle = handle;
      if (input.notes !== undefined) existing.notes = input.notes;
      if (input.policy !== undefined) existing.policy = input.policy;
      existing.updatedAt = now;
      this.save(list);
      return copy(existing);
    }

    // A second person with the same name needs an explicit id ("alex-kim-work"):
    // by default the name merges, because "add Alex's email" is the common case.
    const id = input.id ?? slugify(input.name);

    const contact: Contact = {
      id,
      name: input.name,
      tier: input.tier ?? "contact",
      phones,
      emails,
      createdAt: now,
      updatedAt: now,
    };
    if (handle) contact.agentHandle = handle;
    if (input.notes !== undefined) contact.notes = input.notes;
    if (input.policy !== undefined) contact.policy = input.policy;
    list.push(contact);
    this.save(list);
    return copy(contact);
  }

  setTier(id: string, tier: Tier): Contact | undefined {
    const list = this.loadForWrite();
    const c = list.find((x) => x.id === id);
    if (!c) return undefined;
    assertStaffHasAgent(c.name, tier, c.agentHandle);
    c.tier = tier;
    c.updatedAt = new Date().toISOString();
    this.save(list);
    return copy(c);
  }

  remove(id: string): boolean {
    const list = this.loadForWrite();
    const next = list.filter((c) => c.id !== id);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }
}
