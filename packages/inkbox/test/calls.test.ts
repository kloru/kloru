import { describe, expect, it, vi } from "vitest";
import { callOutcomeSentence, callReportText, handleCallEnded, voiceInstructions } from "../src/calls.js";
import { parseCallEnded, parseInkboxEvent, type CallEndedEvent } from "../src/events.js";

/** A `call.ended` payload as Inkbox posts it for a Voice AI call that got through. */
function callEndedPayload(over: { transcript?: unknown; items?: unknown; call?: Record<string, unknown>; data?: Record<string, unknown> } = {}) {
  return {
    id: "evt_call_1",
    event_type: "call.ended",
    timestamp: "2026-10-16T18:04:05Z",
    data: {
      call: {
        id: "call_1",
        origin: "shared_imessage_number",
        local_phone_number: null,
        remote_phone_number: "+14155550123",
        direction: "outbound",
        status: "completed",
        hangup_reason: "remote",
        started_at: "2026-10-16T18:02:00Z",
        ended_at: "2026-10-16T18:04:00Z",
        created_at: "2026-10-16T18:01:50Z",
        updated_at: "2026-10-16T18:04:05Z",
        duration_seconds: 120,
        mode: "hosted_agent",
        reason: "Book a table for 4 at 7pm under Maria",
        ...(over.call ?? {}),
      },
      contacts: [{ id: "c_1", name: "Nopa" }],
      agent_identities: [],
      transcript:
        over.transcript !== undefined
          ? over.transcript
          : {
              entries: [
                { party: "remote", text: "Nopa, how can I help?", ts_ms: 0 },
                { party: "local", text: "Hi, I'm calling for Maria to book a table for four at 7 tonight.", ts_ms: 2000 },
                { party: "remote", text: "Seven is full, I can do seven thirty.", ts_ms: 6000 },
                { marker: "abridged", omitted_turns: 2, omitted_ms: 9000 },
                { party: "local", text: "Seven thirty for four under Maria, thank you.", ts_ms: 20000 },
                { party: "remote", text: "   ", ts_ms: 21000 },
                { party: "remote", text: "See you at seven thirty.", ts_ms: 22000 },
              ],
              abridged: true,
              url: "https://inkbox.ai/api/v1/phone/calls/call_1/transcripts",
            },
      transcript_url: "https://inkbox.ai/api/v1/phone/calls/call_1/transcripts",
      outcome: "completed",
      post_call_action_items:
        over.items !== undefined
          ? over.items
          : [
              { id: "a_1", seq: 1, action: "Confirm the booking by text tomorrow morning", details: "They send a reminder at 9am", status: "open" },
              { id: "a_2", seq: 2, action: "Bring a credit card for the deposit", details: null, status: "open" },
            ],
      ...(over.data ?? {}),
    },
  };
}

describe("parseCallEnded", () => {
  it("maps a completed Voice AI call, dropping the abridgment marker and blank turns", () => {
    const e = parseCallEnded(callEndedPayload())!;
    expect(e).toMatchObject({
      id: "evt_call_1",
      callId: "call_1",
      remoteNumber: "+14155550123",
      contactName: "Nopa",
      direction: "outbound",
      status: "completed",
      outcome: "completed",
      hangupReason: "remote",
      durationSeconds: 120,
      reason: "Book a table for 4 at 7pm under Maria",
      transcriptAbridged: true,
      receivedAt: "2026-10-16T18:04:05Z",
    });
    expect(e.transcript).toEqual([
      { party: "remote", text: "Nopa, how can I help?" },
      { party: "local", text: "Hi, I'm calling for Maria to book a table for four at 7 tonight." },
      { party: "remote", text: "Seven is full, I can do seven thirty." },
      { party: "local", text: "Seven thirty for four under Maria, thank you." },
      { party: "remote", text: "See you at seven thirty." },
    ]);
    expect(e.actionItems).toEqual([
      { action: "Confirm the booking by text tomorrow morning", details: "They send a reminder at 9am" },
      { action: "Bring a credit card for the deposit" },
    ]);
  });

  it("keeps a null transcript as null (to be fetched) and an empty list as empty", () => {
    expect(parseCallEnded(callEndedPayload({ transcript: null }))!.transcript).toBeNull();
    expect(parseCallEnded(callEndedPayload({ transcript: { entries: [], abridged: false, url: "u" } }))!.transcript).toEqual([]);
  });

  it("is undefined for other events, and parseInkboxEvent never turns a call into a model message", () => {
    expect(parseCallEnded({ ...callEndedPayload(), event_type: "imessage.received" })).toBeUndefined();
    expect(parseCallEnded({ id: "x", event_type: "call.ended", data: { contacts: [] } })).toBeUndefined();
    expect(parseCallEnded("call.ended")).toBeUndefined();
    expect(parseInkboxEvent(callEndedPayload())).toBeUndefined();
  });

  it("falls back to a stable id and the remote_number spelling on older payloads", () => {
    const raw = callEndedPayload({ call: { remote_phone_number: undefined, remote_number: "+14155550123" }, data: { outcome: undefined, post_call_action_items: undefined } });
    delete (raw as { id?: string }).id;
    const e = parseCallEnded(raw)!;
    expect(e.id).toBe("call:call_1:ended");
    expect(e.remoteNumber).toBe("+14155550123");
    expect(e.outcome).toBeUndefined();
    expect(e.actionItems).toEqual([]);
  });
});

describe("callReportText", () => {
  const event = parseCallEnded(callEndedPayload())!;

  it("is one text: the outcome, the last turns, then the action items", () => {
    expect(callReportText(event, event.transcript!)).toBe(
      [
        "My call to Nopa (+14155550123) is done (2 min).",
        "What was said:",
        "Them: Nopa, how can I help?",
        "Me: Hi, I'm calling for Maria to book a table for four at 7 tonight.",
        "Them: Seven is full, I can do seven thirty.",
        "Me: Seven thirty for four under Maria, thank you.",
        "Them: See you at seven thirty.",
        "To do:",
        "- Confirm the booking by text tomorrow morning (They send a reminder at 9am)",
        "- Bring a credit card for the deposit",
      ].join("\n"),
    );
  });

  it("keeps only the last six turns of a long call and says so", () => {
    const turns = Array.from({ length: 9 }, (_, i) => ({ party: i % 2 ? "local" : "remote", text: `turn ${i + 1}` }));
    const text = callReportText({ ...event, actionItems: [] }, turns);
    expect(text).toContain("Last part of the call:");
    expect(text).not.toContain("turn 3\n");
    expect(text).toContain("Me: turn 4");
    expect(text.endsWith("Them: turn 9")).toBe(true);
  });

  it("clips long turns and long items, and skips system lines", () => {
    const long = "x".repeat(400);
    const text = callReportText({ ...event, actionItems: [{ action: long }] }, [{ party: "system", text: "Call connected" }, { party: "remote", text: long }]);
    expect(text).not.toContain("Call connected");
    expect(text).toContain(`Them: ${"x".repeat(159)}…`);
    expect(text).toContain(`- ${"x".repeat(199)}…`);
  });

  it("says what happened for every outcome without inventing anything", () => {
    const base: CallEndedEvent = { ...event, contactName: undefined, transcript: [], actionItems: [] } as CallEndedEvent;
    delete (base as { contactName?: string }).contactName;
    expect(callOutcomeSentence({ ...base, outcome: "no_answer", status: "completed" })).toBe("My call to +14155550123 was not answered.");
    expect(callOutcomeSentence({ ...base, outcome: "declined" })).toBe("My call to +14155550123 was declined.");
    expect(callOutcomeSentence({ ...base, outcome: "failed", status: "failed" })).toBe("My call to +14155550123 did not connect.");
    expect(callOutcomeSentence({ ...base, hangupReason: "voicemail", outcome: "completed" })).toBe("My call to +14155550123 went to voicemail; I left a message.");
    expect(callOutcomeSentence({ ...base, outcome: undefined, status: "canceled" })).toBe("My call to +14155550123 did not connect.");
    expect(callOutcomeSentence({ ...base, outcome: undefined, status: "completed", durationSeconds: 45 })).toBe("My call to +14155550123 is done (45 s).");
    expect(callOutcomeSentence({ ...base, outcome: undefined, status: "answered", durationSeconds: 0 })).toBe("My call to +14155550123 ended (answered).");
    expect(callReportText({ ...base, outcome: "no_answer" }, [])).toBe("My call to +14155550123 was not answered.");
  });
});

describe("handleCallEnded", () => {
  it("uses the inline transcript and texts the owner exactly once", async () => {
    const event = parseCallEnded(callEndedPayload())!;
    const relayToOwner = vi.fn(async () => true);
    const fetchTranscript = vi.fn(async () => []);
    const out = await handleCallEnded(event, { relayToOwner, fetchTranscript });
    expect(fetchTranscript).not.toHaveBeenCalled();
    expect(relayToOwner).toHaveBeenCalledTimes(1);
    expect(out.delivered).toBe(true);
    expect(out.text.startsWith("My call to Nopa (+14155550123) is done (2 min).\nWhat was said:\n")).toBe(true);
  });

  it("fetches the verbatim transcript when the event carries none", async () => {
    const event = parseCallEnded(callEndedPayload({ transcript: null, items: [] }))!;
    const relayToOwner = vi.fn(async () => true);
    const fetchTranscript = vi.fn(async (callId: string) => {
      expect(callId).toBe("call_1");
      return [
        { party: "local", text: "Hi, calling for Maria." },
        { party: "remote", text: "We are closed today." },
      ];
    });
    const out = await handleCallEnded(event, { relayToOwner, fetchTranscript });
    expect(fetchTranscript).toHaveBeenCalledTimes(1);
    expect(out.text).toBe("My call to Nopa (+14155550123) is done (2 min).\nWhat was said:\nMe: Hi, calling for Maria.\nThem: We are closed today.");
  });

  it("still reports the outcome when the transcript fetch fails, and says when the owner is unreachable", async () => {
    const event = parseCallEnded(callEndedPayload({ transcript: null, items: [] }))!;
    const logs: string[] = [];
    const out = await handleCallEnded(event, {
      relayToOwner: async () => false,
      fetchTranscript: async () => {
        throw new Error("503 from Inkbox");
      },
      logger: (m) => logs.push(m),
    });
    expect(out).toEqual({ delivered: false, text: "My call to Nopa (+14155550123) is done (2 min)." });
    expect(logs).toEqual(["call call_1: transcript unavailable: 503 from Inkbox", "call call_1: no way to reach the owner with the call report"]);
  });
});

describe("voiceInstructions", () => {
  it("names the owner and forbids sharing their card or personal data", () => {
    expect(voiceInstructions("Maria")).toBe(
      "You are Maria's assistant calling on their behalf. Be brief and polite, confirm names and times before you end the call, and never share Maria's card details or personal data.",
    );
  });
});
