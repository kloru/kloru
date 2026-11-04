/**
 * Texts and emails as desk conversations, like phone calls. Each thread (one iMessage thread per
 * person; an email thread by its root Message-ID) is a desk call with channel imessage or email.
 * Each message from them is a caller turn the text talker answers; each result that lands in the
 * call's inbox becomes one message in the thread. Every message goes through the desk's one outbox
 * (sendInConversation): checked like any other, sent on this thread, and recorded in the ledger. Quiet for idleMs ends the conversation, which
 * runs the memory update and the after-conversation note exactly as hanging up does.
 *
 * Who's writing is a hard rule: a phone number through the family's caller list, an email address
 * only when it passed DMARC (email is easy to forge, and these conversations act with their powers).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { luhnNumbers, mediaNote, type ConversationSend, type Desk, type MediaItem, type Merge } from "@kloru/desk";
import { normalizePhone } from "@kloru/core";
import type { Caller } from "./desk-routes.js";
import type { TalkerTurn } from "./text-talker.js";
import { REDRAFT, type DraftInput, type DraftVerdict, type FeedbackInput, type MessageShape, type ShapeInput } from "./message-shape.js";

export interface TextIn {
  channel: "imessage" | "email";
  /** The provider's message id, for dedupe. */
  id: string;
  /** A phone number (iMessage) or an email address. */
  from: string;
  /** The thread: `imessage:<phone>`, or an email thread's root Message-ID. */
  thread: string;
  text: string;
  subject?: string;
  messageId?: string;
  references?: string[];
  /** Email only: Resend's DMARC verdict for the From domain. */
  dmarc?: string;
  /** iMessage: Inkbox's conversation key and message id, so Kloru can react to it. */
  reactTo?: ReactTarget;
  /** Photos and files that came with it: downloaded only once the sender is known to be family. */
  attachments?: Array<{ url: string; mime?: string; name?: string }>;
}

export interface ReactTarget {
  conversation: string;
  message: string;
}

export interface EmailThreading {
  inReplyTo?: string;
  references?: string[];
}

interface Thread {
  key: string;
  callId: string;
  phone: string;
  channel: TextIn["channel"];
  /** Where replies go: their number or their address. */
  to: string;
  subject: string;
  threading: EmailThreading;
  brief: string;
  seq: number;
  timer?: ReturnType<typeof setTimeout>;
  /** One turn at a time per thread, in order. */
  chain: Promise<unknown>;
  /** Their last message, and where a reaction on it goes. */
  lastAsk?: string;
  reactTo?: ReactTarget;
  /** The last result Kloru passed on, to learn from how they answer it. */
  lastSent?: { asked: string; text: string; shape: MessageShape };
}

export interface TextDeskOptions {
  desk: Desk;
  callers: (phone: string) => Caller;
  /** The phone of the person an email address belongs to (owner or contact); undefined: nobody we know. */
  emailPerson: (address: string) => string | undefined;
  talker: (t: TalkerTurn) => Promise<string>;
  send: {
    imessage?: (to: string, text: string) => Promise<boolean>;
    email?: (to: string, subject: string, text: string, threading: EmailThreading) => Promise<boolean>;
    /** A tapback on their message: how a text says "on it" without another message. */
    react?: (conversation: string, message: string, reaction: Reaction) => Promise<boolean>;
  };
  idleMs?: number;
  /** Message ids already handled, kept across restarts (a provider may redeliver after a deploy). */
  seenFile?: string;
  /** How long to wait for more results before telling them as one message. */
  burstMs?: number;
  /** The longest a held result waits for others to go with it. */
  holdMs?: number;
  timezone: string;
  log: (m: string) => void;
  /** How a written message should look for this person (message-shape.ts), decided before it's written. */
  shape?: (s: ShapeInput) => Promise<MessageShape>;
  /** Whether a written draft fits how they like messages; anything else sends it back once to be redrafted. */
  checkDraft?: (d: DraftInput) => Promise<{ verdict: DraftVerdict; p?: number }>;
  /** What their reply says about how the last message was written: a line for their messages.md. */
  feedback?: (f: FeedbackInput) => Promise<string | undefined>;
  /** Keep one attachment in the media store, as the person it came from. */
  ingest?: (a: NonNullable<TextIn["attachments"]>[number], phone: string) => Promise<MediaItem | undefined>;
}

type Reaction = "eyes" | "like";

const SEEN_MAX = 2000;

export class TextDesk {
  private readonly threads = new Map<string, Thread>();
  private readonly seen = new Set<string>();
  private readonly idleMs: number;
  private readonly burstMs: number;
  private readonly holdMs: number;

  constructor(private readonly o: TextDeskOptions) {
    this.idleMs = o.idleMs ?? 30 * 60_000;
    this.burstMs = o.burstMs ?? 3000;
    this.holdMs = o.holdMs ?? 90_000;
    if (o.seenFile && existsSync(o.seenFile)) {
      for (const id of readFileSync(o.seenFile, "utf8").split("\n").filter(Boolean).slice(-SEEN_MAX)) this.seen.add(id);
    }
  }

  /** One message from someone. Resolves once their reply (if any) is sent. */
  async receive(m: TextIn): Promise<void> {
    const key = `${m.channel}:${m.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    if (this.o.seenFile) {
      try {
        appendFileSync(this.o.seenFile, `${key}\n`);
      } catch (error) {
        this.o.log(`text: can't record message ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!m.text.trim() && !m.attachments?.length) return;

    const phone = this.whoIs(m);
    if (!phone) {
      this.o.log(`text: ignored a ${m.channel} message from someone who isn't family`);
      return;
    }
    const notes = await this.keep(m.attachments ?? [], phone);
    const raw = [m.text.trim(), ...notes].filter(Boolean).join("\n");
    if (!raw) return;
    // A card number sent by text or email never reaches the transcript, a model or memory.
    const cards = luhnNumbers(raw);
    const words = cards.length
      ? `${cards.reduce((t, c) => t.split(c).join("[card number removed]"), raw)}\n(They sent a card number. Kloru removed it before anyone saw it: tell them cards go in the Vault on Kloru's website, never by text or email.)`
      : raw;
    const { t, fresh } = this.open(m, phone);
    if (m.channel === "email") {
      t.threading = { ...(m.messageId ? { inReplyTo: m.messageId } : {}), references: [...(m.references ?? []), ...(m.messageId ? [m.messageId] : [])] };
      if (m.subject) t.subject = m.subject;
    }
    this.touch(t);
    const run = t.chain.then(() => this.answer(t, words, m.channel === "imessage" ? m.reactTo : undefined));
    t.chain = run.catch(() => undefined);
    try {
      await run;
    } catch (error) {
      // Accepted from the provider, so it won't come again: tell them rather than go quiet.
      this.o.log(`text: couldn't answer in ${t.callId}: ${error instanceof Error ? error.message : String(error)}`);
      await this.send(t, "Sorry, I couldn't work on that just now. Could you send it again?", [], words).catch(() => "failed");
    } finally {
      if (fresh) void this.pump(t.key, t);
    }
  }

  /** Shutdown: open conversations end properly (memory update, note), so a deploy doesn't cut them off. */
  close(): void {
    for (const t of this.threads.values()) {
      clearTimeout(t.timer);
      if (!this.o.desk.repo.call(t.callId)?.endedAt) this.o.desk.endCall(t.callId);
    }
    this.threads.clear();
  }

  /** Each attachment kept and noted ([photo m_…]); one that can't be kept is said so. */
  private async keep(attachments: NonNullable<TextIn["attachments"]>, phone: string): Promise<string[]> {
    if (!this.o.ingest || !attachments.length) return [];
    const notes: string[] = [];
    for (const a of attachments.slice(0, 10)) {
      try {
        const item = await this.o.ingest(a, phone);
        if (item) notes.push(mediaNote(item));
      } catch (error) {
        notes.push(`[${a.name ?? "an attachment"} couldn't be kept: ${error instanceof Error ? error.message : String(error)}]`);
      }
    }
    return notes;
  }

  private whoIs(m: TextIn): string | undefined {
    if (m.channel === "imessage") {
      const phone = normalizePhone(m.from);
      return phone && this.o.callers(phone).allowed ? phone : undefined;
    }
    if (!m.from) return undefined;
    if ((m.dmarc ?? "").toLowerCase() !== "pass") return undefined;
    const phone = this.o.emailPerson(m.from.toLowerCase());
    return phone && this.o.callers(phone).allowed ? phone : undefined;
  }

  /** A thread is one person's: someone else replying in it (a CC'd reply-all) gets their own conversation. */
  private open(m: TextIn, phone: string): { t: Thread; fresh: boolean } {
    const key = `${m.channel}:${phone}:${m.thread}`;
    const existing = this.threads.get(key);
    if (existing && !this.o.desk.repo.call(existing.callId)?.endedAt) return { t: existing, fresh: false };
    const { call, brief } = this.o.desk.startCall({ callSid: `${m.channel}:${m.id}`, phone, channel: m.channel });
    const t: Thread = { key, callId: call.id, phone, channel: m.channel, to: m.from, subject: m.subject ?? "", threading: {}, brief, seq: call.deliveredSeq ?? 0, chain: Promise.resolve() };
    this.threads.set(key, t);
    return { t, fresh: true };
  }

  /** Quiet for idleMs ends the conversation, once. */
  private touch(t: Thread): void {
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      for (const [k, v] of this.threads) if (v === t) this.threads.delete(k);
      if (!this.o.desk.repo.call(t.callId)?.endedAt) this.o.desk.endCall(t.callId);
    }, this.idleMs);
    t.timer.unref?.();
  }

  /**
   * Their message, answered with whatever was waiting for them (an ask, a result, a held burst) in
   * view: it's part of this answer, so it isn't sent again a moment later.
   */
  private async answer(t: Thread, text: string, reactTo?: ReactTarget): Promise<void> {
    this.o.desk.addTurn(t.callId, { role: "caller", text });
    // How they answered the last result teaches how they like messages; it never holds up the reply.
    if (t.lastSent && this.o.feedback) {
      const last = t.lastSent;
      void this.o.feedback({ asked: last.asked, sent: last.text, shape: last.shape, reply: text }).then(
        (line) => line && this.o.desk.learnMessagePreference(t.phone, line),
        (e: Error) => this.o.log(`text: feedback check failed: ${e.message}`),
      );
    }
    t.lastSent = undefined;
    t.lastAsk = text;
    if (reactTo) t.reactTo = reactTo;
    const carried = this.o.desk.repo.inbox(t.callId, t.seq);
    const r = await this.say(t, carried, text, reactTo);
    if (carried.length && r !== "failed") {
      t.seq = carried.at(-1)!.seq;
      this.o.desk.ack(t.callId, t.seq);
    }
  }

  /**
   * Results that land in the conversation's inbox become messages, a burst as one. A held burst goes
   * with the next result, or on its own once it has waited holdMs.
   */
  private async pump(key: string, t: Thread): Promise<void> {
    let after = t.seq;
    let heldAt: number | undefined;
    for (;;) {
      const call = this.o.desk.repo.call(t.callId);
      if (!call || call.endedAt || this.threads.get(key) !== t) return;
      after = Math.max(after, t.seq);
      const first = await this.o.desk.waitInbox(t.callId, after, heldAt === undefined ? 60_000 : Math.max(0, heldAt + this.holdMs - Date.now()));
      const due = !first.length && heldAt !== undefined && Date.now() - heldAt >= this.holdMs;
      if (!first.length && !due) continue;
      if (first.length) await new Promise((r) => setTimeout(r, this.burstMs).unref?.());
      // Read in turn with their messages: a reply that already carried these leaves nothing to send.
      let last = t.seq;
      const run = t.chain.then(async () => {
        const merges = this.o.desk.repo.inbox(t.callId, t.seq);
        if (!merges.length) return "none" as const;
        last = merges.at(-1)!.seq;
        return this.say(t, merges, undefined, undefined, due);
      });
      t.chain = run.catch(() => undefined);
      let r: ConversationSend | "quiet" | "none" = "failed";
      try {
        r = await run;
      } catch (error) {
        this.o.log(`text: passing on results for ${t.callId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (r === "none") {
        heldAt = undefined;
        continue;
      }
      // Not sent (a failed send): left undelivered, so the note after the conversation carries it.
      if (r === "failed") return;
      // Held: it waits for the next result and goes with it.
      if (r === "held") {
        after = last;
        heldAt ??= Date.now();
        continue;
      }
      heldAt = undefined;
      t.seq = last;
      this.o.desk.ack(t.callId, last);
    }
  }

  /** One message from Kloru, through the one outbox; quiet when there's nothing new to say. */
  private async say(t: Thread, merges: Merge[] = [], replyingTo?: string, reactTo?: ReactTarget, heldBefore = false): Promise<ConversationSend | "quiet"> {
    const shape = await this.shapeFor(t, merges, replyingTo);
    // A reaction goes on their message: the one this answers, or for a result, the one that asked.
    const target = reactTo ?? (merges.length ? t.reactTo : undefined);
    const reacted = { done: false };
    const turn = {
      brief: t.brief,
      channel: t.channel,
      thread: this.o.desk.repo.turns(t.callId, 0).slice(-30).map((x) => ({ role: x.role === "caller" ? "caller" : "kloru", text: x.text })),
      ...(merges.length ? { event: merges.map(tag).join("\n") } : {}),
      pending: this.pending(t),
      open: this.openFor(t),
      tools: {
        fileIssue: (request) => `Filed #${this.o.desk.fileIssue(t.callId, request).id}.`,
        updateIssue: (issue, text) => (this.o.desk.comment(issue, t.callId, text), "Updated."),
        confirm: (issue, draft) => {
          // A yes has to be in their own words: never in a message that carries a forward.
          const last = this.o.desk.repo.turns(t.callId, 0).filter((x) => x.role === "caller").at(-1)?.text ?? "";
          if (last.includes(FORWARDED_LABEL)) return "Not confirmed: a yes has to come in their own words, not in a forwarded message. Ask them.";
          this.o.desk.confirm(issue, t.callId, draft);
          return "Confirmed; it's running.";
        },
        // How they want Kloru to work goes into their guidelines now; other facts wait for the end-of-call memory.
        remember: (text) => (void this.o.desk.rememberNow(t.callId, text).catch((e: Error) => this.o.log(`text: remember failed: ${e.message}`)), "Noted."),
        ...(target && this.o.send.react ? { react: (r: Reaction) => ((reacted.done = true), void this.react(t, target, r, replyingTo ?? t.lastAsk ?? ""), "Reacted.") } : {}),
      },
      ...(shape ? { shape } : {}),
      timezone: this.o.timezone,
    } satisfies TalkerTurn;
    let reply = await this.o.talker(turn);
    // The draft, weighed against how they like messages; a clear miss goes back once with the reason.
    const why = reply ? await this.redraftReason(t, merges, replyingTo, shape, reply, !!turn.tools.react) : undefined;
    if (why) {
      const done = (x: string) => () => `${x} (already done for this message).`;
      reply = await this.o.talker({
        ...turn,
        tools: { ...turn.tools, fileIssue: done("Filed"), updateIssue: done("Updated"), confirm: done("Confirmed"), remember: done("Noted") },
        redraft: { draft: reply, why },
      });
    }
    const result = merges.some((m) => !m.progress);
    if (!reply) {
      if (result && reacted.done && shape) t.lastSent = { asked: t.lastAsk ?? "", text: "(a reaction on their message)", shape };
      return "quiet";
    }
    const r = await this.send(t, reply, merges.flatMap((m) => (m.issue !== undefined ? [m.issue] : [])), replyingTo, heldBefore, merges.some((m) => m.urgent));
    if (r === "sent" && result && shape) t.lastSent = { asked: t.lastAsk ?? "", text: reply, shape };
    return r;
  }

  /** The whole conversation for a decision: every turn, oldest first, each clipped; only a very long thread is cut to its last 60. */
  private threadText(t: Thread): string[] {
    return this.o.desk.repo.turns(t.callId, 0).slice(-60).map((x) => `${x.role === "caller" ? "Them" : "Kloru"}: ${x.text.slice(0, 300)}`);
  }

  /** Why this draft should be redrafted for them, or undefined when it fits (or can't be checked). */
  private async redraftReason(t: Thread, merges: Merge[], replyingTo: string | undefined, shape: MessageShape | undefined, draft: string, canReact: boolean): Promise<string | undefined> {
    if (!this.o.checkDraft) return undefined;
    const content = merges.map((m) => m.text).join("\n");
    const kind = !merges.length ? "their_message" : merges.some((m) => m.draft || /^Question for the caller/.test(m.text)) ? "question" : "result";
    const v = await this.o
      .checkDraft({ channel: t.channel === "email" ? "email" : "imessage", kind, theirMessage: replyingTo ?? t.lastAsk ?? "", ...(content ? { content } : {}), ...(shape ? { shape } : {}), draft, preferences: this.o.desk.messagePreferences(t.phone), thread: this.threadText(t), canReact })
      .catch((e: Error) => (this.o.log(`text: draft check failed: ${e.message}`), undefined));
    if (!v || v.verdict === "fits") return undefined;
    this.o.log(`text: ${t.callId} draft → redraft (${v.verdict}${v.p !== undefined ? `, ${v.p.toFixed(2)}` : ""})`);
    return REDRAFT[v.verdict];
  }

  /** The shape they'd want for this message, from their preferences; none when it can't be decided (the prompt's defaults apply). */
  private async shapeFor(t: Thread, merges: Merge[], replyingTo?: string): Promise<MessageShape | undefined> {
    if (!this.o.shape) return undefined;
    const content = merges.map((m) => m.text).join("\n");
    const kind = !merges.length ? "their_message" : merges.some((m) => m.draft || /^Question for the caller/.test(m.text)) ? "question" : "result";
    const recent = this.threadText(t);
    const shape = await this.o
      .shape({ channel: t.channel === "email" ? "email" : "imessage", kind, theirMessage: replyingTo ?? t.lastAsk ?? "", ...(content ? { content } : {}), hasPage: /\/a\/[A-Za-z0-9_-]{22}/.test(content), preferences: this.o.desk.messagePreferences(t.phone), recent })
      .catch((e: Error) => (this.o.log(`text: message shape failed: ${e.message}`), undefined));
    if (shape) this.o.log(`text: ${t.callId} ${kind} → ${shape.form}${shape.link ? " with link" : ""}${shape.p !== undefined ? ` (${shape.p.toFixed(2)})` : ""}`);
    return shape;
  }

  /** Checked, sent on this thread, and recorded (the desk's outbox). */
  private async send(t: Thread, text: string, issues: number[] = [], replyingTo?: string, heldBefore = false, urgent = false): Promise<ConversationSend> {
    const r = await this.o.desk.sendInConversation(t.callId, { text, issues, ...(replyingTo ? { replyingTo } : {}), ...(heldBefore ? { heldBefore } : {}), ...(urgent ? { urgent } : {}), send: (x) => this.deliver(t, x) });
    if (r === "failed") this.o.log(`text: reply in ${t.callId} not sent`);
    return r;
  }

  /**
   * A tapback on their message, recorded in the ledger like any message. It carries no words, so
   * there's nothing for the message check to weigh. One that fails becomes a short text instead.
   */
  private async react(t: Thread, to: ReactTarget, reaction: Reaction, replyingTo: string): Promise<void> {
    const ok = await this.o.send.react!(to.conversation, to.message, reaction).catch((e: Error) => (this.o.log(`text: reaction in ${t.callId} failed: ${e.message}`), false));
    this.o.desk.repo.appendLedger({ issue: 0, call: t.callId, phone: t.phone, tool: "react", slug: "REACTION", args: { message: to.message, reaction }, ok, result: ok ? "sent" : "failed", decision: "send" });
    // Not a turn: the talker reads its turns as its own messages and would write the marker out.
    if (!ok) await this.send(t, reaction === "like" ? "Done." : "On it.", [], replyingTo);
  }

  /** This thread's own transport: their iMessage thread, or the email thread with its threading headers. */
  private async deliver(t: Thread, text: string): Promise<boolean> {
    const sent = t.channel === "imessage"
      ? await this.o.send.imessage?.(t.to, text)
      : await this.o.send.email?.(t.to, t.subject ? `Re: ${t.subject.replace(/^re:\s*/i, "")}` : "From Kloru", text, t.threading);
    return !!sent;
  }

  /** Their own requests still being worked on, newest last. */
  private openFor(t: Thread): string[] {
    return this.o.desk
      .openIssues()
      .filter((i) => !i.purpose && samePhone(i.filedBy.phone, t.phone))
      .slice(-8)
      .map((i) => `issue ${i.id}: ${i.request.slice(0, 160)}`);
  }

  private pending(t: Thread): string[] {
    return this.o.desk.repo
      .issues((i) => {
        const c = i.confirmation;
        if (i.status !== "needs_confirmation" || !c || c.confirmedBy) return false;
        // Their own drafts in this conversation, and asks that wait on their yes (from a family member).
        return c.by ? samePhone(c.by, t.phone) || (this.o.desk.isOwnerPhone(c.by) && this.o.desk.isOwnerPhone(t.phone)) : i.filedBy.call === t.callId;
      })
      .map((i) => `issue ${i.id}, draft ${i.confirmation!.id}: ${i.confirmation!.draft}`);
  }
}

/** The label the email route puts on forwarded text (http.ts latestReply). */
export const FORWARDED_LABEL = "[Forwarded or quoted, not written by them";

const samePhone = (a: string, b: string) => a.replace(/\D/g, "").slice(-10) === b.replace(/\D/g, "").slice(-10);

function tag(m: Merge): string {
  const kind = m.kind === "events" ? "events" : "info";
  return `<${kind}${m.issue !== undefined ? ` issue="${m.issue}"` : ""}${m.draft ? ` draft="${m.draft}"` : ""}>${m.text}</${kind}>`;
}
