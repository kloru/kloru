import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { WorkerRole } from "@kloru/core";
import { afterEach, describe, expect, it } from "vitest";
import { Desk, type WorkerHost } from "../src/desk.js";
import { TechnicalPM, audiences, snapshot } from "../src/pm.js";

const regs: Array<ReturnType<typeof registerFauxProvider>> = [];
afterEach(() => {
  for (const r of regs.splice(0)) r.unregister();
});

class Host implements WorkerHost {
  prompts: string[] = [];
  run(_issue: number, _role: WorkerRole, prompt: string): Promise<string> {
    this.prompts.push(prompt);
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

const toolTurn = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
};

function setup() {
  const faux = registerFauxProvider();
  regs.push(faux);
  const host = new Host();
  const pm = new TechnicalPM({ model: faux.getModel(), streamFn: streamSimple as unknown as StreamFn, getApiKey: () => "k" });
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host, planner: pm, retryMs: 10 });
  return { faux, host, pm, desk };
}

describe("TechnicalPM", () => {
  it("turns a filed issue into an assignment through its tools, seeing the conversation", async () => {
    const { faux, host, desk } = setup();
    let promptSeen = "";
    faux.setResponses([
      (context) => {
        promptSeen = JSON.stringify(context);
        return toolTurn("assign", { issue: 1, kind: "work", goal: "Evan hears his Wednesday", done_when: "every event on Wed Oct 28 is listed", deliverable: "answer", spec: "List every event Wed Oct 28 across all calendars.", resources: ["calendar:2026-10-28"] });
      },
      fauxAssistantMessage("Assigned."),
    ]);
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "What's my Wednesday look like?" });
    desk.fileIssue(call.id, "Check Wednesday");
    await settle();
    expect(promptSeen).toContain("What's my Wednesday look like?");
    expect(promptSeen).toContain("filed");
    expect(desk.repo.issue(1)).toMatchObject({ kind: "work", status: "in_progress", resources: ["calendar:2026-10-28"] });
    expect(host.prompts[0]).toContain("List every event Wed Oct 28");
  });

  it("a refused action goes back to the model as a tool result, not an exception", async () => {
    const { faux, desk } = setup();
    let second = "";
    faux.setResponses([
      toolTurn("merge", { issue: 1, kind: "info", text: "hi", call: "no-such-call" }),
      (context) => {
        second = JSON.stringify(context.messages.at(-1));
        return fauxAssistantMessage("ok");
      },
    ]);
    const { call } = desk.startCall({ callSid: "CA1", phone: "+1", channel: "voice" });
    desk.fileIssue(call.id, "x");
    await settle();
    expect(second).toContain("Refused: no call no-such-call");
  });

  it("a failed model run keeps the triggers and retries them", async () => {
    const { faux, desk } = setup();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }),
      toolTurn("resolve", { issue: 1, text: "Already known: dentist at 11:30." }),
      fauxAssistantMessage("done"),
    ]);
    const { call } = desk.startCall({ callSid: "CA1", phone: "+1", channel: "voice" });
    desk.fileIssue(call.id, "When's the dentist?");
    await settle();
    await settle();
    expect(desk.repo.issue(1)!.status).toBe("resolved");
    expect(desk.repo.inbox(call.id, 0)[0]!.text).toContain("dentist at 11:30");
  });

  it("the snapshot says when a caller isn't the owner, and what the owner said they may see and do", () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: new Host(), planner: { handle: async () => {} }, ownerPhone: "+14155550190", nameOf: (p) => (p === "+14155550190" ? "Evan" : undefined), ownerWords: () => "About anyone who calls: they can schedule a meeting with me" });
    const stranger = desk.startCall({ callSid: "CA2", phone: "+14155550123", channel: "voice" }).call;
    desk.fileIssue(stranger.id, "What's Evan doing Friday?");
    const text = snapshot(desk, [{ kind: "filed", issue: 1 }]);
    expect(text).toContain("+14155550123 is not the family owner");
    expect(text).toContain("they can schedule a meeting with me");
    const own = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" }).call;
    desk.fileIssue(own.id, "What's on Friday?");
    expect(snapshot(desk, [{ kind: "filed", issue: 2 }])).not.toContain("not the family owner");
  });

  it("a batch for a caller who isn't the owner shows the PM only that caller's issues and calls", () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: new Host(), planner: { handle: async () => {} }, ownerPhone: "+14155550190" });
    const evan = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" }).call;
    desk.addTurn(evan.id, { role: "caller", text: "Email Dan about the Acme offer" });
    desk.fileIssue(evan.id, "Email Dan about the Acme offer");
    const pat = desk.startCall({ callSid: "CA9", phone: "+14155550123", channel: "voice" }).call;
    desk.fileIssue(pat.id, "Book 30 minutes with Evan");
    const groups = audiences(desk, [{ kind: "filed", issue: 1 }, { kind: "filed", issue: 2 }]);
    expect(groups.map((g) => g.only)).toEqual([undefined, "+14155550123"]);
    const forPat = snapshot(desk, groups[1]!.triggers, new Date(), { only: "+14155550123" });
    expect(forPat).toContain("Book 30 minutes with Evan");
    expect(forPat).not.toContain("Acme");
  });

  it("the snapshot lists open issues, the involved calls' turns since filing, and ledger entries", () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: new Host(), planner: { handle: async () => {} } });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "Create an event Wednesday at 3" });
    desk.fileIssue(call.id, "Create an event Wednesday at 3");
    desk.addTurn(call.id, { role: "caller", text: "Coffee with Sam" });
    desk.repo.appendLedger({ issue: 1, call: call.id, phone: "+14155550190", tool: "t", slug: "GOOGLECALENDAR_CREATE_EVENT", args: {}, ok: true, result: "ev_9" });
    const text = snapshot(desk, [{ kind: "comment", issue: 1, call: call.id, text: "title: Coffee with Sam" }]);
    expect(text).toContain("#1 untriaged/open");
    expect(text).toContain("Caller: Coffee with Sam");
    expect(text).toContain("GOOGLECALENDAR_CREATE_EVENT ok: ev_9");
    expect(text).toContain("comment on #1");
  });
});

describe("snapshot: recent results (#29)", () => {
  it("shows what this phone's recent closed issues found, with their ids, even from an earlier call", () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: new Host(), planner: { handle: async () => {} } });
    const first = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" }).call;
    desk.fileIssue(first.id, "Anything new in email?");
    desk.assign(1, "work", "Check new email", []);
    const issue = desk.repo.issue(1)!;
    issue.prs.push({ at: "", body: "Credit Karma email, 9:45 PM, message id 1a180d36555f7e3f", baseTurn: 0, status: "open" });
    issue.status = "in_review";
    desk.merge(1, "info", "One email from Credit Karma.");
    desk.endCall(first.id);
    const other = desk.startCall({ callSid: "CA9", phone: "+14155550123", channel: "voice" }).call;
    desk.fileIssue(other.id, "Someone else's lookup");
    desk.resolve(2, "Done.");
    const second = desk.startCall({ callSid: "CA2", phone: "+14155550190", channel: "voice" }).call;
    desk.fileIssue(second.id, "Delete that email");
    const text = snapshot(desk, [{ kind: "filed", issue: 3 }]);
    expect(text).toContain("#1 work/merged");
    expect(text).toContain("1a180d36555f7e3f");
    expect(text).not.toContain("Someone else's lookup");
  });
});

describe("snapshot: memory", () => {
  it("shows what memory knows about the callers involved, and leaves memory runs out", async () => {
    const { Memory } = await import("../src/memory.js");
    const root = mkdtempSync(join(tmpdir(), "pm-"));
    const memory = new Memory(join(root, "memory"), { owner: { name: "Evan Marshall", phones: ["+14155550190"] } });
    memory.init();
    memory.save("household/people/cara.md", "---\nid: cara\ntype: person\naliases: [my wife]\n---\n- Evan's wife\n");
    memory.commit("x");
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} }, memory });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "Check my wife's calendar" });
    desk.fileIssue(call.id, "Check my wife's calendar for Friday");
    const text = snapshot(desk, [{ kind: "filed", issue: 1 }]);
    expect(text).toContain("Cara (my wife)");
    desk.endCall(call.id);
    expect(snapshot(desk, [{ kind: "filed", issue: 1 }])).not.toContain("Update memory from call");
  });
});

describe("TechnicalPM: partial runs", () => {
  it("a run that fails after a successful action counts as handled, so nothing is done twice", async () => {
    const { faux, desk } = setup();
    faux.setResponses([
      toolTurn("resolve", { issue: 1, text: "Dentist at 11:30." }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream 500" }),
      fauxAssistantMessage("should not run"),
    ]);
    const { call } = desk.startCall({ callSid: "CA1", phone: "+1", channel: "voice" });
    desk.fileIssue(call.id, "When's the dentist?");
    await settle();
    await settle();
    expect(desk.repo.inbox(call.id, 0).map((m) => m.text)).toEqual(["Dentist at 11:30."]);
    expect(faux.getPendingResponseCount()).toBe(1);
  });
});

describe("PM voice", () => {
  it("merges are written as Kloru, in first person, never about a team", async () => {
    const { PM_RULES } = await import("../src/pm.js");
    expect(PM_RULES).toContain("first person");
    expect(PM_RULES).toMatch(/no mention of a team/i);
  });

  it("a PR's issue shows plainly when nothing was recorded, so a claim of 'sent' can be checked (#135)", async () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: new Host(), planner: { handle: async () => {} } });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    const issue = desk.fileIssue(call.id, "Send the email to Anthony");
    desk.assign(issue.id, "work", "Send it", []);
    const text = snapshot(desk, [{ kind: "pr", issue: issue.id }]);
    expect(text).toContain(`Ledger for #${issue.id}: nothing recorded (no send, no change)`);
  });

  it("an issue sent back again and again says how many times (#125)", async () => {
    const blocked: WorkerHost = { run: async () => "Blocked: needs approval.", steer: () => false, stop: () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: blocked, planner: { handle: async () => {} } });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    const issue = desk.fileIssue(call.id, "Email Anthony");
    desk.assign(issue.id, "work", "Send it", []);
    for (let n = 0; n < 3; n++) {
      await settle();
      expect(desk.sendBack(issue.id, "Try again").ok).toBe(true);
    }
    await settle();
    expect(snapshot(desk, [{ kind: "pr", issue: issue.id }])).toContain("sent back 3 times");
  });

  it("the PM sees which channel each conversation is on, so a text thread gets links", async () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-")), host: new Host(), planner: { handle: async () => {} } });
    const { call } = desk.startCall({ callSid: "imessage:1", phone: "+14155550190", channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "Look up flights" });
    const issue = desk.fileIssue(call.id, "Look up flights");
    expect(snapshot(desk, [{ kind: "filed", issue: issue.id }])).toMatch(new RegExp(`Call ${call.id} \\(\\+14155550190, by text, live\\)`));
  });
});
