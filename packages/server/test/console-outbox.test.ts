import { describe, expect, it } from "vitest";
import type { Outbox, OutboundMessage } from "@kloru/core";
import { ChatAwareOutbox, ChatReplyBuffer, ConsoleOutbox } from "../src/console-outbox.js";

const owner = { kind: "owner" as const, id: "owner", tier: "owner" as const, displayName: "M" };

describe("ConsoleOutbox", () => {
  it("keeps the last message per conversation and logs", async () => {
    const logs: string[] = [];
    const box = new ConsoleOutbox({ logger: (m) => logs.push(m) });
    await box.send({ channel: "imessage", text: "one" }, { principal: owner, conversationKey: "imessage:a" });
    await box.send({ channel: "imessage", text: "two" }, { principal: owner, conversationKey: "imessage:a" });
    await box.send({ channel: "chat", conversationKey: "chat:x", text: "three", to: "owner" }, { principal: owner, conversationKey: "ignored" });
    expect(box.lastFor("imessage:a")?.text).toBe("two");
    expect(box.lastFor("chat:x")?.text).toBe("three");
    expect(box.lastFor("ignored")).toBeUndefined();
    expect(box.all()).toHaveLength(3);
    expect(logs[2]).toContain("chat chat:x to owner: three");
  });

  it("caps history", async () => {
    const box = new ConsoleOutbox({ logger: () => {}, historyLimit: 2 });
    for (let i = 0; i < 5; i++) await box.send({ channel: "sms", text: String(i) }, { principal: owner, conversationKey: "sms:1" });
    expect(box.all().map((s) => s.msg.text)).toEqual(["3", "4"]);
  });

  it("buffers chat replies per conversation until they are taken", async () => {
    const box = new ConsoleOutbox({ logger: () => {} });
    await box.send({ channel: "chat", text: "late answer" }, { principal: owner, conversationKey: "chat:abc" });
    await box.send({ channel: "chat", conversationKey: "chat:abc", text: "second" }, { principal: owner, conversationKey: "chat:ctx" });
    await box.send({ channel: "imessage", text: "not chat" }, { principal: owner, conversationKey: "imessage:1" });
    expect(box.chat.pendingCounts()).toEqual({ "chat:abc": 2 });
    expect(box.chat.take("chat:abc").map((m) => m.text)).toEqual(["late answer", "second"]);
    expect(box.chat.take("chat:abc")).toEqual([]);
    expect(box.chat.pendingCounts()).toEqual({});
  });
});

describe("ChatReplyBuffer", () => {
  it("drops the oldest reply past the per-conversation limit", () => {
    const buf = new ChatReplyBuffer(2);
    for (const t of ["a", "b", "c"]) buf.push("chat:k", { channel: "chat", text: t });
    expect(buf.peek("chat:k").map((m) => m.text)).toEqual(["b", "c"]);
    expect(buf.pendingCounts()).toEqual({ "chat:k": 2 });
  });
});

describe("ChatAwareOutbox", () => {
  function recording(): Outbox & { sent: OutboundMessage[]; typed: string[] } {
    const sent: OutboundMessage[] = [];
    const typed: string[] = [];
    return {
      sent,
      typed,
      send: async (msg) => void sent.push(msg),
      typing: async (key) => void typed.push(key),
    };
  }

  it("keeps chat replies out of the wire transport and passes everything else through", async () => {
    const inner = recording();
    const box = new ChatAwareOutbox(inner);
    await box.send({ channel: "chat", text: "for the dashboard" }, { principal: owner, conversationKey: "chat:d" });
    await box.send({ channel: "imessage", conversationKey: "imessage:1", text: "for the phone" }, { principal: owner, conversationKey: "imessage:1" });
    expect(inner.sent.map((m) => m.text)).toEqual(["for the phone"]);
    expect(box.chat.take("chat:d").map((m) => m.text)).toEqual(["for the dashboard"]);
  });

  it("skips typing indicators for chat and forwards them otherwise", async () => {
    const inner = recording();
    const box = new ChatAwareOutbox(inner);
    await box.typing("chat:d");
    await box.typing("imessage:1");
    expect(inner.typed).toEqual(["imessage:1"]);
  });

  it("tolerates an inner outbox without typing", async () => {
    const box = new ChatAwareOutbox({ send: async () => undefined });
    await expect(box.typing("imessage:1")).resolves.toBeUndefined();
  });
});
