/**
 * Coms: every message to a person on Kloru's own channels goes through that person's outbox, which
 * sends it now, drops it, or keeps it for the organizer, and writes one ledger entry per message.
 * A send from a connected account (Gmail, Outlook) passes the message check instead.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { MediaStore } from "../src/media.js";
import { Desk, type DeskOptions, type ActionCheck, type MessageCheck, type MessageDecision, type Notice, type NoticeChannel, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import type { FirstPassCheck, FirstPassChoice, Organizer } from "../src/outbox.js";

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

/** Assigns what's filed, merges each PR as info, and records every trigger it sees. */
class PM implements Planner {
  seen: Trigger[] = [];
  async handle(ts: Trigger[], d: Desk): Promise<void> {
    this.seen.push(...ts);
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
const EZRA = "+14155550190";
const CLEO = "+14155550191";

interface Setup {
  /** The message check, for sends from a connected account. */
  decide?: (c: MessageCheck) => Promise<MessageDecision>;
  /** The outbox's first pass. Unset: everything is sent as it comes. */
  pass?: (c: FirstPassCheck) => FirstPassChoice | Promise<FirstPassChoice>;
  organizer?: Organizer;
  send?: (n: Notice) => Promise<boolean | NoticeChannel>;
  decideAction?: (c: ActionCheck) => Promise<never>;
  media?: MediaStore;
  root?: string;
  checkDraft?: DeskOptions["checkDraft"];
  now?: () => Date;
}

function setup(o: Setup = {}) {
  const host = new Host();
  const pm = new PM();
  const sent: Notice[] = [];
  const checks: MessageCheck[] = [];
  const passes: FirstPassCheck[] = [];
  const desk = new Desk({
    ...(o.checkDraft ? { checkDraft: o.checkDraft } : {}),
    root: o.root ?? mkdtempSync(join(tmpdir(), "coms-")),
    host,
    planner: pm,
    notify: o.send ?? (async (n) => (sent.push(n), true)),
    announceMs: 20,
    channelsFor: () => ["imessage", "email"],
    guidelines: () => "Text me short updates.",
    ownEmails: () => ["ezra@work.example.com", "ezra@personal.example.com"],
    decideMessage: async (c) => (checks.push(c), (o.decide ?? (async () => ({ action: "send", channel: "imessage", p: 0.9 })))(c)),
    firstPass: async (c) => (passes.push(c), (o.pass ?? (() => "send"))(c)),
    ...(o.organizer ? { organizer: o.organizer } : {}),
    ...(o.decideAction ? { decideAction: o.decideAction } : {}),
    ...(o.media ? { media: o.media } : {}),
    ...(o.now ? { now: o.now } : {}),
    ownerPhone: EZRA,
  });
  return { host, pm, desk, sent, checks, passes };
}

async function issueOnCall(desk: Desk, request: string) {
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  desk.addTurn(call.id, { role: "caller", text: request });
  const issue = desk.fileIssue(call.id, request);
  await settle(20);
  return { call, issue };
}

describe("send_to_caller goes into the person's outbox", () => {
  it("sent: the worker hears the channel it went on, and the ledger holds one entry with why and who wrote it", async () => {
    const { desk, passes } = setup({ send: async () => "email" });
    const { issue } = await issueOnCall(desk, "Text me the link when you're done");
    const r = await desk.messageCaller(issue.id, "Here's the link: https://example.com/gift");
    expect(r).toEqual({ ok: true, value: "Sent by email." });
    expect(passes[0]!.item).toMatchObject({ text: "Here's the link: https://example.com/gift", why: "result", from: { agent: "worker", issue: issue.id } });
    expect(passes[0]!.request).toContain("Text me the link");
    expect(passes[0]!.person).toMatchObject({ guidelines: "Text me short updates.", inConversation: "voice", channels: ["imessage", "email"] });
    const entries = desk.repo.ledger(issue.id).filter((e) => e.slug === "MESSAGE");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ok: true, decision: "send", tool: "outbox", args: { to: EZRA, channel: "email", text: "Here's the link: https://example.com/gift", why: "result", from: "worker" } });
  });

  it("a channel the worker names is the one it goes on", async () => {
    const { desk, sent } = setup();
    const { issue } = await issueOnCall(desk, "Find a gift");
    await desk.messageCaller(issue.id, "Found one.");
    await desk.messageCaller(issue.id, "Another.", "email");
    expect(sent.map((n) => n.channel)).toEqual([undefined, "email"]);
  });

  it("dropped: nothing goes out, the worker hears not to send it another way, and the ledger keeps it", async () => {
    const { desk, sent } = setup({ pass: () => "drop" });
    const { issue } = await issueOnCall(desk, "Email me the pickup instructions");
    const r = await desk.messageCaller(issue.id, "I've emailed the instructions to your personal inbox.");
    expect(r.ok && r.value).toMatch(/^Not sent: they already have this/);
    expect(sent).toEqual([]);
    expect(desk.repo.ledger(issue.id).at(-1)).toMatchObject({ slug: "MESSAGE", ok: false, decision: "drop" });
  });

  it("left for the organizer: it waits in their outbox, the worker carries on, and the ledger has nothing yet", async () => {
    const { desk, sent } = setup({ pass: () => "organizer" });
    const { issue } = await issueOnCall(desk, "Find a gift");
    const r = await desk.messageCaller(issue.id, "Found a gift.");
    expect(r.ok && r.value).toMatch(/in their outbox/);
    expect(sent).toEqual([]);
    expect(desk.outbox.list(EZRA).map((i) => [i.text, i.state])).toEqual([["Found a gift.", "queued"]]);
    expect(desk.repo.ledger(issue.id).filter((e) => e.slug === "MESSAGE")).toEqual([]);
  });

  it("if the first pass fails, a result waits for the organizer instead of being lost or sent blind", async () => {
    const { desk, sent } = setup({ pass: () => Promise.reject(new Error("timeout")) });
    const { issue } = await issueOnCall(desk, "Text me");
    expect((await desk.messageCaller(issue.id, "Done.")).ok).toBe(true);
    expect(sent).toEqual([]);
    expect(desk.outbox.list(EZRA)).toHaveLength(1);
  });

  it("the first pass sees what they were already sent today", async () => {
    const { desk, passes } = setup();
    const { issue } = await issueOnCall(desk, "Text me");
    await desk.messageCaller(issue.id, "First message.");
    await desk.messageCaller(issue.id, "Second message.");
    expect(passes[1]!.recent.join("\n")).toContain("First message.");
  });

  it("an automation's message is a report, since nobody asked for it by hand", async () => {
    const { desk, passes } = setup();
    const { call } = desk.startCall({ callSid: "schedule:1", phone: EZRA, channel: "schedule" });
    const issue = desk.fileIssue(call.id, "Morning check of the inbox");
    await settle(20);
    await desk.messageCaller(issue.id, "Morning check: nothing new.");
    expect(passes[0]!.item.why).toBe("report");
  });
});

describe("sends from a connected account (Gmail, Outlook) pass the same check", () => {
  const toBoss = { recipient_email: "boss@work.example.com", subject: "Update", body: "Weekly update attached." };
  const toMe = { recipient_email: "ezra@personal.example.com", subject: "Bulky pickup", body: "Instructions: ..." };

  async function role(desk: Desk, host: Host) {
    const { issue } = await issueOnCall(desk, "Email the update");
    return { issue, role: host.last(issue.id).role };
  }

  it("send: goes ahead without the action decider, and the check knows who it reaches", async () => {
    const { desk, host, checks } = setup({ decideAction: async () => Promise.reject(new Error("must not be asked about a message")) });
    const { role: r } = await role(desk, host);
    expect(await r.guard!("app_gmail_send_email", toBoss)).toBeUndefined();
    expect(checks[0]).toMatchObject({ toCaller: false, action: "GMAIL_SEND_EMAIL" });
    expect(checks[0]!.to).toContain("boss@work.example.com");
    expect(checks[0]!.text).toContain("Weekly update attached.");
    expect(await r.guard!("app_gmail_send_email", toMe)).toBeUndefined();
    expect(checks[1]!.toCaller).toBe(true);
  });

  it("drop and hold block the send with a reason; both are kept in the ledger", async () => {
    const answers: MessageDecision[] = [{ action: "drop", p: 0.9 }, { action: "hold", p: 0.8 }];
    const { desk, host } = setup({ decide: async () => answers.shift()! });
    const { issue, role: r } = await role(desk, host);
    expect(await r.guard!("app_gmail_send_email", toBoss)).toMatchObject({ block: true, reason: expect.stringMatching(/not sent/i) });
    expect(await r.guard!("app_gmail_send_email", toBoss)).toMatchObject({ block: true, reason: expect.stringMatching(/now isn't the time/i) });
    expect(desk.repo.ledger(issue.id).map((e) => e.decision)).toEqual(["drop", "hold"]);
  });

  it("if the check fails, a send to someone else is held, not sent", async () => {
    const { desk, host } = setup({ decide: async () => Promise.reject(new Error("503")) });
    const { role: r } = await role(desk, host);
    expect(await r.guard!("app_gmail_send_email", toBoss)).toMatchObject({ block: true });
    expect(await r.guard!("app_gmail_send_email", toMe)).toBeUndefined();
  });

  it("a send that went through is in the caller's message history", async () => {
    const { desk, host } = setup();
    const { role: r } = await role(desk, host);
    await r.guard!("app_gmail_send_email", toMe);
    r.afterTool!("app_gmail_send_email", toMe, false, [{ type: "text", text: "sent, id 19a" }]);
    expect(desk.recentMessages(EZRA).join("\n")).toContain("Bulky pickup");
  });
});

describe("sending a saved draft is checked against what the draft says (#135)", () => {
  it("the check sees the draft's recipient and words, found from when it was created", async () => {
    const { desk, host, checks } = setup();
    const { issue } = await issueOnCall(desk, "Email Anthony that I want the $5M coverage");
    desk.repo.appendLedger({ issue: issue.id, call: issue.filedBy.call, phone: EZRA, tool: "app_composio_multi_execute_tool", slug: "GMAIL_CREATE_EMAIL_DRAFT", args: { recipient_email: "jordan_kim@advisors.example", subject: "Re: Life Insurance", body: "I'd like to proceed with $5 million in coverage." }, ok: true, result: '{"data":{"id":"r3430256160071719656","message":{"labelIds":["DRAFT"]}}}' });
    const r = host.last(issue.id).role;
    await r.guard!("app_gmail_send_draft", { user_id: "me", draft_id: "r3430256160071719656" });
    expect(checks[0]).toMatchObject({ toCaller: false, action: "GMAIL_SEND_DRAFT" });
    expect(checks[0]!.to).toContain("jordan_kim@advisors.example");
    expect(checks[0]!.text).toContain("$5 million");
  });

  it("a draft Kloru didn't write is checked as unknown words to an unknown person", async () => {
    const { desk, host, checks } = setup();
    const { issue } = await issueOnCall(desk, "Send my draft");
    await host.last(issue.id).role.guard!("app_gmail_send_draft", { draft_id: "r999" });
    expect(checks[0]!.toCaller).toBe(false);
    expect(checks[0]!.text).toMatch(/draft.*not known/i);
  });
});

describe("workers coordinate through the PM with comments", () => {
  it("a worker's comment is on the issue and wakes the PM", async () => {
    const { desk, pm } = setup();
    const { issue } = await issueOnCall(desk, "Find a gift");
    const r = desk.workerComment(issue.id, "Held: 'Found a gift: bonbons.' Send it with the dinner booking.");
    expect(r.ok).toBe(true);
    await settle(20);
    expect(pm.seen).toContainEqual(expect.objectContaining({ kind: "worker_comment", issue: issue.id }));
    expect(desk.repo.issue(issue.id)!.thread.at(-1)!.text).toContain("bonbons");
  });
});

describe("after the conversation: what they didn't hear goes to their outbox", () => {
  it("a result that lands after hang-up is one outbox item, sent once, with no PM wake to write it", async () => {
    const { desk, host, pm, sent } = setup();
    const { call, issue } = await issueOnCall(desk, "Move my dentist appointment to Friday");
    desk.endCall(call.id);
    host.last(issue.id).finish("Moved the dentist to Friday at 3.");
    await settle(150);
    expect(sent.map((n) => n.text)).toEqual(["Moved the dentist to Friday at 3."]);
    expect(desk.outbox.all(EZRA).map((i) => [i.why, i.from.agent, i.from.issue, i.state])).toEqual([["result", "pm", issue.id, "sent"]]);
    expect(desk.repo.undelivered(call.id)).toEqual([]);
    expect(pm.seen.map((t) => t.kind)).not.toContain("unheard");
  });

  it("what was merged before hang-up but never heard goes the same way when the call ends", async () => {
    const { desk, host, sent } = setup();
    const { call, issue } = await issueOnCall(desk, "Find a dentist");
    host.last(issue.id).finish("Maplewood Kids Dental.");
    await settle(40);
    expect(sent).toEqual([]);
    desk.endCall(call.id);
    await settle(60);
    expect(sent.map((n) => n.text)).toEqual(["Maplewood Kids Dental."]);
  });

  it("nothing when the call heard everything", async () => {
    const { desk, host, sent } = setup();
    const { call, issue } = await issueOnCall(desk, "Find a dentist");
    host.last(issue.id).finish("Maplewood Kids Dental.");
    await settle(40);
    desk.ack(call.id, desk.repo.inbox(call.id, 0).at(-1)!.seq);
    desk.endCall(call.id);
    await settle(150);
    expect(sent).toEqual([]);
    expect(desk.outbox.all(EZRA)).toEqual([]);
  });

  it("a call where nothing was asked sends nothing", async () => {
    const { desk, sent } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    desk.endCall(call.id);
    await settle(150);
    expect(sent).toEqual([]);
  });

  it("kept for the organizer, it isn't repeated on their next call; the talker's brief says what's waiting", async () => {
    const { desk, host, sent } = setup({ pass: () => "organizer" });
    const { call, issue } = await issueOnCall(desk, "Move my dentist appointment to Friday");
    desk.endCall(call.id);
    host.last(issue.id).finish("Moved the dentist to Friday at 3.");
    await settle(150);
    expect(sent).toEqual([]);
    const next = desk.startCall({ callSid: "CA2", phone: EZRA, channel: "voice" });
    expect(next.pending).toBe(0);
    expect(next.brief).toContain("Messages waiting to go to them");
    expect(next.brief).toContain("Moved the dentist to Friday at 3.");
  });

  it("a question the work waits on is a question in the outbox, in words they can answer", async () => {
    const { desk, passes } = setup();
    const { call, issue } = await issueOnCall(desk, "Book the dentist");
    desk.endCall(call.id);
    desk.askCaller(issue.id, "Morning or afternoon?");
    await settle(60);
    const item = desk.outbox.all(EZRA).at(-1)!;
    expect(item.why).toBe("question");
    expect(item.text).toContain("Morning or afternoon?");
    expect(passes.at(-1)!.item.id).toBe(item.id);
  });
});

describe("the message history is the ledger", () => {
  it("notifications(phone) reads sent messages from the ledger", async () => {
    const { desk } = setup();
    const { issue } = await issueOnCall(desk, "Text me");
    await desk.messageCaller(issue.id, "Hello.", "imessage");
    expect(desk.repo.notifications(EZRA)).toMatchObject([{ phone: EZRA, channel: "imessage", text: "Hello.", issues: [issue.id] }]);
  });

  it("a dropped message is in the history as dropped, so the next look knows it never went", async () => {
    const { desk } = setup({ pass: () => "drop" });
    const { issue } = await issueOnCall(desk, "Text me");
    await desk.messageCaller(issue.id, "Hello again.", "imessage");
    expect(desk.recentMessages(EZRA).at(-1)).toMatch(/dropped, never sent \(imessage to \+14155550190\): .*Hello again\./);
  });
});

describe("the PM sees worker comments; it has no tool of its own for messaging", () => {
  it("a worker's comment reads plainly in its snapshot, and tell_caller is gone", async () => {
    const { pmTools, snapshot } = await import("../src/pm.js");
    const { desk } = setup();
    const { issue } = await issueOnCall(desk, "Find a gift");
    const text = snapshot(desk, [{ kind: "worker_comment", issue: issue.id, text: "The bonbons need the dinner booking first." }]);
    expect(text).toContain(`worker_comment on #${issue.id}: The bonbons need`);
    expect(pmTools(desk).map((t) => t.name)).not.toContain("tell_caller");
  });
});

describe("'text' is the iMessage channel", () => {
  it("send_to_caller takes channel text and sends it by iMessage", async () => {
    const { workerTools } = await import("../src/worker-tools.js");
    const { desk, sent } = setup();
    const { issue } = await issueOnCall(desk, "Text me the link");
    const tool = workerTools(desk).find((t) => t.spec.name === "send_to_caller")!;
    await tool.spec.execute({ text: "Here it is.", channel: "text" } as never, { conversationKey: `desk:issue:${issue.id}:engineer` } as never);
    expect(sent.map((n) => n.channel)).toEqual(["imessage"]);
  });
});

describe("replies come back in the conversation's channel (text first)", () => {
  async function onChannel(channel: string, o: Parameters<typeof setup>[0] = {}) {
    const s = setup(o);
    const { call } = s.desk.startCall({ callSid: `${channel}:1`, phone: EZRA, channel });
    s.desk.addTurn(call.id, { role: "caller", text: "Can you give me the links for these flights?" });
    const issue = s.desk.fileIssue(call.id, "Give me the links for these flights");
    await settle(20);
    return { ...s, call, issue };
  }

  it("in a live text or email thread, a worker's message goes to the thread's writer, not straight out (one writer, 2026-11-03)", async () => {
    for (const channel of ["imessage", "email"] as const) {
      const t = await onChannel(channel);
      expect((await t.desk.messageCaller(t.issue.id, "Here they are.")).ok).toBe(true);
      expect(t.passes).toEqual([]);
      expect(t.desk.repo.inbox(t.call.id, 0).at(-1)).toMatchObject({ text: "Here they are.", issue: t.issue.id });
    }
  });

  it("text_instead: an email to the caller from a text thread is stopped, and the worker is told to text it", async () => {
    const t = await onChannel("imessage", { decide: async () => ({ action: "text_instead", p: 0.8 }) });
    const r = await t.host.last(t.issue.id).role.guard!("app_gmail_send_email", { recipient_email: "ezra@personal.example.com", subject: "Flight links", body: "Delta 2:08 PM: https://delta.com/x" });
    expect(r).toMatchObject({ block: true, reason: expect.stringMatching(/send_to_caller/) });
    expect(t.desk.repo.ledger(t.issue.id).at(-1)).toMatchObject({ decision: "text_instead", ok: false });
  });

  it("a connected-account drop Jev isn't sure of is held instead, so a coin flip never loses a message", async () => {
    const t = await onChannel("voice", { decide: async () => ({ action: "drop", p: 0.56 }) });
    const r = await t.host.last(t.issue.id).role.guard!("app_gmail_send_email", { recipient_email: "ezra@personal.example.com", subject: "Flight links", body: "Here's the flights page: https://kloru.com/a/x" });
    expect(r).toMatchObject({ block: true });
    expect(t.desk.repo.ledger(t.issue.id).at(-1)).toMatchObject({ decision: "hold" });
  });

  it("no 'Just now I…' change notices in a text thread: the result says it once", async () => {
    const t = await onChannel("imessage");
    const r = t.host.last(t.issue.id).role;
    await r.guard!("app_googlecalendar_create_event", { summary: "Flight to ATL" });
    r.afterTool!("app_googlecalendar_create_event", { summary: "Flight to ATL" }, false, [{ type: "text", text: "ok ev1" }]);
    await settle(80);
    expect(t.desk.repo.inbox(t.call.id, 0).filter((m) => m.progress)).toEqual([]);
  });
});

describe("one outbox: the text talker's messages go through it too (#37)", () => {
  const THREAD = { channel: "imessage" as const, to: EZRA };
  function talk(o: Setup = {}) {
    const s = setup(o);
    const out: string[] = [];
    const line = { up: true };
    s.desk.useThreadSender(async (_thread, text) => (line.up ? (out.push(text), true) : false));
    const { call } = s.desk.startCall({ callSid: "imessage:evt_1", phone: EZRA, channel: "imessage" });
    s.desk.addTurn(call.id, { role: "caller", text: "What's the link to the parking at SFO?" });
    return { ...s, out, line, call };
  }

  it("a reply: goes out on the thread's own transport, becomes a turn, and is in the ledger", async () => {
    const { desk, call, out, passes } = talk();
    const r = await desk.submitFromConversation(call.id, { text: "On it.", replyingTo: "What's the link to the parking at SFO?", thread: THREAD });
    expect(r).toBe("sent");
    expect(out).toEqual(["On it."]);
    expect(passes.at(-1)!.item).toMatchObject({ why: "reply", from: { agent: "talker" }, replyingTo: "What's the link to the parking at SFO?" });
    expect(passes.at(-1)!.person.inConversation).toBe("imessage");
    expect(desk.repo.turns(call.id, 0).at(-1)).toMatchObject({ role: "kloru", text: "On it." });
    expect(desk.recentMessages(EZRA).at(-1)).toMatch(/sent \(imessage to \+14155550190\): On it\./);
  });

  it("why it exists comes from plumbing: a result it passes on, a question, else a reply", async () => {
    const { desk, call, passes } = talk();
    const issue = desk.fileIssue(call.id, "SFO parking options");
    await desk.submitFromConversation(call.id, { text: "Three lots near SFO.", issues: [issue.id], thread: THREAD });
    await desk.submitFromConversation(call.id, { text: "Covered or uncovered?", issues: [issue.id], question: true, thread: THREAD });
    await desk.submitFromConversation(call.id, { text: "Sure.", replyingTo: "Thanks", thread: THREAD });
    expect(passes.map((c) => c.item.why)).toEqual(["result", "question", "reply"]);
  });

  it("dropped: nothing goes out, no turn, and the ledger keeps it", async () => {
    const { desk, call, out } = talk({ pass: () => "drop" });
    expect(await desk.submitFromConversation(call.id, { text: "Here are the SFO links again.", thread: THREAD })).toBe("dropped");
    expect(out).toEqual([]);
    expect(desk.repo.turns(call.id, 0).map((t) => t.role)).toEqual(["caller"]);
    expect(desk.recentMessages(EZRA).at(-1)).toMatch(/dropped, never sent \(imessage/);
  });

  it("left for the organizer: nothing goes out yet, and it waits with its thread", async () => {
    const { desk, call, out } = talk({ pass: () => "organizer" });
    expect(await desk.submitFromConversation(call.id, { text: "The weekly summary is ready.", thread: THREAD })).toBe("queued");
    expect(out).toEqual([]);
    expect(desk.outbox.list(EZRA)[0]).toMatchObject({ state: "queued", thread: THREAD });
  });

  it("the first pass sees the talker's earlier messages as already sent", async () => {
    const { desk, call, passes } = talk();
    await desk.submitFromConversation(call.id, { text: "SFO parking: https://kloru.com/a/abc", thread: THREAD });
    await desk.submitFromConversation(call.id, { text: "Here's the SFO page again: https://kloru.com/a/abc", thread: THREAD });
    expect(passes.at(-1)!.recent.join("\n")).toContain("SFO parking: https://kloru.com/a/abc");
  });

  it("if the first pass fails, a reply still goes: they're waiting for it", async () => {
    const { desk, call, out } = talk({ pass: () => Promise.reject(new Error("timeout")) });
    expect(await desk.submitFromConversation(call.id, { text: "On it.", replyingTo: "Find SFO parking", thread: THREAD })).toBe("sent");
    expect(out).toEqual(["On it."]);
  });

  it("a failed send says so, adds no turn, and stays in the outbox to go again", async () => {
    const { desk, call, line } = talk();
    line.up = false;
    expect(await desk.submitFromConversation(call.id, { text: "On it.", replyingTo: "Find SFO parking", thread: THREAD })).toBe("failed");
    expect(desk.repo.turns(call.id, 0).map((t) => t.role)).toEqual(["caller"]);
    expect(desk.outbox.list(EZRA)[0]).toMatchObject({ state: "queued", tries: 1 });
    expect(desk.repo.ledger().filter((e) => e.slug === "MESSAGE")).toEqual([]);
  });

  it("a page whose link went out counts as told, so it isn't sent again after the conversation", async () => {
    const { desk, call } = talk();
    const issue = desk.fileIssue(call.id, "SFO parking options");
    const page = desk.publishArtifact(issue.id, "SFO parking", "# SFO parking");
    if (!page.ok) throw new Error(page.error);
    await desk.submitFromConversation(call.id, { text: `Here it is: ${page.value.url}`, issues: [issue.id], thread: THREAD });
    expect(desk.repo.artifact(page.value.id)!.emailedAt).toBeTruthy();
  });

  it("a text reply is never recorded on an issue, so it never counts as a change an ops issue made", async () => {
    const { desk, call } = talk();
    const issue = desk.fileIssue(call.id, "Add Cleo to the family");
    await desk.submitFromConversation(call.id, { text: "On it.", replyingTo: "Add Cleo to the family", thread: THREAD });
    await desk.submitFromConversation(call.id, { text: "Cleo's added.", issues: [issue.id], thread: THREAD });
    expect(desk.repo.ledger(issue.id)).toEqual([]);
    expect(desk.recentMessages(EZRA)).toHaveLength(2);
  });
});

describe("a worker's text lands in the person's text thread (#37, Cleo's wrong link)", () => {
  it("sent by iMessage while their text thread is open: it's a turn there, so the talker knows it", async () => {
    const { desk } = setup({ send: async () => "imessage" });
    const { issue } = await issueOnCall(desk, "Make a shared to-do list and text me the link");
    const { call: textThread } = desk.startCall({ callSid: "imessage:evt_2", phone: EZRA, channel: "imessage" });
    const r = await desk.messageCaller(issue.id, "Here's your shared to-do list: https://kloru.com/a/todo");
    expect(r.ok).toBe(true);
    expect(desk.repo.turns(textThread.id, 0).at(-1)).toMatchObject({ role: "kloru", text: "Here's your shared to-do list: https://kloru.com/a/todo" });
  });

  it("no open text thread, or sent by email: no turn is added anywhere", async () => {
    const { desk } = setup({ send: async () => "email" });
    const { call, issue } = await issueOnCall(desk, "Email me the list");
    const before = desk.repo.turns(call.id, 0).length;
    await desk.messageCaller(issue.id, "Here's the list.");
    expect(desk.repo.turns(call.id, 0)).toHaveLength(before);
  });
});

describe("a result handed to another conversation carries its links (#37)", () => {
  it("an ended call's result reaches the live text thread with that call's page links", async () => {
    const { desk } = setup();
    const { call, issue } = await issueOnCall(desk, "Make a shared to-do list");
    const page = desk.publishArtifact(issue.id, "Shared to-do list", "- taxes");
    if (!page.ok) throw new Error(page.error);
    desk.endCall(call.id);
    const { call: textThread } = desk.startCall({ callSid: "imessage:evt_3", phone: EZRA, channel: "imessage" });
    desk.resolve(issue.id, "I have texted you the link to the shared to-do list.");
    const got = desk.repo.inbox(textThread.id, 0).at(-1)!;
    expect(got.text).toContain(page.value.url);
  });

  it("a result in its own conversation is left as written", async () => {
    const { desk } = setup();
    const { call, issue } = await issueOnCall(desk, "Make a list");
    const page = desk.publishArtifact(issue.id, "List", "- a");
    if (!page.ok) throw new Error(page.error);
    desk.resolve(issue.id, "Done.");
    expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toBe("Done.");
  });
});

describe("a result handed to another conversation carries only what they haven't had", () => {
  it("a handed-off result carries only pages not yet told, and progress carries none", async () => {
    const { desk } = setup();
    const { call, issue } = await issueOnCall(desk, "Make a list and a trip page");
    const told = desk.publishArtifact(issue.id, "Trip", "- trip");
    const fresh = desk.publishArtifact(issue.id, "List", "- list");
    if (!told.ok || !fresh.ok) throw new Error("publish failed");
    desk.repo.saveArtifact({ ...desk.repo.artifact(told.value.id)!, emailedAt: new Date().toISOString() });
    desk.endCall(call.id);
    const { call: textThread } = desk.startCall({ callSid: "imessage:evt_11", phone: EZRA, channel: "imessage" });
    desk.resolve(issue.id, "Done.");
    const got = desk.repo.inbox(textThread.id, 0).at(-1)!.text;
    expect(got).toContain(fresh.value.url);
    expect(got).not.toContain(told.value.url);
  });
});

describe("a message can carry photos", () => {
  const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const store = () => new MediaStore(mkdtempSync(join(tmpdir(), "coms-media-")));

  it("a worker sends the caller their photo: checked with it in view, attached, and recorded", async () => {
    const media = store();
    const photo = media.put(PNG, { mime: "image/png", name: "receipt.png", phone: EZRA });
    const { desk, sent, passes } = setup({ media });
    const { issue } = await issueOnCall(desk, "Text me that receipt");
    const r = await desk.messageCaller(issue.id, "Here's the receipt.", undefined, undefined, [photo.id]);
    expect(r.ok).toBe(true);
    expect(passes.at(-1)!.item.media).toEqual([photo.id]);
    expect(sent.at(-1)!.text).toBe("Here's the receipt.");
    expect(sent.at(-1)!.media).toEqual([{ path: media.get(photo.id)!.path, mime: "image/png", name: "receipt.png" }]);
    expect(desk.repo.ledger().at(-1)!.args).toMatchObject({ media: [photo.id] });
  });

  it("someone else's photo isn't sent, and says why", async () => {
    const media = store();
    const hers = media.put(PNG, { mime: "image/png", name: "cleo.png", phone: CLEO });
    const { desk, sent } = setup({ media });
    const { call } = desk.startCall({ callSid: "CA2", phone: CLEO, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Text me the photo");
    await settle(20);
    const mine = media.put(Uint8Array.from([...PNG, 0]), { mime: "image/png", name: "ezra.png", phone: EZRA });
    const r = await desk.messageCaller(issue.id, "Here it is.", undefined, undefined, [mine.id]);
    expect(r.ok ? "" : r.error).toMatch(new RegExp(`${mine.id.replace(".", "\\.")} isn't theirs`));
    expect((await desk.messageCaller(issue.id, "Here it is.", undefined, undefined, [hers.id])).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("an id that isn't kept says to keep it first", async () => {
    const { desk, sent } = setup({ media: store() });
    const { issue } = await issueOnCall(desk, "Text me the chart");
    const r = await desk.messageCaller(issue.id, "Here's the chart.", undefined, undefined, ["m_0123456789abcdef.png"]);
    expect(r.ok ? "" : r.error).toMatch(/media_keep/);
    expect(sent).toEqual([]);
  });

  it("a message with a photo that waits keeps the photo, and it's attached when the organizer sends it", async () => {
    const media = store();
    const photo = media.put(PNG, { mime: "image/png", name: "receipt.png", phone: EZRA });
    const organizer: Organizer = { organize: async (view, act) => void (await act.send({ items: [view.queued[0]!.id] })) };
    const { desk, sent } = setup({ media, pass: () => "organizer", organizer });
    const { issue } = await issueOnCall(desk, "Text me that receipt");
    await desk.messageCaller(issue.id, "Here's the receipt.", undefined, undefined, [photo.id]);
    expect(sent).toEqual([]);
    expect(desk.outbox.list(EZRA)[0]!.media).toEqual([photo.id]);
    await desk.outbox.runOrganizer(EZRA);
    expect(sent.at(-1)!.media).toEqual([{ path: media.get(photo.id)!.path, mime: "image/png", name: "receipt.png" }]);
    expect(desk.repo.ledger().at(-1)).toMatchObject({ decision: "send", args: { media: [photo.id] } });
  });
});

describe("Nov 2: the laundry-basket thread's lost results", () => {
  it("a restart doesn't lose what a conversation it cut off never heard: it goes to their outbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "coms-restart-"));
    const { desk, host } = setup({ root });
    const { call, issue } = await issueOnCall(desk, "Find me a laundry basket");
    host.last(issue.id).finish("Found three on the page.");
    await settle(40);
    expect(desk.repo.undelivered(call.id).length).toBeGreaterThan(0);
    // The process dies mid-conversation; a new desk on the same files recovers.
    const sent: Notice[] = [];
    const again = new Desk({ root, host: new Host(), planner: new PM(), notify: async (n) => (sent.push(n), true), channelsFor: () => ["imessage"] });
    again.recover();
    await settle(120);
    expect(sent.map((n) => n.text)).toEqual(["Found three on the page."]);
    expect(again.repo.undelivered(call.id)).toEqual([]);
  });

  it("a page that changed since they got its link is said so to the first pass", async () => {
    const { desk, passes } = setup();
    const { issue } = await issueOnCall(desk, "Find me a laundry basket");
    const page = desk.publishArtifact(issue.id, "Laundry baskets", "# Laundry baskets\n- One");
    if (!page.ok) throw new Error(page.error);
    await desk.messageCaller(issue.id, `Here they are: ${page.value.url}`);
    expect(passes.at(-1)!.changedPages).toEqual([]);
    await settle(10);
    desk.updateArtifact(page.value.id, { append: "- Two" }, { issue: issue.id, phone: EZRA });
    await desk.messageCaller(issue.id, `I added more: ${page.value.url}`);
    expect(passes.at(-1)!.changedPages).toEqual(["Laundry baskets"]);
  });
});

describe("a worker's draft that doesn't fit goes back once (2026-11-03)", () => {
  it("the first draft is sent back with the reason; the rewrite goes on to the send check", async () => {
    const drafts: string[] = [];
    const s = setup({ checkDraft: async (d) => (drafts.push(d.draft), d.draft.length > 30 ? { fits: false, why: "Too long for them: make it shorter." } : { fits: true }) });
    const { call } = s.desk.startCall({ callSid: "voice:1", phone: EZRA, channel: "voice" });
    s.desk.addTurn(call.id, { role: "caller", text: "Find a dentist near us" });
    const t = { desk: s.desk, issue: s.desk.fileIssue(call.id, "Find a dentist near us") };
    await settle(20);
    const first = await t.desk.messageCaller(t.issue.id, "Here's everything I found about the dentists near you, with all the details.");
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error).toBe("Not sent yet: redraft it. Too long for them: make it shorter. Then send the new version the same way.");
    expect((await t.desk.messageCaller(t.issue.id, "Maplewood Kids Dental, Thu 4 PM.")).ok).toBe(true);
    expect(drafts).toHaveLength(1);
  });
});

describe("reminders: words known now, sent at a time they chose (#42)", () => {
  const clock = () => {
    const c = { now: new Date("2026-11-10T22:00:00Z") }; // 2 PM in Portland
    return { c, now: () => c.now, at: (iso: string) => (c.now = new Date(iso)) };
  };

  it("\"Remind me at 9 tomorrow to call the dentist\" is sent at 9, with no PM or worker run", async () => {
    const t = clock();
    const { desk, sent, host, pm, passes } = setup({ now: t.now });
    const r = await desk.remind(EZRA, "Reminder: call the dentist.", "2026-11-11T09:00", { agent: "talker" });
    expect(r.ok && r.value.state).toBe("scheduled");
    const runs = host.runs.length;
    const seen = pm.seen.length;
    t.at("2026-11-11T16:59:30Z");
    await desk.outbox.tick();
    expect(sent).toEqual([]);
    t.at("2026-11-11T17:00:05Z");
    await desk.outbox.tick();
    expect(sent.map((n) => n.text)).toEqual(["Reminder: call the dentist."]);
    expect(passes.at(-1)).toMatchObject({ firing: true, item: { why: "reminder" } });
    expect(host.runs).toHaveLength(runs);
    expect(pm.seen).toHaveLength(seen);
    expect(desk.repo.ledger().filter((e) => e.slug === "MESSAGE")).toMatchObject([{ decision: "send", args: { why: "reminder" } }]);
  });

  it("it survives a restart: a new desk over the same files sends it at its time", async () => {
    const t = clock();
    const root = mkdtempSync(join(tmpdir(), "coms-remind-"));
    const first = setup({ root, now: t.now });
    await first.desk.remind(EZRA, "Reminder: take the bins out.", "2026-11-11T06:30");
    const second = setup({ root, now: t.now });
    second.desk.recover();
    await settle(20);
    expect(second.sent).toEqual([]);
    expect(second.desk.outboxList(EZRA).join("\n")).toMatch(/reminder, goes .*6:30 AM.*take the bins out/);
    t.at("2026-11-11T14:30:10Z");
    await second.desk.outbox.tick();
    expect(second.sent.map((n) => n.text)).toEqual(["Reminder: take the bins out."]);
  });

  it("a time that passed, or isn't one, is said back instead of set", async () => {
    const t = clock();
    const { desk } = setup({ now: t.now });
    const past = await desk.remind(EZRA, "Call Dr. Lee.", "2026-11-10T09:00");
    expect(past.ok ? "" : past.error).toMatch(/already passed/);
    const bad = await desk.remind(EZRA, "Call Dr. Lee.", "soonish");
    expect(bad.ok ? "" : bad.error).toMatch(/isn't a time/);
    expect(desk.outbox.list(EZRA)).toEqual([]);
  });

  it("a worker sets one for the person who asked, and they hear when it goes", async () => {
    const t = clock();
    const { desk } = setup({ now: t.now });
    const { issue } = await issueOnCall(desk, "Remind me at 9 tomorrow to call the dentist");
    const r = await desk.remindCaller(issue.id, "Reminder: call the dentist.", "2026-11-11T09:00");
    expect(r.ok && r.value).toMatch(/they get it .*9:00 AM/);
    expect(desk.outbox.list(EZRA)[0]).toMatchObject({ why: "reminder", state: "scheduled", from: { agent: "worker", issue: issue.id } });
  });

  it("they can list what's waiting and cancel their own; an owner can cancel anyone's; nobody else's", async () => {
    const t = clock();
    const { desk, sent } = setup({ now: t.now });
    const mine = await desk.remind(CLEO, "Reminder: pick up Nora at Little Pines.", "2026-11-11T15:00");
    const ezras = await desk.remind(EZRA, "Reminder: call the dentist.", "2026-11-11T09:00");
    if (!mine.ok || !ezras.ok) throw new Error("not set");
    expect(desk.outboxList(CLEO)).toHaveLength(1);
    expect(desk.outboxCancel(ezras.value.id, CLEO).ok).toBe(false);
    expect(desk.outboxCancel(mine.value.id, EZRA).ok).toBe(true);
    expect(desk.outboxList(CLEO)).toEqual([]);
    t.at("2026-11-12T00:00:00Z");
    await desk.outbox.tick();
    expect(sent.map((n) => n.phone)).toEqual([EZRA]);
    expect(desk.repo.ledger().map((e) => e.decision)).toEqual(["cancelled", "send"]);
  });

  it("a worker's tools list and stop what waits for the person who asked", async () => {
    const { workerTools } = await import("../src/worker-tools.js");
    const t = clock();
    const { desk } = setup({ now: t.now });
    const { issue } = await issueOnCall(desk, "Cancel my dentist reminder");
    const set = await desk.remind(EZRA, "Reminder: call the dentist.", "2026-11-11T09:00");
    if (!set.ok) throw new Error(set.error);
    const ctx = { conversationKey: `desk:issue:${issue.id}:engineer` } as never;
    const tool = (name: string) => workerTools(desk).find((x) => x.spec.name === name)!;
    const listed = await tool("outbox_list").spec.execute({} as never, ctx);
    expect(JSON.stringify(listed)).toContain(set.value.id);
    await tool("outbox_cancel").spec.execute({ id: set.value.id } as never, ctx);
    expect(desk.outbox.list(EZRA)).toEqual([]);
  });
});
