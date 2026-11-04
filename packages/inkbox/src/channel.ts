/**
 * Outbound side of the Inkbox adapter. The runtime hands us an OutboundMessage
 * and a conversation key; we pick the Inkbox call that reaches that thread.
 * Sends go through the official SDK's AgentIdentity so request shapes stay
 * correct as the API evolves. The identity is fetched once and cached.
 */
import { Inkbox, type AgentIdentity, type CallOrigin, type MailAttachmentInput } from "@inkbox/sdk";
import type { InboundMessage, OutboundMessage, Outbox, Principal } from "@kloru/core";
import { createRest } from "./http.js";

export interface InkboxChannelOptions {
  apiKey: string;
  handle: string;
  identityId?: string;
  baseUrl?: string;
  /**
   * Used for REST calls this package makes itself. The SDK resolves the global
   * fetch at call time, so tests stub `globalThis.fetch` for SDK-backed sends.
   */
  fetchImpl?: typeof fetch;
  /** The agent's name, for the subject of an email that starts a thread ("Message from Kloru"). */
  agentName?: string;
}

/** Apple delivers long texts as one bubble; past this length they read badly. */
export const IMESSAGE_MAX_CHARS = 1500;
/** Inkbox's media upload cap for iMessage and SMS attachments. */
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** A sane cap for one email attachment; most receiving servers stop around here. */
export const EMAIL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** A file to deliver on one channel, in the current thread or to a new recipient. */
export interface FileSend {
  channel: "imessage" | "sms" | "email";
  /** Reply in this thread when set (`imessage:<id>`, `sms:<e164>`, `email:<thread>`). */
  conversationKey?: string;
  to?: string | string[];
  filename: string;
  contentType: string;
  content: Buffer;
  /** Text sent with the file: the iMessage bubble or the email body. */
  caption?: string;
  /** Email only: subject of a new thread. Replies keep the thread's subject. */
  subject?: string;
  replyRef?: Record<string, string | undefined>;
}

export interface FileSendResult {
  channel: FileSend["channel"];
  /** The reusable Inkbox media URL, for iMessage and SMS sends. */
  mediaUrl?: string;
}

/** Where an outbound call is placed from. Mirrors the SDK's CallOrigin wire values. */
export type CallOrigination = "dedicated_number" | "shared_imessage_number" | "dedicated_imessage_number";
export const CALL_ORIGINATIONS: readonly CallOrigination[] = ["dedicated_number", "shared_imessage_number", "dedicated_imessage_number"];

export interface PlaceCallInput {
  /** E.164. */
  toNumber: string;
  /** The task brief Inkbox Voice AI follows on the call. */
  reason: string;
  /** What Voice AI says if voicemail answers. Omitted: it composes one from the reason. */
  voicemailMessage?: string;
  /** Omitted: the identity's own iMessage line (dedicated when it has one, else the shared pool). */
  origination?: CallOrigination;
}

export interface PlacedCall {
  id: string;
  /** initiated, ringing, answered, completed, failed or canceled. */
  status: string;
  origination: CallOrigination;
  /** Minutes left on the organization's plan this month, when Inkbox reported them. */
  minutesRemaining?: number;
}

/** One turn of a call transcript, as the owner should read it. */
export interface CallTurn {
  /** "local" is Voice AI (the agent), "remote" is the person called. */
  party: string;
  text: string;
}

export interface ParsedKey {
  channel: "imessage" | "sms" | "email" | "a2a" | "chat" | "scheduled" | "system" | "unknown";
  id: string;
}

export function parseConversationKey(key: string | undefined): ParsedKey {
  if (!key) return { channel: "unknown", id: "" };
  const idx = key.indexOf(":");
  if (idx < 0) return { channel: "unknown", id: key };
  const channel = key.slice(0, idx);
  const id = key.slice(idx + 1);
  switch (channel) {
    case "imessage":
    case "sms":
    case "email":
    case "a2a":
    case "chat":
    case "scheduled":
    case "system":
      return { channel, id };
    default:
      return { channel: "unknown", id };
  }
}

/**
 * Split long text into several sends. Prefer paragraph breaks, then sentence
 * ends, then spaces, so each bubble reads as a whole thought.
 */
export function splitMessageText(text: string, max = IMESSAGE_MAX_CHARS): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed ? [trimmed] : [];
  const parts: string[] = [];
  let rest = trimmed;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf("\n\n");
    if (cut < max * 0.4) cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut < max * 0.4) cut = max;
    else cut += 1;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

interface ReplyContext {
  from: string;
  subject?: string;
  messageId?: string;
  mailbox?: string;
  taskId?: string;
}

function toList(to: string | string[] | undefined): string[] {
  if (!to) return [];
  return (Array.isArray(to) ? to : [to]).map((s) => s.trim()).filter(Boolean);
}

function describeBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(n / 1024)} KiB`;
}

function replySubject(subject: string | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re: your message";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export class InkboxChannel implements Outbox {
  readonly handle: string;
  private readonly opts: InkboxChannelOptions;
  private readonly sdk: Inkbox;
  private identityPromise: Promise<AgentIdentity> | undefined;
  /** Email threads need a recipient; remember who wrote last in each thread. */
  private readonly replyContexts = new Map<string, ReplyContext>();

  constructor(opts: InkboxChannelOptions) {
    this.opts = opts;
    this.handle = opts.handle.replace(/^@+/, "");
    const sdkOpts: ConstructorParameters<typeof Inkbox>[0] = { apiKey: opts.apiKey };
    if (opts.baseUrl) sdkOpts.baseUrl = opts.baseUrl;
    this.sdk = new Inkbox(sdkOpts);
  }

  /** Resolve the AgentIdentity once; retry on the next call if the first fetch failed. */
  identity(): Promise<AgentIdentity> {
    if (!this.identityPromise) {
      this.identityPromise = this.sdk.getIdentity(this.handle).catch((err: unknown) => {
        this.identityPromise = undefined;
        throw err;
      });
    }
    return this.identityPromise;
  }

  /** Resolve a mailbox attachment without forwarding API credentials to its download URL. */
  async emailAttachment(messageId: string, filename: string): Promise<{ url: string }> {
    const identity = await this.identity();
    if (!identity.emailAddress) throw new Error("This identity has no mailbox");
    const path = [identity.emailAddress, messageId, filename].map(encodeURIComponent);
    return createRest(this.opts).request("GET", `/mail/mailboxes/${path[0]}/messages/${path[1]}/attachments/${path[2]}`, undefined, { redirect: "false" });
  }

  /**
   * Record who to answer in a thread, for outbounds that arrive without a replyRef
   * (send_message with no `to`, for example). Hosts call this per inbound message.
   */
  remember(msg: InboundMessage): void {
    if (msg.channel !== "email" && msg.channel !== "a2a") return;
    const ctx: ReplyContext = { from: msg.from };
    if (msg.replyRef.subject) ctx.subject = msg.replyRef.subject;
    if (msg.replyRef.messageId) ctx.messageId = msg.replyRef.messageId;
    if (msg.replyRef.mailbox) ctx.mailbox = msg.replyRef.mailbox;
    if (msg.replyRef.taskId) ctx.taskId = msg.replyRef.taskId;
    this.replyContexts.set(msg.conversationKey, ctx);
  }

  async send(msg: OutboundMessage, _ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    const key = parseConversationKey(msg.conversationKey);
    const channel = msg.channel ?? key.channel;
    switch (channel) {
      case "imessage":
        return this.sendIMessage(msg, key);
      case "sms":
        return this.sendSms(msg, key);
      case "email":
        return this.sendEmail(msg, key);
      case "a2a":
        return this.sendA2A(msg, key);
      default:
        throw new Error(`InkboxChannel cannot deliver on channel "${String(channel)}" (key ${msg.conversationKey ?? "none"})`);
    }
  }

  private async sendIMessage(msg: OutboundMessage, key: ParsedKey): Promise<void> {
    const identity = await this.identity();
    const conversationId = key.channel === "imessage" && key.id ? key.id : undefined;
    const to = toList(msg.to);
    if (!conversationId && to.length === 0) throw new Error("iMessage send needs a conversation key or a `to` number");
    const chunks = splitMessageText(msg.text);
    if (chunks.length === 0 && (msg.mediaUrls?.length ?? 0) === 0) return;
    if (chunks.length === 0) chunks.push("");
    for (let i = 0; i < chunks.length; i++) {
      const options: Parameters<AgentIdentity["sendIMessage"]>[0] = {};
      if (conversationId) options.conversationId = conversationId;
      else options.to = to.length === 1 ? to[0] : to;
      const text = chunks[i] ?? "";
      if (text) options.text = text;
      // Reply threading and media ride on the first bubble only.
      if (i === 0) {
        if (msg.replyToMessageId && conversationId) options.replyToMessageId = msg.replyToMessageId;
        if (msg.mediaUrls && msg.mediaUrls.length > 0) options.mediaUrls = msg.mediaUrls;
        if (msg.sendStyle) options.sendStyle = msg.sendStyle;
      }
      await identity.sendIMessage(options);
    }
  }

  private async sendSms(msg: OutboundMessage, key: ParsedKey): Promise<void> {
    const identity = await this.identity();
    const to = toList(msg.to);
    const conversationId = to.length === 0 && key.channel === "sms" && key.id && !key.id.startsWith("+") ? key.id : undefined;
    const target = to.length > 0 ? (to.length === 1 ? to[0] : to) : key.channel === "sms" && key.id.startsWith("+") ? key.id : undefined;
    if (!target && !conversationId) throw new Error("SMS send needs a conversation key or a `to` number");
    const chunks = splitMessageText(msg.text);
    if (chunks.length === 0 && (msg.mediaUrls?.length ?? 0) === 0) return;
    if (chunks.length === 0) chunks.push("");
    for (let i = 0; i < chunks.length; i++) {
      const options: Parameters<AgentIdentity["sendText"]>[0] = conversationId ? { conversationId } : { to: target };
      const text = chunks[i] ?? "";
      if (text) options.text = text;
      if (i === 0 && msg.mediaUrls && msg.mediaUrls.length > 0) options.mediaUrls = msg.mediaUrls;
      await identity.sendText(options);
    }
  }

  /**
   * Deliver a file. Email attaches it; iMessage and SMS upload it to Inkbox first and
   * send the returned media URL with the caption as the bubble text.
   */
  async sendFile(file: FileSend, _ctx: { principal: Principal; conversationKey: string }): Promise<FileSendResult> {
    const key = parseConversationKey(file.conversationKey);
    const base: OutboundMessage = { channel: file.channel, text: file.caption ?? "" };
    if (file.conversationKey) base.conversationKey = file.conversationKey;
    if (file.to) base.to = file.to;
    if (file.replyRef) base.replyRef = file.replyRef;
    if (file.channel === "email") {
      if (file.content.length > EMAIL_ATTACHMENT_MAX_BYTES) throw new Error(`${file.filename} is ${describeBytes(file.content.length)}; email attachments are capped at ${describeBytes(EMAIL_ATTACHMENT_MAX_BYTES)}`);
      const msg: OutboundMessage = { ...base, text: file.caption?.trim() || `Attached: ${file.filename}` };
      if (file.subject) msg.replyRef = { ...(msg.replyRef ?? {}), subject: file.subject };
      await this.sendEmail(msg, key, [{ filename: file.filename, contentType: file.contentType, contentBase64: file.content.toString("base64") }]);
      return { channel: "email" };
    }
    if (file.content.length > MEDIA_MAX_BYTES) throw new Error(`${file.filename} is ${describeBytes(file.content.length)}; ${file.channel === "sms" ? "SMS" : "iMessage"} attachments are capped at ${describeBytes(MEDIA_MAX_BYTES)}. Send it by email instead.`);
    const identity = await this.identity();
    const upload = await identity.uploadIMessageMedia({ content: new Uint8Array(file.content), filename: file.filename, contentType: file.contentType });
    const msg: OutboundMessage = { ...base, mediaUrls: [upload.mediaUrl] };
    if (file.channel === "sms") await this.sendSms(msg, key);
    else await this.sendIMessage(msg, key);
    return { channel: file.channel, mediaUrl: upload.mediaUrl };
  }

  private async sendEmail(msg: OutboundMessage, key: ParsedKey, attachments?: MailAttachmentInput[]): Promise<void> {
    const identity = await this.identity();
    const remembered = msg.conversationKey ? this.replyContexts.get(msg.conversationKey) : undefined;
    const ref = msg.replyRef ?? {};
    // Recipient: explicit `to`, else the sender of the inbound we are answering, else what remember() saw.
    let to = toList(msg.to);
    if (to.length === 0) to = toList(ref.to ?? ref.from);
    if (to.length === 0 && remembered) to = [remembered.from];
    if (to.length === 0) throw new Error(`email send needs a recipient: no \`to\`, no replyRef.from and no remembered sender for ${msg.conversationKey ?? "a new thread"}`);
    const inThread = key.channel === "email" && key.id.length > 0;
    const subjectHint = ref.subject ?? remembered?.subject;
    const subject = inThread ? replySubject(subjectHint) : (subjectHint ?? `Message from ${this.opts.agentName ?? "Kloru"}`);
    const options: Parameters<AgentIdentity["sendEmail"]>[0] = { to, subject, bodyText: msg.text };
    const inReplyTo = ref.messageId ?? remembered?.messageId;
    if (inThread && inReplyTo) options.inReplyToMessageId = inReplyTo;
    if (attachments && attachments.length > 0) options.attachments = attachments;
    await identity.sendEmail(options);
  }

  private async sendA2A(msg: OutboundMessage, key: ParsedKey): Promise<void> {
    const remembered = msg.conversationKey ? this.replyContexts.get(msg.conversationKey) : undefined;
    // Task id: msg.a2a, else the inbound replyRef, else what remember() saw. Intent defaults to complete.
    const taskId = msg.a2a?.taskId ?? msg.replyRef?.taskId ?? remembered?.taskId;
    if (!taskId) throw new Error(`A2A send on ${msg.conversationKey ?? key.id} needs msg.a2a { taskId, intent } or a replyRef.taskId`);
    const intent = msg.a2a?.intent ?? "complete";
    const identity = await this.identity();
    const parts: Record<string, unknown>[] = [];
    if (msg.text) parts.push({ text: msg.text });
    if (msg.a2a?.data) parts.push({ data: msg.a2a.data });
    if (parts.length === 0) parts.push({ text: "" });
    await identity.a2aReply(taskId, { intent, parts });
  }

  /** Typing indicators exist only on one-to-one iMessage threads; elsewhere this is a no-op. */
  async typing(conversationKey: string): Promise<void> {
    const key = parseConversationKey(conversationKey);
    if (key.channel !== "imessage" || !key.id) return;
    const identity = await this.identity();
    await identity.sendIMessageTyping(key.id);
  }

  async react(conversationKey: string, messageId: string, reaction: string): Promise<void> {
    const key = parseConversationKey(conversationKey);
    if (key.channel !== "imessage") throw new Error("tapbacks are only available on iMessage conversations");
    const identity = await this.identity();
    const target = await identity.getIMessage(messageId);
    if (target.conversationId !== key.id) throw new Error("The reaction target must belong to the current conversation");
    await identity.sendIMessageReaction({ messageId, reaction });
  }

  /**
   * The line a call goes out on when the caller did not choose: the identity's dedicated
   * iMessage number when it has one, else the organization's shared iMessage pool. The
   * dedicated phone number is never the default; it is a different caller id from the one
   * the owner's contacts know.
   */
  async defaultCallOrigination(): Promise<CallOrigination> {
    const identity = await this.identity();
    return identity.imessageNumber ? "dedicated_imessage_number" : "shared_imessage_number";
  }

  /**
   * Place an outbound call that Inkbox Voice AI drives. Voicemail gets a message, never a hang-up.
   * The authority mode is pinned to `contact_scoped` on every call: an organization whose saved
   * Voice AI authority is `yolo` would otherwise widen what the voice agent may do on the owner's
   * behalf, and the policy guard only ever approved the number and the brief.
   */
  async placeCall(input: PlaceCallInput): Promise<PlacedCall> {
    const identity = await this.identity();
    const origination = input.origination ?? (await this.defaultCallOrigination());
    if (origination === "dedicated_number" && !identity.phoneNumber) throw new Error("This identity has no dedicated phone number to call from");
    const call = await identity.placeCall({
      toNumber: input.toNumber,
      origination: origination as CallOrigin,
      mode: "hosted_agent" as Parameters<AgentIdentity["placeCall"]>[0]["mode"],
      hostedAgentAuthorityMode: "contact_scoped" as Parameters<AgentIdentity["placeCall"]>[0]["hostedAgentAuthorityMode"],
      reason: input.reason,
      onVoicemail: "leave_message" as Parameters<AgentIdentity["placeCall"]>[0]["onVoicemail"],
      ...(input.voicemailMessage ? { voicemailMessage: input.voicemailMessage } : {}),
    });
    const out: PlacedCall = { id: call.id, status: call.status, origination };
    if (typeof call.rateLimit?.minutesRemaining === "number") out.minutesRemaining = call.rateLimit.minutesRemaining;
    return out;
  }

  /** The verbatim transcript of a call, in order. Empty when Inkbox kept none. */
  async callTranscript(callId: string): Promise<CallTurn[]> {
    const identity = await this.identity();
    const rows = await identity.listTranscripts(callId);
    return rows
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .filter((r) => typeof r.text === "string" && r.text.trim().length > 0)
      .map((r) => ({ party: r.party, text: r.text.trim() }));
  }

  /** Replace the identity's Voice AI voice and steering instructions (a full-replace PUT on Inkbox). */
  async setVoiceConfig(input: { voice?: string; instructions: string }): Promise<void> {
    const identity = await this.identity();
    await identity.setHostedAgentConfig({ ...(input.voice ? { voice: input.voice } : {}), instructions: input.instructions });
  }

  async markRead(conversationKey: string): Promise<void> {
    const key = parseConversationKey(conversationKey);
    if (key.channel !== "imessage" || !key.id) return;
    const identity = await this.identity();
    await identity.markIMessageConversationRead(key.id);
  }
}
