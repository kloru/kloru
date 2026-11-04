import { describe, expect, it } from "vitest";
import { parseInkboxEvent } from "../src/events.js";

const envelope = (event_type: string, data: Record<string, unknown>, id = "evt_123") => ({
  id,
  event_type,
  timestamp: "2026-10-03T15:04:05Z",
  data: { contacts: [], agent_identities: [], ...data },
});

describe("parseInkboxEvent: imessage.received", () => {
  const payload = envelope("imessage.received", {
    message: {
      id: "msg_1",
      conversation_id: "conv_1",
      assignment_id: "asg_1",
      direction: "inbound",
      remote_number: "+14155550100",
      content: "Book dinner Thursday?",
      message_type: "message",
      service: "imessage",
      media: [{ url: "https://cdn.inkbox.ai/m/1.jpg", content_type: "image/jpeg", size: 1024 }],
      reply_to_message_id: "msg_0",
      is_group: false,
      created_at: "2026-10-03T15:04:04Z",
    },
    contacts: [{ id: "c_1", name: "Sam" }],
  });

  it("maps to an imessage inbound message", () => {
    const m = parseInkboxEvent(payload)!;
    expect(m).toBeDefined();
    expect(m.id).toBe("evt_123");
    expect(m.channel).toBe("imessage");
    expect(m.conversationKey).toBe("imessage:conv_1");
    expect(m.from).toBe("+14155550100");
    expect(m.text).toBe("Book dinner Thursday?");
    expect(m.replyRef).toMatchObject({ conversationId: "conv_1", messageId: "msg_1", assignmentId: "asg_1", replyToMessageId: "msg_0" });
    expect(m.attachments).toEqual([{ url: "https://cdn.inkbox.ai/m/1.jpg", mimeType: "image/jpeg" }]);
    expect(m.meta).toMatchObject({ isGroup: false, contacts: [{ id: "c_1", name: "Sam" }] });
    expect(m.receivedAt).toBe("2026-10-03T15:04:05Z");
  });

  it("uses the sender number in groups and keeps participants", () => {
    const group = envelope("imessage.received", {
      message: {
        id: "msg_2",
        conversation_id: "conv_g",
        remote_number: null,
        sender_number: "+14155550199",
        participants: ["+14155550199", "+14155550100"],
        is_group: true,
        content: "who is in?",
        media: null,
      },
    });
    const m = parseInkboxEvent(group)!;
    expect(m.from).toBe("+14155550199");
    expect(m.meta).toMatchObject({ isGroup: true, participants: ["+14155550199", "+14155550100"] });
  });

  it("marks an image-only message instead of returning empty text", () => {
    const pic = envelope("imessage.received", {
      message: { id: "m", conversation_id: "c", remote_number: "+1", content: null, media: [{ url: "https://x/y.png", content_type: "image/png" }] },
    });
    expect(parseInkboxEvent(pic)!.text).toBe("[attachment]");
  });

  it("falls back to a generated id when the envelope has none", () => {
    const { id: _id, ...noId } = payload;
    expect(parseInkboxEvent(noId)!.id).toBe("imessage:msg_1");
  });

  it("returns undefined without a conversation id", () => {
    expect(parseInkboxEvent(envelope("imessage.received", { message: { id: "x", content: "hi" } }))).toBeUndefined();
    expect(parseInkboxEvent(envelope("imessage.received", { message: null }))).toBeUndefined();
  });
});

describe("parseInkboxEvent: imessage.reaction_received", () => {
  it("describes the tapback in text and meta", () => {
    const m = parseInkboxEvent(
      envelope("imessage.reaction_received", {
        message: null,
        reaction: {
          id: "r_1",
          conversation_id: "conv_1",
          assignment_id: null,
          target_message_id: "msg_9",
          direction: "inbound",
          reaction: "love",
          custom_emoji: null,
          remote_number: "+14155550100",
          part_index: 0,
        },
      }),
    )!;
    expect(m.channel).toBe("imessage");
    expect(m.conversationKey).toBe("imessage:conv_1");
    expect(m.text).toBe("[reaction love on message msg_9]");
    expect(m.from).toBe("+14155550100");
    expect(m.meta?.reaction).toMatchObject({ type: "love", targetMessageId: "msg_9", reactionId: "r_1" });
  });

  it("shows the emoji for custom reactions", () => {
    const m = parseInkboxEvent(
      envelope("imessage.reaction_received", {
        reaction: { id: "r", conversation_id: "c", target_message_id: "m", reaction: "custom", custom_emoji: "🔥", remote_number: "+1" },
      }),
    )!;
    expect(m.text).toBe("[reaction 🔥 on message m]");
  });
});

describe("parseInkboxEvent: text.received", () => {
  it("reads the SDK text_message shape and normalizes the number", () => {
    const m = parseInkboxEvent(
      envelope("text.received", {
        text_message: {
          id: "t_1",
          direction: "inbound",
          local_phone_number: "+16505550000",
          remote_phone_number: "(415) 555-0100",
          text: "running late",
          type: "sms",
          media: null,
          conversation_id: "tc_1",
        },
        recipient_phone_number: null,
      }),
    )!;
    expect(m.channel).toBe("sms");
    expect(m.from).toBe("+14155550100");
    expect(m.conversationKey).toBe("sms:tc_1");
    expect(m.text).toBe("running late");
    expect(m.replyRef).toMatchObject({ textId: "t_1", conversationId: "tc_1", localNumber: "+16505550000" });
  });

  it("also reads the older data.message shape with remote_number and content", () => {
    const m = parseInkboxEvent(envelope("text.received", { message: { id: "t_2", remote_number: "+14155550101", content: "ok", conversation_key: "k" } }))!;
    expect(m.from).toBe("+14155550101");
    expect(m.text).toBe("ok");
    expect(m.replyRef.conversationId).toBe("k");
  });

  it("returns undefined without a remote number", () => {
    expect(parseInkboxEvent(envelope("text.received", { text_message: { id: "t", text: "x" } }))).toBeUndefined();
  });

  it("uses sender_phone_number when remote_phone_number is null and keeps media", () => {
    const m = parseInkboxEvent(
      envelope("text.received", {
        text_message: { id: "t_3", remote_phone_number: null, sender_phone_number: "+14155550102", text: null, media: [{ url: "https://cdn/x.jpg", content_type: "image/jpeg" }], conversation_id: "tc_3" },
      }),
    )!;
    expect(m.from).toBe("+14155550102");
    expect(m.text).toBe("[attachment]");
    expect(m.attachments).toEqual([{ url: "https://cdn/x.jpg", mimeType: "image/jpeg" }]);
    expect(m.replyRef.conversationId).toBe("tc_3");
  });
});

describe("parseInkboxEvent: message.received (mail)", () => {
  const payload = envelope("message.received", {
    message: {
      id: "mail_1",
      mailbox_id: "mb_1",
      thread_id: "th_1",
      message_id: "<abc@mail.example>",
      from_address: "Sam@Example.com",
      to_addresses: ["maria-instinct@inkbox.ai"],
      cc_addresses: null,
      subject: "Dinner next week",
      snippet: "Hi, are you free",
      body: "Hi, are you free Thursday?\n\nSam",
      email_address: "maria-instinct@inkbox.ai",
      direction: "inbound",
      status: "received",
      has_attachments: false,
      created_at: "2026-10-03T15:00:00Z",
    },
  });

  it("maps to an email thread with subject in the text", () => {
    const m = parseInkboxEvent(payload)!;
    expect(m.channel).toBe("email");
    expect(m.conversationKey).toBe("email:th_1");
    expect(m.from).toBe("sam@example.com");
    expect(m.text).toBe("Subject: Dinner next week\n\nHi, are you free Thursday?\n\nSam");
    expect(m.replyRef).toMatchObject({
      from: "sam@example.com",
      messageId: "<abc@mail.example>",
      inkboxMessageId: "mail_1",
      threadId: "th_1",
      subject: "Dinner next week",
      mailbox: "maria-instinct@inkbox.ai",
    });
    expect(m.meta).toMatchObject({ to: ["maria-instinct@inkbox.ai"], hasAttachments: false });
  });

  it("falls back to the snippet and the Inkbox id when body and Message-ID are absent", () => {
    const m = parseInkboxEvent(envelope("message.received", { message: { id: "mail_2", from_address: "a@b.co", subject: null, snippet: "short" } }))!;
    expect(m.text).toBe("Subject: (no subject)\n\nshort");
    expect(m.conversationKey).toBe("email:mail_2");
    expect(m.replyRef.messageId).toBe("mail_2");
  });

  it("ignores outbound mail lifecycle events", () => {
    expect(parseInkboxEvent(envelope("message.sent", payload.data))).toBeUndefined();
    expect(parseInkboxEvent(envelope("message.delivered", payload.data))).toBeUndefined();
    expect(parseInkboxEvent(envelope("message.bounced", payload.data))).toBeUndefined();
  });
});

describe("parseInkboxEvent: A2A", () => {
  const data = {
    task_id: "task_1",
    context_id: "ctx_1",
    state: "submitted",
    caller: { handle: "sam-instinct", identity_id: "id_9", organization_id: "org_9" },
    message_id: "m_1",
    parts: [
      { text: "Hi, this is Sam's Kloru. Is Maria free Thursday evening?" },
      { data: { oip: "1", intent: "request_freebusy", payload: { window: { from: "2026-10-08", to: "2026-10-09" } } } },
      { text: "Reply by noon." },
    ],
  };

  it("maps a2a.task.created with joined text and the first data part", () => {
    const m = parseInkboxEvent(envelope("a2a.task.created", data))!;
    expect(m.channel).toBe("a2a");
    expect(m.conversationKey).toBe("a2a:ctx_1");
    expect(m.from).toBe("sam-instinct");
    expect(m.text).toBe("Hi, this is Sam's Kloru. Is Maria free Thursday evening?\n\nReply by noon.");
    expect(m.data).toMatchObject({ oip: "1", intent: "request_freebusy" });
    expect(m.replyRef).toEqual({ taskId: "task_1", contextId: "ctx_1", messageId: "m_1" });
    expect(m.meta).toMatchObject({ eventType: "a2a.task.created", state: "submitted", callerIdentityId: "id_9" });
  });

  it("maps a2a.task.message the same way", () => {
    const m = parseInkboxEvent(envelope("a2a.task.message", { ...data, state: "working", parts: [{ text: "any update?" }] }))!;
    expect(m.conversationKey).toBe("a2a:ctx_1");
    expect(m.text).toBe("any update?");
    expect(m.data).toBeUndefined();
  });

  it("marks received tasks with direction received and reads the caller", () => {
    const m = parseInkboxEvent(envelope("a2a.task.created", data))!;
    expect(m.meta).toMatchObject({ direction: "received", callerOrganizationId: "org_9" });
  });

  it("turns a2a.task.canceled into a system-style line in the same conversation", () => {
    const m = parseInkboxEvent(envelope("a2a.task.canceled", { ...data, state: "canceled", message_id: undefined, parts: [] }, "evt_c"))!;
    expect(m.channel).toBe("a2a");
    expect(m.conversationKey).toBe("a2a:ctx_1");
    expect(m.from).toBe("sam-instinct");
    expect(m.text).toBe("[task task_1 canceled by @sam-instinct]");
    expect(m.replyRef).toEqual({ taskId: "task_1", contextId: "ctx_1", messageId: undefined });
    expect(m.meta).toMatchObject({ eventType: "a2a.task.canceled", state: "canceled", direction: "received" });
    expect(m.data).toBeUndefined();
  });

  it("appends the caller's note to a cancel and defaults the state when missing", () => {
    const m = parseInkboxEvent(envelope("a2a.task.canceled", { task_id: "t", context_id: "c", caller: {}, parts: [{ text: "never mind" }] }))!;
    expect(m.text).toBe("[task t canceled by the caller]\n\nnever mind");
    expect(m.meta?.state).toBe("canceled");
    expect(m.from).toBe("");
  });

  describe("a2a.sent_task.updated", () => {
    // On this event `caller` is our own identity; the peer who answered rides on `sender`.
    const sent = {
      task_id: "task_7",
      context_id: "ctx_7",
      state: "completed",
      caller: { handle: "maria-instinct", identity_id: "id_me", organization_id: "org_me" },
      sender: { handle: "sam-instinct", identity_id: "id_9", organization_id: "org_9" },
      message_id: "m_9",
      parts: [{ text: "Thu 7pm works for Sam." }, { data: { oip: "1", intent: "accept", payload: { slot: { start: "2026-10-08T19:00:00-07:00" } } } }],
    };

    it("maps the peer's answer to a message from the sender with text, data and replyRef", () => {
      const m = parseInkboxEvent(envelope("a2a.sent_task.updated", sent, "evt_s"))!;
      expect(m.channel).toBe("a2a");
      expect(m.id).toBe("evt_s");
      expect(m.conversationKey).toBe("a2a:ctx_7");
      expect(m.from).toBe("sam-instinct");
      expect(m.from).not.toBe("maria-instinct");
      expect(m.text).toBe("Thu 7pm works for Sam.");
      expect(m.data).toEqual({ oip: "1", intent: "accept", payload: { slot: { start: "2026-10-08T19:00:00-07:00" } } });
      expect(m.replyRef).toEqual({ taskId: "task_7", contextId: "ctx_7", messageId: "m_9" });
      expect(m.meta).toMatchObject({ eventType: "a2a.sent_task.updated", state: "completed", direction: "sent", callerIdentityId: "id_9", callerOrganizationId: "org_9" });
    });

    it("still prompts on a bare state change and keeps successive updates apart", () => {
      const { message_id: _m, parts: _p, ...bare } = sent;
      const working = parseInkboxEvent({ event_type: "a2a.sent_task.updated", data: { ...bare, state: "working" } })!;
      const done = parseInkboxEvent({ event_type: "a2a.sent_task.updated", data: { ...bare, state: "completed" } })!;
      expect(working.text).toBe("[working]");
      expect(done.text).toBe("[completed]");
      expect(working.id).toBe("a2a:task_7:working");
      expect(done.id).toBe("a2a:task_7:completed");
      expect(working.data).toBeUndefined();
    });

    it("falls back to the task id as context and reads other peer field names", () => {
      const noCtx = parseInkboxEvent(envelope("a2a.sent_task.updated", { task_id: "task_8", state: "working", caller: { handle: "maria-instinct" }, worker: { handle: "alex-instinct" }, parts: [{ text: "on it" }] }))!;
      expect(noCtx.conversationKey).toBe("a2a:task_8");
      expect(noCtx.replyRef).toMatchObject({ taskId: "task_8", contextId: "task_8" });
      expect(noCtx.from).toBe("alex-instinct");
      const unknownPeer = parseInkboxEvent(envelope("a2a.sent_task.updated", { task_id: "task_9", context_id: "c9", state: "working", caller: { handle: "maria-instinct" } }))!;
      // Never present our own identity as the sender.
      expect(unknownPeer.from).toBe("");
      expect(unknownPeer.text).toBe("[working]");
    });

    it("drops an update without a task id", () => {
      expect(parseInkboxEvent(envelope("a2a.sent_task.updated", { context_id: "c", state: "working" }))).toBeUndefined();
    });
  });

  it("tolerates a missing caller handle and missing parts", () => {
    const m = parseInkboxEvent(envelope("a2a.task.created", { task_id: "t", context_id: "c", caller: { handle: null } }))!;
    expect(m.from).toBe("");
    expect(m.text).toBe("");
  });
});

describe("parseInkboxEvent: garbage", () => {
  it("returns undefined for non-objects, missing event types and delivery events", () => {
    expect(parseInkboxEvent(null)).toBeUndefined();
    expect(parseInkboxEvent("imessage.received")).toBeUndefined();
    expect(parseInkboxEvent({ data: {} })).toBeUndefined();
    expect(parseInkboxEvent({ event_type: "imessage.received" })).toBeUndefined();
    expect(parseInkboxEvent(envelope("imessage.delivered", { message: { id: "m", conversation_id: "c" } }))).toBeUndefined();
    expect(parseInkboxEvent(envelope("text.delivered", { text_message: { id: "t", remote_phone_number: "+1" } }))).toBeUndefined();
  });
});
