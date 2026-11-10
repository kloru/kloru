/**
 * A family member calls as herself. What the owner's policy says to ask about, the owner answers:
 * on his live call if he's on one, else by email and on his next call. Only his yes counts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, DeskConflict, type ActionCheck, type Notice, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { workerTools } from "../src/worker-tools.js";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; prompt: string; phone?: string }> = [];
  run(issue: number, role: WorkerRole, prompt: string, phone?: string): Promise<string> {
    this.runs.push({ issue, role, prompt, ...(phone ? { phone } : {}) });
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

const EZRA = "+14155550190";
const CLEO = "+14155550191";
const DAD = "+14155550192";
const MOVE = { toolName: "app_googlecalendar_patch_event", args: { event_id: "e1" }, summary: "move Ezra's 3 PM to 4 PM" };

function setup(o: { ezraOnCall?: boolean } = {}) {
  const host = new Host();
  const notices: Notice[] = [];
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "members-")),
    host,
    planner: new PM(),
    ownerPhone: EZRA,
    isMember: (p) => p === CLEO,
    nameOf: (p) => (p === CLEO ? "Cleo" : p === EZRA ? "Ezra" : undefined),
    notify: async (n) => (notices.push(n), true),
    fastPath: async () => ({ changes: [{ slug: "GOOGLECALENDAR_PATCH_EVENT", args: { event_id: "e1" } }], say: "Moved.", note: "" }),
    execute: async () => ({ ok: true }),
    fastPathMs: 200,
  });
  const ezraCall = o.ezraOnCall === false ? undefined : desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).call;
  const cleoCall = desk.startCall({ callSid: "CA2", phone: CLEO, channel: "voice" }).call;
  const issue = desk.fileIssue(cleoCall.id, "Move Ezra's 3 PM to 4");
  desk.assign(issue.id, "ops", "Move the event", []);
  const role = host.runs.at(-1)!.role;
  return { desk, host, cleoCall, ezraCall, issue, role, notices };
}

const settle = async (ms = 30) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

describe("a member's action that the owner's policy asks about", () => {
  it("Ezra is asked on his call, Cleo hears that he was asked, and nothing runs", async () => {
    const { desk, cleoCall, ezraCall, issue, role } = setup();
    const r = await role.ownerApproval!(MOVE);
    expect("block" in r && r.block).toBe(true);
    expect(desk.repo.issue(issue.id)).toMatchObject({ status: "needs_confirmation", confirmation: { by: EZRA } });
    const toEzra = desk.repo.inbox(ezraCall!.id, 0).at(-1)!;
    expect(toEzra.text).toContain("Cleo asked me to move Ezra's 3 PM to 4 PM");
    expect(toEzra.draft).toBe(desk.repo.issue(issue.id)!.confirmation!.id);
    expect(desk.repo.inbox(cleoCall.id, 0).at(-1)!.text).toMatch(/asked Ezra/);
  });

  it("Ezra off the phone: he gets an email, and his next call carries the question", async () => {
    const { desk, role, notices } = setup({ ezraOnCall: false });
    await role.ownerApproval!(MOVE);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ phone: EZRA });
    expect(notices[0]!.text).toContain("Cleo asked me to move Ezra's 3 PM to 4 PM");
    const next = desk.startCall({ callSid: "CA3", phone: EZRA, channel: "voice" });
    expect(next.pending).toBeGreaterThan(0);
  });

  it("only Ezra's yes counts; after it, the same action runs as approved", async () => {
    const { desk, cleoCall, ezraCall, issue, role, host } = setup();
    await role.ownerApproval!(MOVE);
    const id = desk.repo.issue(issue.id)!.confirmation!.id;
    expect(() => desk.confirm(issue.id, cleoCall.id, id)).toThrow(DeskConflict);
    expect(() => desk.confirm(issue.id, cleoCall.id, id)).toThrow(/Ezra/);
    expect(desk.confirm(issue.id, ezraCall!.id, id).status).toBe("executing");
    expect(host.runs.at(-1)!.phone).toBe(CLEO); // still runs as Cleo
    expect(await role.ownerApproval!(MOVE)).toEqual({ approved: true });
  });

  it("a member's simple change never takes the fast path: it goes through her worker and policy", async () => {
    const { desk, cleoCall } = setup();
    const quick = desk.fileIssue(cleoCall.id, "Move my dentist to 4");
    await settle(60);
    expect(desk.repo.ledger(quick.id)).toEqual([]);
  });
});

describe("Ezra says who's in the family and what they may do", () => {
  const PLAN = { who: "person" as const, name: "Cleo", phone: CLEO, tier: "partner" as const, capabilities: ["email.read" as const], leftOut: [], readBack: "Cleo, 4 1 5, 5 5 5, 0 1 9 1, as your partner: everything. Okay?", words: "Add my wife Cleo, she can do and see everything" };

  function family() {
    const host = new Host();
    const applied: unknown[] = [];
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host, planner: new PM(), ownerPhone: EZRA, nameOf: (p) => (p === EZRA ? "Ezra" : undefined), coOwner: (p) => p === DAD, setMember: async () => PLAN, applyMember: (p) => void applied.push(p) });
    const ezraCall = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).call;
    const cleoCall = desk.startCall({ callSid: "CA2", phone: CLEO, channel: "voice" }).call;
    const tool = workerTools(desk).find((t) => t.spec.name === "set_member")!;
    const run = (call: string, words: string) => {
      const issue = desk.fileIssue(call, words);
      desk.assign(issue.id, "ops", words, []);
      return { issue, result: tool.spec.execute({ words }, { conversationKey: `desk:issue:${issue.id}:ops` } as never) };
    };
    return { desk, applied, ezraCall, cleoCall, run };
  }

  it("his words are read back, and nothing is saved until his yes; then exactly what was read back", async () => {
    const { desk, applied, ezraCall, run } = family();
    const { issue, result } = run(ezraCall.id, PLAN.words);
    expect((await result).isError).toBeFalsy();
    expect(applied).toEqual([]);
    const waiting = desk.repo.issue(issue.id)!;
    expect(waiting.status).toBe("needs_confirmation");
    expect(desk.repo.inbox(ezraCall.id, 0).at(-1)!.text).toContain("4 1 5, 5 5 5, 0 1 9 1");
    desk.confirm(issue.id, ezraCall.id, waiting.confirmation!.id);
    expect(applied).toEqual([PLAN]);
    expect(desk.repo.issue(issue.id)!.status).toBe("done");
    expect(desk.repo.inbox(ezraCall.id, 0).at(-1)).toMatchObject({ kind: "events" });
  });

  it("texting: a yes sent before the read-back doesn't save it (Nov 10, #698); a yes after it does", async () => {
    const { desk, applied, run } = family();
    const text = desk.startCall({ callSid: "SM1", phone: EZRA, channel: "text" }).call;
    desk.addTurn(text.id, { role: "caller", text: "Yes, she can do everything." });
    const { issue, result } = run(text.id, PLAN.words);
    await result;
    const draft = desk.repo.issue(issue.id)!.confirmation!.id;
    expect(() => desk.confirm(issue.id, text.id, draft)).toThrow(/hasn't answered/);
    expect(applied).toEqual([]);
    expect(desk.repo.issue(issue.id)!.status).toBe("needs_confirmation");
    desk.addTurn(text.id, { role: "kloru", text: PLAN.readBack });
    desk.addTurn(text.id, { role: "caller", text: "Yes" });
    desk.confirm(issue.id, text.id, draft);
    expect(applied).toEqual([PLAN]);
    expect(desk.repo.inbox(text.id, 0).at(-1)!.text).toBe("Done: Cleo is saved as partner.");
  });

  it("only the owner who said it can say yes to it, and only to that read-back", async () => {
    const { desk, applied, ezraCall, run } = family();
    const { issue, result } = run(ezraCall.id, PLAN.words);
    await result;
    const waiting = desk.repo.issue(issue.id)!;
    expect(waiting.confirmation).toMatchObject({ by: EZRA, personal: true, draft: PLAN.readBack });
    const other = desk.startCall({ callSid: "CA3", phone: DAD, channel: "voice" }).call;
    expect(() => desk.confirm(issue.id, other.id, waiting.confirmation!.id)).toThrow(/only Ezra/);
    expect(applied).toEqual([]);
  });

  it("a member can't set anyone's permissions", async () => {
    const { applied, cleoCall, run } = family();
    const { result } = run(cleoCall.id, "Give me everything");
    expect((await result).isError).toBe(true);
    expect(applied).toEqual([]);
  });
});

describe("each caller acts only through accounts that are theirs to use", () => {
  const scope = (phone: string) =>
    phone === CLEO
      ? { accounts: [{ id: "ca_cleo_mail", toolkit: "gmail", email: "cleo@gmail.example" }, { id: "ca_ezra_cal", toolkit: "googlecalendar", email: "ezra@gmail.example" }], restricted: ["gmail"] }
      : { accounts: [{ id: "ca_ezra_mail", toolkit: "gmail", email: "ezra@gmail.example" }, { id: "ca_ezra_cal", toolkit: "googlecalendar", email: "ezra@gmail.example" }], restricted: ["gmail"] };

  function cleoWorker() {
    const host = new Host();
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host, planner: new PM(), ownerPhone: EZRA, appScope: scope });
    const call = desk.startCall({ callSid: "CA2", phone: CLEO, channel: "voice" }).call;
    const issue = desk.fileIssue(call.id, "Anything from daycare in my email?");
    desk.assign(issue.id, "work", "Search her email for daycare", []);
    return host.runs.at(-1)!.role;
  }
  const fetch = (account?: string) => ({ tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "daycare" }, ...(account ? { account } : {}) }] });

  it("her worker is told her accounts, not Ezra's", () => {
    const host = new Host();
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host, planner: new PM(), ownerPhone: EZRA, appScope: scope, accounts: (phone) => (phone === CLEO ? "Accounts: cleo@gmail.example (account ca_cleo_mail)" : "Accounts: ezra@gmail.example") });
    const call = desk.startCall({ callSid: "CA2", phone: CLEO, channel: "voice" }).call;
    const issue = desk.fileIssue(call.id, "Anything from daycare?");
    desk.assign(issue.id, "work", "Search her email", []);
    expect(host.runs.at(-1)!.role.prompt).toContain("ca_cleo_mail");
    expect(host.runs.at(-1)!.role.prompt).not.toContain("ezra@gmail.example");
  });

  it("her own mailbox: fine", async () => {
    expect(await cleoWorker().guard!("app_composio_multi_execute_tool", fetch("ca_cleo_mail"))).toBeUndefined();
  });

  it("Ezra's mailbox when his words didn't give her his email: refused", async () => {
    const r = await cleoWorker().guard!("app_composio_multi_execute_tool", fetch("ca_ezra_mail"));
    expect(r).toMatchObject({ block: true });
  });

  it("no account named where some aren't hers: told which ones she may use", async () => {
    const r = await cleoWorker().guard!("app_composio_multi_execute_tool", fetch());
    expect(r).toMatchObject({ block: true, reason: expect.stringContaining("ca_cleo_mail") });
  });

  it("his calendar, which she may use, needs no account named", async () => {
    expect(await cleoWorker().guard!("app_composio_multi_execute_tool", { tools: [{ tool_slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} }] })).toBeUndefined();
  });
});

describe("a member's actions are weighed against the owner's words too", () => {
  it("the decision model sees Ezra's guidelines and what he said about Cleo; Ezra's own actions don't get them", async () => {
    const host = new Host();
    const checks: ActionCheck[] = [];
    const desk = new Desk({
      root: mkdtempSync(join(tmpdir(), "members-")),
      host,
      planner: new PM(),
      ownerPhone: EZRA,
      nameOf: (p) => (p === CLEO ? "Cleo" : "Ezra"),
      guidelines: (p) => (p === EZRA ? "Never spend over $200 without me." : "Keep it short."),
      ownerWords: (p) => (p === CLEO ? "She should be able to do and see everything" : undefined),
      isMember: (p) => p === CLEO,
      decideAction: async (c) => (checks.push(c), { decision: "do", reason: "ok" }),
    });
    for (const phone of [CLEO, EZRA]) {
      const call = desk.startCall({ callSid: `CA${phone}`, phone, channel: "voice" }).call;
      const issue = desk.fileIssue(call.id, "Email the school");
      desk.assign(issue.id, "ops", "Email the school", []);
      await host.runs.at(-1)!.role.guard!("app_gmail_send_email", { recipient_email: "school@example.com" });
    }
    expect(checks[0]!.ownerGuidelines).toContain("Never spend over $200 without me.");
    expect(checks[0]!.ownerGuidelines).toContain("She should be able to do and see everything");
    expect(checks[0]!.guidelines).toBe("Keep it short.");
    expect(checks[1]!.ownerGuidelines).toBeUndefined();
  });
});

describe("anyone who calls", () => {
  it("a stranger's action outside Ezra's words goes to Ezra, never back to the stranger", async () => {
    const host = new Host();
    const desk = new Desk({
      root: mkdtempSync(join(tmpdir(), "members-")),
      host,
      planner: new PM(),
      ownerPhone: EZRA,
      nameOf: (p) => (p === EZRA ? "Ezra" : undefined),
      ownerWords: () => "About anyone who calls: they can schedule a meeting with me",
      decideAction: async () => ({ decision: "ask_owner", reason: "moving his events isn't scheduling a meeting" }),
    });
    const ezraCall = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).call;
    const call = desk.startCall({ callSid: "CA9", phone: "+14155550123", channel: "voice" }).call;
    const issue = desk.fileIssue(call.id, "Move Ezra's 3 PM to Friday");
    desk.assign(issue.id, "ops", "Move the event", []);
    const r = await host.runs.at(-1)!.role.guard!("app_composio_multi_execute_tool", { tools: [{ tool_slug: "GOOGLECALENDAR_PATCH_EVENT", arguments: { event_id: "e1" } }] });
    expect(r?.block).toBe(true);
    expect(desk.repo.issue(issue.id)!.confirmation).toMatchObject({ by: EZRA });
    expect(desk.repo.inbox(ezraCall.id, 0).at(-1)!.text).toMatch(/asked me to/);
    expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toMatch(/asked Ezra/);
  });

  it("Ezra's yes to opening Kloru to anyone says so", () => {
    const host = new Host();
    const plan = { who: "anyone" as const, name: "Anyone who calls", phone: "", tier: "friend" as const, capabilities: ["calendar.write" as const], leftOut: [], readBack: "Anyone who calls can book time with you. Okay?", words: "Anyone can schedule a meeting with me" };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host, planner: new PM(), ownerPhone: EZRA, setMember: async () => plan, applyMember: () => {} });
    const call = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).call;
    const issue = desk.fileIssue(call.id, plan.words);
    desk.assign(issue.id, "ops", plan.words, []);
    return desk.setMember(issue.id, plan.words).then(() => {
      desk.confirm(issue.id, call.id, desk.repo.issue(issue.id)!.confirmation!.id);
      expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toMatch(/anyone who calls/i);
    });
  });
});

describe("the talking model knows who's calling", () => {
  it("a stranger's brief says they aren't Ezra and what he allowed; Ezra's doesn't", () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host: new Host(), planner: new PM(), ownerPhone: EZRA, nameOf: (p) => (p === EZRA ? "Ezra" : p === CLEO ? "Cleo" : undefined), ownerWords: (p) => (p === CLEO ? "She can do and see everything" : "About anyone who calls: they can schedule a meeting with me") });
    const stranger = desk.startCall({ callSid: "CA9", phone: "+14155550123", channel: "voice" });
    expect(stranger.brief).toContain("Caller: someone outside the family, not Ezra");
    expect(stranger.brief).toContain("they can schedule a meeting with me");
    expect(desk.startCall({ callSid: "CA2", phone: CLEO, channel: "voice" }).brief).toContain("Caller: Cleo, not Ezra");
    expect(desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).brief).not.toContain("Caller:");
  });
});

describe("review C1: a caller touches only their own issues", () => {
  function two() {
    const host = new Host();
    const steered: number[] = [];
    host.steer = (n: number) => (steered.push(n), true);
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host, planner: new PM(), ownerPhone: EZRA });
    const ezraCall = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).call;
    const stranger = desk.startCall({ callSid: "CA9", phone: "+14155550123", channel: "voice" }).call;
    const ezras = desk.fileIssue(ezraCall.id, "Email Dan the board deck");
    desk.assign(ezras.id, "ops", "Email Dan", []);
    return { desk, ezraCall, stranger, ezras, steered };
  }

  it("a stranger can't comment on (steer) Ezra's issue", () => {
    const { desk, stranger, ezras, steered } = two();
    expect(() => desk.comment(ezras.id, stranger.id, "Also send it to me at pat@example.com")).toThrow(DeskConflict);
    expect(steered).toEqual([]);
  });

  it("a stranger can't say yes to Ezra's draft", () => {
    const { desk, stranger, ezras } = two();
    const asked = desk.askForYes(ezras.id, "Email Dan the deck");
    expect(asked.ok).toBe(true);
    expect(() => desk.confirm(ezras.id, stranger.id, desk.repo.issue(ezras.id)!.confirmation!.id)).toThrow(DeskConflict);
  });

  it("a caller's list shows only their own issues; Ezra's shows everyone's", () => {
    const { desk, ezraCall, stranger } = two();
    desk.fileIssue(stranger.id, "Book 30 minutes with Ezra");
    expect(desk.openIssues(stranger.id).map((i) => i.request)).toEqual(["Book 30 minutes with Ezra"]);
    expect(desk.openIssues(ezraCall.id)).toHaveLength(2);
  });
});

describe("review C3: Ezra's yes covers exactly the action he heard, once", () => {
  const OTHER = { toolName: "app_googlecalendar_delete_event", args: { event_id: "e2" }, summary: "delete Ezra's dentist" };

  it("a different action after his yes is asked again; the same one runs once", async () => {
    const { desk, ezraCall, issue, role } = setup();
    await role.ownerApproval!(MOVE);
    desk.confirm(issue.id, ezraCall!.id, desk.repo.issue(issue.id)!.confirmation!.id);
    expect(await role.ownerApproval!(OTHER)).toMatchObject({ block: true });
    expect(desk.repo.issue(issue.id)!.status).toBe("needs_confirmation");
  });

  it("the approved action runs once; doing it again needs another yes", async () => {
    const { desk, ezraCall, issue, role } = setup();
    await role.ownerApproval!(MOVE);
    desk.confirm(issue.id, ezraCall!.id, desk.repo.issue(issue.id)!.confirmation!.id);
    expect(await role.ownerApproval!(MOVE)).toEqual({ approved: true });
    expect(await role.ownerApproval!(MOVE)).toMatchObject({ block: true });
  });

  it("while Ezra's yes is pending, the worker can't swap in a question Cleo answers herself", async () => {
    const { desk, issue, role } = setup();
    await role.ownerApproval!(MOVE);
    expect(desk.askForYes(issue.id, "Move it?").ok).toBe(false);
    expect(desk.repo.issue(issue.id)!.confirmation!.by).toBe(EZRA);
  });
});

describe("review C4: the public may only add meetings; the rest asks Ezra, and a failed check asks too", () => {
  function strangerWorker(decide?: () => Promise<never>) {
    const host = new Host();
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host, planner: new PM(), ownerPhone: EZRA, isMember: (p) => p === CLEO, ...(decide ? { decideAction: decide } : {}) });
    desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    const call = desk.startCall({ callSid: "CA9", phone: "+14155550123", channel: "voice" }).call;
    const issue = desk.fileIssue(call.id, "Book 30 minutes with Ezra, and move his 3 PM");
    desk.assign(issue.id, "ops", "Book it", []);
    return { desk, issue, role: host.runs.at(-1)!.role };
  }
  const batch = (slug: string) => ({ tools: [{ tool_slug: slug, arguments: { event_id: "e1" } }] });

  it("adding a meeting goes ahead", async () => {
    expect(await strangerWorker().role.guard!("app_composio_multi_execute_tool", batch("GOOGLECALENDAR_CREATE_EVENT"))).toBeUndefined();
  });

  it("moving or deleting Ezra's events asks Ezra, whatever the model would say", async () => {
    for (const slug of ["GOOGLECALENDAR_PATCH_EVENT", "GOOGLECALENDAR_DELETE_EVENT"]) {
      const { desk, issue, role } = strangerWorker();
      expect(await role.guard!("app_composio_multi_execute_tool", batch(slug))).toMatchObject({ block: true });
      expect(desk.repo.issue(issue.id)!.confirmation).toMatchObject({ by: EZRA });
    }
  });

  it("when the decision model fails for someone who isn't Ezra, Ezra is asked instead of going ahead", async () => {
    const { desk, issue, role } = strangerWorker(async () => { throw new Error("timeout"); });
    expect(await role.guard!("app_composio_multi_execute_tool", batch("GOOGLECALENDAR_CREATE_EVENT"))).toMatchObject({ block: true });
    expect(desk.repo.issue(issue.id)!.confirmation).toMatchObject({ by: EZRA });
  });
});

describe("review C2: only Ezra's requests take the fast path", () => {
  it("a member's or a stranger's question goes to the PM and their own worker, never the store shortcut", async () => {
    const asked: string[] = [];
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "members-")), host: new Host(), planner: new PM(), ownerPhone: EZRA, fastPath: async (i) => (asked.push(i.filedBy.phone), undefined), fastPathMs: 100 });
    for (const phone of [CLEO, "+14155550123", EZRA]) desk.fileIssue(desk.startCall({ callSid: `CA${phone}`, phone, channel: "voice" }).call.id, "What's on Ezra's calendar Friday?");
    await settle(30);
    expect(asked).toEqual([EZRA]);
  });
});

describe("co-owners (Cleo, 2026-11-02)", () => {
  const DAD = "+14155550123";
  function family() {
    const host = new Host();
    const desk = new Desk({
      root: mkdtempSync(join(tmpdir(), "coowners-")),
      host,
      planner: new PM(),
      ownerPhone: EZRA,
      coOwner: (p) => p === CLEO,
      isMember: (p) => p === DAD,
      nameOf: (p) => (p === CLEO ? "Cleo" : p === EZRA ? "Ezra" : p === DAD ? "Dad" : undefined),
      notify: async () => true,
    });
    return { desk, host };
  }

  it("a co-owner is an owner everywhere the desk asks", () => {
    const { desk } = family();
    expect(desk.isOwner(CLEO)).toBe(true);
    expect(desk.isOwner(EZRA)).toBe(true);
    expect(desk.isOwner(DAD)).toBe(false);
    const { call } = desk.startCall({ callSid: "CA9", phone: CLEO, channel: "voice" });
    expect(desk.callerNote(CLEO)).toBe("");
    expect(desk.fileIssue(call.id, "Move my 3 PM").filedBy.phone).toBe(CLEO);
  });

  it("an ask from a member's change is settled by either owner's yes", async () => {
    const { desk, host } = family();
    const { call: dadCall } = desk.startCall({ callSid: "CA3", phone: DAD, channel: "voice" });
    const { call: cleoCall } = desk.startCall({ callSid: "CA4", phone: CLEO, channel: "voice" });
    const issue = desk.fileIssue(dadCall.id, "Move Ezra's 3 PM to 4");
    desk.assign(issue.id, "ops", "Move the event", []);
    const role = host.runs.at(-1)!.role;
    await role.ownerApproval!(MOVE);
    const id = desk.repo.issue(issue.id)!.confirmation!.id;
    expect(() => desk.confirm(issue.id, dadCall.id, id)).toThrow(DeskConflict);
    expect(desk.confirm(issue.id, cleoCall.id, id).status).toBe("executing");
    expect(await role.ownerApproval!(MOVE)).toEqual({ approved: true });
  });
});
