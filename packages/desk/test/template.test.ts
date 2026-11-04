/** The PM's issue template: every assigned issue says what done looks like, and everyone sees it. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { pmTools, snapshot } from "../src/pm.js";

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

const target = { goal: "Evan has the Acme summary in his inbox", doneWhen: "An email is sent to evan@work.example.com", deliverable: "email" as const };

function setup() {
  const host = new Host();
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "template-")), host, planner: new PM() });
  const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
  return { host, desk, call };
}

describe("the issue template", () => {
  it("an assigned issue keeps its goal, done-when and deliverable, and the worker reads them first", () => {
    const { host, desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Email me a summary of the Acme discussion");
    expect(desk.assign(issue.id, "work", "Cover the trust layer and the pitch", [], target).ok).toBe(true);
    expect(desk.repo.issue(issue.id)!.target).toEqual(target);
    const prompt = host.runs.at(-1)!.prompt;
    expect(prompt).toContain("Goal: Evan has the Acme summary in his inbox");
    expect(prompt).toContain("Done when: An email is sent to evan@work.example.com");
    expect(prompt.indexOf("Goal:")).toBeLessThan(prompt.indexOf("Spec:"));
  });

  it("the PM's snapshot shows done-when next to the result, so it can check one against the other", () => {
    const { desk, call } = setup();
    const issue = desk.fileIssue(call.id, "Email me a summary");
    desk.assign(issue.id, "work", "Summarize", [], target);
    expect(snapshot(desk, [{ kind: "pr", issue: issue.id }])).toContain("done when: An email is sent to evan@work.example.com");
  });

  it("the PM's assign and file_ops tools require the template", () => {
    const { desk } = setup();
    for (const name of ["assign", "file_ops"]) {
      const schema = pmTools(desk).find((t) => t.name === name)!.parameters as { required?: string[] };
      expect(schema.required).toEqual(expect.arrayContaining(["goal", "done_when", "deliverable"]));
    }
  });

  it("file_ops carries the template to the ops worker", () => {
    const { host, desk, call } = setup();
    const parent = desk.fileIssue(call.id, "Invite Cara");
    const r = desk.fileOps({ spec: "Add Cara to both events", resources: [], parent: parent.id, target: { goal: "Cara is invited", doneWhen: "Both events list Cara as a guest", deliverable: "change" } });
    expect(r.ok).toBe(true);
    expect(host.runs.at(-1)!.prompt).toContain("Done when: Both events list Cara as a guest");
  });
});

describe("several accounts", () => {
  it("a worker that can write hears which accounts there are and how to pick one", () => {
    const host = new Host();
    const line = "Connected accounts. Gmail: evan@gmail.com (account ca_1), evan@work.example.com (account ca_2).";
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "accounts-")), host, planner: new PM(), accounts: () => line });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    const issue = desk.fileIssue(call.id, "Email Acme from my work account");
    desk.assign(issue.id, "work", "Send it", [], target);
    expect(host.runs.at(-1)!.role.prompt).toContain(line);
  });
});
