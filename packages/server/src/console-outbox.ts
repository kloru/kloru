/**
 * Outbox used when Inkbox is not configured (local dev, smoke tests, CI).
 * Nothing leaves the process: messages are logged and the last one per
 * conversation is kept so a caller can read what the agent "sent".
 *
 * The `chat` channel has no wire: it is the dashboard or CLI waiting on an HTTP
 * response. When the runtime finishes a chat run after /chat already acked, the
 * reply lands here and the HTTP layer hands it back on the next /chat for that
 * conversation (`pending`) and counts it on GET /status.
 */
import type { Outbox, OutboundMessage, Principal } from "@kloru/core";
import type { ChatBuffer } from "./http.js";

export interface ConsoleOutboxOptions {
  logger?: (m: string) => void;
  /** How many sends to keep in `all()`. Oldest entries drop first. */
  historyLimit?: number;
  /** How many chat replies to hold per conversation. Default 20. */
  pendingLimit?: number;
}

export interface ConsoleSend {
  at: string;
  conversationKey: string;
  principal: string;
  msg: OutboundMessage;
}

/** Holds finished chat replies per conversation until the HTTP layer collects them. */
export class ChatReplyBuffer implements ChatBuffer {
  private readonly pending = new Map<string, OutboundMessage[]>();
  private readonly limit: number;

  constructor(limit = 20) {
    this.limit = limit;
  }

  push(conversationKey: string, msg: OutboundMessage): void {
    const list = this.pending.get(conversationKey) ?? [];
    list.push(msg);
    while (list.length > this.limit) list.shift();
    this.pending.set(conversationKey, list);
  }

  take(conversationKey: string): OutboundMessage[] {
    const list = this.pending.get(conversationKey) ?? [];
    this.pending.delete(conversationKey);
    return list;
  }

  peek(conversationKey: string): readonly OutboundMessage[] {
    return this.pending.get(conversationKey) ?? [];
  }

  pendingCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [key, list] of this.pending) if (list.length > 0) out[key] = list.length;
    return out;
  }
}

export class ConsoleOutbox implements Outbox {
  private readonly lastByKey = new Map<string, OutboundMessage>();
  private readonly history: ConsoleSend[] = [];
  private readonly log: (m: string) => void;
  private readonly limit: number;
  readonly chat: ChatReplyBuffer;

  constructor(opts: ConsoleOutboxOptions = {}) {
    this.log = opts.logger ?? ((m) => console.log(m));
    this.limit = opts.historyLimit ?? 200;
    this.chat = new ChatReplyBuffer(opts.pendingLimit);
  }

  async send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    const key = msg.conversationKey ?? ctx.conversationKey;
    this.lastByKey.set(key, msg);
    this.history.push({ at: new Date().toISOString(), conversationKey: key, principal: ctx.principal.id, msg });
    while (this.history.length > this.limit) this.history.shift();
    if (msg.channel === "chat") this.chat.push(key, msg);
    const to = msg.to ? ` to ${Array.isArray(msg.to) ? msg.to.join(",") : msg.to}` : "";
    this.log(`[outbox] ${msg.channel} ${key}${to}: ${msg.text}`);
  }

  async typing(conversationKey: string): Promise<void> {
    this.log(`[outbox] typing ${conversationKey}`);
  }

  /** Last message sent in a conversation, if any. */
  lastFor(conversationKey: string): OutboundMessage | undefined {
    return this.lastByKey.get(conversationKey);
  }

  all(): readonly ConsoleSend[] {
    return this.history;
  }
}

/**
 * Give a real channel (Inkbox) the same chat behaviour: `chat` replies are buffered
 * for the HTTP layer instead of being handed to a transport that cannot deliver them.
 * Everything else passes through untouched.
 */
export class ChatAwareOutbox implements Outbox {
  readonly chat: ChatReplyBuffer;
  private readonly inner: Outbox;

  constructor(inner: Outbox, pendingLimit?: number) {
    this.inner = inner;
    this.chat = new ChatReplyBuffer(pendingLimit);
  }

  async send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    if (msg.channel === "chat") {
      this.chat.push(msg.conversationKey ?? ctx.conversationKey, msg);
      return;
    }
    await this.inner.send(msg, ctx);
  }

  async typing(conversationKey: string): Promise<void> {
    if (conversationKey.startsWith("chat:")) return;
    await this.inner.typing?.(conversationKey);
  }
}
