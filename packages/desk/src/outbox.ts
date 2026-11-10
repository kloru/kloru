/**
 * The outbox: the one way a message reaches a person on Kloru's own channels. Every agent submits
 * here. A fast first pass sends it now, drops it, or hands it to that person's organizer, a full
 * agent that sees everything waiting for them and decides what they get, when and in what shape.
 *
 * This file is plumbing: storage, timing, the state machine, retries, and one ledger entry per item.
 * What is worth sending is the first pass's and the organizer's judgment, from the person's guidelines.
 */
import { randomBytes } from "node:crypto";
import { moveItem, type OutboxState } from "./outbox-machine.js";
import { OutboxStore, type OutboxChannel, type OutboxItem, type OutboxThread, type OutboxWhy } from "./outbox-store.js";
import { err, ok, type Result } from "./result.js";

export interface OutboxSubmit {
  phone: string;
  text: string;
  why: OutboxWhy;
  from: OutboxItem["from"];
  channel?: OutboxChannel;
  subject?: string;
  media?: string[];
  thread?: OutboxThread;
  /** Set: the item waits as scheduled and fires then. */
  sendAt?: Date | string;
  drafted?: boolean;
  replyingTo?: string;
}

/** What the first pass and the organizer know about the person. */
export interface OutboxPerson {
  name: string;
  /** Their local time, in words ("Tue, Nov 10, 11:04 PM"). */
  localTime: string;
  guidelines: string;
  /** How they like messages. */
  preferences: string;
  /** The organizer's own dated notes about this person's outbox. */
  notes: string;
  /** Whether they're in a conversation with Kloru right now, and on what. */
  inConversation: string | undefined;
  /** The last turns of their latest conversation, oldest first. */
  turns: string[];
  /** Their requests still being worked on. */
  running: string[];
  channels: OutboxChannel[];
}

export interface FirstPassCheck {
  item: OutboxItem;
  /** The request behind the item, if any. */
  request: string;
  /** Pages it links that changed since they last got the link: the link is the same, the page isn't. */
  changedPages: string[];
  /** Minutes since it was submitted. */
  waitedMinutes: number;
  /** Set when a scheduled item's time arrived; a reminder's time is the one the person chose. */
  firing: boolean;
  person: OutboxPerson;
  queued: OutboxItem[];
  scheduled: OutboxItem[];
  /** What they were sent or had dropped in the last day, oldest first. */
  recent: string[];
  now: Date;
}

export type FirstPassChoice = "send" | "drop" | "organizer";

export interface OrganizerView {
  phone: string;
  now: Date;
  person: OutboxPerson;
  queued: OutboxItem[];
  scheduled: OutboxItem[];
  recent: string[];
  /** The request behind each queued item, by item id. */
  requests: Record<string, string>;
  /** Pages each queued item links that changed since they last got the link, by item id. */
  changed: Record<string, string[]>;
}

/** What the organizer can do; each returns a line for the organizer to read. */
export interface OrganizerActions {
  /** Send one item as written (no text), or a message the organizer wrote that carries the items. */
  send(o: { items: string[]; text?: string; channel?: OutboxChannel; subject?: string }): Promise<string>;
  /** Put content on a page (a new one, or a new version of `page`) and get its link. */
  page(o: { page?: string; title: string; markdown: string }): string;
  schedule(o: { items: string[]; at: Date }): string;
  drop(o: { items: string[]; reason: string }): string;
  wake(o: { at: Date }): string;
  note(o: { line: string }): string;
  ask(o: { question: string }): Promise<string>;
}

export interface Organizer {
  organize(view: OrganizerView, actions: OrganizerActions): Promise<void>;
}

export interface OutboxDeps {
  dir: string;
  now?: () => Date;
  log?: (m: string) => void;
  /** The fast first pass. Unset: everything is sent as it comes. Throwing counts as a failure. */
  firstPass?: (c: FirstPassCheck) => Promise<FirstPassChoice>;
  organizer?: Organizer;
  person: (phone: string) => OutboxPerson;
  request: (item: OutboxItem) => string;
  /** Pages the item links that changed since the person last got their link. */
  changedPages?: (item: OutboxItem) => string[];
  recent: (phone: string) => string[];
  /** Why this text misses how its reader likes messages, or undefined when it fits. */
  checkDraft?: (item: OutboxItem, text: string, channel: OutboxChannel | undefined) => Promise<string | undefined>;
  /** Hands the words to the channel: the channel it went on, or false. */
  deliver: (item: OutboxItem, o: { text: string; channel?: OutboxChannel; subject?: string }) => Promise<string | false>;
  /** One ledger entry: called once per item, when it reaches a final state. */
  record: (item: OutboxItem) => void;
  /** After an item was delivered. */
  sent?: (item: OutboxItem) => void;
  page?: (phone: string, o: { page?: string; title: string; markdown: string; issue?: number }) => Result<string>;
  addNote?: (phone: string, line: string) => Result<string>;
  isOwner?: (phone: string) => boolean;
  /** Quiet time after an item is queued before the organizer runs; each new item restarts it. */
  settleMs?: number;
  /** The longest a burst of items waits for the organizer. */
  maxSettleMs?: number;
  /** How soon the organizer looks after the person speaks, so the reply in that conversation lands first. */
  spokeMs?: number;
  /** The longest one organizer run may take. */
  organizerMs?: number;
}

const MINUTE = 60_000;
const samePhone = (a: string, b: string) => a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);

export class PersonOutbox {
  readonly store: OutboxStore;
  private readonly now: () => Date;
  private readonly log: (m: string) => void;
  private readonly settleMs: number;
  private readonly maxSettleMs: number;
  private readonly spokeMs: number;
  private readonly organizerMs: number;
  /** Organizer runs in progress, per person; a wake during a run is remembered in `again`. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  /** Items a tick is already handling. */
  private readonly busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: OutboxDeps) {
    this.store = new OutboxStore(deps.dir);
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.settleMs = deps.settleMs ?? 90_000;
    this.maxSettleMs = deps.maxSettleMs ?? 5 * MINUTE;
    this.spokeMs = deps.spokeMs ?? 20_000;
    this.organizerMs = deps.organizerMs ?? 3 * MINUTE;
  }

  // ---------------------------------------------------------------------------
  // Submitting
  // ---------------------------------------------------------------------------

  /** Every message starts here. Resolves once it was sent, dropped, queued or scheduled. */
  async submit(o: OutboxSubmit): Promise<OutboxItem> {
    const at = this.now().toISOString();
    const sendAt = o.sendAt === undefined ? undefined : new Date(o.sendAt);
    const waits = sendAt !== undefined && !Number.isNaN(sendAt.getTime()) && sendAt.getTime() > this.now().getTime();
    const item: OutboxItem = {
      id: `o_${randomBytes(5).toString("hex")}`,
      at,
      updatedAt: at,
      phone: o.phone,
      state: waits ? "scheduled" : "new",
      why: o.why,
      text: o.text.trim(),
      from: o.from,
      ...(o.channel ? { channel: o.channel } : {}),
      ...(o.subject ? { subject: o.subject } : {}),
      ...(o.media?.length ? { media: o.media } : {}),
      ...(o.thread ? { thread: o.thread } : {}),
      ...(waits ? { sendAt: sendAt.toISOString() } : {}),
      ...(o.drafted ? { drafted: true } : {}),
      ...(o.replyingTo ? { replyingTo: o.replyingTo } : {}),
    };
    this.store.save(item);
    this.log(`outbox ${item.id}: ${item.why} from ${item.from.agent}${item.from.issue ? ` #${item.from.issue}` : ""}, ${item.state}`);
    if (item.state === "scheduled") return item;
    this.busy.add(item.id);
    try {
      await this.firstPass(item, false);
    } finally {
      this.busy.delete(item.id);
    }
    return item;
  }

  /** The fast pass over one item: send it now, drop it, or leave it for the organizer. */
  private async firstPass(item: OutboxItem, firing: boolean): Promise<void> {
    let choice: FirstPassChoice;
    if (!this.deps.firstPass) {
      choice = "send";
    } else {
      try {
        choice = await this.deps.firstPass(this.check(item, firing));
      } catch (e) {
        // Without a decision: a direct reply and a reminder at the time they chose still go; the rest waits.
        choice = item.why === "reply" || (firing && item.why === "reminder") ? "send" : "organizer";
        this.log(`outbox ${item.id}: first pass failed (${(e as Error).message}), ${choice}`);
      }
    }
    this.log(`outbox ${item.id}: first pass → ${choice}`);
    if (choice === "drop") this.finish(item, "dropped", "the first pass: they don't need this");
    else if (choice === "organizer") this.queue(item);
    else await this.trySend(item);
  }

  private check(item: OutboxItem, firing: boolean): FirstPassCheck {
    const now = this.now();
    const items = this.store.items(item.phone).filter((i) => i.id !== item.id);
    return {
      item,
      request: this.deps.request(item),
      changedPages: this.deps.changedPages?.(item) ?? [],
      waitedMinutes: Math.round((now.getTime() - Date.parse(item.at)) / MINUTE),
      firing,
      person: this.deps.person(item.phone),
      queued: items.filter((i) => i.state === "queued"),
      scheduled: items.filter((i) => i.state === "scheduled"),
      recent: this.deps.recent(item.phone),
      now,
    };
  }

  // ---------------------------------------------------------------------------
  // Moving items
  // ---------------------------------------------------------------------------

  private move(item: OutboxItem, to: OutboxState, note?: string): boolean {
    const moved = moveItem(item, to);
    if (!moved.ok) {
      this.log(moved.error);
      return false;
    }
    item.updatedAt = this.now().toISOString();
    if (note !== undefined) item.note = note;
    this.store.save(item);
    return true;
  }

  /** A final state, and its one ledger entry. */
  private finish(item: OutboxItem, to: "sent" | "dropped" | "merged" | "cancelled", note?: string): boolean {
    if (!this.move(item, to, note)) return false;
    try {
      this.deps.record(item);
    } catch (e) {
      this.log(`outbox ${item.id}: ledger failed: ${(e as Error).message}`);
    }
    return true;
  }

  /** Leave it for the organizer, and make sure the organizer wakes. */
  private queue(item: OutboxItem, note?: string): void {
    if (item.state === "queued") {
      if (note !== undefined) {
        item.note = note;
        this.store.save(item);
      }
    } else if (!this.move(item, "queued", note)) return;
    this.settle(item.phone);
  }

  /** The organizer runs once the queue has been quiet for a moment; a burst never waits past the cap. */
  private settle(phone: string): void {
    const now = this.now().getTime();
    const clock = this.store.clock(phone);
    const burstStart = clock.burstStart ? Date.parse(clock.burstStart) : now;
    this.store.setClock(phone, { burstStart: new Date(burstStart).toISOString(), wakeAt: new Date(Math.min(now + this.settleMs, burstStart + this.maxSettleMs)).toISOString() });
  }

  /** Wake the organizer no later than `at`. */
  private wakeBy(phone: string, at: number): void {
    const clock = this.store.clock(phone);
    if (clock.wakeAt && Date.parse(clock.wakeAt) <= at) return;
    this.store.setClock(phone, { wakeAt: new Date(at).toISOString() });
  }

  /**
   * Send an item's words. It is saved as sending before the channel is called, so a restart in the
   * middle knows it may already have gone.
   */
  private async trySend(item: OutboxItem, o: { channel?: OutboxChannel; unchecked?: boolean } = {}): Promise<Result<string>> {
    const channel = o.channel ?? item.channel;
    if (!item.drafted && !o.unchecked && this.deps.checkDraft) {
      const why = await this.deps.checkDraft(item, item.text, channel).catch(() => undefined);
      if (why) {
        this.queue(item, `needs rewriting: ${why}`);
        return err(`it doesn't fit how they like messages (${why}). Write it yourself: send with these items and your text.`);
      }
    }
    if (!this.move(item, "sending")) return err(`${item.id} is ${item.state}`);
    return this.handOver(item, channel);
  }

  /** The channel call for an item already saved as sending. */
  private async handOver(item: OutboxItem, channel: OutboxChannel | undefined): Promise<Result<string>> {
    let went: string | false = false;
    let error = "the channel didn't take it";
    try {
      went = await this.deps.deliver(item, { text: item.text, ...(channel ? { channel } : {}), ...(item.subject ? { subject: item.subject } : {}) });
    } catch (e) {
      error = (e as Error).message;
    }
    if (went) {
      item.sentOn = went;
      this.finish(item, "sent");
      this.log(`outbox ${item.id}: sent on ${went}`);
      try {
        this.deps.sent?.(item);
      } catch (e) {
        this.log(`outbox ${item.id}: after-send failed: ${(e as Error).message}`);
      }
      return ok(went);
    }
    item.tries = (item.tries ?? 0) + 1;
    this.move(item, "queued", `not delivered: ${error}`);
    // Plumbing retry: the organizer looks again after a growing wait.
    this.wakeBy(item.phone, this.now().getTime() + Math.min(60 * MINUTE, this.settleMs * 2 ** item.tries));
    this.log(`outbox ${item.id}: not delivered (${error}), try ${item.tries}`);
    return err(`not delivered: ${error}. It stays queued.`);
  }

  // ---------------------------------------------------------------------------
  // What people and the talker see
  // ---------------------------------------------------------------------------

  /** What is waiting for this person: queued and scheduled, oldest first. */
  list(phone: string): OutboxItem[] {
    return this.store.items(phone).filter((i) => i.state === "queued" || i.state === "scheduled");
  }

  /** Everything for a person, oldest first. */
  all(phone: string): OutboxItem[] {
    return this.store.items(phone);
  }

  /** Cancel a waiting item: its own person may, and an owner may cancel anyone's. */
  cancel(id: string, by: string): Result<OutboxItem> {
    const item = this.store.find(id);
    if (!item) return err(`no outbox item ${id}`);
    if (!samePhone(item.phone, by) && !this.deps.isOwner?.(by)) return err("that message isn't yours to cancel");
    if (item.state !== "queued" && item.state !== "scheduled") return err(`${id} is already ${item.state}`);
    this.finish(item, "cancelled", `cancelled by ${samePhone(item.phone, by) ? "them" : "an owner"}`);
    return ok(item);
  }

  /** The organizer's latest question to this person in the last day, so their answer can be saved. */
  recentAsk(phone: string): string | undefined {
    const since = this.now().getTime() - 24 * 60 * MINUTE;
    return this.store
      .items(phone)
      .filter((i) => i.state === "sent" && i.from.agent === "organizer" && i.why === "question" && !i.covers && Date.parse(i.updatedAt) >= since)
      .at(-1)?.text;
  }

  /** The person said something or started a conversation: the organizer looks at what's waiting. */
  personSpoke(phone: string): void {
    if (!this.store.items(phone).some((i) => i.state === "queued")) return;
    this.wakeBy(phone, this.now().getTime() + this.spokeMs);
  }

  // ---------------------------------------------------------------------------
  // Time
  // ---------------------------------------------------------------------------

  start(pollMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`outbox tick failed: ${(e as Error).message}`)), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Fire scheduled items whose time came, and run organizers whose wake-up came. */
  async tick(): Promise<void> {
    const now = this.now().getTime();
    const work: Array<Promise<unknown>> = [];
    for (const phone of this.store.people()) {
      for (const item of this.store.items(phone)) {
        const due = (item.state === "scheduled" && Date.parse(item.sendAt ?? "") <= now) || item.state === "new";
        if (!due || this.busy.has(item.id)) continue;
        this.busy.add(item.id);
        work.push(this.firstPass(item, item.state === "scheduled").finally(() => this.busy.delete(item.id)));
      }
      const clock = this.store.clock(phone);
      const wake = (clock.wakeAt && Date.parse(clock.wakeAt) <= now) || (clock.selfWakeAt && Date.parse(clock.selfWakeAt) <= now);
      if (wake) work.push(this.runOrganizer(phone));
    }
    await Promise.all(work);
  }

  /**
   * After a restart: a send that was cut off may have gone, so it waits for the organizer and says so;
   * items the first pass never saw get it; a queue with nobody due to look at it gets a wake-up.
   */
  async recover(): Promise<void> {
    const now = this.now();
    for (const phone of this.store.people()) {
      for (const item of this.store.items(phone)) {
        if (item.state === "sending") this.move(item, "queued", "may already have been delivered (Kloru restarted mid-send)");
      }
      this.store.compact(phone, now);
      const clock = this.store.clock(phone);
      if (this.store.items(phone).some((i) => i.state === "queued") && !clock.wakeAt) this.settle(phone);
    }
    await this.tick();
  }

  // ---------------------------------------------------------------------------
  // The organizer
  // ---------------------------------------------------------------------------

  /** One run at a time per person; a wake that comes during a run starts another right after. */
  runOrganizer(phone: string): Promise<void> {
    const current = this.running.get(phone);
    if (current) {
      this.again.add(phone);
      return current;
    }
    const run = (async () => {
      do {
        this.again.delete(phone);
        await this.organize(phone).catch((e) => this.log(`outbox organizer for ${phone} failed: ${(e as Error).message}`));
      } while (this.again.has(phone));
    })().finally(() => this.running.delete(phone));
    this.running.set(phone, run);
    return run;
  }

  private async organize(phone: string): Promise<void> {
    const now = this.now();
    const before = this.store.clock(phone);
    const selfWakeAt = before.selfWakeAt && Date.parse(before.selfWakeAt) <= now.getTime() ? undefined : before.selfWakeAt;
    this.store.setClock(phone, { wakeAt: undefined, burstStart: undefined, selfWakeAt });
    const queued = this.store.items(phone).filter((i) => i.state === "queued");
    if (!queued.length) return;
    const failures = before.failures ?? 0;
    if (!this.deps.organizer) return this.sendWaiting(phone);
    const run = { open: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const view: OrganizerView = {
        phone,
        now,
        person: this.deps.person(phone),
        queued,
        scheduled: this.store.items(phone).filter((i) => i.state === "scheduled"),
        recent: this.deps.recent(phone),
        requests: Object.fromEntries(queued.map((i) => [i.id, this.deps.request(i)])),
        changed: Object.fromEntries(queued.map((i) => [i.id, this.deps.changedPages?.(i) ?? []])),
      };
      await Promise.race([
        this.deps.organizer.organize(view, this.actions(phone, run)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`took longer than ${Math.round(this.organizerMs / 1000)} s`)), this.organizerMs);
          timer.unref?.();
        }),
      ]);
      this.store.setClock(phone, { failures: undefined });
      // Whatever it left queued without saying when to look again is looked at again in an hour.
      const clock = this.store.clock(phone);
      if (this.store.items(phone).some((i) => i.state === "queued") && !clock.wakeAt && !clock.selfWakeAt) this.wakeBy(phone, this.now().getTime() + 60 * MINUTE);
    } catch (e) {
      this.log(`outbox organizer for ${phone}: run ${failures + 1} failed: ${(e as Error).message}`);
      if (failures + 1 >= 2) {
        this.store.setClock(phone, { failures: undefined });
        await this.sendWaiting(phone);
      } else {
        this.store.setClock(phone, { failures: failures + 1 });
        this.wakeBy(phone, this.now().getTime() + MINUTE);
      }
    } finally {
      run.open = false;
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Without a working organizer nothing someone waits for is lost: what's queued goes as written,
   * oldest first. Reports nobody asked for stay until an organizer can weigh them.
   */
  private async sendWaiting(phone: string): Promise<void> {
    for (const item of this.store.items(phone)) {
      if (item.state !== "queued" || item.why === "report") continue;
      await this.trySend(item, { unchecked: true });
    }
    if (this.store.items(phone).some((i) => i.state === "queued")) this.wakeBy(phone, this.now().getTime() + 60 * MINUTE);
  }

  private actions(phone: string, run: { open: boolean }): OrganizerActions {
    /** Drafts already sent back once, by the items they cover. */
    const redrafted = new Set<string>();
    const waiting = (ids: string[], states: OutboxState[] = ["queued"]): Result<OutboxItem[]> => {
      if (!run.open) return err("this run is over");
      if (!ids.length) return err("name the items");
      const items: OutboxItem[] = [];
      for (const id of ids) {
        const item = this.store.get(phone, id);
        if (!item) return err(`no item ${id}`);
        if (!states.includes(item.state)) return err(`${id} is ${item.state}`);
        items.push(item);
      }
      return ok(items);
    };
    return {
      send: async (o) => {
        const found = waiting(o.items);
        if (!found.ok) return found.error;
        const items = found.value;
        if (!o.text?.trim()) {
          if (items.length !== 1) return "To send several items as one message, write the message: send with items and text.";
          const sent = await this.trySend(items[0]!, o.channel ? { channel: o.channel } : {});
          return sent.ok ? `sent on ${sent.value}` : sent.error;
        }
        if (items.length > 1 && items.some((i) => i.why === "question")) return "A question goes on its own, never inside a digest. Send it separately.";
        const text = o.text.trim();
        const key = [...o.items].sort().join(",");
        if (this.deps.checkDraft && !redrafted.has(key)) {
          const why = await this.deps.checkDraft(items[0]!, text, o.channel ?? items[0]!.channel).catch(() => undefined);
          if (why) {
            redrafted.add(key);
            return `Not sent: it doesn't fit how they like messages (${why}). Rewrite it and send again.`;
          }
        }
        const sent = await this.sendWritten(phone, items, text, o.channel, o.subject);
        return sent.ok ? `sent on ${sent.value}; it covers ${o.items.join(", ")}` : sent.error;
      },
      page: (o) => {
        if (!run.open) return "this run is over";
        if (!this.deps.page) return "pages aren't available";
        const made = this.deps.page(phone, o);
        return made.ok ? `The page is at ${made.value}. Put that link in the message you send.` : made.error;
      },
      schedule: (o) => {
        const found = waiting(o.items);
        if (!found.ok) return found.error;
        if (Number.isNaN(o.at.getTime()) || o.at.getTime() <= this.now().getTime()) return "That time isn't in the future.";
        for (const item of found.value) {
          item.sendAt = o.at.toISOString();
          this.move(item, "scheduled");
        }
        return `scheduled for ${o.at.toISOString()}; each is weighed again then`;
      },
      drop: (o) => {
        const found = waiting(o.items, ["queued", "scheduled"]);
        if (!found.ok) return found.error;
        for (const item of found.value) this.finish(item, "dropped", o.reason.trim() || "the organizer dropped it");
        return "dropped";
      },
      wake: (o) => {
        if (!run.open) return "this run is over";
        if (Number.isNaN(o.at.getTime()) || o.at.getTime() <= this.now().getTime()) return "That time isn't in the future.";
        this.store.setClock(phone, { selfWakeAt: o.at.toISOString() });
        return `you'll look again at ${o.at.toISOString()}`;
      },
      note: (o) => {
        if (!run.open) return "this run is over";
        if (!this.deps.addNote) return "notes aren't available";
        const saved = this.deps.addNote(phone, o.line);
        return saved.ok ? "noted" : saved.error;
      },
      ask: async (o) => {
        if (!run.open) return "this run is over";
        const text = o.question.trim();
        if (!text) return "Ask what?";
        const sent = await this.sendWritten(phone, [], text, undefined, undefined, "question");
        return sent.ok ? "asked; their answer is saved as a guideline when it comes" : sent.error;
      },
    };
  }

  /**
   * A message the organizer wrote. The drafts it carries are kept: each ends as merged, naming this
   * message, and this message lists what it covers.
   */
  private async sendWritten(phone: string, covered: OutboxItem[], text: string, channel?: OutboxChannel, subject?: string, why?: OutboxWhy): Promise<Result<string>> {
    const at = this.now().toISOString();
    const issues = [...new Set(covered.map((i) => i.from.issue).filter((n): n is number => n !== undefined))];
    const calls = [...new Set(covered.map((i) => i.from.call).filter((c): c is string => !!c))];
    const media = [...new Set(covered.flatMap((i) => i.media ?? []))];
    const only = covered.length === 1 ? covered[0]! : undefined;
    const useChannel = channel ?? only?.channel;
    const item: OutboxItem = {
      id: `o_${randomBytes(5).toString("hex")}`,
      at,
      updatedAt: at,
      phone,
      state: "sending",
      why: why ?? (covered.some((i) => i.why === "question") ? "question" : covered.some((i) => i.why === "result" || i.why === "reply") ? "result" : covered.some((i) => i.why === "reminder") ? "reminder" : "report"),
      text,
      from: { agent: "organizer", ...(issues.length === 1 ? { issue: issues[0] } : {}), ...(calls.length === 1 ? { call: calls[0] } : {}) },
      drafted: true,
      ...(useChannel ? { channel: useChannel } : {}),
      ...(subject ?? only?.subject ? { subject: subject ?? only?.subject } : {}),
      ...(media.length ? { media } : {}),
      // One item answered in its own thread keeps the thread, unless the organizer moved it to another channel.
      ...(only?.thread && (!channel || channel === only.thread.channel) ? { thread: only.thread } : {}),
      ...(covered.length ? { covers: covered.map((i) => i.id) } : {}),
    };
    this.store.save(item);
    for (const c of covered) {
      c.coveredBy = item.id;
      this.finish(c, "merged");
    }
    return this.handOver(item, useChannel);
  }
}

// One formatter per timezone and shape, kept: building one per call leaks native memory (the 2026-11-09 freeze).
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", options);
    formatters.set(key, f);
  }
  return f;
}

/**
 * A time an agent wrote, as a date: ISO with an offset is taken as is; a bare local time
 * ("2026-11-11T07:05") is read in the person's timezone.
 */
export function whenIn(at: string, timezone: string): Date | undefined {
  const text = at.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return undefined;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  // The zone's offset at that moment, found by asking what the wall clock reads there; twice, for a change of clocks.
  const offset = (utc: number) => {
    const parts = Object.fromEntries(formatter(`wall:${timezone}`, { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utc)).map((p) => [p.type, p.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - utc;
  };
  let utc = wall - offset(wall);
  utc = wall - offset(utc);
  return new Date(utc);
}

/** A time in words in a timezone ("Tue, Nov 10, 11:04 PM"). */
export function localTime(d: Date, timezone: string): string {
  return formatter(`words:${timezone}`, { timeZone: timezone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
}
