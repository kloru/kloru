import { describe, expect, it } from "vitest";
import { OIP_INTENTS, decodeOip, describeOip, encodeOip, oipToText, type OipMessage } from "../src/oip.js";

const proposal: OipMessage = {
  oip: "1",
  intent: "propose_times",
  subject: "dinner with Maria and Sam",
  on_behalf_of: { handle: "maria-instinct", display: "Maria" },
  payload: {
    slots: [
      { start: "2026-10-07T19:00:00-04:00", end: "2026-10-07T22:00:00-04:00" },
      { start: "2026-10-09T19:00:00-04:00", end: "2026-10-09T22:00:00-04:00" },
    ],
    place_hint: "walking distance from Mission",
  },
  needs_consent: false,
  reply_by: "2026-10-06T12:00:00-04:00",
};

describe("encodeOip / decodeOip", () => {
  it("round-trips every intent", () => {
    for (const intent of OIP_INTENTS) {
      const m: OipMessage = { oip: "1", intent, payload: { k: intent, n: 1, nested: { a: [1, 2] } } };
      expect(decodeOip(encodeOip(m))).toEqual(m);
    }
  });

  it("round-trips the full proposal and keeps optional fields", () => {
    const wire = encodeOip(proposal);
    expect(wire.oip).toBe("1");
    expect(wire.on_behalf_of).toEqual({ handle: "maria-instinct", display: "Maria" });
    expect(decodeOip(wire)).toEqual(proposal);
  });

  it("drops undefined optional fields on encode", () => {
    const wire = encodeOip({ oip: "1", intent: "ask", payload: {} });
    expect(Object.keys(wire).sort()).toEqual(["intent", "oip", "payload"]);
  });

  it("does not alias the payload object", () => {
    const payload = { a: 1 };
    const wire = encodeOip({ oip: "1", intent: "inform", payload });
    (wire.payload as Record<string, unknown>).a = 2;
    expect(payload.a).toBe(1);
  });

  it("rejects junk", () => {
    expect(decodeOip(undefined)).toBeUndefined();
    expect(decodeOip(null)).toBeUndefined();
    expect(decodeOip("propose_times")).toBeUndefined();
    expect(decodeOip([])).toBeUndefined();
    expect(decodeOip({})).toBeUndefined();
    expect(decodeOip({ oip: "1" })).toBeUndefined();
    expect(decodeOip({ oip: "2", intent: "ask", payload: {} })).toBeUndefined();
    expect(decodeOip({ oip: "1", intent: "delete_everything", payload: {} })).toBeUndefined();
    expect(decodeOip({ oip: "1", intent: "ask", payload: "not an object" })).toBeUndefined();
    expect(decodeOip({ oip: "1", intent: "ask", payload: [1] })).toBeUndefined();
  });

  it("accepts a missing payload as empty and drops malformed optional fields", () => {
    const m = decodeOip({ oip: 1, intent: "inform", subject: 42, on_behalf_of: { display: "x" }, needs_consent: "yes", reply_by: 5 });
    expect(m).toEqual({ oip: "1", intent: "inform", payload: {} });
  });
});

describe("describeOip", () => {
  it("names the intent, subject, sender and payload in one paragraph", () => {
    const text = describeOip(proposal);
    expect(text).toContain('intent "propose_times"');
    expect(text).toContain("dinner with Maria and Sam");
    expect(text).toContain("Maria (@maria-instinct)");
    expect(text).toContain("place_hint");
    expect(text).toContain("2026-10-06T12:00:00-04:00");
    expect(text).not.toContain("\n");
  });

  it("flags consent", () => {
    expect(describeOip({ ...proposal, needs_consent: true })).toContain("consent");
  });
});

describe("oipToText", () => {
  it("renders propose_times as numbered options with the sender's wall clock", () => {
    const text = oipToText(proposal, "Maria");
    const lines = text.split("\n");
    expect(lines[0]).toBe("Hi, this is Kloru, Maria's assistant.");
    expect(text).toContain("dinner with Maria and Sam");
    expect(text).toMatch(/1\) .*Oct 7.*7:00 PM to 10:00 PM/);
    expect(text).toMatch(/2\) .*Oct 9.*7:00 PM to 10:00 PM/);
    expect(text).toContain("Place: walking distance from Mission.");
    expect(text).toContain("Reply with the number that works");
    expect(text).toMatch(/Please reply by .*Oct 6/);
  });

  it("uses the given time zone when provided", () => {
    const text = oipToText(proposal, "Maria", { tz: "America/Los_Angeles" });
    // 19:00 -04:00 is 16:00 in Los Angeles.
    expect(text).toMatch(/1\) .*Oct 7.*4:00 PM to 7:00 PM/);
  });

  it("falls back to payload.text when typed fields are missing", () => {
    const text = oipToText({ oip: "1", intent: "ask", payload: { text: "Does Sam eat fish?" } }, "Maria");
    expect(text).toContain("Does Sam eat fish?");
  });

  it("renders the other intents without throwing", () => {
    expect(oipToText({ oip: "1", intent: "request_freebusy", subject: "a hike", payload: { window: { from: "2026-10-10", to: "2026-10-12" } } }, "Maria")).toMatch(/free between .*Oct 10.* and .*Oct 12/);
    expect(oipToText({ oip: "1", intent: "accept", payload: { slot: { start: "2026-10-07T19:00:00-04:00" }, place: "Nopa" } }, "Maria")).toMatch(/Maria can do .*Oct 7.*7:00 PM at Nopa/);
    expect(oipToText({ oip: "1", intent: "decline", payload: { reason: "travelling" } }, "Maria")).toContain("cannot make it (travelling)");
    expect(oipToText({ oip: "1", intent: "confirm", payload: { summary: "Nopa, Thu 7 pm, 2 people" } }, "Maria")).toContain("Confirmed: Nopa, Thu 7 pm, 2 people.");
    expect(oipToText({ oip: "1", intent: "ask", payload: { question: "Veg or fish?", options: ["veg", "fish"] } }, "Maria")).toContain("Options: veg, fish.");
    expect(oipToText({ oip: "1", intent: "inform", payload: { facts: { busy: "Tue evening", free: "Thu" } } }, "Maria")).toContain("busy: Tue evening");
    expect(oipToText({ oip: "1", intent: "share", payload: { kind: "location.approx", value: "Boston" } }, "Maria")).toContain("shared location approx: Boston");
    expect(oipToText({ oip: "1", intent: "book_request", payload: { vendor: "Nopa", details: "2 people Thu 7 pm", budget_usd: 150 } }, "Maria")).toContain("Budget up to $150.");
  });
});
