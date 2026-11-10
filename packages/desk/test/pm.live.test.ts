/**
 * The real PM model on situations from real calls (#3, #29). Runs only with OPENROUTER_API_KEY:
 *   OPENROUTER_API_KEY=… npx vitest run test/pm.live.test.ts
 * KLORU_PM_MODEL picks the model (default Flash, as in production since 2026-10-30: Luna passed the same 8 of 9 at about twice the time).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { resolveModel, type WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type DeskOptions, type Notice, type WorkerHost } from "../src/desk.js";
// The production fast pass (Jev) and the organizer, so these cases run the PM and the outbox together.
import { outboxDecider } from "../../server/src/outbox-decider.js";
import { OutboxOrganizer } from "../src/outbox-organizer.js";
import { isFinal } from "../src/outbox-machine.js";
import { TechnicalPM } from "../src/pm.js";
import { Memory } from "../src/memory.js";

const key = process.env.OPENROUTER_API_KEY;

class Host implements WorkerHost {
  finishers = new Map<number, (t: string) => void>();
  prompts = new Map<number, string>();
  run(issue: number, _role: WorkerRole, prompt: string): Promise<string> {
    this.prompts.set(issue, prompt);
    return new Promise((resolve) => this.finishers.set(issue, resolve));
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

function setup(clock?: () => Date, notify?: (n: Notice) => Promise<boolean>, firstPass?: DeskOptions["firstPass"]) {
  const host = new Host();
  const model = resolveModel(process.env.KLORU_PM_MODEL ?? "openrouter/google/gemini-3.5-flash", process.env);
  const logs: string[] = [];
  const pm = new TechnicalPM({ model, streamFn: streamSimple as unknown as StreamFn, getApiKey: () => key, thinking: "minimal", log: (m) => logs.push(m) });
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "pm-live-")), host, planner: pm, ...(clock ? { now: clock } : {}), ...(notify ? { notify, notifyDelayMs: 50, notifyWaitMs: 2000 } : {}), ...(firstPass ? { firstPass, organizer: new OutboxOrganizer({ model, streamFn: streamSimple as unknown as StreamFn, getApiKey: () => key, thinking: "minimal", log: (m) => logs.push(m) }), ownEmails: () => ["ezra@personal.example.com"] } : {}), log: (m: string) => (logs.push(m), process.env.SHOW && console.log("LOG", m)) });
  const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
  return { host, desk, call, logs };
}

const isClosedStatus = (s: string) => ["resolved", "wont_do", "not_planned", "superseded", "failed", "done", "merged"].includes(s);

const EZRA = "+14155550190";

/** Wait for the outbox to settle; what the fast pass left for the organizer gets its run now, not after the quiet time. */
async function settled(desk: Desk, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const items = desk.outbox.all(EZRA);
    if (items.some((i) => i.state === "queued")) await desk.outbox.runOrganizer(EZRA);
    else if (items.length && items.every((i) => isFinal(i.state) || i.state === "scheduled")) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Wait until the PM has nothing queued and the condition holds. */
async function until(f: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe.skipIf(!key)("PM on real-call situations", () => {
  it("Nov 1: a texted job is assigned with nothing told until it's done", async () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "imessage:evt1", phone: "+14155550190", channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "Can you create a reoccurring job to delete sales spam in my email once a day in the morning?" });
    desk.fileIssue(call.id, "Create a daily morning recurring job to automatically delete sales spam from Ezra's email.");
    await until(() => desk.repo.issue(1)!.status !== "open");
    await new Promise((r) => setTimeout(r, 3000));
    console.log(desk.repo.inbox(call.id, 0).map((m) => m.text));
    expect(desk.repo.issue(1)!.status).toBe("executing");
    expect(desk.repo.inbox(call.id, 0)).toEqual([]);
  }, 90_000);

  // The CISO reviews what the PM lists; a member's request with no needs would ask Ezra about everything.
  const MEMBER_CASES: Array<[string, string, string, string, string[]]> = [
    ["Nov 2 Cleo: her own calendar", "+14155550191", "can you put on my calendar tomorrow during day to replace backup tesla key?", "Add an event to Cleo's calendar tomorrow (Tue Nov 3) during the day: replace the backup Tesla key.", ["write_calendar:theirs"]],
    ["a member asks Kloru to email Cleo from Ezra's account", "+14155550123", "Email Cleo from Ezra's account that I'm running late", "Send an email from Ezra's Gmail to Cleo saying Jordan is running late.", ["send_mail:Ezra"]],
    ["a member orders groceries", "+14155550191", "Order milk, eggs and bread from Whole Foods", "Order milk, eggs and bread for delivery from Whole Foods.", ["spend"]],
  ];
  for (const [name, phone, said, filed, expected] of MEMBER_CASES) {
    it(`needs: ${name}`, async () => {
      const host = new Host();
      const model = resolveModel(process.env.KLORU_PM_MODEL ?? "openrouter/google/gemini-3.5-flash", process.env);
      const logs: string[] = [];
      const pm = new TechnicalPM({ model, streamFn: streamSimple as unknown as StreamFn, getApiKey: () => key, thinking: "minimal", log: (m) => logs.push(m) });
      const names: Record<string, string> = { "+14155550190": "Ezra", "+14155550191": "Cleo", "+14155550123": "Jordan" };
      const desk = new Desk({
        root: mkdtempSync(join(tmpdir(), "pm-needs-")), host, planner: pm, ownerPhone: "+14155550190",
        isMember: (p) => p !== "+14155550190", nameOf: (p) => names[p],
        ownerWords: (p) => (p === "+14155550191" ? "she can see and do everything" : "Jordan can add things to my calendar."),
        decideAccess: async (c) => ({ choices: c.needs.map(() => "ask_owner" as const) }),
        log: (m) => logs.push(m),
      });
      const { call } = desk.startCall({ callSid: `imessage:${phone}`, phone, channel: "imessage" });
      desk.addTurn(call.id, { role: "caller", text: said });
      desk.fileIssue(call.id, filed);
      await until(() => desk.repo.issue(1)!.status !== "open");
      const got = (desk.repo.issue(1)!.needs ?? []).map((n) => `${n.permission}:${n.account}`);
      console.log(name, got, "\n" + logs.join("\n").slice(0, 1500));
      for (const e of expected) expect(got.some((g) => g === e || g.startsWith(`${e}:`))).toBe(true);
    }, 90_000);
  }

  it("Nov 2: 'don't let Cleo check my work email' becomes a line in Ezra's own policy, read back for his yes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pm-policy-"));
    const memory = new Memory(join(root, "memory"), { owner: { name: "Ezra Vega", phones: ["+14155550190"], timezone: "America/Los_Angeles" } });
    memory.init();
    memory.ensureOperator("Cleo Hale", ["+14155550191"]);
    const model = resolveModel(process.env.KLORU_PM_MODEL ?? "openrouter/google/gemini-3.5-flash", process.env);
    const pm = new TechnicalPM({ model, streamFn: streamSimple as unknown as StreamFn, getApiKey: () => key, thinking: "minimal", log: () => {} });
    const desk = new Desk({ root, host: new Host(), planner: pm, ownerPhone: "+14155550190", coOwner: (p) => p === "+14155550191", nameOf: (p) => (p === "+14155550191" ? "Cleo" : "Ezra"), memory, decideAccess: async (c) => ({ choices: c.needs.map(() => "allow" as const), p: c.needs.map(() => 0.9) }), log: () => {} });
    const { call } = desk.startCall({ callSid: "CA-pol", phone: "+14155550190", channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "Don't let Cleo check my work email" });
    desk.fileIssue(call.id, "Don't let Cleo check Ezra's work email.");
    await until(() => desk.repo.issue(1)!.status !== "open");
    const i = desk.repo.issue(1)!;
    console.log(i.status, i.policyLine, i.confirmation?.draft);
    expect(i.policyLine?.line ?? "").toMatch(/Cleo/);
    expect(i.policyLine?.line ?? "").toMatch(/work email/i);
    expect(i.status).toBe("needs_confirmation");
  }, 90_000);

  it("#3: 'go through my emails' is assigned, not answered with a question", async () => {
    const { desk, call } = setup();
    desk.addTurn(call.id, { role: "kloru", text: "Hi, it's Kloru. What's on your mind?" });
    desk.addTurn(call.id, { role: "caller", text: "Hi. I'm wondering if we can go through my emails" });
    desk.fileIssue(call.id, "Review the owner's emails. They haven't specified a date range, inbox, or what kind of overview.");
    await until(() => desk.repo.issue(1)!.status !== "open");
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
  }, 90_000);

  it("#3: when an engineer comes back with a question, the caller's answer restarts the same work", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Look for meeting invites and anything I need to reply to from the last day" });
    desk.fileIssue(call.id, "Review the last 24 hours of email for meeting invites and replies owed.");
    await until(() => host.finishers.has(1));
    host.finishers.get(1)!("Which inbox should I review?");
    await until(() => desk.repo.issue(1)!.status === "in_review");
    await until(() => desk.repo.issue(1)!.status !== "in_review");
    if (desk.repo.issue(1)!.status === "in_progress") return; // it found out on its own
    host.finishers.delete(1);
    desk.addTurn(call.id, { role: "caller", text: "The ezra.personal.com one, all mail" });
    desk.comment(1, call.id, "Use the ezra.personal.com account, all mail.");
    await until(() => host.finishers.has(1));
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
  }, 120_000);

  it("#29: 'delete that email' reaches ops with the message id from the earlier result", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Anything new in email since last night?" });
    desk.fileIssue(call.id, "Check for new email since last night.");
    await until(() => host.finishers.has(1));
    host.finishers.get(1)!("One new email: Credit Karma, “Congrats on your loan progress in the last few months, Ezra!”, Oct 27 at 9:45 PM PT. Message id 1a180d36555f7e3f.");
    await until(() => desk.repo.issue(1)!.status === "merged");
    desk.addTurn(call.id, { role: "kloru", text: "One new email from Credit Karma last night, congratulating you on your loan progress." });
    desk.addTurn(call.id, { role: "caller", text: "Delete that email" });
    desk.fileIssue(call.id, "Delete the Credit Karma email from 9:45 PM last night.");
    await until(() => desk.repo.issues((i) => i.kind === "ops").length > 0);
    const ops = desk.repo.issues((i) => i.kind === "ops");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.spec).toContain("1a180d36555f7e3f");
  }, 120_000);

  it("Nov 3 SFO parking: asked again after a try that fell short, the goal stays booked, not links", async () => {
    const { desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "I have to book parking at sfo for my trip tomorrow. Can you help?" });
    desk.addTurn(call.id, { role: "kloru", text: "SFO parking is not booked: my computer and payments aren't set up. Please reserve and pay here: https://parking.flysfo.com/book/SFO/Parking. Options: https://kloru.com/a/bp49" });
    desk.addTurn(call.id, { role: "caller", text: "Can you help me book parking? I want long term" });
    desk.fileIssue(call.id, "Book long term parking at SFO for Ezra's trip starting tomorrow, November 3, 2026.");
    await until(() => desk.repo.issue(1)!.status !== "open");
    const t = desk.repo.issue(1)!.target;
    expect(`${t?.goal} ${t?.doneWhen}`).toMatch(/\b(booked|reserved|reservation|confirmation)\b/i);
  }, 90_000);

  it("Nov 3 SFO parking, again: an old 'payments aren't set up' result doesn't stop a booking now that it is set up", async () => {
    const { desk, call } = setup();
    desk.setSetup(() => "- Browser: yes, Kloru's own (browser_open, skill `browser`). Sign up, log in, book and check out on any site, with saved logins by reference.\n- Payments: yes, the person's saved cards (vault_list); pay at checkout with browser_pay. The card's own limits hold.");
    desk.addTurn(call.id, { role: "caller", text: "I have to book parking at sfo for my trip tomorrow. Can you help?" });
    const old = desk.fileIssue(call.id, "Book parking at SFO for Ezra's trip starting tomorrow, November 3, to November 5.");
    desk.close(old.id, "resolved", { note: "I can't book the parking directly since my payments aren't set up, but I've put the SFO long-term parking details and booking links on your parking page: https://kloru.com/a/bp49" });
    desk.addTurn(call.id, { role: "kloru", text: "I can't book the parking directly since my payments aren't set up, but the details and booking links are on your parking page: https://kloru.com/a/bp49" });
    desk.addTurn(call.id, { role: "caller", text: "Book sfo long term parking for my trip" });
    const now = desk.fileIssue(call.id, "Book SFO long term parking for Ezra's trip starting tomorrow November 3 to November 5, 2026.");
    await until(() => desk.repo.issue(now.id)!.status !== "open");
    const i = desk.repo.issue(now.id)!;
    expect(i.status).not.toBe("resolved");
    expect(`${i.target?.goal} ${i.target?.doneWhen}`).toMatch(/\b(booked|reserved|reservation|confirmation)\b/i);
  }, 90_000);

  it("#9: a combined request keeps the 'add': the Saturday reminder is created, not looked for", async () => {
    const { desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "I think I have an event on my calendar November second or third that says I'm flying to Tucson. I need to add it to November fourth or fifth." });
    desk.addTurn(call.id, { role: "caller", text: "I also want to add an event to Saturday that says make sure I gather all of the house paperwork." });
    desk.fileIssue(call.id, "Check the owner's calendar for an event on November 2 or 3, 2026 saying they're flying to Tucson, and move it to November 4 or 5; the owner hasn't chosen which yet. Also add a calendar event for Saturday, October 31, 2026, titled \"Make sure I gather all of the house paperwork.\"");
    await until(() => desk.repo.issue(1)!.status !== "open");
    const specs = desk.repo.issues().map((i) => i.spec ?? "").join("\n");
    // On the call it became "check for the event titled …"; it has to stay a new event.
    expect(specs).toMatch(/(creat|add|new)[^.]*paperwork/i);
    expect(specs).not.toMatch(/preserve/i);
  }, 90_000);

  it("call CA896c…: 'email me all this' gets a target that says sent, and a draft-only result is sent back", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Alright, I gotta get going. Can you send me an email with all this information?" });
    desk.fileIssue(call.id, "Email Ezra a thorough summary of our Acme AI strategy discussion to ezra@personal.example.com.");
    await until(() => host.finishers.has(1));
    expect(desk.repo.issue(1)!.target?.deliverable).toBe("email");
    expect(desk.repo.issue(1)!.target?.doneWhen).toMatch(/sent/i);
    const finish = host.finishers.get(1)!;
    host.finishers.delete(1);
    finish("To: ezra@personal.example.com. Subject: Acme AI strategy discussion. Status: draft only, not saved or sent. Hi Ezra, here's the summary…");
    await until(() => host.finishers.has(1) || desk.repo.issue(1)!.status === "merged");
    expect(desk.repo.issue(1)!.status).toBe("in_progress");
  }, 120_000);

  it("stuck and outdated: yesterday's news rundown that lost its worker is closed, not restarted", async () => {
    let t = Date.now();
    const { host, desk, call } = setup(() => new Date(t));
    desk.addTurn(call.id, { role: "caller", text: "Give me a quick rundown of today's AI news" });
    desk.fileIssue(call.id, "Quick rundown of today's AI and startup news, for right now on this call.");
    await until(() => host.finishers.has(1));
    desk.endCall(call.id);
    const lost = desk.repo.issue(1)!;
    lost.status = "in_progress";
    desk.repo.saveIssue(lost);
    host.finishers.clear();
    t += 26 * 60 * 60_000; // found the next day
    desk.sweep();
    await until(() => ["wont_do", "not_planned", "resolved", "superseded"].includes(desk.repo.issue(1)!.status));
    if (process.env.SHOW) console.log(desk.repo.issue(1)!.status, JSON.stringify(desk.repo.issue(1)!.thread.map((t) => `${t.by}: ${t.text}`), null, 1));
    expect(["wont_do", "not_planned", "resolved", "superseded"]).toContain(desk.repo.issue(1)!.status);
    expect(host.finishers.has(1)).toBe(false);
  }, 120_000);

  it("stuck but current: a calendar change that lost its worker minutes ago is retried", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Put Nora's dentist on Friday at 3 on my calendar" });
    desk.fileIssue(call.id, "Add Nora's dentist appointment, Friday October 30 at 3 PM, to the owner's calendar.");
    await until(() => desk.repo.issue(1)!.status === "executing" || host.finishers.has(1));
    host.finishers.clear();
    desk.sweep(new Date(Date.now() + 40 * 60_000)); // its worker ran far too long
    await until(() => host.finishers.has(1) || ["wont_do", "not_planned"].includes(desk.repo.issue(1)!.status));
    if (process.env.SHOW && !host.finishers.has(1)) console.log("MISS", desk.repo.issue(1)!.kind, desk.repo.issue(1)!.status, JSON.stringify(desk.repo.issue(1)!.thread.map((t) => `${t.by}: ${t.text}`), null, 1), JSON.stringify(desk.repo.inbox(call.id, 0)));
    expect(host.finishers.has(1)).toBe(true);
  }, 120_000);

  it("#493 (Nov 8): research whose worker keeps getting stuck is told to the caller honestly, not reassigned all day", async () => {
    const sent: string[] = [];
    const { host, desk, logs, call: voice } = setup(undefined, async (n) => (sent.push(JSON.stringify(n)), true));
    desk.endCall(voice.id);
    const { call } = desk.startCall({ callSid: "imessage:evt493", phone: "+14155550190", channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "Research how divorce probability changes with taking jobs where you travel 4 months or more in a year" });
    desk.fileIssue(call.id, "Research how divorce probability changes with taking jobs where you travel 4 months or more in a year");
    await until(() => host.finishers.has(1));
    desk.endCall(call.id);
    const told = () => [...desk.repo.inbox(call.id, 0).map((m) => m.text), ...sent, ...desk.repo.ledger().filter((e) => e.tool === "outbox").map((e) => JSON.stringify(e.args))];
    for (let i = 0; i < 3 && !told().length; i++) {
      host.finishers.clear();
      desk.sweep(new Date(Date.now() + 40 * 60_000)); // its worker ran far too long, again
      await until(() => host.finishers.has(1) || told().length > 0 || isClosedStatus(desk.repo.issue(1)!.status));
    }
    await until(() => told().length > 0, 10_000);
    if (process.env.SHOW) console.log(told(), logs.filter((l) => l.startsWith("pm")), JSON.stringify(desk.repo.issue(1)!.thread.map((t) => `${t.by}: ${t.text}`), null, 1));
    expect(told().join(" ")).toMatch(/stuck|trouble|delay|longer|problem|couldn't|can't|not able|unable|snag|issue/i);
  }, 240_000);

  it("a result with a page link is spoken without the link", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Compare the pediatric dentists near Maplewood for Nora" });
    desk.fileIssue(call.id, "Compare pediatric dentists near Maplewood for Nora.");
    await until(() => host.finishers.has(1));
    host.finishers.get(1)!("Compared five; best is Maplewood Kids Dental (4.9, new patients, 0.6 mi). Full comparison: https://kloru.com/a/Qm9vZ2xlR29vZ2xlR29vZ2");
    await until(() => desk.repo.inbox(call.id, 0).length > 0);
    const spoken = desk.repo.inbox(call.id, 0).map((m) => m.text).join(" ");
    expect(spoken).not.toMatch(/https?:|kloru\.com/);
    expect(spoken).toMatch(/Maplewood Kids Dental/);
  }, 120_000);

  it("in a text thread, the result is a short summary with the page link", async () => {
    const { host, desk } = setup();
    const { call } = desk.startCall({ callSid: "imessage:t1", phone: "+14155550190", channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "Can you look up flights for my ATL trip next week?" });
    desk.fileIssue(call.id, "Look up flights for the Tucson trip next week (it's on the calendar).");
    await until(() => host.finishers.size > 0);
    const [n, finish] = [...host.finishers.entries()].at(-1)!;
    finish("Best nonstop: Delta 2:08 PM next Tuesday SFO→ATL; return United 5:35 PM next Thursday. All options: https://kloru.com/a/Qm9vZ2xlR29vZ2xlR29vZ2");
    await until(() => desk.repo.inbox(call.id, 0).length > 0);
    const sent = desk.repo.inbox(call.id, 0).map((m) => m.text).join(" ");
    expect(sent, `#${n}`).toContain("https://kloru.com/a/Qm9vZ2xlR29vZ2xlR29vZ2");
    expect(sent.length).toBeLessThan(400);
  }, 120_000);

  it("a follow-up ('I prefer United') edits the earlier page instead of making a new one", async () => {
    const { host, desk } = setup();
    const { call } = desk.startCall({ callSid: "imessage:f1", phone: "+14155550190", channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "Can you look up flights for my ATL trip? Out Tuesday Nov 3, back Thursday Nov 5." });
    const first = desk.fileIssue(call.id, "Look up PDX to Tucson flights, out Tue Nov 3 and back Thu Nov 5.");
    await until(() => host.finishers.has(first.id));
    const page = desk.publishArtifact(first.id, "Tucson flights", "# Tucson flights\n\n## Outbound, Tue Nov 3\n- Delta 2:08 PM nonstop\n");
    if (!page.ok) throw new Error(page.error);
    host.finishers.get(first.id)!(`Best nonstop: Delta 2:08 PM Tue Nov 3. All options: ${page.value.url}`);
    await until(() => desk.repo.issue(first.id)!.status === "merged");
    desk.addTurn(call.id, { role: "caller", text: "I prefer United nonstops if possible" });
    const follow = desk.fileIssue(call.id, "Caller prefers United nonstop flights for the Tucson trip.");
    await until(() => host.prompts.has(follow.id) || desk.repo.issue(follow.id)!.status !== "open");
    const prompt = host.prompts.get(follow.id) ?? "";
    const i = desk.repo.issue(follow.id)!;
    expect(`${prompt} ${i.spec ?? ""}`, JSON.stringify({ status: i.status, spec: i.spec, links: i.links })).toContain(page.value.id);
  }, 120_000);

  it("a recurring request goes to ops as an automation, not a one-time lookup", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Every weekday at 7 in the morning, email me a debrief of my day" });
    desk.fileIssue(call.id, "Every weekday at 7 AM, email Ezra a debrief of his day: calendar, important email, anything due.");
    await until(() => host.finishers.has(1));
    const issue = desk.repo.issue(1)!;
    expect(issue.kind).toBe("ops");
    expect(issue.spec ?? "").toMatch(/automation/i);
  }, 120_000);

  it("'when I get an email I need to answer, draft a reply' goes to ops as an automation, not a one-time pass over the inbox", async () => {
    const { host, desk, call } = setup();
    desk.addTurn(call.id, { role: "caller", text: "Whenever I get an email I need to answer, draft a reply for me" });
    desk.fileIssue(call.id, "Whenever an email Ezra needs to answer arrives, draft a reply for him.");
    await until(() => host.finishers.has(1));
    const issue = desk.repo.issue(1)!;
    expect(issue.kind).toBe("ops");
    expect(issue.spec ?? "").toMatch(/automation/i);
  }, 120_000);

  it("coms: a request done after the call ended gets one message from the PM", async () => {
    const sent: Notice[] = [];
    const { host, desk, call, logs } = setup(undefined, async (n) => (sent.push(n), true));
    desk.addTurn(call.id, { role: "caller", text: "Move my dentist appointment on Thursday to Friday at 3" });
    desk.fileIssue(call.id, "Move the dentist appointment from Thursday to Friday at 3 PM.");
    await until(() => host.finishers.has(1));
    desk.endCall(call.id);
    // This week's Friday, so the result is never in the past.
    const d = new Date();
    d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
    const friday = d.toISOString().slice(0, 10);
    // As a real worker's change would be: recorded in the ledger as it happens.
    desk.repo.appendLedger({ issue: 1, call: call.id, phone: "+14155550190", tool: "app_googlecalendar_patch_event", slug: "GOOGLECALENDAR_PATCH_EVENT", args: { event_id: "5k2", start_datetime: `${friday}T15:00:00-08:00` }, ok: true, result: "updated 5k2" });
    host.finishers.get(1)!(`Moved 'Dentist' from this Thursday 3 PM to this Friday (${friday}) 3 PM on ezra@personal.example.com's calendar. Event id 5k2.`);
    await until(() => sent.length > 0, 60_000);
    await new Promise((r) => setTimeout(r, 3000));
    const i = desk.repo.issue(1)!;
    expect(sent, JSON.stringify({ kind: i.kind, status: i.status, thread: i.thread.map((t) => `${t.by}: ${t.text}`), inbox: desk.repo.inbox(call.id, 0), logs })).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/Friday/i);
  }, 120_000);

  it("Nov 2 laundry: new options on a page they already have the link to still get the message", async () => {
    const sent: Notice[] = [];
    const { host, desk, logs, call: voice } = setup(undefined, async (n) => (sent.push(n), true), outboxDecider({ apiKey: key! }));
    desk.endCall(voice.id);
    const { call } = desk.startCall({ callSid: "imessage:l1", phone: "+14155550190", channel: "imessage" });
    desk.addTurn(call.id, { role: "caller", text: "I need a new laundry basket. Not expensive, from Amazon, light, and my wife shouldn't think it's ugly" });
    const first = desk.fileIssue(call.id, "Find lightweight, affordable, good-looking laundry baskets on Amazon.");
    await until(() => host.finishers.has(first.id));
    const page = desk.publishArtifact(first.id, "Lightweight Amazon laundry baskets", "# Lightweight Amazon laundry baskets\n- HOBASKET woven cotton, $17.95\n");
    if (!page.ok) throw new Error(page.error);
    host.finishers.get(first.id)!(`Done. Options on the page: ${page.value.url}`);
    await until(() => ["merged", "resolved", "done"].includes(desk.repo.issue(first.id)!.status));
    // The talker texted that result with the link, as it did on Nov 2.
    const told = desk.repo.inbox(call.id, 0);
    await desk.submitFromConversation(call.id, { text: `I found a few cheap, light options: ${page.value.url}`, issues: [first.id], thread: { channel: "imessage", to: "+14155550190" } });
    await settled(desk);
    if (told.length) desk.ack(call.id, told.at(-1)!.seq);
    const before = sent.length;
    desk.addTurn(call.id, { role: "caller", text: "She thinks all of those are ugly. You can spend up to $100" });
    const second = desk.fileIssue(call.id, "Find stylish, high-quality laundry baskets on Amazon up to $100; update the same page.");
    await until(() => host.finishers.has(second.id));
    desk.updateArtifact(page.value.id, { append: "- Brabantia, $62\n- Joseph Joseph, $90\n" }, { issue: second.id, phone: "+14155550190" });
    host.finishers.get(second.id)!(`Updated the page with four design-forward options up to $100, including a $62 Brabantia and a $90 Joseph Joseph: ${page.value.url}`);
    await until(() => desk.repo.inbox(call.id, told.at(-1)?.seq ?? 0).length > 0);
    // A deploy ended the conversation before the talker texted it, so it goes to his outbox.
    desk.endCall(call.id);
    await settled(desk);
    const after = sent.slice(before);
    expect(after, logs.join("\n")).toHaveLength(1);
    expect(after[0]!.text).toMatch(/\$100|Brabantia|Joseph/);
  }, 180_000);

  it("coms: a result the caller already got by email gets no second message", async () => {
    const sent: Notice[] = [];
    const { host, desk, call } = setup(undefined, async (n) => (sent.push(n), true), outboxDecider({ apiKey: key! }));
    desk.addTurn(call.id, { role: "caller", text: "Email me the Portland bulky-item pickup instructions" });
    desk.fileIssue(call.id, "Email the Portland bulky-item pickup instructions to ezra@personal.example.com.");
    await until(() => host.finishers.has(1));
    desk.endCall(call.id);
    desk.repo.appendLedger({ issue: 1, call: call.id, phone: "+14155550190", tool: "app_gmail_send_email", slug: "GMAIL_SEND_EMAIL", args: { recipient_email: "ezra@personal.example.com", subject: "Portland bulky-item pickup", body: "Instructions and the scheduling link…" }, ok: true, result: "sent, id 19a" });
    host.finishers.get(1)!("Done. I emailed the Portland bulky-item pickup instructions and scheduling link to ezra@personal.example.com.");
    await until(() => desk.repo.issue(1)!.status === "merged");
    await settled(desk);
    expect(sent).toEqual([]);
  }, 120_000);
});
