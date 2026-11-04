/**
 * Task discovery: after a call (and every few hours), a scout reads the caller's calendar, mail,
 * memory and recent work, and suggests what they'll likely want next, each with its goal and why
 * now ("Atlanta trip Nov 4 to 5, but no flight booked"). Kloru offers them on the next calls.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Memory } from "../src/memory.js";

const EVAN = "+14155550190";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; prompt: string; finish: (t: string) => void }> = [];
  run(issue: number, role: WorkerRole, prompt: string): Promise<string> {
    return new Promise((finish) => this.runs.push({ issue, role, prompt, finish }));
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));
};

function setup(now = () => new Date("2026-10-30T16:00:00Z")) {
  const root = mkdtempSync(join(tmpdir(), "scout-"));
  const memory = new Memory(join(root, "memory"), { owner: { name: "Evan Marshall", phones: [EVAN] } });
  memory.init();
  const host = new Host();
  const triggers: Trigger[] = [];
  const planner: Planner = { handle: async (ts) => void triggers.push(...ts) };
  const desk = new Desk({ root, host, planner, memory, now, dayView: () => "Tue, Nov 3 (all day) | Atlanta trip" });
  return { desk, host, triggers };
}

async function afterCall(desk: Desk, host: Host) {
  const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
  desk.addTurn(call.id, { role: "caller", text: "Move my Atlanta trip to the 4th and 5th" });
  desk.endCall(call.id);
  await settle();
  host.runs.find((r) => r.role.name === "memory")!.finish("Noted the trip.");
  await settle();
  return host.runs.find((r) => r.role.name === "scout")!;
}

describe("the scout: what the caller will want next", () => {
  it("runs after a call's memory update, with the caller's day, memory and recent requests", async () => {
    const { desk, host, triggers } = setup();
    const scout = await afterCall(desk, host);
    expect(scout.prompt).toContain("Atlanta trip");
    expect(scout.prompt).toContain("Move my Atlanta trip");
    expect(triggers).toEqual([]);
    expect(desk.openIssues()).toEqual([]);
  });

  it("only looks: an app write is refused and it's told to suggest instead", async () => {
    const { desk, host } = setup();
    const scout = await afterCall(desk, host);
    const r = await scout.role.guard!("app_composio_multi_execute_tool", { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "x@y.com" } }] });
    expect(r).toMatchObject({ block: true });
    expect(await scout.role.guard!("app_composio_multi_execute_tool", { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} }] })).toBeUndefined();
  });

  it("its suggestions, each with a goal and why now, go in the next call's brief, offered at most twice", async () => {
    const { desk, host } = setup();
    const scout = await afterCall(desk, host);
    const r = desk.suggest(scout.issue, { ask: "Book your flight to Atlanta for the evening of Nov 3", goal: "Get to the Atlanta board visit Nov 4 to 5", why: "The trip is on your calendar but there's no flight confirmation in your email", kind: "one_off" });
    expect(r.ok).toBe(true);
    scout.finish("1 suggestion.");
    await settle();
    for (let n = 0; n < 2; n++) {
      const { brief, call } = desk.startCall({ callSid: `CA${n + 2}`, phone: EVAN, channel: "voice" });
      expect(brief).toContain("Book your flight to Atlanta");
      expect(brief).toContain("no flight confirmation");
      desk.endCall(call.id);
    }
    expect(desk.startCall({ callSid: "CA9", phone: EVAN, channel: "voice" }).brief).not.toContain("Book your flight");
  });

  it("a repeated suggestion isn't stored twice", async () => {
    const { desk, host } = setup();
    const scout = await afterCall(desk, host);
    const s = { ask: "Make the promo cleanup nightly", goal: "A clean inbox", why: "You asked for it today", kind: "automation" as const };
    expect(desk.suggest(scout.issue, s).ok).toBe(true);
    expect(desk.suggest(scout.issue, { ...s, ask: "make the promo cleanup nightly." }).ok).toBe(false);
  });

  it("the sweeper runs it again when it hasn't looked in six hours", async () => {
    let t = new Date("2026-10-30T16:00:00Z");
    const { desk, host } = setup(() => t);
    const scout = await afterCall(desk, host);
    scout.finish("Nothing new.");
    await settle();
    const before = host.runs.filter((r) => r.role.name === "scout").length;
    desk.sweep(new Date("2026-10-30T18:00:00Z"));
    expect(host.runs.filter((r) => r.role.name === "scout").length).toBe(before);
    t = new Date("2026-10-30T23:00:00Z");
    desk.sweep(t);
    expect(host.runs.filter((r) => r.role.name === "scout").length).toBe(before + 1);
  });
});
