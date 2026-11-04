import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
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

/** A PM that assigns what's filed and merges each PR as info, like the real one usually does. */
class PM implements Planner {
  async handle(ts: Trigger[], d: Desk): Promise<void> {
    for (const t of ts) {
      if (t.kind === "filed") d.assign(t.issue, "work", "Do it", []);
      if (t.kind === "pr") d.merge(t.issue, "info", d.repo.issue(t.issue)!.prs.at(-1)!.body);
    }
  }
}

const settle = async (ms = 60) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};
const EVAN = "+14155550190";

function setup(o: { send?: (n: Notice) => Promise<boolean> } = {}) {
  const host = new Host();
  const sent: Notice[] = [];
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "notify-")),
    host,
    planner: new PM(),
    notify: o.send ?? (async (n) => (sent.push(n), true)),
    notifyDelayMs: 20,
    notifyWaitMs: 400,
  });
  return { host, desk, sent };
}

describe("after hang-up, no note is written in code (the PM writes the rare one; see coms.test.ts)", () => {
  it("calling back before anything goes out: the new call carries the result", async () => {
    const { host, desk, sent } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const a = desk.fileIssue(call.id, "Check email");
    await settle(20);
    desk.endCall(call.id);
    const next = desk.startCall({ callSid: "CA2", phone: EVAN, channel: "voice" });
    host.last(a.id).finish("Nothing new.");
    await settle(150);
    expect(sent).toEqual([]);
    expect(desk.repo.inbox(next.call.id, 0).some((m) => m.text.includes("Nothing new"))).toBe(true);
  });

  it("a result that lands after the call ended isn't sent by code; the next call still carries it", async () => {
    const { host, desk, sent } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const a = desk.fileIssue(call.id, "Find a dentist");
    await settle(20);
    desk.endCall(call.id);
    host.last(a.id).finish("Rockridge Kids Dental.");
    await settle(150);
    expect(sent).toEqual([]);
    expect(desk.startCall({ callSid: "CA2", phone: EVAN, channel: "voice" }).pending).toBe(1);
  });
});

describe("texting the caller mid-call", () => {
  it("a worker can send the person who asked a text or email; it's recorded like any notice", async () => {
    const sent: Notice[] = [];
    const { desk, host } = setup({ send: async (n) => (sent.push(n), true) });
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Text me the link when you're done");
    await settle(20);
    const r = await desk.messageCaller(issue.id, "Here's the link: https://example.com/gift", "imessage");
    expect(r.ok).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ phone: EVAN, channel: "imessage", text: "Here's the link: https://example.com/gift" })]);
    expect(desk.repo.notifications(EVAN)).toMatchObject([{ channel: "imessage", issues: [issue.id] }]);
    void host;
  });

  it("without a way to send, it says so", async () => {
    const d = new Desk({ root: mkdtempSync(join(tmpdir(), "notify-")), host: new Host(), planner: new PM() });
    const { call } = d.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const issue = d.fileIssue(call.id, "Text me");
    expect((await d.messageCaller(issue.id, "hi")).ok).toBe(false);
  });

  it("desk workers don't get the old messaging tools; they use send_to_caller", async () => {
    const { desk, host } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "Find a gift");
    await settle(20);
    const role = (host.runs.at(-1) as unknown as { role?: { visible?: (t: { spec: { name: string } }) => boolean } }).role;
    expect(role?.visible?.({ spec: { name: "send_message" } })).toBe(false);
    expect(role?.visible?.({ spec: { name: "send_to_caller" } })).toBe(true);
  });

  it("nor the old approval tools: a yes is asked on the desk (confirm, ownerApproval), never by a side text", async () => {
    const { desk, host } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    desk.fileIssue(call.id, "Email Anthony that I want the $5M coverage");
    await settle(20);
    const role = (host.runs.at(-1) as unknown as { role?: { visible?: (t: { spec: { name: string } }) => boolean } }).role;
    expect(role?.visible?.({ spec: { name: "ask_owner" } })).toBe(false);
    expect(role?.visible?.({ spec: { name: "approval_settle" } })).toBe(false);
  });
});

describe("results never wait on another open conversation", () => {
  it("a call's results go into the person's open text conversation instead of waiting for it to end", async () => {
    const sent: Notice[] = [];
    const { desk, host } = setup({ send: async (n) => (sent.push(n), true) });
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Find a dentist");
    await settle(20);
    desk.endCall(call.id);
    const text = desk.startCall({ callSid: "imessage:m1", phone: EVAN, channel: "imessage" }).call;
    host.last(issue.id).finish("Rockridge has openings.");
    await settle(150);
    expect(desk.repo.inbox(text.id, 0).map((m) => m.text).join(" ")).toContain("Rockridge has openings.");
    expect(desk.repo.undelivered(call.id)).toEqual([]);
    expect(sent).toEqual([]);
  });
});
