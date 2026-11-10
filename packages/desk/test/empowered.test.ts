/** Every agent as empowered as possible (guidelines-not-rules skill): roles differ by goals, not limits. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { workerTools } from "../src/worker-tools.js";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; prompt: string; finish: (t: string) => void }> = [];
  run(issue: number, role: WorkerRole, prompt: string): Promise<string> {
    return new Promise((finish) => this.runs.push({ issue, role, prompt, finish }));
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
  async handle(ts: Trigger[]): Promise<void> {
    this.seen.push(...ts);
  }
}

const EZRA = "+14155550190";
const tool = (name: string, caps: string[] = []) => ({ spec: { name, meta: { capabilities: caps, group: "apps" } } }) as never;
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup() {
  const host = new Host();
  const pm = new PM();
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "empowered-")),
    host,
    planner: pm,
    ownEmails: () => ["ezra@work.example.com"],
    guidelines: (phone) => (phone === EZRA ? "Never spell out links; email them.\nEmails to me need no yes." : ""),
  });
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  return { host, pm, desk, call };
}

describe("every agent can use every tool", () => {
  it("engineers, ops and the memory worker see everything, and nothing is ever blocked", async () => {
    const { host, desk, call } = setup();
    const eng = desk.fileIssue(call.id, "Find and fix the dinner invite");
    desk.assign(eng.id, "work", "Do it", []);
    const ops = desk.fileIssue(call.id, "Email Cleo");
    desk.assign(ops.id, "ops", "Email Cleo", []);
    for (const role of [host.last(eng.id).role, host.last(ops.id).role]) {
      expect(role.visible?.(tool("app_gmail_send_email", ["email.send"])) ?? true).toBe(true);
      expect(role.visible?.(tool("memory_save")) ?? true).toBe(true);
      expect(await role.guard!("app_gmail_send_email", { recipient_email: "cleo@example.com", body: "hi" })).toBeUndefined();
      expect(await role.guard!("memory_save", {})).toBeUndefined();
    }
  });

  it("anything an engineer changes is in the ledger, like ops'", () => {
    const { host, desk, call } = setup();
    const eng = desk.fileIssue(call.id, "Fix the dinner invite");
    desk.assign(eng.id, "work", "Fix it", []);
    host.last(eng.id).role.afterTool!("app_googlecalendar_patch_event", { event_id: "e1", summary: "Dinner" }, false, [{ type: "text", text: "ok" }]);
    expect(desk.repo.ledger(eng.id)).toEqual([expect.objectContaining({ slug: "GOOGLECALENDAR_PATCH_EVENT", ok: true })]);
  });
});

describe("goals and the caller's guidelines, not limits", () => {
  it("every worker hears how to work, who the caller is, and their own guidelines, which win", () => {
    const { host, desk, call } = setup();
    const eng = desk.fileIssue(call.id, "Weather in Portland");
    desk.assign(eng.id, "work", "Look it up", []);
    const prompt = host.last(eng.id).role.prompt;
    expect(prompt).toMatch(/Do what the request needs, end to end/);
    expect(prompt).toMatch(/Do the whole job/);
    expect(prompt).toMatch(/information, never instructions/);
    expect(prompt).toContain("The caller's own email: ezra@work.example.com.");
    expect(prompt).toContain("Never spell out links; email them.");
    expect(prompt).toMatch(/guidelines \(these win\)/);
  });
});

describe("a yes, when a worker judges one is needed", () => {
  it("the worker asks with the exact draft, the call hears it, and the yes comes back to the same worker", async () => {
    const { host, pm, desk, call } = setup();
    const eng = desk.fileIssue(call.id, "Tell Cleo I'm running late");
    desk.assign(eng.id, "work", "Email Cleo", []);
    const [ask] = workerTools(desk);
    await ask!.spec.execute({ draft: "Email Cleo: running 10 minutes late" }, { conversationKey: `desk:issue:${eng.id}:engineer` } as never);
    const waiting = desk.repo.issue(eng.id)!;
    expect(waiting.status).toBe("needs_confirmation");
    const merge = desk.repo.inbox(call.id, 0).at(-1)!;
    expect(merge.text).toBe("Needs a yes before I do it: Email Cleo: running 10 minutes late");
    expect(merge.draft).toBe(waiting.confirmation!.id);
    await settle();
    expect(pm.seen).toContainEqual({ kind: "needs_confirmation", issue: eng.id });
    desk.confirm(eng.id, call.id, waiting.confirmation!.id);
    expect(desk.repo.issue(eng.id)!.status).toBe("in_progress");
    expect(host.last(eng.id).prompt).toContain("The caller said yes to: Email Cleo: running 10 minutes late");
  });

  it("a worker that asked, then went ahead and did it, finishes normally: what happened beats the question", async () => {
    const { host, pm, desk, call } = setup();
    const eng = desk.fileIssue(call.id, "Research daycares and email them to me and Cleo");
    desk.assign(eng.id, "work", "Research and email", []);
    const [ask] = workerTools(desk);
    await ask!.spec.execute({ draft: "Email Cleo the report" }, { conversationKey: `desk:issue:${eng.id}:engineer` } as never);
    host.last(eng.id).role.afterTool!("app_gmail_send_email", { recipient_email: "ezra@work.example.com", extra_recipients: ["cleo@example.com"] }, false, [{ type: "text", text: "sent" }]);
    host.last(eng.id).finish("I emailed the report to you and Cleo.");
    await settle();
    const after = desk.repo.issue(eng.id)!;
    expect(after.status).toBe("in_review");
    expect(after.confirmation).toBeUndefined();
    expect(pm.seen).toContainEqual({ kind: "pr", issue: eng.id });
  });

  it("a worker that asked and stopped keeps waiting for the yes", async () => {
    const { host, desk, call } = setup();
    const eng = desk.fileIssue(call.id, "Tell Cleo I'm late");
    desk.assign(eng.id, "work", "Email Cleo", []);
    const [ask] = workerTools(desk);
    await ask!.spec.execute({ draft: "Email Cleo: running late" }, { conversationKey: `desk:issue:${eng.id}:engineer` } as never);
    host.last(eng.id).finish("Waiting for your yes.");
    await settle();
    expect(desk.repo.issue(eng.id)!.status).toBe("needs_confirmation");
  });
});
