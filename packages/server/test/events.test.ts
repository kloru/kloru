import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateDir, type ScheduleEntry } from "@kloru/core";
import type { GateInput } from "../src/event-gate.js";
import { Events, type EventsOptions } from "../src/events.js";

const EZRA = "+14155550190";
const TOKEN = "hook_token_0123456789abcdef";
const entry = (e: Partial<ScheduleEntry> & Pick<ScheduleEntry, "id" | "on">): ScheduleEntry => ({ name: e.id, prompt: "Do the thing.", enabled: true, target: "desk", phone: EZRA, createdAt: "2026-11-08T00:00:00Z", ...e });
const MAIL = entry({ id: "s_mail", name: "Email replies", prompt: "Draft a reply.", on: { kind: "app", trigger: "GMAIL_NEW_GMAIL_MESSAGE", label: "New Gmail Message", account: "ezra@example.com", instance: "ti_mail" }, when: "an email I need to answer" });
const BELL = entry({ id: "s_bell", name: "Doorbell", on: { kind: "hook", token: TOKEN } });

function setup(o: Partial<EventsOptions> & { list?: ScheduleEntry[] } = {}) {
  const runs: Array<{ id: string; event: string }> = [];
  const gated: GateInput[] = [];
  const records: Array<Record<string, unknown>> = [];
  let now = Date.parse("2026-11-08T12:00:00Z");
  const list = o.list ?? [MAIL, BELL];
  const events = new Events({
    state: new StateDir(mkdtempSync(join(tmpdir(), "events-"))),
    automations: () => list,
    run: (e, event) => void runs.push({ id: e.id, event }),
    gate: async (g) => (gated.push(g), { run: !/newsletter/i.test(g.event), p: 0.9 }),
    guidelines: () => "Short texts.",
    verify: async (body, headers) => {
      if (headers["webhook-signature"] !== "v1,good") throw new Error("signature mismatch");
      return { id: String(headers["webhook-id"]), instance: "ti_mail", trigger: "GMAIL_NEW_GMAIL_MESSAGE", account: "ca_1", data: JSON.parse(body) };
    },
    record: (d) => void records.push(d),
    log: () => {},
    now: () => now,
    ...o,
  });
  events.start();
  return { events, runs, gated, records, list, tick: (ms: number) => (now += ms) };
}
const signed = (id: string) => ({ "webhook-id": id, "webhook-signature": "v1,good", "webhook-timestamp": "1" });

describe("event automations: app events", () => {
  it("a signed event is kept, checked against the condition with their guidelines, and run when it passes", async () => {
    const { events, runs, gated, records } = setup();
    expect(await events.fromApp(JSON.stringify({ sender: "cleo@example.com", subject: "Dinner Saturday?" }), signed("msg_1"))).toBe(204);
    await events.drain();
    expect(gated[0]).toMatchObject({ automation: "Email replies", request: "Draft a reply.", condition: "an email I need to answer", guidelines: "Short texts." });
    expect(gated[0]!.event).toContain("Dinner Saturday?");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event).toMatch(/^New Gmail Message for ezra@example.com, at 2026-11-08T12:00:00.000Z:\n/);
    expect(records[0]).toMatchObject({ event: "app:msg_1", automation: "s_mail", run: true, p: 0.9 });
  });

  it("one the check passes on is recorded and doesn't run", async () => {
    const { events, runs, records } = setup();
    await events.fromApp(JSON.stringify({ subject: "This week's newsletter" }), signed("msg_2"));
    await events.drain();
    expect(runs).toEqual([]);
    expect(records[0]).toMatchObject({ automation: "s_mail", run: false });
  });

  it("a forged event is refused and nothing runs", async () => {
    const { events, runs } = setup();
    expect(await events.fromApp("{}", { ...signed("msg_3"), "webhook-signature": "v1,forged" })).toBe(401);
    await events.drain();
    expect(runs).toEqual([]);
  });

  it("a redelivery runs once", async () => {
    const { events, runs } = setup();
    await events.fromApp(JSON.stringify({ subject: "Dinner?" }), signed("msg_4"));
    await events.fromApp(JSON.stringify({ subject: "Dinner?" }), signed("msg_4"));
    await events.drain();
    expect(runs).toHaveLength(1);
  });

  it("when the check fails, it runs anyway, so nothing they asked for is missed", async () => {
    const { events, runs, records } = setup({ gate: async () => Promise.reject(new Error("decision model 503")) });
    await events.fromApp(JSON.stringify({ subject: "Dinner?" }), signed("msg_5"));
    await events.drain();
    expect(runs).toHaveLength(1);
    expect(records[0]).toMatchObject({ run: true, error: "decision model 503" });
  });

  it("a paused automation, or an event no automation waits for, runs nothing", async () => {
    const paused = setup({ list: [{ ...MAIL, enabled: false }] });
    expect(await paused.events.fromApp("{}", signed("msg_6"))).toBe(204);
    await paused.events.drain();
    expect(paused.runs).toEqual([]);
    const none = setup({ list: [BELL] });
    expect(await none.events.fromApp("{}", signed("msg_7"))).toBe(204);
    await none.events.drain();
    expect(none.runs).toEqual([]);
  });

  it("without a way to verify, app events are refused", async () => {
    const { events } = setup({ verify: undefined });
    expect(await events.fromApp("{}", signed("msg_8"))).toBe(503);
  });
});

describe("event automations: their own webhook", () => {
  it("a call to its URL runs it with the body; no condition means no check", async () => {
    const { events, runs, gated } = setup();
    expect(events.fromHook(TOKEN, JSON.stringify({ who: "delivery driver" }), {})).toBe(204);
    await events.drain();
    expect(gated).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.event).toMatch(/^A call to its webhook, at .*:\n\{\n "who": "delivery driver"\n\}$/);
  });

  it("text bodies come as they are", async () => {
    const { events, runs } = setup();
    events.fromHook(TOKEN, "someone's at the door", {});
    await events.drain();
    expect(runs[0]!.event).toMatch(/someone's at the door$/);
  });

  it("an unknown token is a 404", () => {
    expect(setup().events.fromHook("hook_token_wrong_wrong_wrong", "{}", {})).toBe(404);
  });

  it("a sender's own request id makes its retries count once", async () => {
    const { events, runs } = setup();
    events.fromHook(TOKEN, "{}", { "idempotency-key": "k1" });
    events.fromHook(TOKEN, "{}", { "idempotency-key": "k1" });
    events.fromHook(TOKEN, "{}", { "x-request-id": "k2" });
    await events.drain();
    expect(runs).toHaveLength(2);
  });

  it("a runaway sender gets 429 after the hourly limit, and is let in again an hour later", async () => {
    const { events, tick } = setup({ hourlyLimit: 2 });
    expect(events.fromHook(TOKEN, "{}", {})).toBe(204);
    expect(events.fromHook(TOKEN, "{}", {})).toBe(204);
    expect(events.fromHook(TOKEN, "{}", {})).toBe(429);
    tick(3_600_001);
    expect(events.fromHook(TOKEN, "{}", {})).toBe(204);
  });

  it("a paused automation's webhook is acknowledged and dropped", async () => {
    const { events, runs } = setup({ list: [{ ...BELL, enabled: false }] });
    expect(events.fromHook(TOKEN, "{}", {})).toBe(204);
    await events.drain();
    expect(runs).toEqual([]);
  });

  it("a long body is trimmed", async () => {
    const { events, runs } = setup();
    events.fromHook(TOKEN, "x".repeat(20_000), {});
    await events.drain();
    expect(runs[0]!.event.length).toBeLessThan(8_100);
  });
});
