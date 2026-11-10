/**
 * Coms: every message passes one decision (Jev in production) and lands in one ledger. The agent that
 * drafted it sends it; the decision says send (and where), hold, drop or ask. After-call messages go
 * out only when something the caller asked for got done and they didn't hear it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { MediaStore } from "../src/media.js";
import { Desk, type DeskOptions, type ActionCheck, type MessageCheck, type MessageDecision, type Notice, type NoticeChannel, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

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

function setup(o: { decide?: (c: MessageCheck) => Promise<MessageDecision>; send?: (n: Notice) => Promise<boolean | NoticeChannel>; decideAction?: (c: ActionCheck) => Promise<never>; media?: MediaStore; root?: string; checkDraft?: DeskOptions["checkDraft"] } = {}) {
  const host = new Host();
  const pm = new PM();
  const sent: Notice[] = [];
  const checks: MessageCheck[] = [];
  const desk = new Desk({
    ...(o.checkDraft ? { checkDraft: o.checkDraft } : {}),
    root: o.root ?? mkdtempSync(join(tmpdir(), "coms-")),
    host,
    planner: pm,
    notify: o.send ?? (async (n) => (sent.push(n), true)),
    notifyDelayMs: 20,
    notifyWaitMs: 400,
    announceMs: 20,
    channelsFor: () => ["imessage", "email"],
    guidelines: () => "Text me short updates.",
    ownEmails: () => ["ezra@work.example.com", "ezra@personal.example.com"],
    decideMessage: async (c) => (checks.push(c), (o.decide ?? (async () => ({ action: "send", channel: "imessage", p: 0.9 })))(c)),
    ...(o.decideAction ? { decideAction: o.decideAction } : {}),
    ...(o.media ? { media: o.media } : {}),
    ownerPhone: EZRA,
  });
  return { host, pm, desk, sent, checks };
}

async function issueOnCall(desk: Desk, request: string) {
  const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
  desk.addTurn(call.id, { role: "caller", text: request });
  const issue = desk.fileIssue(call.id, request);
  await settle(20);
  return { call, issue };
}

describe("send_to_caller passes the message check", () => {
  it("send: it goes on the decided channel, and the ledger records the channel actually used", async () => {
    const { desk, sent, checks } = setup({ send: async (n) => (void n, "email") });
    const { issue } = await issueOnCall(desk, "Text me the link when you're done");
    const r = await desk.messageCaller(issue.id, "Here's the link: https://example.com/gift");
    expect(r.ok).toBe(true);
    void sent;
    expect(checks[0]).toMatchObject({ toCaller: true, text: "Here's the link: https://example.com/gift", channels: ["imessage", "email"], onCall: true });
    expect(checks[0]!.request).toContain("Text me the link");
    expect(checks[0]!.guidelines).toContain("Text me short updates.");
    const entry = desk.repo.ledger(issue.id).find((e) => e.slug === "MESSAGE")!;
    expect(entry).toMatchObject({ ok: true, decision: "send", args: { to: EZRA, channel: "email", text: "Here's the link: https://example.com/gift" } });
  });

  it("the channel Jev picks is used unless the worker named one", async () => {
    const { desk, sent } = setup({ decide: async () => ({ action: "send", channel: "email", p: 0.8 }) });
    const { issue } = await issueOnCall(desk, "Find a gift");
    await desk.messageCaller(issue.id, "Found one.");
    await desk.messageCaller(issue.id, "Another.", "imessage");
    expect(sent.map((n) => n.channel)).toEqual(["email", "imessage"]);
  });

  it("drop: nothing goes out, the worker hears why, and the ledger keeps the dropped message", async () => {
    const { desk, sent } = setup({ decide: async () => ({ action: "drop", p: 0.92 }) });
    const { issue } = await issueOnCall(desk, "Email me the pickup instructions");
    const r = await desk.messageCaller(issue.id, "I've emailed the instructions to your personal inbox.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not sent/i);
    expect(sent).toEqual([]);
    expect(desk.repo.ledger(issue.id).at(-1)).toMatchObject({ slug: "MESSAGE", ok: false, decision: "drop" });
  });

  it("hold: nothing goes out yet, and the worker is told to leave it as a comment for the PM", async () => {
    const { desk, sent } = setup({ decide: async () => ({ action: "hold", p: 0.7 }) });
    const { issue } = await issueOnCall(desk, "Find a gift");
    const r = await desk.messageCaller(issue.id, "Found a gift.");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/comment/i);
    expect(sent).toEqual([]);
  });

  it("ask: the caller hears the exact message to say yes to", async () => {
    const { desk, sent } = setup({ decide: async () => ({ action: "ask", p: 0.6 }) });
    const { call, issue } = await issueOnCall(desk, "Text me");
    await desk.messageCaller(issue.id, "Your bank balance is low.");
    expect(sent).toEqual([]);
    expect(desk.repo.issue(issue.id)!.status).toBe("needs_confirmation");
    expect(desk.repo.inbox(call.id, 0).at(-1)!.text).toContain("Your bank balance is low.");
  });

  it("if the check fails, a message to the caller themselves still goes out", async () => {
    const { desk, sent } = setup({ decide: async () => Promise.reject(new Error("timeout")) });
    const { issue } = await issueOnCall(desk, "Text me");
    expect((await desk.messageCaller(issue.id, "Done.")).ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("the check sees what the caller was already sent today", async () => {
    const { desk, checks } = setup();
    const { issue } = await issueOnCall(desk, "Text me");
    await desk.messageCaller(issue.id, "First message.");
    await desk.messageCaller(issue.id, "Second message.");
    expect(checks[1]!.recent.join("\n")).toContain("First message.");
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
    expect(await r.guard!("app_gmail_send_email", toBoss)).toMatchObject({ block: true, reason: expect.stringMatching(/comment/i) });
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

describe("after the call: a message only when something asked for got done and wasn't heard", () => {
  it("a finished request the caller didn't hear wakes the PM once with what's unheard", async () => {
    const { desk, host, pm, sent } = setup();
    const { call, issue } = await issueOnCall(desk, "Move my dentist appointment to Friday");
    desk.endCall(call.id);
    host.last(issue.id).finish("Moved the dentist to Friday at 3.");
    await settle(150);
    const t = pm.seen.filter((x) => x.kind === "unheard");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ call: call.id, issue: issue.id });
    expect((t[0] as { unheard: string[] }).unheard.join(" ")).toContain("Moved the dentist");
    expect(sent).toEqual([]); // the PM writes it; no code note
  });

  it("nothing when the call heard everything", async () => {
    const { desk, host, pm } = setup();
    const { call, issue } = await issueOnCall(desk, "Find a dentist");
    host.last(issue.id).finish("Maplewood Kids Dental.");
    await settle(40);
    desk.ack(call.id, desk.repo.inbox(call.id, 0).at(-1)!.seq);
    desk.endCall(call.id);
    await settle(150);
    expect(pm.seen.some((x) => x.kind === "unheard")).toBe(false);
  });

  it("nothing for a request that failed: the next call carries it", async () => {
    const { desk, pm } = setup();
    const { call, issue } = await issueOnCall(desk, "Book a table");
    desk.endCall(call.id);
    desk.repo.appendInbox(call.id, { kind: "info", text: "Couldn't book it.", issue: issue.id });
    (desk as unknown as { scheduleNotice(id: string): void }).scheduleNotice(call.id);
    await settle(150);
    expect(pm.seen.some((x) => x.kind === "unheard")).toBe(false);
    expect(desk.startCall({ callSid: "CA2", phone: EZRA, channel: "voice" }).pending).toBe(1);
  });

  it("a call where nothing was asked wakes no one", async () => {
    const { desk, pm } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    desk.endCall(call.id);
    await settle(150);
    expect(pm.seen.some((x) => x.kind === "unheard")).toBe(false);
  });

  it("tell_caller sends through the check, and what it covered counts as heard", async () => {
    const { desk, host, sent, checks } = setup();
    const { call, issue } = await issueOnCall(desk, "Move my dentist appointment to Friday");
    desk.endCall(call.id);
    host.last(issue.id).finish("Moved the dentist to Friday at 3.");
    await settle(150);
    const r = await desk.tellCaller(call.id, "I moved your dentist to Friday at 3.");
    expect(r.ok).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ phone: EZRA, text: "I moved your dentist to Friday at 3.", channel: "imessage" })]);
    expect(checks.at(-1)).toMatchObject({ toCaller: true, from: "pm" });
    expect(desk.repo.undelivered(call.id)).toEqual([]);
  });

  it("a dropped after-call message also counts as heard, so it isn't tried again", async () => {
    const { desk, host, sent } = setup({ decide: async () => ({ action: "drop", p: 0.9 }) });
    const { call, issue } = await issueOnCall(desk, "Email me the instructions");
    desk.endCall(call.id);
    host.last(issue.id).finish("Emailed them.");
    await settle(150);
    await desk.tellCaller(call.id, "I emailed you the instructions.");
    expect(sent).toEqual([]);
    expect(desk.repo.undelivered(call.id)).toEqual([]);
  });
});

describe("the message history is the ledger", () => {
  it("notifications(phone) reads sent messages from the ledger", async () => {
    const { desk } = setup();
    const { issue } = await issueOnCall(desk, "Text me");
    await desk.messageCaller(issue.id, "Hello.");
    expect(desk.repo.notifications(EZRA)).toMatchObject([{ phone: EZRA, channel: "imessage", text: "Hello.", issues: [issue.id] }]);
  });
});

describe("the PM sees worker comments and what wasn't heard, and can tell the caller", () => {
  it("both triggers read plainly in its snapshot, and tell_caller is one of its tools", async () => {
    const { pmTools, snapshot } = await import("../src/pm.js");
    const { desk } = setup();
    const { call, issue } = await issueOnCall(desk, "Find a gift");
    const text = snapshot(desk, [
      { kind: "worker_comment", issue: issue.id, text: "Held: 'Bonbons from Casa de Chocolates.'" },
      { kind: "unheard", issue: issue.id, call: call.id, unheard: ["I found bonbons."] },
    ]);
    expect(text).toContain(`worker_comment on #${issue.id}: Held: 'Bonbons`);
    expect(text).toContain(`unheard: conversation ${call.id} ended; these never reached them`);
    expect(text).toContain("- I found bonbons.");
    expect(pmTools(desk).map((t) => t.name)).toContain("tell_caller");
  });
});

describe("'text' is the iMessage channel", () => {
  it("send_to_caller takes channel text and sends it by iMessage", async () => {
    const { workerTools } = await import("../src/worker-tools.js");
    const { desk, sent } = setup({ decide: async () => ({ action: "send", channel: "email", p: 0.6 }) });
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
      expect(t.checks).toEqual([]);
      expect(t.desk.repo.inbox(t.call.id, 0).at(-1)).toMatchObject({ text: "Here they are.", issue: t.issue.id });
    }
  });

  it("the check knows the conversation's channel and the default reply channel for it", async () => {
    const v = await onChannel("voice");
    await v.desk.messageCaller(v.issue.id, "Here they are.");
    expect(v.checks[0]).toMatchObject({ conversation: "voice", defaultChannel: "imessage" });
  });

  it("text_instead: an email to the caller from a text thread is stopped, and the worker is told to text it", async () => {
    const t = await onChannel("imessage", { decide: async () => ({ action: "text_instead", p: 0.8 }) });
    const r = await t.host.last(t.issue.id).role.guard!("app_gmail_send_email", { recipient_email: "ezra@personal.example.com", subject: "Flight links", body: "Delta 2:08 PM: https://delta.com/x" });
    expect(r).toMatchObject({ block: true, reason: expect.stringMatching(/send_to_caller/) });
    expect(t.desk.repo.ledger(t.issue.id).at(-1)).toMatchObject({ decision: "text_instead", ok: false });
  });

  it("a drop Jev isn't sure of is held instead, so a coin flip never loses a message", async () => {
    const t = await onChannel("voice", { decide: async () => ({ action: "drop", p: 0.56 }) });
    const r = await t.desk.messageCaller(t.issue.id, "Here's the flights page: https://kloru.com/a/x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/held/i);
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

describe("one outbox: the text talker's messages pass the same check (#37)", () => {
  async function thread(desk: Desk) {
    const { call } = desk.startCall({ callSid: "imessage:evt_1", phone: EZRA, channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "What's the link to the parking at SFO?" });
    return call;
  }

  it("send: goes out on the thread's own transport, becomes a turn, and is in the ledger", async () => {
    const { desk, checks } = setup();
    const call = await thread(desk);
    const out: string[] = [];
    const r = await desk.sendInConversation(call.id, { text: "On it.", replyingTo: "What's the link to the parking at SFO?", send: async (t) => (out.push(t), true) });
    expect(r).toBe("sent");
    expect(out).toEqual(["On it."]);
    expect(checks.at(-1)).toMatchObject({ from: "talker", toCaller: true, channels: ["imessage"], replyingTo: "What's the link to the parking at SFO?", conversation: "imessage" });
    expect(desk.repo.turns(call.id, 0).at(-1)).toMatchObject({ role: "kloru", text: "On it." });
    expect(desk.recentMessages(EZRA).at(-1)).toMatch(/sent \(imessage to \+14155550190\): On it\./);
  });

  it("drop and hold: nothing goes out, no turn, and the ledger keeps it", async () => {
    for (const action of ["drop", "hold"] as const) {
      const { desk } = setup({ decide: async () => ({ action, p: 0.95 }) });
      const call = await thread(desk);
      const out: string[] = [];
      const r = await desk.sendInConversation(call.id, { text: "Here are the SFO links again.", send: async (t) => (out.push(t), true) });
      expect(r).toBe(action === "drop" ? "dropped" : "held");
      expect(out).toEqual([]);
      expect(desk.repo.turns(call.id, 0).map((t) => t.role)).toEqual(["caller"]);
      expect(desk.recentMessages(EZRA).at(-1)).toMatch(new RegExp(`${action === "drop" ? "dropped" : "held"}, never sent \\(imessage`));
    }
  });

  it("the check sees the talker's earlier messages as already sent", async () => {
    const { desk, checks } = setup();
    const call = await thread(desk);
    await desk.sendInConversation(call.id, { text: "SFO parking: https://kloru.com/a/abc", send: async () => true });
    await desk.sendInConversation(call.id, { text: "Here's the SFO page again: https://kloru.com/a/abc", send: async () => true });
    expect(checks.at(-1)!.recent.join("\n")).toContain("SFO parking: https://kloru.com/a/abc");
  });

  it("a held result that waited goes, even if the second look calls it a repeat: the SFO parking answer lost on 2026-11-03", async () => {
    const { desk } = setup({ decide: async () => ({ action: "drop", p: 0.95 }) });
    const call = await thread(desk);
    const out: string[] = [];
    const r = await desk.sendInConversation(call.id, { text: "Parking isn't booked yet; here's the page: https://kloru.com/a/abc", heldBefore: true, send: async (t) => (out.push(t), true) });
    expect(r).toBe("sent");
    expect(out).toHaveLength(1);
  });

  it("an unsure drop of a direct reply sends it: a missed answer costs more than a repeat", async () => {
    const { desk } = setup({ decide: async () => ({ action: "drop", p: 0.55 }) });
    const call = await thread(desk);
    const r = await desk.sendInConversation(call.id, { text: "On it.", replyingTo: "What's the link?", send: async () => true });
    expect(r).toBe("sent");
  });

  it("if the check fails, the message still goes", async () => {
    const { desk } = setup({
      decide: async () => {
        throw new Error("timeout");
      },
    });
    const call = await thread(desk);
    expect(await desk.sendInConversation(call.id, { text: "On it.", send: async () => true })).toBe("sent");
  });

  it("a failed send is recorded as failed and adds no turn", async () => {
    const { desk } = setup();
    const call = await thread(desk);
    expect(await desk.sendInConversation(call.id, { text: "On it.", send: async () => false })).toBe("failed");
    expect(desk.repo.turns(call.id, 0).map((t) => t.role)).toEqual(["caller"]);
    expect(desk.recentMessages(EZRA).at(-1)).toMatch(/failed, never sent \(imessage/);
  });

  it("a page whose link went out counts as told, so the after-conversation note doesn't send it again", async () => {
    const { desk } = setup();
    const call = await thread(desk);
    const issue = desk.fileIssue(call.id, "SFO parking options");
    const page = desk.publishArtifact(issue.id, "SFO parking", "# SFO parking");
    if (!page.ok) throw new Error(page.error);
    await desk.sendInConversation(call.id, { text: `Here it is: ${page.value.url}`, issues: [issue.id], send: async () => true });
    expect(desk.repo.artifact(page.value.id)!.emailedAt).toBeTruthy();
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

describe("one outbox review fixes", () => {
  it("a text reply is never recorded on an issue, so it never counts as a change an ops issue made", async () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "imessage:evt_9", phone: EZRA, channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "Add Cleo to the family" });
    const issue = desk.fileIssue(call.id, "Add Cleo to the family");
    await desk.sendInConversation(call.id, { text: "On it.", replyingTo: "Add Cleo to the family", send: async () => true });
    await desk.sendInConversation(call.id, { text: "Cleo's added.", issues: [issue.id], send: async () => true });
    expect(desk.repo.ledger(issue.id)).toEqual([]);
    expect(desk.recentMessages(EZRA)).toHaveLength(2);
  });

  it("a direct reply Jev would hold is sent: they're waiting for it", async () => {
    const { desk } = setup({ decide: async () => ({ action: "hold", p: 0.9 }) });
    const { call } = desk.startCall({ callSid: "imessage:evt_10", phone: EZRA, channel: "imessage" });
    expect(await desk.sendInConversation(call.id, { text: "On it.", replyingTo: "Find SFO parking", send: async () => true })).toBe("sent");
  });

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
  const CLEO = "+14155550191";
  const store = () => new MediaStore(mkdtempSync(join(tmpdir(), "coms-media-")));

  it("a worker sends the caller their photo: checked with it in view, attached, and recorded", async () => {
    const media = store();
    const photo = media.put(PNG, { mime: "image/png", name: "receipt.png", phone: EZRA });
    const { desk, sent, checks } = setup({ media });
    const { issue } = await issueOnCall(desk, "Text me that receipt");
    const r = await desk.messageCaller(issue.id, "Here's the receipt.", undefined, undefined, [photo.id]);
    expect(r.ok).toBe(true);
    expect(checks.at(-1)!.text).toBe(`Here's the receipt.\n[photo ${photo.id}]`);
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

  it("a held message with a photo sends nothing; the ledger keeps the photo's id", async () => {
    const media = store();
    const photo = media.put(PNG, { mime: "image/png", name: "receipt.png", phone: EZRA });
    const { desk, sent } = setup({ media, decide: async () => ({ action: "hold", p: 0.9 }) });
    const { issue } = await issueOnCall(desk, "Text me that receipt");
    const r = await desk.messageCaller(issue.id, "Here's the receipt.", undefined, undefined, [photo.id]);
    expect(r.ok ? "" : r.error).toContain(photo.id);
    expect(sent).toEqual([]);
    expect(desk.repo.ledger().at(-1)).toMatchObject({ decision: "hold", args: { media: [photo.id] } });
    // The PM sends the held message, photo and all, once the call is over.
    const told = await desk.tellCaller(issue.filedBy.call, "Here's the receipt.", undefined, undefined, [photo.id]);
    expect(told.ok).toBe(false);
    expect(desk.repo.ledger().at(-1)).toMatchObject({ tool: "tell_caller", args: { media: [photo.id] } });
  });
});

describe("Nov 2: the laundry-basket thread's lost results", () => {
  it("a restart doesn't lose the note for a conversation it cut off", async () => {
    const root = mkdtempSync(join(tmpdir(), "coms-restart-"));
    const { desk, host } = setup({ root });
    const { call, issue } = await issueOnCall(desk, "Find me a laundry basket");
    host.last(issue.id).finish("Found three on the page.");
    await settle(40);
    expect(desk.repo.undelivered(call.id).length).toBeGreaterThan(0);
    // The process dies mid-conversation; a new desk on the same files recovers.
    const pm = new PM();
    const again = new Desk({ root, host: new Host(), planner: pm, notify: async () => true, notifyDelayMs: 20, notifyWaitMs: 400, channelsFor: () => ["imessage"] });
    again.recover();
    await settle(120);
    expect(pm.seen.map((t) => t.kind)).toContain("unheard");
  });

  it("a page that changed since they got its link is said so to the check", async () => {
    const { desk, checks } = setup();
    const { issue } = await issueOnCall(desk, "Find me a laundry basket");
    const page = desk.publishArtifact(issue.id, "Laundry baskets", "# Laundry baskets\n- One");
    if (!page.ok) throw new Error(page.error);
    await desk.messageCaller(issue.id, `Here they are: ${page.value.url}`);
    expect(checks.at(-1)!.changedPages ?? []).toEqual([]);
    await settle(10);
    desk.updateArtifact(page.value.id, { append: "- Two" }, { issue: issue.id, phone: EZRA });
    await desk.messageCaller(issue.id, `I added more: ${page.value.url}`);
    expect(checks.at(-1)!.changedPages).toEqual(["Laundry baskets"]);
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
