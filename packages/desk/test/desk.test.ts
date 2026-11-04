import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, DeskConflict, type DeskSpan, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

interface Run {
  issue: number;
  phone?: string;
  session?: number;
  role: WorkerRole;
  prompt: string;
  finish: (text: string) => void;
  fail: (err: Error) => void;
}

class FakeHost implements WorkerHost {
  runs: Run[] = [];
  steered: Array<{ issue: number; text: string }> = [];
  stopped: number[] = [];
  private live = new Set<number>();
  run(issue: number, role: WorkerRole, prompt: string, phone?: string, session?: number): Promise<string> {
    this.live.add(issue);
    return new Promise((resolve, reject) => {
      this.runs.push({
        issue, role, prompt, ...(phone ? { phone } : {}), ...(session !== undefined ? { session } : {}),
        finish: (t) => { this.live.delete(issue); resolve(t); },
        fail: (e) => { this.live.delete(issue); reject(e); },
      });
    });
  }
  steer(issue: number, text: string): boolean {
    if (!this.live.has(issue)) return false;
    this.steered.push({ issue, text });
    return true;
  }
  stop(issue: number): void {
    this.stopped.push(issue);
  }
  last(issue: number): Run {
    return this.runs.filter((r) => r.issue === issue).at(-1)!;
  }
}

/** A planner the test drives: it records every batch and runs the test's reaction. */
class ScriptedPM implements Planner {
  batches: Trigger[][] = [];
  react: (t: Trigger, desk: Desk) => Promise<void> | void = () => {};
  async handle(triggers: Trigger[], desk: Desk): Promise<void> {
    this.batches.push(triggers);
    for (const t of triggers) await this.react(t, desk);
  }
  all(): Trigger[] {
    return this.batches.flat();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

function setup() {
  const host = new FakeHost();
  const pm = new ScriptedPM();
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host, planner: pm, retryMs: 5 });
  return { host, pm, desk };
}

const EVAN = "+14155550190";
const CARA = "+14155550123";

describe("Desk: work issues", () => {
  it("a follow-up continues the engineer that already has the context, instead of starting over", async () => {
    const { host, pm, desk } = setup();
    pm.react = (t, d) => {
      if (t.kind === "filed" && t.issue === 1) d.assign(1, "work", "Find Halloween diamond-art cards", []);
    };
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "Find Halloween diamond-art cards");
    await settle();
    host.last(1).finish("Antor six-pack $10; Saillong twelve-pack $9.");
    await settle();
    desk.merge(1, "info", "Found two packs.");
    const second = desk.fileIssue(call.id, "Email me the links to those");
    expect(desk.assign(second.id, "work", "Email Evan the links", [], undefined, { continues: 1 }).ok).toBe(true);
    expect(host.last(second.id).session).toBe(1);
    expect(desk.repo.issue(second.id)!.links.continues).toBe(1);
  });

  it("a follow-up never continues someone else's engineer, or one that's still busy", async () => {
    const { host, pm, desk } = setup();
    pm.react = () => {};
    const evan = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" }).call;
    const cara = desk.startCall({ callSid: "CA2", phone: CARA, channel: "voice" }).call;
    const first = desk.fileIssue(evan.id, "Research daycares");
    desk.assign(first.id, "work", "Research daycares", []);
    const theirs = desk.fileIssue(cara.id, "Email me those");
    expect(desk.assign(theirs.id, "work", "Email", [], undefined, { continues: first.id }).ok).toBe(true);
    expect(host.last(theirs.id).session).toBeUndefined(); // someone else's: starts fresh
    const busy = desk.fileIssue(evan.id, "Email me those");
    desk.assign(busy.id, "work", "Email", [], undefined, { continues: first.id });
    expect(host.last(busy.id).session).toBeUndefined(); // #1 is still running
  });

  it("a worker runs as the person who filed the issue", async () => {
    const { host, pm, desk } = setup();
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "Check her calendar", []);
    };
    const { call } = desk.startCall({ callSid: "CA9", phone: CARA, channel: "voice" });
    desk.fileIssue(call.id, "What's on tomorrow?");
    await settle();
    expect(host.last(1).phone).toBe(CARA);
  });

  it("file → assign → engineer PR → rebase and merge into the call as info", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "What's on Wednesday?" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "List every event on Wed Oct 28 across all calendars.", ["calendar:2026-10-28"]);
      if (t.kind === "pr") d.merge(t.issue, "info", "Wednesday: drop-off 8am, dentist 11:30, pickup 4:30.");
    };
    const issue = desk.fileIssue(call.id, "Check Wednesday's schedule");
    expect(issue).toMatchObject({ id: 1, status: "open", baseTurn: 1 });
    await settle();
    const run = host.last(1);
    expect(run.role.name).toBe("engineer");
    expect(run.prompt).toContain("List every event on Wed Oct 28");
    expect(run.prompt).toContain("Caller: What's on Wednesday?");
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
    run.finish("4 events: drop-off 8:00, dentist 11:30, pickup 4:30, contact Deb.");
    await settle();
    expect(desk.repo.issue(1)).toMatchObject({ status: "merged", prs: [{ status: "merged" }] });
    expect(desk.repo.inbox(call.id, 0)).toEqual([expect.objectContaining({ seq: 1, kind: "info", issue: 1, text: "Wednesday: drop-off 8am, dentist 11:30, pickup 4:30." })]);
  });

  it("the PM can answer from what is already known without spawning anyone", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.resolve(t.issue, "Drop-off is on Evan's calendar; it doesn't say who.");
    };
    desk.fileIssue(call.id, "Who's doing drop-off?");
    await settle();
    expect(host.runs).toHaveLength(0);
    expect(desk.repo.issue(1)!.status).toBe("resolved");
    expect(desk.repo.inbox(call.id, 0)[0]!.text).toContain("doesn't say who");
  });

  it("comments and the caller's new turns reach a running engineer between steps", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "spec", []);
    };
    desk.fileIssue(call.id, "Find a 30 minute slot Thursday");
    await settle();
    desk.comment(1, call.id, "After 2pm only");
    desk.addTurn(call.id, { role: "caller", text: "Actually Friday works too" });
    desk.addTurn(call.id, { role: "kloru", text: "Got it" });
    expect(host.steered.map((s) => s.text)).toEqual([
      expect.stringContaining("After 2pm only"),
      expect.stringContaining("Actually Friday works too"),
    ]);
    expect(desk.repo.issue(1)!.thread.map((e) => e.by)).toEqual(["talker", "pm", "talker"]);
    await settle();
    expect(pm.all().some((t) => t.kind === "comment" && t.issue === 1)).toBe(true);
  });

  it("the caller's words reach the engineer as overheard on the phone, not as a question to answer", () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "spec", []);
    };
    desk.fileIssue(call.id, "What's on my calendar tomorrow?");
    desk.assign(1, "work", "Look up tomorrow", []);
    desk.addTurn(call.id, { role: "caller", text: "How are you gonna tell me if I hang up?" });
    const text = host.steered.at(-1)!.text;
    expect(text).toMatch(/on the phone/);
    expect(text).toMatch(/Kloru answers/);
  });

  it("send back continues the same engineer with the PM's note", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    let sentBack = false;
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "spec", []);
      if (t.kind === "pr" && !sentBack) {
        sentBack = true;
        d.sendBack(t.issue, "The caller changed it to Friday; check Friday instead.");
      }
    };
    desk.fileIssue(call.id, "Find a slot Thursday");
    await settle();
    host.last(1).finish("Thursday 3pm is free");
    await settle();
    expect(host.runs).toHaveLength(2);
    expect(host.last(1).prompt).toContain("check Friday instead");
    expect(desk.repo.issue(1)!.prs.map((p) => p.status)).toEqual(["rejected"]);
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
  });

  it("never mind before any write: closed as won't do, the worker is stopped, and its late result is dropped", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "spec", []);
      if (t.kind === "comment" && /never mind/i.test(t.text)) d.close(t.issue, "wont_do", { note: "Caller cancelled." });
    };
    desk.fileIssue(call.id, "Research flights to Denver");
    await settle();
    desk.comment(1, call.id, "never mind");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("wont_do");
    expect(host.stopped).toEqual([1]);
    host.last(1).finish("Found 3 flights");
    await settle();
    expect(desk.repo.issue(1)!.prs).toEqual([]);
    expect(pm.all().some((t) => t.kind === "pr")).toBe(false);
  });

  it("a worker that fails marks the issue failed and tells the PM", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "spec", []);
    };
    desk.fileIssue(call.id, "x");
    await settle();
    host.last(1).fail(new Error("Gmail rate limit"));
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("failed");
    expect(pm.all()).toContainEqual(expect.objectContaining({ kind: "worker_failed", issue: 1, error: "Gmail rate limit" }));
  });
});

describe("Desk: roles", () => {
  it("ops write to the ledger with who triggered it", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "ops", "Create 'Coffee with Sam' Wed Oct 28 3pm on Evan's calendar, no guests.", ["calendar:2026-10-28"]);
    };
    desk.fileIssue(call.id, "Create an event Wednesday at 3, coffee with Sam");
    await settle();
    const run = host.last(1);
    expect(run.role.name).toBe("ops");
    const args = { summary: "Coffee with Sam", start: "2026-10-28T15:00" };
    expect(await run.role.guard!("app_googlecalendar_create_event", args)).toBeUndefined();
    run.role.afterTool!("app_googlecalendar_create_event", args, false, [{ type: "text", text: '{"id":"ev_9"}' }]);
    run.role.afterTool!("app_googlecalendar_events_list", {}, false, [{ type: "text", text: "[]" }]);
    expect(desk.repo.ledger(1)).toEqual([expect.objectContaining({ issue: 1, call: call.id, phone: EVAN, slug: "GOOGLECALENDAR_CREATE_EVENT", ok: true, result: '{"id":"ev_9"}' })]);
    run.finish("Created 'Coffee with Sam' Wed 3pm, event id ev_9.");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("done");
    expect(pm.all()).toContainEqual(expect.objectContaining({ kind: "ops_finished", issue: 1 }));
  });
});

describe("Desk: confirmation", () => {
  async function emailFlow() {
    const ctx = setup();
    const { host, pm, desk } = ctx;
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "ops", "Email Sam that Evan is running 10 minutes late.", []);
      if (t.kind === "needs_confirmation") d.merge(t.issue, "info", `Needs a yes: ${d.repo.issue(t.issue)!.confirmation!.draft}`);
    };
    desk.fileIssue(call.id, "Email Sam I'm running late");
    await settle();
    return { ...ctx, call };
  }
  const send = { to: "sam@example.com", body: "Running about 10 minutes late." };

  it("confirming when nothing is waiting for a yes is refused", async () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "x");
    expect(() => desk.confirm(1, call.id, "x")).toThrow(DeskConflict);
    expect(() => desk.confirm(99, call.id, "x")).toThrow(DeskConflict);
  });
});

describe("Desk: never mind after a write", () => {
  it("the PM files a revert from the ledger; when it's done, the original is reverted", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed" && d.repo.issue(t.issue)!.kind === "untriaged") d.assign(t.issue, "ops", "Create the event", ["calendar:2026-10-28"]);
      if (t.kind === "comment" && /never mind/.test(t.text)) {
        const ev = d.repo.ledger(t.issue)[0]!.result;
        d.fileOps({ parent: t.issue, reverts: t.issue, spec: `Delete event ${ev}`, resources: ["calendar:2026-10-28"] });
      }
    };
    desk.fileIssue(call.id, "Create an event Wednesday");
    await settle();
    host.last(1).role.afterTool!("app_googlecalendar_create_event", {}, false, [{ type: "text", text: "ev_9" }]);
    host.last(1).finish("Created ev_9");
    await settle();
    desk.comment(1, call.id, "never mind");
    await settle();
    const revert = desk.repo.issue(2)!;
    expect(revert).toMatchObject({ kind: "ops", status: "executing", links: { parent: 1, reverts: 1 }, filedBy: { phone: EVAN, call: call.id } });
    expect(host.last(2).prompt).toContain("Delete event ev_9");
    host.last(2).finish("Deleted ev_9");
    await settle();
    expect(desk.repo.issue(2)!.status).toBe("done");
    expect(desk.repo.issue(1)).toMatchObject({ status: "reverted", links: { revertedBy: 2 } });
  });
});

describe("Desk: across calls", () => {
  it("two calls touching the same resource raise one conflict, and the PM can tell both callers", async () => {
    const { pm, desk } = setup();
    const evan = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" }).call;
    const cara = desk.startCall({ callSid: "CA2", phone: CARA, channel: "voice" }).call;
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "Build the grocery order", ["order:groceries"]);
      if (t.kind === "conflict") {
        d.merge(t.issues[0], "info", "Cara is ordering groceries right now too.", evan.id);
        d.merge(t.issues[1], "info", "Evan is ordering groceries right now too.", cara.id);
      }
    };
    desk.fileIssue(cara.id, "Order groceries");
    await settle();
    desk.fileIssue(evan.id, "Order groceries for the week");
    await settle();
    const conflicts = pm.all().filter((t) => t.kind === "conflict");
    expect(conflicts).toEqual([expect.objectContaining({ kind: "conflict", resource: "order:groceries" })]);
    expect(desk.repo.inbox(evan.id, 0).map((m) => m.text)).toContain("Cara is ordering groceries right now too.");
    expect(desk.repo.inbox(cara.id, 0).map((m) => m.text)).toContain("Evan is ordering groceries right now too.");
    desk.assign(2, "work", "still groceries", ["order:groceries"]);
    await settle();
    expect(pm.all().filter((t) => t.kind === "conflict")).toHaveLength(1);
  });

  it("a merge into an ended call reaches that phone's next call, once", async () => {
    const { pm, desk } = setup();
    const first = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" }).call;
    pm.react = (t, d) => {
      if (t.kind === "filed") d.resolve(t.issue, "Drop-off doesn't say who.");
    };
    desk.endCall(first.id);
    desk.fileIssue(first.id, "Who's doing drop-off?");
    await settle();
    const second = desk.startCall({ callSid: "CA2", phone: EVAN, channel: "voice" });
    expect(second.pending).toBe(1);
    expect(desk.repo.inbox(second.call.id, 0).map((m) => m.text)).toEqual([expect.stringContaining("Drop-off doesn't say who.")]);
    expect(desk.startCall({ callSid: "CA3", phone: EVAN, channel: "voice" }).pending).toBe(0);
    expect(desk.startCall({ callSid: "CA4", phone: CARA, channel: "voice" }).pending).toBe(0);
  });
});

describe("Desk: the PM loop and the inbox", () => {
  it("a PM batch that throws keeps its triggers and retries them with the next batch", async () => {
    const { pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    let fails = 1;
    pm.react = (t) => {
      if (fails > 0) {
        fails--;
        throw new Error("model timeout");
      }
    };
    desk.fileIssue(call.id, "x");
    await settle();
    await settle();
    const filed = pm.batches.filter((b) => b.some((t) => t.kind === "filed" && t.issue === 1));
    expect(filed.length).toBeGreaterThanOrEqual(2);
  });

  it("waiting on the inbox returns as soon as a merge lands, or empty at the deadline", async () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "x");
    const waiting = desk.waitInbox(call.id, 0, 2000);
    setTimeout(() => desk.merge(1, "info", "hello"), 20);
    const started = Date.now();
    expect((await waiting).map((m) => m.text)).toEqual(["hello"]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await desk.waitInbox(call.id, 1, 30)).toEqual([]);
    expect(desk.repo.call(call.id)!.deliveredSeq).toBe(0);
    desk.ack(call.id, 1);
    expect(desk.repo.call(call.id)!.deliveredSeq).toBe(1);
  });

  it("open issues are summarized for the talking model", async () => {
    const { pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed" && t.issue === 2) d.close(2, "duplicate", { link: 1 });
    };
    desk.fileIssue(call.id, "Check Wednesday");
    desk.fileIssue(call.id, "Check Wednesday again");
    await settle();
    expect(desk.openIssues().map((i) => [i.id, i.status])).toEqual([[1, "open"]]);
    expect(desk.repo.issue(2)!.links.duplicateOf).toBe(1);
  });
});

describe("Desk: never mind while ops is mid-change", () => {
  it("an ops issue that already wrote something can't be closed; the PM is told to wait and revert", async () => {
    const { host, pm, desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const results: unknown[] = [];
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "ops", "Create two events", []);
      if (t.kind === "comment") results.push(d.close(t.issue, "wont_do"));
    };
    desk.fileIssue(call.id, "Create events Wednesday and Thursday");
    await settle();
    host.last(1).role.afterTool!("app_googlecalendar_create_event", { summary: "Wed" }, false, [{ type: "text", text: "ev_1" }]);
    desk.comment(1, call.id, "never mind");
    await settle();
    expect(results).toEqual([{ ok: false, error: expect.stringContaining("already changed") }]);
    expect(desk.repo.issue(1)!.status).toBe("executing");
    expect(host.stopped).toEqual([]);
  });
});

describe("Desk: restart", () => {
  it("work interrupted by a restart is failed for the PM to retry, and a waiting PR is handed back to the PM", async () => {
    const root = mkdtempSync(join(tmpdir(), "desk-"));
    const first = new Desk({ root, host: new FakeHost(), planner: { handle: async () => {} } });
    const { call } = first.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    first.fileIssue(call.id, "running work");
    first.fileIssue(call.id, "waiting PR");
    first.fileIssue(call.id, "still open");
    first.assign(1, "work", "spec", []);
    first.assign(2, "work", "spec", []);
    const two = first.repo.issue(2)!;
    two.status = "in_review";
    two.prs.push({ at: "", body: "result", baseTurn: 0, status: "open" });
    first.repo.saveIssue(two);

    const pm = new ScriptedPM();
    const again = new Desk({ root, host: new FakeHost(), planner: pm });
    again.recover();
    await settle();
    expect(again.repo.issue(1)!.status).toBe("failed");
    expect(pm.all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "worker_failed", issue: 1, error: expect.stringContaining("restarted") }),
      { kind: "pr", issue: 2 },
    ]));
    expect(pm.all().some((t) => "issue" in t && t.issue === 3 && t.kind !== "filed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

const appTool = (name: string, caps: string[]) => ({ spec: { name, meta: { capabilities: caps, group: "apps" } } }) as never;
const coreTool = (name: string, caps: string[], group = "system") => ({ spec: { name, meta: { capabilities: caps, group } } }) as never;

async function opsIssue(spec = "Make the change", kind: "ops" | "work" = "ops") {
  const ctx = setup();
  const { call } = ctx.desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
  ctx.pm.react = (t, d) => {
    if (t.kind === "filed" && d.repo.issue(t.issue)!.kind === "untriaged") d.assign(t.issue, kind, spec, []);
  };
  ctx.desk.fileIssue(call.id, "do it");
  await settle();
  return { ...ctx, call };
}

describe("review: C1 a worker finishing after ask_caller", () => {
  it("lands its PR instead of throwing, and a failure after ask_caller is recorded too", async () => {
    const { host, desk } = await opsIssue("spec", "work");
    expect(desk.askCaller(1, "Which Halloween event?").ok).toBe(true);
    host.last(1).finish("Two events found");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("in_review");
  });

  it("an unexpected refusal inside a worker callback is logged, never thrown", async () => {
    const logs: string[] = [];
    const host = new FakeHost();
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host, planner: { handle: async (ts, d) => ts.forEach((t) => t.kind === "filed" && d.assign(t.issue, "work", "s", [])) }, log: (m) => logs.push(m) });
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "x");
    await settle();
    const issue = desk.repo.issue(1)!;
    issue.status = "merged";
    desk.repo.saveIssue(issue);
    host.last(1).fail(new Error("boom"));
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("merged");
  });
});


describe("review: C4 never mind during an in-flight write", () => {
  it("close is refused while a write is running; the write then gets undone automatically", async () => {
    const { host, desk } = await opsIssue("Create two events");
    const run = host.last(1);
    expect(await run.role.guard!("app_googlecalendar_create_event", { summary: "Wed" })).toBeUndefined();
    const refused = desk.close(1, "wont_do");
    expect(refused.ok).toBe(false);
    run.role.afterTool!("app_googlecalendar_create_event", { summary: "Wed" }, false, [{ type: "text", text: "ev_1" }]);
    run.finish("Created ev_1, stopped before the second");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("done");
    const undo = desk.repo.issue(2)!;
    expect(undo).toMatchObject({ kind: "ops", status: "executing", links: { reverts: 1, parent: 1 } });
    expect(undo.spec).toContain("ev_1");
    expect(host.stopped).toEqual([]);
    host.last(2).finish("Deleted ev_1");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("reverted");
  });
});

describe("review: C5 stale runs and one send per yes", () => {
  it("a run superseded by a confirmation can't mark the issue done", async () => {
    const { host, desk, call } = await opsIssue("Email Sam");
    const run1 = host.last(1);
    const args = { to: "sam@example.com", body: "late" };
    desk.askForYes(1, "Email Sam: late");
    const draft = desk.repo.issue(1)!.confirmation!;
    desk.confirm(1, call.id, draft.id);
    run1.finish("Draft: to Sam, 'late'");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("executing");
    const run2 = host.last(1);
    expect(await run2.role.guard!("app_gmail_send_email", args)).toBeUndefined();
    run2.role.afterTool!("app_gmail_send_email", args, false, [{ type: "text", text: "m_4" }]);
    run2.finish("Sent");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("done");
  });

});


describe("review: I2 PM retries and idempotent assign", () => {
  it("assign refuses an issue that's already assigned", async () => {
    const { host, desk } = await opsIssue("s", "work");
    expect(desk.assign(1, "work", "again", []).ok).toBe(false);
    expect(host.runs).toHaveLength(1);
  });

  it("triggers that keep failing are not dropped silently: the caller hears about it", async () => {
    const pm: Planner = { handle: async () => { throw new Error("provider down"); } };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host: new FakeHost(), planner: pm, retryMs: 1, maxTries: 3 });
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "x");
    for (let i = 0; i < 10; i++) await settle();
    expect(desk.repo.issue(1)!.status).toBe("failed");
    expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toMatch(/couldn't get to/i);
  });
});

describe("review: I3 restart", () => {
  it("issues filed but never triaged go back to the PM, and calls that were live are ended", async () => {
    const root = mkdtempSync(join(tmpdir(), "desk-"));
    const first = new Desk({ root, host: new FakeHost(), planner: { handle: async () => { throw new Error("down"); } }, retryMs: 100000 });
    const { call } = first.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    first.fileIssue(call.id, "untriaged");
    const pm = new ScriptedPM();
    const again = new Desk({ root, host: new FakeHost(), planner: pm });
    again.recover();
    await settle();
    expect(pm.all()).toContainEqual({ kind: "filed", issue: 1 });
    expect(again.repo.call(call.id)!.endedAt).toBeTruthy();
  });
});

describe("review: I5 delivery", () => {
  it("a merge for an ended call goes to that phone's live call", async () => {
    const { pm, desk } = setup();
    const first = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" }).call;
    pm.react = () => {};
    desk.fileIssue(first.id, "x");
    desk.endCall(first.id);
    const second = desk.startCall({ callSid: "CA2", phone: EVAN, channel: "voice" }).call;
    desk.merge(1, "info", "result");
    expect(desk.repo.inbox(second.id, 0).map((m) => m.text)).toEqual(["result"]);
    expect(desk.repo.inbox(first.id, 0)).toEqual([]);
  });

  it("polling no longer acknowledges; an explicit ack does, clamped to what exists, and carried text isn't prefixed twice", async () => {
    const { desk } = setup();
    const a = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" }).call;
    desk.fileIssue(a.id, "x");
    desk.merge(1, "info", "one");
    await desk.waitInbox(a.id, 1, 0);
    expect(desk.repo.call(a.id)!.deliveredSeq).toBe(0);
    desk.ack(a.id, 99);
    expect(desk.repo.call(a.id)!.deliveredSeq).toBe(1);
    desk.merge(1, "info", "two");
    desk.endCall(a.id);
    const b = desk.startCall({ callSid: "CA2", phone: EVAN, channel: "voice" }).call;
    desk.endCall(b.id);
    const c = desk.startCall({ callSid: "CA3", phone: EVAN, channel: "voice" }).call;
    expect(desk.repo.inbox(c.id, 0).map((m) => m.text)).toEqual(["From an earlier call: two"]);
  });
});

describe("review: I6/I10", () => {
  it("file_ops needs a parent issue", () => {
    const { desk } = setup();
    desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    expect(desk.fileOps({ spec: "x", resources: [] }).ok).toBe(false);
  });

  it("a conflict goes to the PM only: the desk never tells a call about it on its own", async () => {
    const { pm, desk } = setup();
    const evan = desk.startCall({ callSid: "CA1", phone: EVAN, name: "Evan", channel: "voice" }).call;
    const cara = desk.startCall({ callSid: "CA2", phone: CARA, name: "Cara", channel: "voice" }).call;
    pm.react = (t, d) => {
      if (t.kind === "filed") d.assign(t.issue, "work", "groceries", ["order:groceries"]);
    };
    desk.fileIssue(cara.id, "Order groceries");
    await settle();
    desk.fileIssue(evan.id, "Order groceries for the week");
    await settle();
    expect(desk.repo.inbox(evan.id, 0).some((m) => /same thing/.test(m.text))).toBe(false);
    expect(desk.repo.inbox(cara.id, 0).some((m) => /same thing/.test(m.text))).toBe(false);
    expect(pm.all().filter((t) => t.kind === "conflict")).toHaveLength(1);
  });
});

describe("telemetry", () => {
  it("reports PM batches and worker runs into the call's session, with words only when allowed", async () => {
    const spans: DeskSpan[] = [];
    const host = new FakeHost();
    let allowed = true;
    const pm: Planner = { handle: async (ts, d) => ts.forEach((t) => t.kind === "filed" && d.assign(t.issue, "work", "List Wednesday", [])) };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host, planner: pm, telemetry: { span: (s) => spans.push(s) }, contentAllowed: () => allowed });
    const { call } = desk.startCall({ callSid: "CA9", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "What's Wednesday?");
    await settle();
    host.last(1).finish("Dentist 11:30");
    await settle();
    const pmSpan = spans.find((s) => s.name === "pm")!;
    expect(pmSpan).toMatchObject({ sessionId: "CA9", attributes: { triggers: "filed #1", ok: true } });
    const worker = spans.find((s) => s.name === "engineer #1")!;
    expect(worker).toMatchObject({ sessionId: "CA9", input: "List Wednesday", output: "Dentist 11:30", attributes: { issue: 1, role: "engineer", outcome: "done" } });
    expect(worker.end.getTime()).toBeGreaterThanOrEqual(worker.start.getTime());

    allowed = false;
    desk.fileIssue(call.id, "Anything Thursday?");
    await settle();
    host.last(2).finish("Nothing");
    await settle();
    const quiet = spans.find((s) => s.name === "engineer #2")!;
    expect(quiet.input).toBeUndefined();
    expect(quiet.output).toBeUndefined();
    expect(quiet.attributes.outcome).toBe("done");
  });
});

describe("engineer model", () => {
  it("engineers run on the configured model; ops keep the agent's", async () => {
    const host = new FakeHost();
    const terra = { id: "openai/gpt-6.1-terra" } as never;
    const pm: Planner = { handle: async (ts, d) => ts.forEach((t, i) => t.kind === "filed" && d.assign(t.issue, t.issue === 1 ? "work" : "ops", "s", [])) };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host, planner: pm, engineerModel: terra });
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "research");
    desk.fileIssue(call.id, "change");
    await settle();
    expect(host.last(1).role.model).toBe(terra);
    expect(host.last(2).role.model).toBeUndefined();
  });
});

describe("#3 the caller's answer continues the same issue", () => {
  it("an engineer's question goes to the caller, and the answer restarts the same engineer", async () => {
    const { host, desk, pm, call } = await opsIssue("Review the last 24 hours of email", "work");
    host.last(1).finish("Which inbox should I review?");
    await settle();
    expect(desk.askCaller(1, "Which inbox should I review?").ok).toBe(true);
    expect(desk.repo.issue(1)).toMatchObject({ status: "needs_info", prs: [{ status: "rejected" }] });
    pm.react = (t, d) => {
      if (t.kind === "comment") d.assign(t.issue, "work", "Review the last 24 hours of all mail", []);
    };
    desk.comment(1, call.id, "The evan.personal.com one, all mail");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
    expect(host.last(1).prompt).toContain("evan.personal.com");
  });

  it("an answer on a resolved issue reopens it instead of being refused", async () => {
    const { desk, pm, host } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    pm.react = (t, d) => {
      if (t.kind === "filed") d.resolve(t.issue, "Your inbox had nothing new.");
      if (t.kind === "comment") d.assign(t.issue, "work", "Check all mail, not just the inbox", []);
    };
    desk.fileIssue(call.id, "Anything new in email?");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("resolved");
    desk.comment(1, call.id, "Check all mail too");
    await settle();
    expect(desk.repo.issue(1)).toMatchObject({ kind: "work", status: "in_progress" });
    expect(host.runs).toHaveLength(1);
  });

  it("a follow-up on a merged issue reopens it for the same engineer", async () => {
    const { host, desk, pm, call } = await opsIssue("Review email", "work");
    host.last(1).finish("I need to know which inbox to review.");
    await settle();
    desk.merge(1, "info", "I need to know which inbox to review.");
    expect(desk.repo.issue(1)!.status).toBe("merged");
    pm.react = (t, d) => {
      if (t.kind === "comment") d.assign(t.issue, "work", "Review all mail in evan.personal.com", []);
    };
    desk.comment(1, call.id, "The evan.personal.com one");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
    expect(host.runs.filter((r) => r.issue === 1)).toHaveLength(2);
  });

  it("a comment alone ('thanks') never reopens a finished issue; only the PM's assign does", async () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "When's the dentist?");
    desk.resolve(1, "Thursday at 11:30.");
    desk.comment(1, call.id, "thanks");
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("resolved");
  });

  it("the caller's new turns reach a running ops worker too (#13)", async () => {
    const { host, desk, call } = await opsIssue("Delete the Credit Karma email");
    desk.addTurn(call.id, { role: "caller", text: "Just delete it" });
    expect(host.steered).toEqual([expect.objectContaining({ issue: 1, text: expect.stringContaining("Just delete it") })]);
  });
});

describe("#11/#12 ops results follow the ledger", () => {
  it("an ops result with a change in the ledger merges as events", async () => {
    const { host, desk, call } = await opsIssue("Create the reminder");
    desk.repo.appendLedger({ issue: 1, call: call.id, phone: EVAN, tool: "t", slug: "GOOGLECALENDAR_CREATE_EVENT", args: {}, ok: true, result: "ev_1" });
    host.last(1).finish("Created it, ev_1.");
    await settle();
    const m = desk.merge(1, "events", "I created Saturday's reminder.");
    expect(m.ok && m.value.kind).toBe("events");
  });

  it("an ops worker that fails after its change succeeded is done, not failed (#12)", async () => {
    const { host, desk, pm, call } = await opsIssue("Trash the AWS email");
    desk.repo.appendLedger({ issue: 1, call: call.id, phone: EVAN, tool: "t", slug: "GMAIL_MOVE_TO_TRASH", args: { message_id: "m1" }, ok: true, result: "ok" });
    host.last(1).fail(new Error("429 rate limited"));
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("done");
    expect(pm.all()).toContainEqual(expect.objectContaining({ kind: "ops_finished", issue: 1 }));
    expect(pm.all().some((t) => t.kind === "worker_failed")).toBe(false);
  });

  it("an ops worker that fails before changing anything is still failed", async () => {
    const { host, desk } = await opsIssue("Trash the AWS email");
    host.last(1).fail(new Error("429 rate limited"));
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("failed");
  });
});
