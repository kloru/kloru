import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, StateDir, type WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { AUTOMATION_CREATE, automationTools, type AutomationEvents } from "../src/automations.js";
import { Desk, EVENT_HEADING, type Notice, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

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
const EZRA = "+14155550190";
const ctx = (issue: number, role = "ops") => ({ conversationKey: `desk:issue:${issue}:${role}` }) as never;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

function setup() {
  const host = new Host();
  const sent: Notice[] = [];
  const root = mkdtempSync(join(tmpdir(), "automations-"));
  const scheduler = new Scheduler(new StateDir(join(root, "state")));
  const desk = new Desk({ root: join(root, "repo"), host, planner: new PM(), scheduler, timezone: "America/Los_Angeles", notify: async (n) => (sent.push(n), true), notifyDelayMs: 20, notifyWaitMs: 300 });
  const tools = Object.fromEntries(automationTools(desk).map((t) => [t.spec.name, t]));
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  const issue = desk.fileIssue(call.id, "Every weekday at 7, email me a debrief of my day");
  desk.assign(issue.id, "ops", "Create the automation", []);
  return { host, desk, scheduler, tools, call, issue, sent };
}

const DEBRIEF = { name: "Morning debrief", request: "Debrief Ezra on today: his calendar, important unread email, and anything due.", cron: "0 7 * * 1-5" };

describe("automations: set up on a call, run on their own", () => {
  it("when it fires, the desk does the work and the result arrives by email, under its name", async () => {
    const { host, desk, scheduler, sent, call } = setup();
    desk.endCall(call.id); // nobody's on the phone at 7 AM
    const entry = scheduler.create({ name: "Morning debrief", prompt: DEBRIEF.request, cron: DEBRIEF.cron, tz: "America/Los_Angeles", enabled: true, target: "desk", phone: EZRA });
    desk.runAutomation(entry);
    await settle(30);
    const run = desk.repo.issues().find((i) => i.request.startsWith("Morning debrief"))!;
    expect(desk.repo.call(run.filedBy.call)).toMatchObject({ channel: "schedule", phone: EZRA });
    expect(desk.repo.call(run.filedBy.call)!.endedAt).toBeTruthy();
    host.last(run.id).finish("Today: dentist at 3, two emails from Cleo, rent due Friday.");
    await settle(150);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/Morning debrief/);
    expect(sent[0]!.text).toContain("dentist at 3");
  });

  it("deleting one stops it, and is recorded too", async () => {
    const { desk, scheduler, tools, issue } = setup();
    const entry = scheduler.create({ name: "Morning debrief", prompt: "x", cron: "0 7 * * *", tz: "UTC", enabled: true, target: "desk", phone: EZRA });
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



describe("event automations: run when something happens", () => {
  function withEvents() {
    const s = setup();
    const watched: string[] = [];
    const unwatched: string[] = [];
    const events: AutomationEvents = {
      types: async (app) => (app === "gmail" ? "GMAIL_NEW_GMAIL_MESSAGE: New Gmail Message. A new email arrives." : ""),
      watch: async (o) => {
        if (o.account.toLowerCase() !== "ezra@example.com") throw new Error(`${o.account} isn't the caller's account`);
        watched.push(o.trigger);
        return { instance: "ti_mail", label: "New Gmail Message" };
      },
      unwatch: async (i) => void unwatched.push(i),
      hookUrl: (token) => `https://kloru.example/webhooks/hook/${token}`,
    };
    const tools = Object.fromEntries(automationTools(s.desk, events).map((t) => [t.spec.name, t]));
    return { ...s, tools, watched, unwatched };
  }
  const REPLY = { name: "Email replies", request: "Draft a reply in the thread and text me a one-line summary.", on_event: { trigger: "gmail_new_gmail_message", account: "Ezra@example.com" }, when: "an email I need to answer" };

  it("an app event is watched for the caller's own account, saved with its condition, and read back in words", async () => {
    const { tools, scheduler, issue, watched, desk } = withEvents();
    const r = text(await tools.automation_create!.spec.execute(REPLY, ctx(issue.id)));
    expect(watched).toEqual(["GMAIL_NEW_GMAIL_MESSAGE"]);
    const [e] = scheduler.list();
    expect(e).toMatchObject({ on: { kind: "app", trigger: "GMAIL_NEW_GMAIL_MESSAGE", label: "New Gmail Message", account: "ezra@example.com", instance: "ti_mail" }, when: "an email I need to answer", target: "desk", phone: EZRA });
    expect(e!.cron).toBeUndefined();
    expect(e!.nextRunAt).toBeUndefined();
    expect(r).toContain("on each New Gmail Message for ezra@example.com, if an email I need to answer");
    expect(text(await tools.automation_list!.spec.execute({}, ctx(issue.id)))).toContain("New Gmail Message");
    expect(desk.repo.ledger(issue.id).find((l) => l.slug === "AUTOMATION_CREATE")?.ok).toBe(true);
  });

  it("someone else's account isn't watched, and nothing is saved", async () => {
    const { tools, scheduler, issue } = withEvents();
    const r = await tools.automation_create!.spec.execute({ ...REPLY, on_event: { trigger: "GMAIL_NEW_GMAIL_MESSAGE", account: "cleo@example.com" } }, ctx(issue.id));
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(scheduler.list()).toEqual([]);
  });

  it("a webhook automation gets its own URL, given back to pass on", async () => {
    const { tools, scheduler, issue } = withEvents();
    const r = text(await tools.automation_create!.spec.execute({ name: "Doorbell", request: "Text me who's at the door.", on_webhook: true }, ctx(issue.id)));
    const on = scheduler.list()[0]!.on!;
    expect(on.kind).toBe("hook");
    const token = (on as { token: string }).token;
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(r).toContain(`https://kloru.example/webhooks/hook/${token}`);
  });

  it("exactly one 'when': a schedule and an event together are refused", async () => {
    const { tools, scheduler, issue } = withEvents();
    const r = await tools.automation_create!.spec.execute({ ...REPLY, cron: "0 7 * * *" }, ctx(issue.id));
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(scheduler.list()).toEqual([]);
  });

  it("deleting the last automation on an event stops watching it; one still in use stays", async () => {
    const { tools, scheduler, issue, unwatched } = withEvents();
    await tools.automation_create!.spec.execute(REPLY, ctx(issue.id));
    await tools.automation_create!.spec.execute({ ...REPLY, name: "Bills", request: "Add bills to my list.", when: "a bill" }, ctx(issue.id));
    const [a, b] = scheduler.list();
    await tools.automation_delete!.spec.execute({ id: a!.id }, ctx(issue.id));
    expect(unwatched).toEqual([]);
    await tools.automation_delete!.spec.execute({ id: b!.id }, ctx(issue.id));
    expect(unwatched).toEqual(["ti_mail"]);
  });

  it("lists what an app can start an automation on", async () => {
    const { tools, issue } = withEvents();
    expect(text(await tools.automation_events!.spec.execute({ app: "gmail" }, ctx(issue.id)))).toContain("GMAIL_NEW_GMAIL_MESSAGE");
  });

  it("without events, automation_create offers schedules only", () => {
    const { tools } = setup();
    expect(tools.automation_events).toBeUndefined();
    expect(JSON.stringify(tools.automation_create!.spec.parameters)).not.toContain("on_event");
  });

  it("when one fires, the event reaches the worker, marked as outside content, and the PM sees a short part", async () => {
    const { host, desk, scheduler, call } = setup();
    desk.endCall(call.id);
    const entry = scheduler.create({ name: "Email replies", prompt: REPLY.request, on: { kind: "app", trigger: "GMAIL_NEW_GMAIL_MESSAGE", account: "ezra@example.com", instance: "ti_mail" }, tz: "UTC", enabled: true, target: "desk", phone: EZRA });
    const email = `New Gmail Message for ezra@example.com:\n{"subject": "Dinner Saturday?", "sender": "cleo@example.com", "body": "${"x".repeat(9000)}"}`;
    const run = desk.runAutomation(entry, email)!;
    await settle(30);
    expect(run.event!.length).toBeLessThanOrEqual(Desk.EVENT_MAX + 1);
    expect(run.thread.find((t) => t.by === "system")?.text).toContain("on each GMAIL_NEW_GMAIL_MESSAGE for ezra@example.com");
    expect(host.last(run.id)).toBeTruthy();
    const prompt = (desk as unknown as { workerPrompt(i: unknown): string }).workerPrompt(desk.repo.issue(run.id));
    expect(prompt).toContain(`${EVENT_HEADING}\nNew Gmail Message for ezra@example.com`);
    expect(prompt).toContain("Dinner Saturday?");
  });
});
