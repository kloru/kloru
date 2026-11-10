import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type FastAnswer, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole }> = [];
  run(issue: number, role: WorkerRole): Promise<string> {
    this.runs.push({ issue, role });
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

class PM implements Planner {
  seen: Trigger[] = [];
  async handle(ts: Trigger[]): Promise<void> {
    this.seen.push(...ts);
  }
}

const settle = async (ms = 60) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};
const EZRA = "+14155550190";

function setup(fastPath: (request: string) => Promise<FastAnswer | undefined>, fastPathMs = 200) {
  const pm = new PM();
  const host = new Host();
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "fast-")), host, planner: pm, fastPath: async (issue) => fastPath(issue.request), fastPathMs });
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  return { desk, pm, host, call };
}

describe("the fast path: answered from the store before the PM starts", () => {
  it("a read the store can answer is merged into the call within seconds and closed; the PM never runs", async () => {
    const { desk, pm, host, call } = setup(async () => ({ answer: "Tomorrow you have drop-off at 8, the dentist at 3, and pickup at 4:30.", note: "From the store: calendar as of 30 s ago." }));
    const issue = desk.fileIssue(call.id, "What's on my calendar tomorrow?");
    await settle();
    expect(desk.repo.inbox(call.id, 0).map((m) => m.text)).toEqual(["Tomorrow you have drop-off at 8, the dentist at 3, and pickup at 4:30."]);
    expect(desk.repo.issue(issue.id)!).toMatchObject({ status: "resolved" });
    expect(desk.repo.issue(issue.id)!.thread.at(-1)!.text).toContain("calendar as of 30 s ago");
    expect(pm.seen).toEqual([]);
    expect(host.runs).toEqual([]);
  });

  it("when the fast path declines, the PM starts right away", async () => {
    const { desk, pm, call } = setup(async () => undefined);
    const issue = desk.fileIssue(call.id, "Email Sam that I'm running late");
    await settle();
    expect(pm.seen).toEqual([{ kind: "filed", issue: issue.id }]);
    expect(desk.repo.inbox(call.id, 0)).toEqual([]);
  });

  it("a slow or failing fast path never holds the desk up", async () => {
    const slow = setup(() => new Promise((r) => setTimeout(() => r({ answer: "too late", note: "" }), 500)), 50);
    const a = slow.desk.fileIssue(slow.call.id, "What's on tomorrow?");
    await settle(120);
    expect(slow.pm.seen).toEqual([{ kind: "filed", issue: a.id }]);
    await settle(500);
    expect(slow.desk.repo.inbox(slow.call.id, 0)).toEqual([]); // the late answer is dropped, not doubled
    const broken = setup(async () => {
      throw new Error("model down");
    });
    const b = broken.desk.fileIssue(broken.call.id, "What's on tomorrow?");
    await settle();
    expect(broken.pm.seen).toEqual([{ kind: "filed", issue: b.id }]);
  });

  it("an update from the caller while it's thinking sends it to the PM instead", async () => {
    const { desk, pm, call } = setup(() => new Promise((r) => setTimeout(() => r({ answer: "stale answer", note: "" }), 80)));
    const issue = desk.fileIssue(call.id, "What's on tomorrow?");
    desk.comment(issue.id, call.id, "Actually, Friday");
    await settle(200);
    expect(desk.repo.inbox(call.id, 0)).toEqual([]);
    expect(pm.seen.some((t) => t.kind === "filed" && t.issue === issue.id)).toBe(true);
  });
});

describe("steering workers only with what changes their work", () => {
  it("'I'll just wait' never reaches the engineer; 'actually Friday' does (call CA75760d…, issue #46)", async () => {
    const steered: string[] = [];
    const host = { run: () => new Promise<string>(() => {}), steer: (_i: number, t: string) => (steered.push(t), true), stop: () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "steer-")), host, planner: new PM(), steerFilter: async (_issue, text) => !/wait|thanks/i.test(text) });
    const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Weather in Portland today");
    desk.assign(issue.id, "work", "Look it up", []);
    desk.addTurn(call.id, { role: "caller", text: "I'll just wait." });
    desk.addTurn(call.id, { role: "caller", text: "Actually make it Friday." });
    await settle();
    expect(steered).toHaveLength(1);
    expect(steered[0]).toContain("Actually make it Friday.");
    expect(steered[0]).toMatch(/final message must still be your complete result/);
  });

  it("if the filter fails, the worker is steered anyway: missing a real change is worse", async () => {
    const steered: string[] = [];
    const host = { run: () => new Promise<string>(() => {}), steer: (_i: number, t: string) => (steered.push(t), true), stop: () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "steer-")), host, planner: new PM(), steerFilter: async () => { throw new Error("down"); } });
    const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Weather");
    desk.assign(issue.id, "work", "Look it up", []);
    desk.addTurn(call.id, { role: "caller", text: "Make it Friday." });
    await settle();
    expect(steered).toHaveLength(1);
  });
});
