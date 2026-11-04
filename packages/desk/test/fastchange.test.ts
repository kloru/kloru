/**
 * A simple change (move an event, trash some mail) is made in seconds by one fast step: the
 * fast path names the exact app actions, the desk weighs them, runs them, records them in the
 * ledger, and the call hears what was done. No PM, no worker.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type ActionCheck, type ActionDecision, type FastAnswer, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

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

const MOVE: FastAnswer = {
  say: "Done: the Atlanta trip is now November 4 to 5.",
  note: "From the store: calendar as of 20 s ago.",
  changes: [{ slug: "GOOGLECALENDAR_PATCH_EVENT", args: { calendar_id: "primary", event_id: "atl1", start_time: "2026-11-04", end_time: "2026-11-06", send_updates: "none" }, account: "evan@example.com" }],
};

function setup(o: { got?: FastAnswer; decide?: (c: ActionCheck) => Promise<ActionDecision>; execute?: (slug: string, args: Record<string, unknown>, account?: string) => Promise<{ ok: boolean; data?: unknown; error?: string }> | undefined } = {}) {
  const pm = new PM();
  const host = new Host();
  const executed: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  const writes: string[] = [];
  const execute =
    o.execute === undefined
      ? async (slug: string, args: Record<string, unknown>, account?: string) => {
          executed.push({ slug, args, ...(account ? { account } : {}) });
          return { ok: true, data: { id: "atl1", start: { date: "2026-11-04" } } };
        }
      : o.execute;
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "fastchange-")),
    host,
    planner: pm,
    fastPath: async () => o.got ?? MOVE,
    fastPathMs: 200,
    ...(execute ? { execute } : {}),
    ...(o.decide ? { decideAction: o.decide } : {}),
    onWrite: (slug) => writes.push(slug),
  });
  const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
  return { desk, pm, host, call, executed, writes };
}

describe("a simple change, made by the fast path", () => {
  it("runs the exact actions, records them in the ledger, tells the call it's done, and never starts the PM or a worker", async () => {
    const { desk, pm, host, call, executed, writes } = setup();
    const issue = desk.fileIssue(call.id, "Move my Atlanta trip to the 4th and 5th");
    await settle();
    expect(executed).toEqual([{ slug: "GOOGLECALENDAR_PATCH_EVENT", args: MOVE.changes![0]!.args, account: "evan@example.com" }]);
    expect(desk.repo.inbox(call.id, 0)).toMatchObject([{ kind: "events", text: "Done: the Atlanta trip is now November 4 to 5.", issue: issue.id }]);
    expect(desk.repo.issue(issue.id)).toMatchObject({ kind: "ops", status: "done" });
    expect(desk.repo.ledger(issue.id)).toMatchObject([{ slug: "GOOGLECALENDAR_PATCH_EVENT", ok: true }]);
    expect(writes).toEqual(["GOOGLECALENDAR_PATCH_EVENT"]);
    expect(pm.seen).toEqual([]);
    expect(host.runs).toEqual([]);
  });

  it("every change is weighed first: when it needs a yes, nothing runs and the caller hears the question", async () => {
    const { desk, call, executed } = setup({ decide: async () => ({ decision: "ask", reason: "guests", ask: "Move the trip and tell your guests?" }) });
    const issue = desk.fileIssue(call.id, "Move my Atlanta trip to the 4th and 5th");
    await settle();
    expect(executed).toEqual([]);
    expect(desk.repo.issue(issue.id)!.status).toBe("needs_confirmation");
    expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toContain("Move the trip and tell your guests?");
  });

  it("after the yes, the same exact actions run (no worker re-deriving them)", async () => {
    const { desk, call, executed, host } = setup({ decide: async () => ({ decision: "ask", reason: "guests", ask: "Tell your guests?" }) });
    const issue = desk.fileIssue(call.id, "Move my Atlanta trip to the 4th and 5th");
    await settle();
    desk.confirm(issue.id, call.id, desk.repo.issue(issue.id)!.confirmation!.id);
    await settle();
    expect(executed).toHaveLength(1);
    expect(host.runs).toEqual([]);
    expect(desk.repo.issue(issue.id)!.status).toBe("done");
    expect(desk.repo.inbox(call.id, 0).at(-1)).toMatchObject({ kind: "events", text: MOVE.say });
  });

  it("revise or a failed action goes to the PM with the ledger, so nothing is redone blindly", async () => {
    const revise = setup({ decide: async () => ({ decision: "revise", reason: "x", fix: "Keep the guests' copy" }) });
    const a = revise.desk.fileIssue(revise.call.id, "Move my trip");
    await settle();
    expect(revise.executed).toEqual([]);
    expect(revise.pm.seen).toEqual([{ kind: "filed", issue: a.id }]);

    const failing = setup({ execute: async () => ({ ok: false, error: "404 event not found" }) });
    const b = failing.desk.fileIssue(failing.call.id, "Move my trip");
    await settle();
    expect(failing.desk.repo.ledger(b.id)).toMatchObject([{ ok: false }]);
    expect(failing.pm.seen).toEqual([{ kind: "filed", issue: b.id }]);
    expect(failing.desk.repo.issue(b.id)!.thread.map((t) => t.text).join("\n")).toContain("404 event not found");
  });

  it("without a way to run app actions, a change goes to the PM as before", async () => {
    const pm = new PM();
    const d = new Desk({ root: mkdtempSync(join(tmpdir(), "fastchange-")), host: new Host(), planner: pm, fastPath: async () => MOVE, fastPathMs: 200 });
    const c = d.startCall({ callSid: "CA2", phone: EVAN, channel: "voice" }).call;
    const issue = d.fileIssue(c.id, "Move my trip");
    await settle();
    expect(pm.seen).toEqual([{ kind: "filed", issue: issue.id }]);
    expect(d.repo.inbox(c.id, 0)).toEqual([]);
  });

  it("the sweeper leaves a fast change alone while it runs (in production it reopened one mid-change, and finishing it crashed the agent)", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { desk, call, pm } = setup({ decide: async () => (await slow, { decision: "do", reason: "asked" }) });
    const issue = desk.fileIssue(call.id, "Add the test event");
    await settle(30);
    desk.sweep(new Date(Date.now() + 2 * 60_000));
    expect(desk.repo.issue(issue.id)!.status).toBe("executing");
    release();
    await settle();
    expect(desk.repo.issue(issue.id)!.status).toBe("done");
    expect(pm.seen).toEqual([]);
  });

  it("if the issue moves on while a change runs (closed, reopened), finishing never throws out of the desk", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { desk, call } = setup({ decide: async () => (await slow, { decision: "do", reason: "asked" }) });
    const errors: unknown[] = [];
    const onRejection = (e: unknown) => errors.push(e);
    process.on("unhandledRejection", onRejection);
    const issue = desk.fileIssue(call.id, "Add the test event");
    await settle(30);
    desk.close(issue.id, "wont_do", { note: "caller said never mind" }); // still weighing: nothing changed yet
    release();
    await settle();
    process.off("unhandledRejection", onRejection);
    expect(errors).toEqual([]);
    expect(desk.repo.ledger(issue.id)).toEqual([]); // closed before anything ran: nothing runs
  });

  it("never mind while a fast change runs: it's marked cancelled, and what it did is undone, like a worker's change", async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const { desk, call, pm } = setup({ execute: async () => (await slow, { ok: true, data: { id: "atl1" } }) });
    const issue = desk.fileIssue(call.id, "Move my trip");
    await settle(30);
    expect(desk.close(issue.id, "wont_do", { note: "never mind" }).ok).toBe(false); // mid-change: can't just close
    release();
    await settle();
    const undo = desk.repo.issues((i) => i.links.reverts === issue.id)[0];
    expect(undo?.request).toContain("Undo");
    expect(pm.seen).toEqual([]);
  });
});
