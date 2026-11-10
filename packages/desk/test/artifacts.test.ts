import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { artifactTools } from "../src/artifacts.js";
import { Desk, type Notice, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Repo } from "../src/repo.js";

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

class PM implements Planner {
  async handle(ts: Trigger[], d: Desk): Promise<void> {
    for (const t of ts) {
      if (t.kind === "pr") d.merge(t.issue, "info", "I put the dentist comparison on a page; the link is in your email.");
      // Like the real PM: what the caller didn't get goes in one message.
      if (t.kind === "unheard") await d.tellCaller(t.call, t.unheard.join("\n"));
    }
  }
}

const settle = async (ms = 60) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};
const EZRA = "+14155550190";
const ctx = (key: string) => ({ conversationKey: key }) as never;

function setup() {
  const host = new Host();
  const sent: Notice[] = [];
  const root = mkdtempSync(join(tmpdir(), "artifacts-"));
  const desk = new Desk({ root, host, planner: new PM(), artifactBaseUrl: "https://kloru.com/a/", notify: async (n) => (sent.push(n), true), notifyDelayMs: 20, notifyWaitMs: 300 });
  const [publish] = artifactTools(desk);
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  const issue = desk.fileIssue(call.id, "Compare pediatric dentists near Maplewood");
  desk.assign(issue.id, "work", "Compare them", []);
  return { host, desk, publish: publish!, call, issue, sent, root };
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

describe("publishing an artifact", () => {
  it("a worker publishes a page from its own issue and gets a link to put in its result", async () => {
    const { desk, publish, issue, call } = setup();
    const out = await publish.spec.execute({ title: "Pediatric dentists near Maplewood", markdown: "| Name | Stars |\n|---|---|\n| Maplewood Kids | 4.9 |" }, ctx(`desk:issue:${issue.id}:engineer`));
    const url = /https:\/\/kloru\.com\/a\/([\w-]+)/.exec(text(out))![1]!;
    expect(url.length).toBeGreaterThanOrEqual(22);
    const a = desk.repo.artifact(url)!;
    expect(a).toMatchObject({ title: "Pediatric dentists near Maplewood", issue: issue.id, call: call.id, phone: EZRA });
    expect(desk.repo.issue(issue.id)!.thread.at(-1)!.text).toContain(`https://kloru.com/a/${url}`);
  });

  it("each page gets its own unguessable id", async () => {
    const { desk, publish, issue } = setup();
    for (let i = 0; i < 2; i++) await publish.spec.execute({ title: "Plan", markdown: "x" }, ctx(`desk:issue:${issue.id}:engineer`));
    const ids = desk.repo.artifacts().map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("only desk workers can publish, with a title and a page of sane size", async () => {
    const { publish, issue } = setup();
    expect((await publish.spec.execute({ title: "x", markdown: "y" }, ctx("owner:chat"))) as { isError?: boolean }).toMatchObject({ isError: true });
    expect((await publish.spec.execute({ title: " ", markdown: "y" }, ctx(`desk:issue:${issue.id}:engineer`))) as { isError?: boolean }).toMatchObject({ isError: true });
    expect((await publish.spec.execute({ title: "x", markdown: "y".repeat(300_000) }, ctx(`desk:issue:${issue.id}:engineer`))) as { isError?: boolean }).toMatchObject({ isError: true });
  });

  it("a page's link reaches the caller by email even when the result was spoken on the call", async () => {
    const { host, desk, publish, issue, call, sent } = setup();
    await publish.spec.execute({ title: "Pediatric dentists near Maplewood", markdown: "x" }, ctx(`desk:issue:${issue.id}:engineer`));
    host.last(issue.id).finish("Compared three; page published.");
    await settle(30);
    desk.repo.ack(call.id, desk.repo.inbox(call.id, 0).at(-1)!.seq); // spoken on the call
    desk.endCall(call.id);
    await settle(150);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Pediatric dentists near Maplewood: https:\/\/kloru\.com\/a\/[\w-]{22}/);
    desk.endCall(call.id);
    await settle(100);
    expect(sent).toHaveLength(1); // each page is emailed once
  });

  it("the website reads pages read-only, and never by anything but a well-formed id", async () => {
    const { publish, issue, root } = setup();
    const out = await publish.spec.execute({ title: "Plan", markdown: "x" }, ctx(`desk:issue:${issue.id}:engineer`));
    const id = /a\/([\w-]+)/.exec(text(out))![1]!;
    const ro = new Repo(root, undefined, { readOnly: true });
    expect(ro.artifact(id)?.title).toBe("Plan");
    expect(ro.artifact("../issues/1")).toBeUndefined();
    expect(ro.artifact("short")).toBeUndefined();
  });
});
