import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk, type MessageCheck, type MessageDecision, type Planner, type WorkerHost } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { TextDesk, type TextDeskOptions, type TextIn } from "../src/text-desk.js";
import type { TalkerTurn } from "../src/text-talker.js";

class Host implements WorkerHost {
  run(): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

const EVAN = "+14155550190";
const settle = async (ms = 40) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

function setup(o: { reply?: (t: TalkerTurn) => string; idleMs?: number; ingest?: TextDeskOptions["ingest"]; decide?: (c: MessageCheck) => Promise<MessageDecision>; react?: (conversation: string, message: string, reaction: string) => Promise<boolean>; holdMs?: number; shape?: TextDeskOptions["shape"]; feedback?: TextDeskOptions["feedback"]; checkDraft?: TextDeskOptions["checkDraft"] } = {}) {
  const planner: Planner = { handle: async () => {} };
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "textdesk-")), host: new Host(), planner, ...(o.decide ? { decideMessage: o.decide } : {}) });
  const turns: TalkerTurn[] = [];
  const sent: string[] = [];
  const text = new TextDesk({
    desk,
    callers: (p) => (p === EVAN ? { allowed: true, name: "Evan", tier: "owner" } : { allowed: false }),
    emailPerson: (e) => (e === "evan@work.example.com" ? EVAN : undefined),
    talker: async (t) => {
      turns.push(t);
      if (!t.event) t.tools.fileIssue(t.thread.at(-1)!.text);
      return o.reply ? o.reply(t) : t.event ? "Here's what I found." : "On it.";
    },
    send: {
      imessage: async (to, body) => (sent.push(`imessage ${to}: ${body}`), true),
      email: async (to, subject, body, thread) => (sent.push(`email ${to} [${subject}] re ${thread.inReplyTo}: ${body}`), true),
      ...(o.react ? { react: o.react } : {}),
    },
    idleMs: o.idleMs ?? 10_000,
    burstMs: 10,
    ...(o.holdMs !== undefined ? { holdMs: o.holdMs } : {}),
    ...(o.ingest ? { ingest: o.ingest } : {}),
    ...(o.shape ? { shape: o.shape } : {}),
    ...(o.feedback ? { feedback: o.feedback } : {}),
    ...(o.checkDraft ? { checkDraft: o.checkDraft } : {}),
    timezone: "America/Los_Angeles",
    log: () => {},
  });
  return { desk, text, turns, sent };
}

const imsg = (id: string, body: string, from = EVAN): TextIn => ({ channel: "imessage", id, from, thread: `imessage:${from}`, text: body });
const mail = (id: string, body: string, o: Partial<TextIn> = {}): TextIn => ({ channel: "email", id, from: "evan@work.example.com", thread: "<root@work.example.com>", text: body, subject: "Dentist", messageId: `<${id}@work.example.com>`, references: ["<root@work.example.com>"], dmarc: "pass", ...o });

describe("texts and emails become desk conversations", () => {
  it("a text from Evan opens a conversation, files the request, and gets a reply in the thread", async () => {
    const { desk, text, sent, turns } = setup();
    await text.receive(imsg("m1", "What's on tomorrow?"));
    const call = desk.repo.liveCallFor(EVAN)!;
    expect(call.channel).toBe("imessage");
    expect(desk.repo.turns(call.id, 0).map((t) => `${t.role}: ${t.text}`)).toEqual(["caller: What's on tomorrow?", "kloru: On it."]);
    expect(desk.openIssues()).toHaveLength(1);
    expect(sent).toEqual([`imessage ${EVAN}: On it.`]);
    expect(turns[0]!.channel).toBe("imessage");
  });

  it("someone who isn't family gets no reply and no conversation", async () => {
    const { desk, text, sent } = setup();
    await text.receive(imsg("m1", "hi", "+14155550123"));
    expect(sent).toEqual([]);
    expect(desk.repo.liveCalls()).toEqual([]);
  });

  it("an email from Evan's address only counts as Evan when it passed DMARC", async () => {
    const { desk, text, sent } = setup();
    await text.receive(mail("e1", "When's the dentist?", { dmarc: "fail" }));
    expect(sent).toEqual([]);
    expect(desk.repo.liveCalls()).toEqual([]);
    await text.receive(mail("e2", "When's the dentist?"));
    expect(sent).toEqual(["email evan@work.example.com [Re: Dentist] re <e2@work.example.com>: On it."]);
  });

  it("someone else replying in Evan's email thread never joins his conversation or gets his replies", async () => {
    const CARA = "+14155550191";
    const planner: Planner = { handle: async () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "textdesk-")), host: new Host(), planner });
    const sent: string[] = [];
    const text = new TextDesk({
      desk,
      callers: (p) => (p === EVAN || p === CARA ? { allowed: true, tier: p === EVAN ? "owner" : "partner" } : { allowed: false }),
      emailPerson: (e) => (e === "evan@work.example.com" ? EVAN : e === "cara@gmail.com" ? CARA : undefined),
      talker: async () => "On it.",
      send: { email: async (to) => (sent.push(to), true) },
      timezone: "America/Los_Angeles",
      log: () => {},
    });
    await text.receive(mail("e1", "Find a dentist"));
    await text.receive(mail("e2", "Also book it for me", { from: "cara@gmail.com" }));
    const evans = desk.repo.liveCallFor(EVAN)!;
    const caras = desk.repo.liveCallFor(CARA)!;
    expect(caras.id).not.toBe(evans.id);
    expect(desk.repo.turns(evans.id, 0).map((t) => t.text)).not.toContain("Also book it for me");
    expect(sent).toEqual(["evan@work.example.com", "cara@gmail.com"]);
  });

  it("the same message delivered twice is handled once", async () => {
    const { text, sent } = setup();
    await text.receive(imsg("m1", "What's on tomorrow?"));
    await text.receive(imsg("m1", "What's on tomorrow?"));
    expect(sent).toHaveLength(1);
  });

  it("a result that lands becomes one message in the thread, and is acknowledged", async () => {
    const { desk, text, sent, turns } = setup();
    await text.receive(imsg("m1", "What's on tomorrow?"));
    const call = desk.repo.liveCallFor(EVAN)!;
    desk.resolve(1, "Tomorrow: drop-off at 8.");
    await settle(120);
    expect(turns.at(-1)!.event).toContain("Tomorrow: drop-off at 8.");
    expect(sent.at(-1)).toBe(`imessage ${EVAN}: Here's what I found.`);
    expect(desk.repo.undelivered(call.id)).toEqual([]);
  });

  it("quiet for the idle time ends the conversation once; the next text starts a new one", async () => {
    const { desk, text } = setup({ idleMs: 50 });
    await text.receive(imsg("m1", "What's on tomorrow?"));
    const first = desk.repo.liveCallFor(EVAN)!;
    await settle(120);
    expect(desk.repo.call(first.id)!.endedAt).toBeDefined();
    await text.receive(imsg("m2", "And Friday?"));
    const second = desk.repo.liveCallFor(EVAN)!;
    expect(second.id).not.toBe(first.id);
  });

  it("nothing new to say sends nothing", async () => {
    const { text, sent } = setup({ reply: () => "" });
    await text.receive(imsg("m1", "thanks!"));
    expect(sent).toEqual([]);
  });
});

describe("a result that can't be sent", () => {
  it("stays undelivered, so the note after the conversation carries it", async () => {
    const planner: Planner = { handle: async () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "textdesk-")), host: new Host(), planner });
    let up = true;
    const text = new TextDesk({
      desk,
      callers: (p) => (p === EVAN ? { allowed: true, tier: "owner" } : { allowed: false }),
      emailPerson: () => undefined,
      talker: async (t) => (t.event ? "Found it." : (t.tools.fileIssue("x"), "On it.")),
      send: { imessage: async () => up },
      burstMs: 10,
      timezone: "America/Los_Angeles",
      log: () => {},
    });
    await text.receive(imsg("m1", "What's on tomorrow?"));
    const call = desk.repo.liveCallFor(EVAN)!;
    up = false;
    desk.resolve(1, "Tomorrow: drop-off at 8.");
    await settle(120);
    expect(desk.repo.undelivered(call.id).map((m) => m.text)).toEqual(["Tomorrow: drop-off at 8."]);
  });
});

describe("Evan answers an ask by text", () => {
  it("a waiting ask is in the first turn's context with its draft id, and isn't asked again", async () => {
    const CARA = "+14155550191";
    const planner: Planner = { handle: async () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "textdesk-")), host: new Host(), planner, ownerPhone: EVAN, nameOf: (p) => (p === CARA ? "Cara" : "Evan") });
    const caraCall = desk.startCall({ callSid: "CA2", phone: CARA, channel: "voice" }).call;
    const issue = desk.fileIssue(caraCall.id, "Move Evan's 3 PM to 4");
    desk.assign(issue.id, "ops", "Move it", []);
    expect(desk.askOwner(issue.id, "move Evan's 3 PM to 4 PM").ok).toBe(true);
    const draft = desk.repo.issue(issue.id)!.confirmation!.id;
    const turns: TalkerTurn[] = [];
    const sent: string[] = [];
    const text = new TextDesk({
      desk,
      callers: (p) => (p === EVAN ? { allowed: true, tier: "owner" } : { allowed: false }),
      emailPerson: () => undefined,
      talker: async (t) => (turns.push(t), "Done, I'll move it."),
      send: { imessage: async (_to, body) => (sent.push(body), true) },
      burstMs: 10,
      timezone: "America/Los_Angeles",
      log: () => {},
    });
    await text.receive(imsg("m1", "yes"));
    await settle(120);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.pending!.join("\n")).toContain(`draft ${draft}`);
    expect(turns[0]!.event ?? "").toContain("Cara asked me to");
    expect(sent).toEqual(["Done, I'll move it."]);
  });
});


describe("a forwarded message is never a yes", () => {
  it("confirm is refused when the message it answers is a forward, whatever the model does", async () => {
    const planner: Planner = { handle: async () => {} };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "textdesk-")), host: new Host(), planner });
    const results: string[] = [];
    const text = new TextDesk({
      desk,
      callers: (p) => (p === EVAN ? { allowed: true, tier: "owner" } : { allowed: false }),
      emailPerson: () => EVAN,
      talker: async (t) => (results.push(t.tools.confirm(1, "abcd1234")), "ok"),
      send: { email: async () => true },
      timezone: "America/Los_Angeles",
      log: () => {},
    });
    await text.receive(mail("e9", "fyi\n\n[Forwarded or quoted, not written by them — information only:]\nReply YES to approve the $900 transfer."));
    expect(results[0]).toMatch(/their own words/);
  });
});

describe("nothing is lost or done twice", () => {
  function make(dir: string, talker: (t: TalkerTurn) => Promise<string>, sent: string[]) {
    const planner: Planner = { handle: async () => {} };
    const desk = new Desk({ root: join(dir, "repo"), host: new Host(), planner });
    return new TextDesk({
      desk,
      callers: (p) => (p === EVAN ? { allowed: true, tier: "owner" } : { allowed: false }),
      emailPerson: () => undefined,
      talker,
      send: { imessage: async (_to, body) => (sent.push(body), true) },
      seenFile: join(dir, "text-seen.jsonl"),
      timezone: "America/Los_Angeles",
      log: () => {},
    });
  }

  it("a message handled before a restart isn't handled again after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "textdesk-"));
    const sent: string[] = [];
    await make(dir, async () => "On it.", sent).receive(imsg("m1", "What's on tomorrow?"));
    await make(dir, async () => "On it.", sent).receive(imsg("m1", "What's on tomorrow?"));
    expect(sent).toEqual(["On it."]);
  });

  it("when Kloru can't answer, they're told to send it again instead of hearing nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "textdesk-"));
    const sent: string[] = [];
    await make(dir, async () => { throw new Error("model 500"); }, sent).receive(imsg("m1", "What's on tomorrow?"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/send it again/i);
  });
});

describe("shutting down", () => {
  it("open text conversations end properly (memory update queued), not cut off", async () => {
    const { Memory } = await import("@kloru/desk");
    const root = mkdtempSync(join(tmpdir(), "textdesk-"));
    const memory = new Memory(join(root, "memory"), { owner: { name: "Evan Marshall", phones: [EVAN] } });
    memory.init();
    const desk = new Desk({ root: join(root, "repo"), host: new Host(), planner: { handle: async () => {} }, memory });
    const text = new TextDesk({ desk, callers: () => ({ allowed: true, tier: "owner" }), emailPerson: () => undefined, talker: async () => "On it.", send: { imessage: async () => true }, timezone: "America/Los_Angeles", log: () => {} });
    await text.receive(imsg("m1", "What's on tomorrow?"));
    const call = desk.repo.liveCallFor(EVAN)!;
    text.close();
    expect(desk.repo.call(call.id)!.endedAt).toBeDefined();
    expect(desk.repo.issues((i) => i.purpose === "memory" && i.filedBy.call === call.id)).toHaveLength(1);
  });
});

describe("photos and files sent by text or email", () => {
  it("each one is kept and noted in the conversation, so workers can look at it", async () => {
    const got: Array<{ url: string; phone: string }> = [];
    const { desk, text } = setup({ ingest: async (a, phone) => (got.push({ url: a.url, phone }), { id: "m_0123456789abcdef.jpg", mime: "image/jpeg", name: "IMG_1.jpg", size: 10, at: "", phone }) });
    await text.receive({ channel: "imessage", id: "m1", from: EVAN, thread: `imessage:${EVAN}`, text: "What's on this receipt?", attachments: [{ url: "https://media.inkbox.ai/x.jpg", mime: "image/jpeg", name: "IMG_1.jpg" }] });
    expect(got).toEqual([{ url: "https://media.inkbox.ai/x.jpg", phone: EVAN }]);
    const call = desk.repo.callsFor(EVAN)[0]!;
    expect(desk.repo.turns(call.id, 0)[0]!.text).toBe("What's on this receipt?\n[photo m_0123456789abcdef.jpg]");
  });

  it("a photo with no words still starts a conversation", async () => {
    const { desk, text } = setup({ ingest: async (_a, phone) => ({ id: "m_0123456789abcdef.png", mime: "image/png", name: "a.png", size: 1, at: "", phone }) });
    await text.receive({ channel: "imessage", id: "m2", from: EVAN, thread: `imessage:${EVAN}`, text: "", attachments: [{ url: "https://media.inkbox.ai/a.png" }] });
    expect(desk.repo.turns(desk.repo.callsFor(EVAN)[0]!.id, 0)[0]!.text).toBe("[photo m_0123456789abcdef.png]");
  });

  it("nothing is downloaded from someone who isn't family", async () => {
    const got: string[] = [];
    const { text } = setup({ ingest: async (a) => (got.push(a.url), undefined) });
    await text.receive({ channel: "imessage", id: "m3", from: "+15550001111", thread: "imessage:+15550001111", text: "hi", attachments: [{ url: "https://evil.example/x.exe" }] });
    expect(got).toEqual([]);
  });

  it("one that can't be kept is said so, and the rest go on", async () => {
    const { desk, text } = setup({ ingest: async () => { throw new Error("files of type application/x-msdownload aren't kept"); } });
    await text.receive({ channel: "imessage", id: "m4", from: EVAN, thread: `imessage:${EVAN}`, text: "see attached", attachments: [{ url: "https://media.inkbox.ai/x.exe", name: "x.exe" }] });
    expect(desk.repo.turns(desk.repo.callsFor(EVAN)[0]!.id, 0)[0]!.text).toMatch(/see attached\n\[x\.exe couldn't be kept: files of type/);
  });
});

describe("one outbox: every message in a thread passes the check (#37)", () => {
  it("a reply to their text is checked as a direct answer and recorded in the ledger", async () => {
    const checks: MessageCheck[] = [];
    const { desk, text, sent } = setup({ decide: async (c) => (checks.push(c), { action: "send", p: 0.9 }) });
    await text.receive(imsg("m1", "What's the link to the parking at SFO?"));
    expect(sent).toEqual([`imessage ${EVAN}: On it.`]);
    expect(checks[0]).toMatchObject({ from: "talker", replyingTo: "What's the link to the parking at SFO?" });
    expect(desk.recentMessages(EVAN).at(-1)).toMatch(/sent \(imessage to \+14155550190\): On it\./);
  });

  it("a dropped result isn't sent but counts as told", async () => {
    const { desk, text, sent } = setup({ decide: async (c) => ({ action: c.replyingTo ? "send" : "drop", p: 0.95 }) });
    await text.receive(imsg("m1", "What's on tomorrow?"));
    const call = desk.repo.liveCallFor(EVAN)!;
    desk.resolve(desk.openIssues()[0]!.id, "Dentist at 3.");
    await settle(80);
    expect(sent).toEqual([`imessage ${EVAN}: On it.`]);
    expect(desk.repo.call(call.id)!.deliveredSeq).toBe(1);
  });

  it("a held result waits, then goes out with the next result as one message", async () => {
    let hold = true;
    const { desk, text, sent, turns } = setup({ decide: async (c) => ({ action: c.replyingTo || !hold ? "send" : "hold", p: 0.95 }) });
    await text.receive(imsg("m1", "Find SFO parking and a mailbox plan"));
    const call = desk.repo.liveCallFor(EVAN)!;
    const [a] = desk.openIssues();
    desk.resolve(a!.id, "SFO long-term is $27 a day.");
    await settle(80);
    expect(sent).toHaveLength(1);
    expect(desk.repo.call(call.id)!.deliveredSeq).toBe(0);
    const talkerCalls = turns.length;
    await settle(80);
    expect(turns.length).toBe(talkerCalls); // no busy loop while nothing new arrives
    hold = false;
    const b = desk.fileIssue(call.id, "Mailbox plan");
    desk.resolve(b.id, "Mailbox plan is on your page.");
    await settle(80);
    expect(sent).toHaveLength(2);
    expect(turns.at(-1)!.event).toContain("SFO long-term");
    expect(turns.at(-1)!.event).toContain("Mailbox plan");
    expect(desk.repo.call(call.id)!.deliveredSeq).toBe(2);
  });
});

describe("held results are part of the next reply (review fix)", () => {
  it("their next text is answered with the held result in view, and it isn't sent again after", async () => {
    let hold = true;
    const { desk, text, sent, turns } = setup({ decide: async (c) => ({ action: c.replyingTo || !hold ? "send" : "hold", p: 0.95 }) });
    await text.receive(imsg("m1", "Find SFO parking"));
    const call = desk.repo.liveCallFor(EVAN)!;
    desk.resolve(desk.openIssues()[0]!.id, "SFO long-term is $27 a day.");
    await settle(80);
    expect(sent).toHaveLength(1);
    hold = false;
    await text.receive(imsg("m2", "Any news?"));
    expect(turns.at(-1)!.event).toContain("SFO long-term");
    expect(sent).toHaveLength(2);
    expect(desk.repo.call(call.id)!.deliveredSeq).toBe(1);
    await settle(80);
    expect(sent).toHaveLength(2);
  });
});

describe("a text that starts work gets a reaction, not a message", () => {
  const onIt = (t: TalkerTurn) => (t.event ? "Done: spam is cleared every morning at 7." : t.tools.react ? (t.tools.react("eyes"), "") : "On it.");
  const reactTo = { conversation: "imessage:conv1", message: "msg1" };

  it("the talker can react to their message; it's recorded and nothing else is sent", async () => {
    const reacted: string[] = [];
    const { desk, text, sent } = setup({ reply: onIt, react: async (c, m, r) => (reacted.push(`${c} ${m} ${r}`), true) });
    await text.receive({ ...imsg("m1", "Delete sales spam every morning"), reactTo });
    await settle();
    const call = desk.repo.liveCallFor(EVAN)!;
    expect(reacted).toEqual(["imessage:conv1 msg1 eyes"]);
    expect(sent).toEqual([]);
    expect(desk.repo.ledger().filter((e) => e.call === call.id).map((e) => `${e.tool} ${e.ok}`)).toEqual(["react true"]);
    expect(desk.repo.turns(call.id, 0).map((t) => t.text)).toEqual(["Delete sales spam every morning"]);
  });

  it("the result is then the one message", async () => {
    const { desk, text, sent } = setup({ reply: onIt, react: async () => true });
    await text.receive({ ...imsg("m1", "Delete sales spam every morning"), reactTo });
    const issue = desk.openIssues()[0]!;
    desk.merge(issue.id, "events", "I saved the daily 7 AM sales-spam cleanup.");
    await settle(200);
    expect(sent).toEqual([`imessage ${EVAN}: Done: spam is cleared every morning at 7.`]);
  });

  it("a reaction that fails becomes a short text", async () => {
    const { text, sent } = setup({ reply: onIt, react: async () => { throw new Error("Inkbox down"); } });
    await text.receive({ ...imsg("m1", "Delete sales spam every morning"), reactTo });
    await settle();
    expect(sent).toEqual([`imessage ${EVAN}: On it.`]);
  });

  it("without the message's ids (or by email) there's no react tool", async () => {
    const { text, turns } = setup({ react: async () => true });
    await text.receive(imsg("m1", "What's on tomorrow?"));
    await text.receive(mail("e1", "When's the dentist?", { reactTo } as Partial<TextIn>));
    expect(turns.map((t) => !!t.tools.react)).toEqual([false, false]);
  });
});

describe("Nov 2: a held result still reaches them", () => {
  it("a result held with nothing to wait for goes on its own after holdMs, once", async () => {
    // Jev holds every result that isn't a direct reply, as it did with the laundry baskets.
    const { desk, text, sent } = setup({ holdMs: 80, decide: async (c) => (c.replyingTo ? { action: "send", p: 0.9 } : { action: "hold", p: 0.9 }) });
    await text.receive(imsg("m1", "Find me a laundry basket"));
    const issue = desk.openIssues()[0]!;
    desk.merge(issue.id, "info", "I updated the page with four options up to $100.");
    await settle(40);
    expect(sent).toEqual([`imessage ${EVAN}: On it.`]);
    await settle(250);
    expect(sent).toEqual([`imessage ${EVAN}: On it.`, `imessage ${EVAN}: Here's what I found.`]);
    const call = desk.repo.liveCallFor(EVAN)!;
    expect(desk.repo.undelivered(call.id)).toEqual([]);
  });
});

describe("a card number sent by text (2026-11-02)", () => {
  it("is removed before the transcript or the talker sees it", async () => {
    const { desk, text, turns } = setup();
    await text.receive(imsg("m1", "use my card 4242 4242 4242 4242 exp 12/29 for the order"));
    const call = desk.repo.liveCallFor(EVAN)!;
    const said = desk.repo.turns(call.id, 0)[0]!.text;
    expect(said).not.toContain("4242 4242");
    expect(said).toContain("[card number removed]");
    expect(JSON.stringify(turns)).not.toContain("4242 4242");
  });
});

describe("follow-ups and questions (SFO parking, 2026-11-03)", () => {
  it("the talker sees their open requests, so a follow-up updates one instead of filing it again", async () => {
    const { desk, text, turns } = setup();
    await text.receive(imsg("m1", "Book SFO long-term parking"));
    const [open] = desk.openIssues();
    await text.receive(imsg("m2", "Use the card I just added"));
    expect(turns.at(-1)!.open).toEqual([`issue ${open!.id}: ${open!.request}`]);
  });

  it("a question from the PM goes out at once, even when the check would hold it", async () => {
    const { desk, text, sent } = setup({ decide: async (c) => ({ action: c.replyingTo ? "send" : "hold", p: 0.95 }), reply: (t) => (t.event ? "Did you see a $78 charge from SFO?" : "On it.") });
    await text.receive(imsg("m1", "Book SFO long-term parking"));
    const [issue] = desk.openIssues();
    expect(desk.askCaller(issue!.id, "Do you see a $78 charge from SFO in Wallet?").ok).toBe(true);
    await settle(120);
    expect(sent.at(-1)).toContain("Did you see a $78 charge from SFO?");
  });
});

describe("each message shaped the way they like it (2026-11-03)", () => {
  const reactTo = { conversation: "imessage:conv1", message: "msg1" };

  it("the shape is decided first, from their preferences, and the writer gets it", async () => {
    const asked: Array<Parameters<NonNullable<TextDeskOptions["shape"]>>[0]> = [];
    const { desk, text, turns } = setup({ shape: async (s) => (asked.push(s), { form: "detailed", link: true }) });
    desk.learnMessagePreference = () => {};
    desk.messagePreferences = () => "- Wants the whole comparison for research (2026-11-03)";
    await text.receive(imsg("m1", "Compare the three dentists near us"));
    expect(asked[0]).toMatchObject({ kind: "their_message", theirMessage: "Compare the three dentists near us", preferences: "- Wants the whole comparison for research (2026-11-03)" });
    expect(turns.at(-1)!.shape).toEqual({ form: "detailed", link: true });
  });

  it("a result whose shape is a reaction gets 👍 on the message that asked, and no text", async () => {
    const reacted: string[] = [];
    const { desk, text, sent } = setup({
      react: async (c, m, r) => (reacted.push(`${m} ${r}`), true),
      shape: async (s) => ({ form: s.kind === "result" ? "emoji" : "emoji", link: false }),
      reply: (t) => ((t.event ? t.tools.react?.("like") : t.tools.react?.("eyes")), ""),
    });
    await text.receive({ ...imsg("m1", "Add milk to the grocery list"), reactTo });
    const [issue] = desk.openIssues();
    desk.merge(issue!.id, "events", "Added milk to the grocery list.");
    await settle(120);
    expect(reacted).toEqual(["msg1 eyes", "msg1 like"]);
    expect(sent).toEqual([]);
  });

  it("their reply to a result teaches how they like messages", async () => {
    const lessons: string[] = [];
    const { desk, text } = setup({
      shape: async () => ({ form: "short", link: false }),
      feedback: async (f) => (f.reply.includes("link") ? `Wanted the link for "${f.asked}"` : undefined),
    });
    desk.learnMessagePreference = (_p, line) => void lessons.push(line);
    await text.receive(imsg("m1", "Find a pediatric dentist"));
    const [issue] = desk.openIssues();
    desk.merge(issue!.id, "info", "Rockridge Kids Dental has openings; the comparison is at https://kloru.com/a/abcdefghijklmnopqrstuv");
    await settle(120);
    await text.receive(imsg("m2", "Can you send the link?"));
    await settle(40);
    expect(lessons).toEqual(['Wanted the link for "Find a pediatric dentist"']);
  });
});

describe("a draft that doesn't fit goes back once (2026-11-03)", () => {
  it("too long for them: the writer redrafts with the reason and the whole thread was weighed; only the new draft goes, and nothing is filed twice", async () => {
    const checked: Array<Parameters<NonNullable<TextDeskOptions["checkDraft"]>>[0]> = [];
    const { desk, text, sent, turns } = setup({
      checkDraft: async (d) => (checked.push(d), { verdict: d.draft.length > 20 ? "too_long" : "fits", p: 0.9 }),
      reply: (t) => (t.redraft ? "On it." : "I'm on it, I'll look that up and let you know shortly."),
    });
    await text.receive(imsg("m1", "What's on tomorrow?"));
    expect(sent).toEqual([`imessage ${EVAN}: On it.`]);
    expect(turns.at(-1)!.redraft).toEqual({ draft: "I'm on it, I'll look that up and let you know shortly.", why: "Too long for them: make it shorter." });
    expect(checked[0]!.thread).toEqual(["Them: What's on tomorrow?"]);
    expect(checked).toHaveLength(1);
    expect(desk.openIssues()).toHaveLength(1);
  });
});
