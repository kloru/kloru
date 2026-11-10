/**
 * Where outbox items live: one file per person, outbox/<phone digits>.jsonl. Every change appends
 * the whole item and syncs it to disk before anything else happens, so a restart never loses a
 * message or sends one twice without knowing. The newest line per id is the item.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isFinal, type OutboxState } from "./outbox-machine.js";

/** Why a message exists; set by the code that submits it, never by the agent that wrote the words. */
export type OutboxWhy = "reply" | "result" | "report" | "question" | "reminder";

export type OutboxChannel = "imessage" | "email";

/** The conversation thread a message answers in (a text thread, an email thread). */
export interface OutboxThread {
  channel: OutboxChannel;
  to: string;
  subject?: string;
  /** Email only: the headers that keep a reply in its thread. */
  threading?: { inReplyTo?: string; references?: string[] };
}

export interface OutboxItem {
  id: string;
  /** When it was submitted, and when it last changed. */
  at: string;
  updatedAt: string;
  phone: string;
  state: OutboxState;
  why: OutboxWhy;
  /** The words as drafted; never edited in place. */
  text: string;
  /** The channel its writer suggested; the organizer may choose another. */
  channel?: OutboxChannel;
  subject?: string;
  /** Media ids to attach. */
  media?: string[];
  from: { agent: "talker" | "worker" | "pm" | "organizer" | "system"; issue?: number; call?: string };
  thread?: OutboxThread;
  /** When a scheduled item fires. */
  sendAt?: string;
  /** Its writer already had the draft checked against how the reader likes messages. */
  drafted?: boolean;
  /** What the person wrote that this answers. */
  replyingTo?: string;
  /** Why it is where it is: a drop reason, a channel error, "may already have been delivered". */
  note?: string;
  /** Failed sends so far. */
  tries?: number;
  /** For a merged item: the message that carried it. */
  coveredBy?: string;
  /** For a message the organizer wrote: the items it carries. */
  covers?: string[];
  /** The channel it went out on. */
  sentOn?: string;
}

/** What the organizer's timer remembers per person. */
export interface OutboxClock {
  /** When the organizer next runs because items are queued. */
  wakeAt?: string;
  /** When the current burst of queued items began: the wait never runs past five minutes from here. */
  burstStart?: string;
  /** A wake-up the organizer set for itself. */
  selfWakeAt?: string;
  /** Organizer runs that failed in a row. */
  failures?: number;
}

const DAY_MS = 86_400_000;
const KEEP_FINAL_MS = 30 * DAY_MS;

const digits = (phone: string) => phone.replace(/\D/g, "") || "unknown";

function appendSynced(path: string, line: string): void {
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeSynced(path: string, body: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function parseItems(path: string): Map<string, OutboxItem> {
  const items = new Map<string, OutboxItem>();
  if (!existsSync(path)) return items;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line) as OutboxItem;
      items.set(item.id, item);
    } catch {
      // A line cut off by a crash: the item's earlier line stands.
    }
  }
  return items;
}

/** Every person's items, oldest first, straight from disk (the website reads this). */
export function readOutbox(dir: string): OutboxItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => [...parseItems(join(dir, f)).values()])
    .sort((a, b) => a.at.localeCompare(b.at));
}

export class OutboxStore {
  private readonly cache = new Map<string, Map<string, OutboxItem>>();
  private readonly clocks = new Map<string, OutboxClock>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private load(phone: string): Map<string, OutboxItem> {
    const key = digits(phone);
    let items = this.cache.get(key);
    if (!items) {
      items = parseItems(join(this.dir, `${key}.jsonl`));
      this.cache.set(key, items);
    }
    return items;
  }

  /** Everyone with an outbox file. */
  people(): string[] {
    const phones = new Set<string>();
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const first = this.load(f.slice(0, -".jsonl".length)).values().next().value as OutboxItem | undefined;
      if (first) phones.add(first.phone);
    }
    return [...phones];
  }

  /** A person's items, oldest first. */
  items(phone: string): OutboxItem[] {
    return [...this.load(phone).values()].sort((a, b) => a.at.localeCompare(b.at));
  }

  get(phone: string, id: string): OutboxItem | undefined {
    return this.load(phone).get(id);
  }

  /** Find an item by id across everyone. */
  find(id: string): OutboxItem | undefined {
    for (const phone of this.people()) {
      const item = this.get(phone, id);
      if (item) return item;
    }
    return undefined;
  }

  /** Write the item as it is now; on disk before this returns. */
  save(item: OutboxItem): void {
    this.load(item.phone).set(item.id, item);
    appendSynced(join(this.dir, `${digits(item.phone)}.jsonl`), `${JSON.stringify(item)}\n`);
  }

  clock(phone: string): OutboxClock {
    const key = digits(phone);
    let clock = this.clocks.get(key);
    if (!clock) {
      const path = join(this.dir, `${key}.json`);
      try {
        clock = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as OutboxClock) : {};
      } catch {
        clock = {};
      }
      this.clocks.set(key, clock);
    }
    return clock;
  }

  setClock(phone: string, change: Partial<OutboxClock>): OutboxClock {
    const clock = { ...this.clock(phone), ...change };
    for (const k of Object.keys(clock) as Array<keyof OutboxClock>) if (clock[k] === undefined) delete clock[k];
    this.clocks.set(digits(phone), clock);
    writeSynced(join(this.dir, `${digits(phone)}.json`), JSON.stringify(clock));
    return clock;
  }

  /** Rewrite a person's file with one line per item, leaving out finished items older than 30 days. */
  compact(phone: string, now: Date): number {
    const items = this.load(phone);
    const before = items.size;
    for (const [id, item] of items) {
      if (isFinal(item.state) && now.getTime() - Date.parse(item.updatedAt) > KEEP_FINAL_MS) items.delete(id);
    }
    writeSynced(join(this.dir, `${digits(phone)}.jsonl`), [...items.values()].map((i) => `${JSON.stringify(i)}\n`).join(""));
    return before - items.size;
  }
}
