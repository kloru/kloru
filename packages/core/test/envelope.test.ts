import { describe, expect, it } from "vitest";
import { decodeEvent, encodeEvent, isEnvelope, systemTaskOf } from "../src/envelope.js";
import { EVENT_ENVELOPE_PREFIX } from "../src/types.js";

describe("envelope", () => {
  it("round-trips an event", () => {
    const event = {
      id: "evt_123",
      event_type: "imessage.received",
      data: { message: { id: "m1", conversation_id: "c1", content: "hi @@instinct-event@@ not a prefix", media: [] } },
    };
    const wire = encodeEvent(event);
    expect(wire.startsWith(EVENT_ENVELOPE_PREFIX)).toBe(true);
    expect(isEnvelope(wire)).toBe(true);
    expect(decodeEvent(wire)).toEqual(event);
  });

  it("returns undefined for plain text and broken payloads", () => {
    expect(decodeEvent("hello there")).toBeUndefined();
    expect(decodeEvent("")).toBeUndefined();
    expect(decodeEvent(EVENT_ENVELOPE_PREFIX)).toBeUndefined();
    expect(decodeEvent(EVENT_ENVELOPE_PREFIX + "{not json")).toBeUndefined();
    expect(decodeEvent("x" + EVENT_ENVELOPE_PREFIX + "{}")).toBeUndefined();
    expect(isEnvelope("plain")).toBe(false);
    // @ts-expect-error runtime guard for untyped callers
    expect(decodeEvent(undefined)).toBeUndefined();
  });

  it("tolerates leading whitespace and primitive payloads", () => {
    expect(decodeEvent("  " + encodeEvent({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeEvent(encodeEvent("text"))).toBe("text");
    expect(decodeEvent(encodeEvent(null))).toBeNull();
  });
});

describe("systemTaskOf", () => {
  it("accepts a well-formed task and rejects anything else", () => {
    expect(systemTaskOf({ type: "system.task", id: "conference-prepare", prompt: "Research the owner", name: "Prepare", quiet: true })).toEqual({
      type: "system.task",
      id: "conference-prepare",
      prompt: "Research the owner",
      name: "Prepare",
      quiet: true,
    });
    expect(systemTaskOf({ type: "system.task", id: "x", prompt: "go", quiet: "yes" })).toEqual({ type: "system.task", id: "x", prompt: "go" });
    expect(systemTaskOf({ type: "system.task", id: "bad id!", prompt: "go" })).toBeUndefined();
    expect(systemTaskOf({ type: "system.task", id: "x", prompt: "   " })).toBeUndefined();
    expect(systemTaskOf({ type: "imessage.received", id: "x", prompt: "go" })).toBeUndefined();
    expect(systemTaskOf("system.task")).toBeUndefined();
  });
});
