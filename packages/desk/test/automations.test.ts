import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, StateDir, type WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { AUTOMATION_CREATE, automationTools } from "../src/automations.js";
import { Desk, type Notice, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; finish: (t: string) => void }> = [];
  run(issue: number, role: WorkerRole): Promise<string> {
    return new Promise((finish) => this.runs.push({ issue, role, finish }));
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
  last(issue: number) {
    return this.runs.filter((r) => r.issue === issue).at(-1)!;
  }
}

/** Reads go to an engineer and merge as info; the PM itself doesn't matter here. */
class PM implements Planner {
  async handle(ts: Trigger[], d: Desk): Promise<void> {
    for (const t of ts) {
      if (t.kind === "filed") d.assign(t.issue, "work", "Do it", []);
      if (t.kind === "pr") d.merge(t.issue, "info", d.repo.issue(t.issue)!.prs.at(-1)!.body);
      // Like the real PM: what the caller didn't hear goes in one message.
      if (t.kind === "unheard") await d.tellCaller(t.call, t.unheard.join("\n"));
    }
  }
}

const settle = async (ms = 60) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};
const EVAN = "+14155550190";
const ctx = (issue: number, role = "ops") => ({ conversationKey: `desk:issue:${issue}:${role}` }) as never;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

function setup() {
  const host = new Host();
  const sent: Notice[] = [];
  const root = mkdtempSync(join(tmpdir(), "automations-"));
  const scheduler = new Scheduler(new StateDir(join(root, "state")));
  const desk = new Desk({ root: join(root, "repo"), host, planner: new PM(), scheduler, timezone: "America/Los_Angeles", notify: async (n) => (sent.push(n), true), notifyDelayMs: 20, notifyWaitMs: 300 });
  const tools = Object.fromEntries(automationTools(desk).map((t) => [t.spec.name, t]));
  const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
  const issue = desk.fileIssue(call.id, "Every weekday at 7, email me a debrief of my day");
  desk.assign(issue.id, "ops", "Create the automation", []);
  return { host, desk, scheduler, tools, call, issue, sent };
}

const DEBRIEF = { name: "Morning debrief", request: "Debrief Evan on today: his calendar, important unread email, and anything due.", cron: "0 7 * * 1-5" };

describe("automations: set up on a call, run on their own", () => {
  it("when it fires, the desk does the work and the result arrives by email, under its name", async () => {
    const { host, desk, scheduler, sent, call } = setup();
    desk.endCall(call.id); // nobody's on the phone at 7 AM
    const entry = scheduler.create({ name: "Morning debrief", prompt: DEBRIEF.request, cron: DEBRIEF.cron, tz: "America/Los_Angeles", enabled: true, target: "desk", phone: EVAN });
    desk.runAutomation(entry);
    await settle(30);
    const run = desk.repo.issues().find((i) => i.request.startsWith("Morning debrief"))!;
    expect(desk.repo.call(run.filedBy.call)).toMatchObject({ channel: "schedule", phone: EVAN });
    expect(desk.repo.call(run.filedBy.call)!.endedAt).toBeTruthy();
    host.last(run.id).finish("Today: dentist at 3, two emails from Cara, rent due Friday.");
    await settle(150);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/Morning debrief/);
    expect(sent[0]!.text).toContain("dentist at 3");
  });

  it("deleting one stops it, and is recorded too", async () => {
    const { desk, scheduler, tools, issue } = setup();
    const entry = scheduler.create({ name: "Morning debrief", prompt: "x", cron: "0 7 * * *", tz: "UTC", enabled: true, target: "desk", phone: EVAN });
    expect(text(await tools.automation_list!.spec.execute({}, ctx(issue.id)))).toContain(entry.id);
    expect(text(await tools.automation_delete!.spec.execute({ id: entry.id }, ctx(issue.id)))).toMatch(/Deleted/);
    expect(scheduler.list()).toEqual([]);
    expect(desk.repo.ledger(issue.id).map((e) => e.slug)).toContain("AUTOMATION_DELETE");
  });
});

describe("saying when, in words", () => {
  it("reads a schedule back the way a person would", async () => {
    const { describeWhen } = await import("../src/desk.js");
    expect(describeWhen("0 7 * * 1-5", undefined)).toBe("weekdays at 7:00 AM");
    expect(describeWhen("30 18 * * 5", undefined)).toBe("Fridays at 6:30 PM");
    expect(describeWhen("0 9 * * *", undefined)).toBe("every day at 9:00 AM");
    expect(describeWhen("*/15 * * * *", undefined)).toBe('on the schedule "*/15 * * * *"');
    expect(describeWhen(undefined, "2026-10-30T16:00:00Z")).toMatch(/^once on Fri, Oct 30, 9:00 AM$/);
  });
});


