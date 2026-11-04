/**
 * Before any change reaches the world, a decision model weighs it (decision-models skill): do it,
 * ask the caller first, or revise. Biased toward doing: not acting costs the caller too.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type ActionCheck, type ActionDecision, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

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
  async handle(_: Trigger[]): Promise<void> {}
}

const EVAN = "+14155550190";
const send = { recipient_email: "boss@work.example.com", subject: "Update", body: "Also, I'm interviewing at Acme." };

function setup(decide: (c: ActionCheck) => Promise<ActionDecision>) {
  const host = new Host();
  const checks: ActionCheck[] = [];
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "decide-")),
    host,
    planner: new PM(),
    guidelines: () => "Emails to me need no yes.",
    decideAction: (c) => (checks.push(c), decide(c)),
  });
  const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
  desk.addTurn(call.id, { role: "caller", text: "Send my boss the weekly update" });
  const issue = desk.fileIssue(call.id, "Send my boss the weekly update");
  desk.assign(issue.id, "work", "Email the update", [], { goal: "The boss has the update", doneWhen: "Email sent", deliverable: "email" });
  const role = host.runs.at(-1)!.role;
  return { desk, call, issue, role, checks };
}

describe("every change is weighed before it happens", () => {
  it("do: the action goes ahead, and the model saw the action, the request, the target, the call and the guidelines", async () => {
    const { role, checks } = setup(async () => ({ decision: "do", reason: "the caller asked" }));
    expect(await role.guard!("app_gmail_send_email", send)).toBeUndefined();
    const c = checks[0]!;
    expect(c.action).toBe("GMAIL_SEND_EMAIL");
    expect(c.args).toMatchObject({ recipient_email: "boss@work.example.com" });
    expect(c.request).toContain("weekly update");
    expect(c.target?.doneWhen).toBe("Email sent");
    expect(c.call).toContain("Send my boss the weekly update");
    expect(c.guidelines).toContain("Emails to me need no yes.");
  });

  it("ask: nothing happens yet, and the caller hears the one question", async () => {
    const { desk, call, issue, role } = setup(async () => ({ decision: "ask", reason: "a job search reaching his boss", ask: "Send your boss the update that mentions Acme?" }));
    const r = await role.guard!("app_gmail_send_email", send);
    expect(r?.block).toBe(true);
    expect(desk.repo.issue(issue.id)!.status).toBe("needs_confirmation");
    expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toContain("Send your boss the update that mentions Acme?");
  });

  it("revise: nothing happens, the worker hears what to change, and the caller isn't bothered", async () => {
    const { desk, call, issue, role } = setup(async () => ({ decision: "revise", reason: "job search", fix: "Leave out the line about Acme" }));
    const r = await role.guard!("app_gmail_send_email", send);
    expect(r).toMatchObject({ block: true, reason: expect.stringContaining("Leave out the line about Acme") });
    expect(desk.repo.issue(issue.id)!.status).toBe("in_progress");
    expect(desk.repo.inbox(call.id, 0)).toEqual([]);
  });

  it("reads are never weighed", async () => {
    const { role, checks } = setup(async () => ({ decision: "ask", reason: "x", ask: "x?" }));
    expect(await role.guard!("app_gmail_fetch_emails", { query: "from:boss" })).toBeUndefined();
    expect(checks).toEqual([]);
  });

  it("after the caller's yes, the action goes ahead without asking again", async () => {
    const { desk, call, issue, role, checks } = setup(async () => ({ decision: "ask", reason: "boss", ask: "Send it?" }));
    await role.guard!("app_gmail_send_email", send);
    desk.confirm(issue.id, call.id, desk.repo.issue(issue.id)!.confirmation!.id);
    checks.length = 0;
    expect(await role.guard!("app_gmail_send_email", send)).toBeUndefined();
    expect(checks).toEqual([]);
  });

  it("if the decision model fails, the worker's own judgment stands", async () => {
    const { role } = setup(async () => {
      throw new Error("model 503");
    });
    expect(await role.guard!("app_gmail_send_email", send)).toBeUndefined();
  });
});
