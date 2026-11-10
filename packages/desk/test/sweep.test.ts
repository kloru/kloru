import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; finish: (t: string) => void; fail: (e: Error) => void }> = [];
  run(issue: number, role: WorkerRole): Promise<string> {
    return new Promise((finish, fail) => this.runs.push({ issue, role, finish, fail }));
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
  last(issue: number) {
    return this.runs.filter((r) => r.issue === issue).at(-1)!;
  }
}

class PM implements Planner {
  seen: Trigger[] = [];
  react: (t: Trigger, d: Desk) => void = () => {};
  async handle(ts: Trigger[], d: Desk): Promise<void> {
    for (const t of ts) {
      this.seen.push(t);
      this.react(t, d);
    }
  }
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));
};
const later = (min: number) => new Date(Date.now() + min * 60_000);
const EZRA = "+14155550190";

function setup() {
  const host = new Host();
  const pm = new PM();
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "sweep-")), host, planner: pm, retryMs: 5 });
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  return { host, pm, desk, call };
}

describe("a parent closes when its follow-up finishes", () => {
  it("#43: the lookup's result went to ops, ops added the note, and the lookup closes too", async () => {
    const { host, pm, desk, call } = setup();
    const lookup = desk.fileIssue(call.id, "Find Saturday's reminder and add a trash pickup note");
    desk.assign(lookup.id, "work", "Find the reminder", []);
    host.last(lookup.id).finish("Found one reminder: evt_1");
    await settle();
    expect(desk.repo.issue(lookup.id)!.status).toBe("in_review");
    const ops = desk.fileOps({ parent: lookup.id, spec: "Add the note to evt_1", resources: [] });
    expect(ops.ok).toBe(true);
    host.last(ops.ok ? ops.value.id : 0).finish("Added the note.");
    await settle();
    const parent = desk.repo.issue(lookup.id)!;
    expect(parent.status).toBe("resolved");
    expect(parent.prs.every((p) => p.status !== "open")).toBe(true);
    expect(parent.thread.at(-1)!.text).toMatch(/Done in #\d+/);
    expect(pm.seen.some((t) => t.kind === "ops_finished")).toBe(true); // the PM still tells the caller
  });

  it("a parent with another follow-up still running stays open", async () => {
    const { host, desk, call } = setup();
    const parent = desk.fileIssue(call.id, "Delete two promotions");
    desk.assign(parent.id, "work", "Find them", []);
    host.last(parent.id).finish("Found two");
    await settle();
    const a = desk.fileOps({ parent: parent.id, spec: "Delete A", resources: [] });
    desk.fileOps({ parent: parent.id, spec: "Delete B", resources: [] });
    host.last(a.ok ? a.value.id : 0).finish("Deleted A.");
    await settle();
    expect(desk.repo.issue(parent.id)!.status).toBe("in_review");
  });
});

describe("the sweeper", () => {
  it("#24: a reopened issue whose follow-up already finished is closed on the next sweep", async () => {
    const { host, desk, call } = setup();
    const review = desk.fileIssue(call.id, "Review my email and delete promotions");
    desk.assign(review.id, "work", "Review", []);
    host.last(review.id).finish("Three promotions");
    await settle();
    const ops = desk.fileOps({ parent: review.id, spec: "Delete the three", resources: [] });
    // Production: the follow-up finished while the parent was reopened by the caller's yes.
    const parent = desk.repo.issue(review.id)!;
    parent.status = "open";
    desk.repo.saveIssue(parent);
    const child = desk.repo.issue(ops.ok ? ops.value.id : 0)!;
    child.status = "done";
    desk.repo.saveIssue(child);
    desk.sweep(later(5));
    expect(desk.repo.issue(review.id)!.status).toBe("resolved");
  });

  it("an issue waiting on the PM for minutes gets a nudge, and the PM's work clears it", async () => {
    const { host, pm, desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Find a dentist");
    desk.assign(issue.id, "work", "Find one", []);
    host.last(issue.id).finish("Maplewood Kids Dental");
    await settle();
    pm.seen = [];
    desk.sweep(later(1));
    await settle();
    expect(pm.seen).toEqual([]); // a minute is not stuck
    desk.sweep(later(5));
    await settle();
    expect(pm.seen).toEqual([expect.objectContaining({ kind: "stuck", issue: issue.id })]);
  });

  it("a worker that was lost (no run behind it) goes back to the PM, still open, so nudges continue", async () => {
    const { pm, desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Look something up");
    const lost = desk.repo.issue(issue.id)!;
    lost.kind = "work";
    lost.status = "in_progress"; // as after a crash that recovery missed
    desk.repo.saveIssue(lost);
    desk.sweep(later(5));
    await settle();
    expect(desk.repo.issue(issue.id)!.status).toBe("open");
    // The PM decides whether it's still worth doing; nothing is restarted behind its back.
    expect(pm.seen).toContainEqual(expect.objectContaining({ kind: "stuck", issue: issue.id, why: expect.stringContaining("no worker") }));
    expect(pm.seen.some((t) => t.kind === "worker_failed")).toBe(false);
  });

  it("a running worker is left alone until it has run far too long", async () => {
    const { pm, desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Research");
    desk.assign(issue.id, "work", "Research", []);
    await settle();
    pm.seen = [];
    desk.sweep(later(5));
    await settle();
    expect(desk.repo.issue(issue.id)!.status).toBe("in_progress");
    desk.sweep(later(45));
    await settle();
    expect(desk.repo.issue(issue.id)!.status).toBe("open");
  });

  it("a wait that outlived its call goes back to the PM, which decides if it still matters", async () => {
    const { desk, call, pm } = setup();
    const issue = desk.fileIssue(call.id, "Email the 811 link");
    await settle();
    const asked = desk.repo.issue(issue.id)!;
    asked.kind = "ops";
    asked.status = "needs_confirmation";
    desk.repo.saveIssue(asked);
    desk.endCall(call.id);
    await settle();
    pm.seen = [];
    desk.sweep(later(60));
    await settle();
    expect(pm.seen).toEqual([]); // an hour after the call: still a fair wait
    desk.sweep(later(Desk.WAITING_MS / 60_000 + 1));
    await settle();
    expect(pm.seen).toContainEqual(expect.objectContaining({ kind: "stuck", issue: issue.id }));
  });

  it("waiting on the caller during their call is not stuck", async () => {
    const { desk, call, pm } = setup();
    const issue = desk.fileIssue(call.id, "Email Sam");
    await settle();
    const asked = desk.repo.issue(issue.id)!;
    asked.kind = "work";
    asked.status = "needs_info";
    desk.repo.saveIssue(asked);
    pm.seen = [];
    desk.sweep(later(60));
    await settle();
    expect(pm.seen).toEqual([]);
  });

  it("after three nudges with no progress it gives up, and says so", async () => {
    const { desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Something the PM keeps ignoring");
    await settle();
    for (const m of [5, 10, 15]) {
      desk.sweep(later(m));
      await settle();
    }
    expect(desk.repo.issue(issue.id)!.status).toBe("open");
    desk.sweep(later(20));
    const gave = desk.repo.issue(issue.id)!;
    expect(gave.status).toBe("failed");
    expect(gave.thread.at(-1)!.text).toMatch(/gave up/i);
  });
});

describe("an ops worker lost after it changed something", () => {
  it("is finished from the ledger, not reopened to run again", async () => {
    const { host, desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Delete the promo");
    desk.assign(issue.id, "ops", "Delete it", []);
    await settle();
    desk.repo.appendLedger({ issue: issue.id, call: call.id, phone: EZRA, tool: "app_gmail_trash", slug: "GMAIL_MOVE_TO_TRASH", args: {}, ok: true, result: "trashed" });
    void host;
    desk.sweep(later(45));
    await settle();
    expect(desk.repo.issue(issue.id)!.status).toBe("done");
  });
});

describe("the PM decides what a stuck issue deserves", () => {
  it("an outdated stuck issue is closed as won't do: never restarted, nothing told to the caller", async () => {
    const { pm, desk, call } = setup();
    pm.react = (t, d) => {
      if (t.kind === "stuck") d.close(t.issue, "wont_do", { note: "Yesterday's news roundup; no longer useful" });
    };
    const issue = desk.fileIssue(call.id, "Rundown of yesterday's AI news");
    const lost = desk.repo.issue(issue.id)!;
    lost.kind = "work";
    lost.status = "in_progress";
    desk.repo.saveIssue(lost);
    desk.sweep(later(5));
    await settle();
    const closed = desk.repo.issue(issue.id)!;
    expect(closed.status).toBe("wont_do");
    expect(closed.thread.at(-1)!.text).toContain("no longer useful");
    expect(desk.repo.inbox(call.id, 0)).toEqual([]);
    desk.sweep(later(60));
    await settle();
    expect(pm.seen.filter((t) => t.kind === "stuck")).toHaveLength(1);
  });
});

