/**
 * The action ledger, live (#36): every real change a worker makes is told to the call as it
 * lands, in plain words, and every agent sees what has already changed, so nobody says "it
 * wasn't updated" after it was, or does it twice.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, describeWrite, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { snapshot } from "../src/pm.js";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; prompt: string }> = [];
  run(issue: number, role: WorkerRole, prompt: string): Promise<string> {
    this.runs.push({ issue, role, prompt });
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
const EVAN = "+14155550190";
const multi = (slug: string, args: Record<string, unknown>) => ["app_composio_multi_execute_tool", { tools: [{ tool_slug: slug, arguments: args }] }] as const;

function setup() {
  const host = new Host();
  const pm = new PM();
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "ledger-")), host, planner: pm, announceMs: 20 });
  const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
  desk.addTurn(call.id, { role: "caller", text: "Move my Atlanta trip and clean out the promos" });
  const issue = desk.fileIssue(call.id, "Move the Atlanta trip to Nov 4-5");
  desk.assign(issue.id, "ops", "Patch the trip", []);
  const role = host.runs.at(-1)!.role;
  return { desk, host, pm, call, issue, role };
}

describe("the ledger, told as it happens", () => {
  it("a change the worker makes reaches the call within moments as <events>, while the work goes on", async () => {
    const { desk, call, issue, role } = setup();
    const [tool, args] = multi("GOOGLECALENDAR_PATCH_EVENT", { calendar_id: "primary", event_id: "atl1", start_time: "2026-11-04", end_time: "2026-11-06" });
    await role.guard!(tool, args);
    role.afterTool!(tool, args, false, JSON.stringify({ successful: true, data: { summary: "Atlanta trip", start: { date: "2026-11-04" }, end: { date: "2026-11-06" } } }));
    await settle();
    const m = desk.repo.inbox(call.id, 0);
    expect(m).toMatchObject([{ kind: "events", issue: issue.id, progress: true }]);
    expect(m[0]!.text).toContain("Atlanta trip");
    expect(m[0]!.text).toContain("Nov 4");
    expect(desk.repo.issue(issue.id)!.status).toBe("executing");
  });

  it("a burst of changes is told once, together", async () => {
    const { desk, call, role } = setup();
    for (const id of ["a", "b", "c"]) {
      const [tool, args] = multi("GMAIL_MOVE_TO_TRASH", { message_id: id });
      await role.guard!(tool, args);
      role.afterTool!(tool, args, false, "{}");
    }
    await settle();
    const m = desk.repo.inbox(call.id, 0);
    expect(m).toHaveLength(1);
    expect(m[0]!.text).toContain("3 emails to Trash");
  });

  it("failed changes and code runs aren't announced", async () => {
    const { desk, call, role } = setup();
    const [tool, args] = multi("GMAIL_MOVE_TO_TRASH", { message_id: "a" });
    await role.guard!(tool, args);
    role.afterTool!(tool, args, true, "404");
    await settle();
    expect(desk.repo.inbox(call.id, 0)).toEqual([]);
  });

  it("every agent sees what already changed: a new worker's prompt and the PM's snapshot list it", async () => {
    const { desk, host, call, role, issue } = setup();
    const [tool, args] = multi("GOOGLECALENDAR_PATCH_EVENT", { calendar_id: "primary", event_id: "atl1", start_time: "2026-11-04", end_time: "2026-11-06" });
    await role.guard!(tool, args);
    role.afterTool!(tool, args, false, JSON.stringify({ data: { summary: "Atlanta trip" } }));
    const next = desk.fileIssue(call.id, "Is the Atlanta trip updated?");
    desk.assign(next.id, "work", "Check the trip", []);
    expect(host.runs.at(-1)!.prompt).toContain("Already changed");
    expect(host.runs.at(-1)!.prompt).toContain("Atlanta trip");
    expect(snapshot(desk, [{ kind: "filed", issue: next.id }])).toContain(`#${issue.id}`);
    expect(snapshot(desk, [{ kind: "filed", issue: next.id }])).toContain("Atlanta trip");
  });
});

describe("describing a change in plain words", () => {
  it("names what changed", () => {
    expect(describeWrite("GOOGLECALENDAR_PATCH_EVENT", { start_time: "2026-11-04", end_time: "2026-11-06" }, JSON.stringify({ data: { summary: "Atlanta trip" } }))).toBe('updated "Atlanta trip" (Nov 4 to Nov 5)');
    expect(describeWrite("GOOGLECALENDAR_CREATE_EVENT", { summary: "Coffee with Sam" }, "{}")).toBe('added "Coffee with Sam"');
    expect(describeWrite("GMAIL_SEND_EMAIL", { recipient_email: "cara@x.com", subject: "Daycare" }, "{}")).toBe('sent "Daycare" to cara@x.com');
  });
});
