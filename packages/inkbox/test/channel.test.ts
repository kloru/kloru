import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@kloru/core";
import { InkboxChannel, parseConversationKey, splitMessageText } from "../src/channel.js";
import { fakeFetch, rawIdentity, type Recorded } from "./fake-fetch.js";

const BASE = "https://inkbox.test";
const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const ctx = (conversationKey: string) => ({ principal: owner, conversationKey });

function sdkRoutes(extra: Record<string, unknown> = {}) {
  return {
    "GET /api/v1/identities/maria-instinct": { body: rawIdentity(extra) },
    "GET /api/v1/imessage/messages/msg_1": { body: { id: "msg_1", conversation_id: "conv_1", created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" } },
    "POST /api/v1/imessage/messages": (req: Recorded) => ({ body: { message: { id: "sent_1", conversation_id: req.body && (req.body as { conversation_id?: string }).conversation_id, created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" } } }),
    "POST /api/v1/phone/numbers/pn_1/texts": { body: { id: "txt_1", created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" } },
    "POST /api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages": { body: { id: "mail_1", created_at: "2026-10-03T00:00:00Z" } },
    "POST /api/v1/imessage/typing": { status: 204 },
    "POST /api/v1/imessage/reactions": { body: { id: "r_1", conversation_id: "conv_1", message_id: "msg_1", reaction: "love", created_at: "2026-10-03T00:00:00Z" } },
    "POST /api/v1/imessage/mark-read": { body: { conversation_id: "conv_1", updated_count: 2 } },
    "POST /api/v1/identities/maria-instinct/a2a/tasks/task_1/reply": { body: { id: "task_1", context_id: "ctx_1", state: "completed", caller: { identity_id: "x", organization_id: "y", handle: "sam" }, messages: [], created_at: "2026-10-03T00:00:00Z", updated_at: "2026-10-03T00:00:00Z" } },
  };
}

// The SDK resolves the global fetch at call time, so the channel's SDK sends are
// observed by stubbing it. The channel's own fetchImpl covers its direct REST calls.
let fake: ReturnType<typeof fakeFetch>;
beforeEach(() => {
  fake = fakeFetch(sdkRoutes());
  vi.stubGlobal("fetch", fake.fetchImpl);
});
afterEach(() => vi.unstubAllGlobals());

function channel() {
  return new InkboxChannel({ apiKey: "ik_test", handle: "@maria-instinct", baseUrl: BASE, fetchImpl: fake.fetchImpl });
}

function sends(path: string) {
  return fake.calls.filter((c) => c.method === "POST" && c.path === path);
}

describe("InkboxChannel routing", () => {
  it("replies in an iMessage conversation by conversation id and resolves the identity once", async () => {
    const ch = channel();
    await ch.send({ channel: "imessage", conversationKey: "imessage:conv_1", text: "On it.", replyToMessageId: "msg_1" }, ctx("imessage:conv_1"));
    await ch.send({ channel: "imessage", conversationKey: "imessage:conv_1", text: "Done." }, ctx("imessage:conv_1"));
    const idGets = fake.calls.filter((c) => c.path === "/api/v1/identities/maria-instinct");
    expect(idGets).toHaveLength(1);
    expect(idGets[0]?.headers["x-api-key"]).toBe("ik_test");
    const posts = sends("/api/v1/imessage/messages");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toEqual({ conversation_id: "conv_1", text: "On it.", reply_to_message_id: "msg_1", plain_reply_fallback: true });
    expect(posts[0]?.query).toEqual({ agent_identity_id: "ident_1" });
    expect(posts[1]?.body).toEqual({ conversation_id: "conv_1", text: "Done." });
  });

  it("starts a new iMessage with `to` when there is no conversation key", async () => {
    await channel().send({ channel: "imessage", to: "+14155550100", text: "Hi Sam", sendStyle: "confetti" }, ctx("chat:cli"));
    expect(sends("/api/v1/imessage/messages")[0]?.body).toEqual({ to: "+14155550100", text: "Hi Sam", send_style: "confetti" });
  });

  it("splits long iMessage text into several bubbles and attaches media to the first only", async () => {
    const para = "This is a sentence that keeps going for a while. ".repeat(20).trim(); // ~1000 chars
    const text = `${para}\n\n${para}\n\n${para}`;
    await channel().send({ channel: "imessage", conversationKey: "imessage:conv_1", text, mediaUrls: ["https://x/y.png"] }, ctx("imessage:conv_1"));
    const posts = sends("/api/v1/imessage/messages");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const p of posts) expect(((p.body as { text: string }).text ?? "").length).toBeLessThanOrEqual(1500);
    expect((posts[0]?.body as { media_urls?: string[] }).media_urls).toEqual(["https://x/y.png"]);
    expect((posts[1]?.body as { media_urls?: string[] }).media_urls).toBeUndefined();
    expect(posts.map((p) => (p.body as { text: string }).text).join("\n\n")).toBe(text);
  });

  it("sends SMS to the number in the key or in `to`", async () => {
    const ch = channel();
    await ch.send({ channel: "sms", conversationKey: "sms:+14155550100", text: "ok" }, ctx("sms:+14155550100"));
    await ch.send({ channel: "sms", to: "+14155550199", text: "hello" }, ctx("chat:x"));
    const posts = sends("/api/v1/phone/numbers/pn_1/texts");
    expect(posts[0]?.body).toEqual({ to: "+14155550100", text: "ok" });
    expect(posts[1]?.body).toEqual({ to: "+14155550199", text: "hello" });
  });

  it("replies to a text conversation without narrowing its participants to the sender", async () => {
    await channel().send({ channel: "sms", conversationKey: "sms:group_1", text: "Hello everyone", replyRef: { conversationId: "group_1" } }, ctx("sms:group_1"));
    expect(sends("/api/v1/phone/numbers/pn_1/texts")[0]?.body).toEqual({ conversation_id: "group_1", text: "Hello everyone" });
  });

  it("replies to an email thread with Re: subject and In-Reply-To from replyRef", async () => {
    const ch = channel();
    const msg = { channel: "email" as const, conversationKey: "email:th_1", to: "sam@example.com", text: "Thursday works.", replyRef: { subject: "Dinner next week", messageId: "<abc@mail.example>" } };
    await ch.send(msg, ctx("email:th_1"));
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toEqual({ recipients: { to: ["sam@example.com"] }, subject: "Re: Dinner next week", body_text: "Thursday works.", in_reply_to_message_id: "<abc@mail.example>" });
  });

  it("remembers the sender of an inbound email so a reply without `to` reaches them", async () => {
    const ch = channel();
    ch.remember({
      id: "evt",
      channel: "email",
      conversationKey: "email:th_2",
      from: "sam@example.com",
      text: "Subject: Re: Plans\n\nhi",
      replyRef: { subject: "Re: Plans", messageId: "<m2@x>", threadId: "th_2", mailbox: "maria-instinct@inkbox.ai" },
      receivedAt: "2026-10-03T00:00:00Z",
    });
    await ch.send({ channel: "email", conversationKey: "email:th_2", text: "Sounds good." }, ctx("email:th_2"));
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toEqual({ recipients: { to: ["sam@example.com"] }, subject: "Re: Plans", body_text: "Sounds good.", in_reply_to_message_id: "<m2@x>" });
  });

  it("answers an inbound email from replyRef.from with no `to` and no prior remember()", async () => {
    // What core's runtime.deliver sends after a message.received webhook: no `to`, the inbound replyRef attached.
    const msg = { channel: "email" as const, conversationKey: "email:th_1", text: "Thursday works.", replyRef: { from: "sam@example.com", subject: "Dinner next week", messageId: "<abc@mail.example>", threadId: "th_1" } };
    await channel().send(msg, ctx("email:th_1"));
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toEqual({ recipients: { to: ["sam@example.com"] }, subject: "Re: Dinner next week", body_text: "Thursday works.", in_reply_to_message_id: "<abc@mail.example>" });
  });

  it("prefers replyRef over a stale remembered sender", async () => {
    const ch = channel();
    ch.remember({ id: "e", channel: "email", conversationKey: "email:th_3", from: "old@example.com", text: "x", replyRef: { subject: "Old", messageId: "<old@x>" }, receivedAt: "2026-10-03T00:00:00Z" });
    await ch.send({ channel: "email", conversationKey: "email:th_3", text: "hi", replyRef: { from: "new@example.com", subject: "New", messageId: "<new@x>" } } as Parameters<typeof ch.send>[0], ctx("email:th_3"));
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toEqual({ recipients: { to: ["new@example.com"] }, subject: "Re: New", body_text: "hi", in_reply_to_message_id: "<new@x>" });
  });

  it("fails clearly when an email has no recipient", async () => {
    await expect(channel().send({ channel: "email", conversationKey: "email:unknown", text: "x" }, ctx("email:unknown"))).rejects.toThrow(/recipient/);
  });

  it("starts a new email with a plain subject", async () => {
    await channel().send({ channel: "email", to: ["a@b.co", "c@d.co"], text: "Hello" }, ctx("chat:x"));
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toEqual({ recipients: { to: ["a@b.co", "c@d.co"] }, subject: "Message from Kloru", body_text: "Hello" });
  });

  it("answers an A2A task with text and data parts", async () => {
    await channel().send(
      { channel: "a2a", conversationKey: "a2a:ctx_1", text: "Maria is free Thursday after 7.", a2a: { taskId: "task_1", intent: "complete", data: { oip: "1", intent: "inform" } } },
      ctx("a2a:ctx_1"),
    );
    const post = sends("/api/v1/identities/maria-instinct/a2a/tasks/task_1/reply")[0];
    expect(post?.body).toEqual({ intent: "complete", parts: [{ text: "Maria is free Thursday after 7." }, { data: { oip: "1", intent: "inform" } }] });
  });

  it("completes an A2A task from replyRef.taskId when msg.a2a is absent, and from remember() as a last resort", async () => {
    const ch = channel();
    await ch.send({ channel: "a2a", conversationKey: "a2a:ctx_1", text: "Free after 7.", replyRef: { taskId: "task_1", contextId: "ctx_1" } } as Parameters<typeof ch.send>[0], ctx("a2a:ctx_1"));
    ch.remember({ id: "e", channel: "a2a", conversationKey: "a2a:ctx_1", from: "sam-instinct", text: "?", replyRef: { taskId: "task_1", contextId: "ctx_1" }, receivedAt: "2026-10-03T00:00:00Z" });
    await ch.send({ channel: "a2a", conversationKey: "a2a:ctx_1", text: "Still free." }, ctx("a2a:ctx_1"));
    const posts = sends("/api/v1/identities/maria-instinct/a2a/tasks/task_1/reply");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toEqual({ intent: "complete", parts: [{ text: "Free after 7." }] });
    expect(posts[1]?.body).toEqual({ intent: "complete", parts: [{ text: "Still free." }] });
  });

  it("refuses an A2A send without task details and unknown channels", async () => {
    await expect(channel().send({ channel: "a2a", conversationKey: "a2a:ctx_1", text: "x" }, ctx("a2a:ctx_1"))).rejects.toThrow(/replyRef\.taskId/);
    await expect(channel().send({ channel: "chat", conversationKey: "chat:1", text: "x" }, ctx("chat:1"))).rejects.toThrow(/cannot deliver/);
  });

  it("typing, react and markRead hit the iMessage endpoints and no-op elsewhere", async () => {
    const ch = channel();
    await ch.typing("imessage:conv_1");
    await ch.typing("sms:+1415");
    await ch.markRead("imessage:conv_1");
    await ch.markRead("email:x");
    await ch.react("imessage:conv_1", "msg_1", "love");
    expect(sends("/api/v1/imessage/typing")).toHaveLength(1);
    expect(sends("/api/v1/imessage/typing")[0]?.body).toEqual({ conversation_id: "conv_1" });
    expect(sends("/api/v1/imessage/mark-read")).toHaveLength(1);
    expect(sends("/api/v1/imessage/reactions")[0]?.body).toEqual({ message_id: "msg_1", reaction: "love", part_index: 0 });
    await expect(ch.react("sms:+1", "m", "love")).rejects.toThrow(/iMessage/);
  });

  it("retries the identity lookup after a failure instead of caching the rejection", async () => {
    let fail = true;
    fake = fakeFetch({
      ...sdkRoutes(),
      "GET /api/v1/identities/maria-instinct": () => (fail ? { status: 500, body: { detail: "boom" } } : { body: rawIdentity() }),
    });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const ch = channel();
    await expect(ch.typing("imessage:conv_1")).rejects.toThrow();
    fail = false;
    await expect(ch.typing("imessage:conv_1")).resolves.toBeUndefined();
  });

  it("does not react to a message from a different conversation", async () => {
    await expect(channel().react("imessage:other_conversation", "msg_1", "love")).rejects.toThrow(/current conversation/);
    expect(sends("/api/v1/imessage/reactions")).toHaveLength(0);
  });

  it("encodes mailbox attachment names as a single path segment", async () => {
    fake = fakeFetch({
      ...sdkRoutes(),
      "GET /api/v1/mail/mailboxes/maria-instinct%40inkbox.ai/messages/mail_1/attachments/photo%20%231%2Ffinal.png": { body: { url: "https://media.example.test/signed" } },
    });
    vi.stubGlobal("fetch", fake.fetchImpl);
    expect(await channel().emailAttachment("mail_1", "photo #1/final.png")).toEqual({ url: "https://media.example.test/signed" });
    expect(fake.calls.at(-1)?.query).toEqual({ redirect: "false" });
  });
});

describe("splitMessageText", () => {
  it("keeps short text whole and drops empty text", () => {
    expect(splitMessageText("hi")).toEqual(["hi"]);
    expect(splitMessageText("   ")).toEqual([]);
  });

  it("prefers paragraph breaks, then sentence ends, and never exceeds the limit", () => {
    const a = "a".repeat(900);
    const b = "b".repeat(900);
    expect(splitMessageText(`${a}\n\n${b}`)).toEqual([a, b]);
    const s1 = "First sentence that is long. ".repeat(80).trim();
    const parts = splitMessageText(s1);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(1500);
      expect(p.endsWith(".")).toBe(true);
    }
    const noBreaks = "x".repeat(3100);
    expect(splitMessageText(noBreaks).map((p) => p.length)).toEqual([1500, 1500, 100]);
  });
});

describe("parseConversationKey", () => {
  it("splits channel and id and flags unknown prefixes", () => {
    expect(parseConversationKey("imessage:conv:with:colons")).toEqual({ channel: "imessage", id: "conv:with:colons" });
    expect(parseConversationKey("email:th_1")).toEqual({ channel: "email", id: "th_1" });
    expect(parseConversationKey("telegram:1")).toEqual({ channel: "unknown", id: "1" });
    expect(parseConversationKey(undefined)).toEqual({ channel: "unknown", id: "" });
  });
});

describe("InkboxChannel.sendFile", () => {
  const pdf = Buffer.from("%PDF-1.4\n%fake\n");
  const mediaRoute = { "POST /api/v1/imessage/media": { body: { media_url: "https://media.inkbox.ai/m/abc.pdf", content_type: "application/pdf", size: 15 } } };

  it("attaches the file to an email in the SDK's MailAttachmentInput shape", async () => {
    const ch = channel();
    const r = await ch.sendFile({ channel: "email", to: "sam@example.com", filename: "brief.pdf", contentType: "application/pdf", content: pdf, caption: "Here is the brief as a PDF.", subject: "Research brief" }, ctx("chat:cli"));
    expect(r).toEqual({ channel: "email" });
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toEqual({
      recipients: { to: ["sam@example.com"] },
      subject: "Research brief",
      body_text: "Here is the brief as a PDF.",
      attachments: [{ filename: "brief.pdf", content_type: "application/pdf", content_base64: pdf.toString("base64") }],
    });
    expect(sends("/api/v1/imessage/media")).toHaveLength(0);
  });

  it("replies in an email thread with the attachment, keeping Re: subject and In-Reply-To, and defaults the body", async () => {
    const ch = channel();
    ch.remember({ id: "e", channel: "email", conversationKey: "email:th_9", from: "sam@example.com", text: "x", replyRef: { subject: "Plans", messageId: "<p@x>" }, receivedAt: "2026-10-03T00:00:00Z" });
    await ch.sendFile({ channel: "email", conversationKey: "email:th_9", filename: "plan.csv", contentType: "text/csv", content: Buffer.from("a,b\n") }, ctx("email:th_9"));
    const post = sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")[0];
    expect(post?.body).toMatchObject({ recipients: { to: ["sam@example.com"] }, subject: "Re: Plans", body_text: "Attached: plan.csv", in_reply_to_message_id: "<p@x>" });
    expect((post?.body as { attachments: unknown[] }).attachments).toHaveLength(1);
  });

  it("uploads iMessage media first, then sends the URL with the caption in the conversation", async () => {
    fake = fakeFetch({ ...sdkRoutes(), ...mediaRoute });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const r = await channel().sendFile({ channel: "imessage", conversationKey: "imessage:conv_1", filename: "brief.pdf", contentType: "application/pdf", content: pdf, caption: "Here is the brief as a PDF." }, ctx("imessage:conv_1"));
    expect(r).toEqual({ channel: "imessage", mediaUrl: "https://media.inkbox.ai/m/abc.pdf" });
    const upload = sends("/api/v1/imessage/media")[0];
    expect(upload?.form).toEqual([{ field: "file", filename: "brief.pdf", type: "application/pdf", size: pdf.length }]);
    expect(upload?.headers["x-api-key"]).toBe("ik_test");
    expect(upload?.headers["content-type"]).toBeUndefined();
    const send = sends("/api/v1/imessage/messages")[0];
    expect(send?.body).toEqual({ conversation_id: "conv_1", text: "Here is the brief as a PDF.", media_urls: ["https://media.inkbox.ai/m/abc.pdf"] });
    // Upload strictly before send.
    expect(fake.calls.findIndex((c) => c.path === "/api/v1/imessage/media")).toBeLessThan(fake.calls.findIndex((c) => c.path === "/api/v1/imessage/messages"));
  });

  it("sends a new iMessage by number with no caption, and SMS through the same upload", async () => {
    fake = fakeFetch({ ...sdkRoutes(), ...mediaRoute });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const ch = channel();
    await ch.sendFile({ channel: "imessage", to: "+14155550100", filename: "a.png", contentType: "image/png", content: Buffer.from([1, 2, 3]) }, ctx("chat:cli"));
    expect(sends("/api/v1/imessage/messages")[0]?.body).toEqual({ to: "+14155550100", media_urls: ["https://media.inkbox.ai/m/abc.pdf"] });
    await ch.sendFile({ channel: "sms", conversationKey: "sms:+14155550199", filename: "a.png", contentType: "image/png", content: Buffer.from([1, 2, 3]), caption: "pic" }, ctx("sms:+14155550199"));
    expect(sends("/api/v1/phone/numbers/pn_1/texts")[0]?.body).toEqual({ to: "+14155550199", text: "pic", media_urls: ["https://media.inkbox.ai/m/abc.pdf"] });
    expect(sends("/api/v1/imessage/media")).toHaveLength(2);
  });

  it("refuses files over the media cap before uploading, and over the email cap before sending", async () => {
    fake = fakeFetch({ ...sdkRoutes(), ...mediaRoute });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const ch = channel();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(ch.sendFile({ channel: "imessage", conversationKey: "imessage:conv_1", filename: "big.bin", contentType: "application/octet-stream", content: big }, ctx("imessage:conv_1"))).rejects.toThrow(/10\.0 MiB.*email/);
    await expect(ch.sendFile({ channel: "sms", to: "+14155550100", filename: "big.bin", contentType: "application/octet-stream", content: big }, ctx("chat:x"))).rejects.toThrow(/SMS attachments are capped/);
    const huge = Buffer.alloc(25 * 1024 * 1024 + 1);
    await expect(ch.sendFile({ channel: "email", to: "a@b.co", filename: "huge.bin", contentType: "application/octet-stream", content: huge }, ctx("chat:x"))).rejects.toThrow(/email attachments are capped/);
    expect(sends("/api/v1/imessage/media")).toHaveLength(0);
    expect(sends("/api/v1/mail/mailboxes/maria-instinct@inkbox.ai/messages")).toHaveLength(0);
  });
});

describe("InkboxChannel phone calls", () => {
  const callRow = (over: Record<string, unknown> = {}) => ({
    id: "call_1",
    local_phone_number: null,
    remote_phone_number: "+14152609174",
    direction: "outbound",
    status: "initiated",
    client_websocket_url: null,
    hangup_reason: null,
    started_at: null,
    ended_at: null,
    is_blocked: false,
    origin: "shared_imessage_number",
    mode: "hosted_agent",
    reason: "Say hi",
    hosted_agent_authority_mode: "contact_scoped",
    voicemail_detection: "enabled",
    on_voicemail: "leave_message",
    post_call_action_items: [],
    forwardings: [],
    created_at: "2026-10-16T18:00:00Z",
    updated_at: "2026-10-16T18:00:00Z",
    rate_limit: { calls_used: 1, calls_remaining: 9, calls_limit: 10, minutes_used: 3, minutes_remaining: 27, minutes_limit: 30 },
    ...over,
  });

  it("places a Voice AI call from the shared iMessage pool by default, leaving a voicemail message", async () => {
    fake = fakeFetch({ ...sdkRoutes({ imessage_number: null }), "POST /api/v1/phone/place-call": { body: callRow() } });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const out = await channel().placeCall({ toNumber: "+14152609174", reason: "Say hi", voicemailMessage: "Maria says hi." });
    expect(out).toEqual({ id: "call_1", status: "initiated", origination: "shared_imessage_number", minutesRemaining: 27 });
    expect(sends("/api/v1/phone/place-call")[0]?.body).toEqual({
      to_number: "+14152609174",
      origination: "shared_imessage_number",
      mode: "hosted_agent",
      // Pinned on every call, so an org-level "yolo" authority never widens what Voice AI may do.
      hosted_agent_authority_mode: "contact_scoped",
      on_voicemail: "leave_message",
      voicemail_message: "Maria says hi.",
      agent_identity_id: "ident_1",
      reason: "Say hi",
    });
  });

  it("prefers the identity's dedicated iMessage line, and dials from the phone number only when told to", async () => {
    const dedicated = { id: "im_1", number: "+16505550199", type: "dedicated_outbound" };
    fake = fakeFetch({ ...sdkRoutes({ imessage_number: dedicated }), "POST /api/v1/phone/place-call": (req: Recorded) => ({ body: callRow({ origin: (req.body as { origination: string }).origination }) }) });
    vi.stubGlobal("fetch", fake.fetchImpl);
    const ch = channel();
    expect((await ch.placeCall({ toNumber: "+14152609174", reason: "Say hi" })).origination).toBe("dedicated_imessage_number");
    expect(sends("/api/v1/phone/place-call")[0]?.body).toMatchObject({ origination: "dedicated_imessage_number", agent_identity_id: "ident_1" });
    expect((sends("/api/v1/phone/place-call")[0]?.body as Record<string, unknown>).from_number).toBeUndefined();
    await ch.placeCall({ toNumber: "+14152609174", reason: "Say hi", origination: "dedicated_number" });
    expect(sends("/api/v1/phone/place-call")[1]?.body).toMatchObject({ origination: "dedicated_number", from_number: "+16505550123", hosted_agent_authority_mode: "contact_scoped" });
  });

  it("refuses dedicated_number on an identity without a phone number", async () => {
    fake = fakeFetch(sdkRoutes({ phone_number: null }));
    vi.stubGlobal("fetch", fake.fetchImpl);
    await expect(channel().placeCall({ toNumber: "+14152609174", reason: "Say hi", origination: "dedicated_number" })).rejects.toThrow(/no dedicated phone number/);
    expect(sends("/api/v1/phone/place-call")).toHaveLength(0);
  });

  it("reads a transcript in sequence order and drops empty rows", async () => {
    fake = fakeFetch({
      ...sdkRoutes(),
      "GET /api/v1/phone/calls/call_1/transcripts": {
        body: [
          { id: "t2", call_id: "call_1", seq: 2, ts_ms: 2000, party: "remote", text: " Hi, this is Maria. ", created_at: "2026-10-16T18:00:02Z" },
          { id: "t1", call_id: "call_1", seq: 1, ts_ms: 0, party: "local", text: "Hello, this is a test call.", created_at: "2026-10-16T18:00:00Z" },
          { id: "t3", call_id: "call_1", seq: 3, ts_ms: 3000, party: "system", text: "", created_at: "2026-10-16T18:00:03Z" },
        ],
      },
    });
    vi.stubGlobal("fetch", fake.fetchImpl);
    expect(await channel().callTranscript("call_1")).toEqual([
      { party: "local", text: "Hello, this is a test call." },
      { party: "remote", text: "Hi, this is Maria." },
    ]);
  });

  it("sets the Voice AI voice and instructions for this identity", async () => {
    fake = fakeFetch({
      ...sdkRoutes(),
      "PUT /api/v1/phone/hosted-agent-config": { body: { agent_identity_id: "ident_1", voice: "ember", effective_voice: "ember", effective_model: "m", instructions: "x", authority_mode: "contact_scoped" } },
    });
    vi.stubGlobal("fetch", fake.fetchImpl);
    await channel().setVoiceConfig({ voice: "ember", instructions: "Be brief." });
    const put = fake.calls.find((c) => c.method === "PUT" && c.path === "/api/v1/phone/hosted-agent-config");
    expect(put?.body).toEqual({ agent_identity_id: "ident_1", voice: "ember", instructions: "Be brief." });
    await channel().setVoiceConfig({ instructions: "Be brief." });
    const second = fake.calls.filter((c) => c.method === "PUT" && c.path === "/api/v1/phone/hosted-agent-config")[1];
    expect(second?.body).toEqual({ agent_identity_id: "ident_1", instructions: "Be brief." });
  });
});
