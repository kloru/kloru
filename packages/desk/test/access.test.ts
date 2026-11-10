/**
 * The CISO: a request is reviewed once, on its spec, against the policy of each person whose things
 * it touches. Their own things and silent policies are open (in code); code enforces the review on
 * each call; a floor no review can lift.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability, WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { toNeeds, type AccessCheck, type AccessDecision, type Need } from "../src/access.js";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Memory } from "../src/memory.js";

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

const EZRA = "+14155550190";
const CLEO = "+14155550191";
const DAD = "+14155550123";
const NAMES: Record<string, string> = { [EZRA]: "Ezra", [CLEO]: "Cleo", [DAD]: "Dad" };
const settle = async (ms = 30) => {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};
const ACCOUNTS = [
  { id: "ca_cleo_cal", toolkit: "googlecalendar", email: "cleo@gmail.example", person: "cleo" },
  { id: "ca_ezra_cal", toolkit: "googlecalendar", email: "ezra@gmail.example" },
  { id: "ca_ezra_mail", toolkit: "gmail", email: "ezra@gmail.example" },
  { id: "ca_cleo_mail", toolkit: "gmail", email: "cleo@gmail.example", person: "cleo" },
];

function setup(o: { policies?: Record<string, string>; coOwner?: boolean; decide?: (c: AccessCheck) => Promise<AccessDecision> } = {}) {
  const host = new Host();
  const reviews: AccessCheck[] = [];
  const policies = o.policies ?? {};
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "access-")),
    host,
    planner: new PM(),
    ownerPhone: EZRA,
    ...(o.coOwner ? { coOwner: (p: string) => p === CLEO } : {}),
    isMember: (p) => p === DAD || (!o.coOwner && p === CLEO),
    nameOf: (p) => NAMES[p],
    phoneOf: (n) => Object.keys(NAMES).find((p) => NAMES[p]!.toLowerCase() === n.toLowerCase()),
    phoneOfPerson: (id) => (id === "cleo" ? CLEO : undefined),
    policyOf: (p) => policies[p] ?? "",
    notify: async () => true,
    appScope: () => ({ accounts: ACCOUNTS, restricted: ["googlecalendar", "gmail"] }),
    decideAccess: async (c) => (reviews.push(c), (o.decide ?? (async (x) => ({ choices: x.needs.map(() => "allow" as const), p: x.needs.map(() => 0.9), reason: "their policy allows it" })))(c)),
  });
  return { desk, host, reviews };
}

async function request(desk: Desk, host: Host, phone: string, needs: Need[], request = "Put replacing the Tesla key on my calendar tomorrow") {
  const { call } = desk.startCall({ callSid: `imessage:${phone}`, phone, channel: "imessage" });
  const issue = desk.fileIssue(call.id, request);
  desk.assign(issue.id, "ops", "Do it", [], undefined, { needs });
  await settle();
  const run = host.runs.filter((r) => r.issue === issue.id).at(-1)!;
  return { issue: desk.repo.issue(issue.id)!, role: run.role, run, call };
}

const call = (toolName: string, account: string, capabilities: Capability[] = ["apps.use"]) => ({ toolName, args: { account }, capabilities, summary: toolName.replace(/^app_/, "") });

describe("whose things: each person's own policy decides", () => {
  it("their own things and a silent policy are open, in code, with no Jev call", async () => {
    const { desk, host, reviews } = setup();
    const { issue } = await request(desk, host, CLEO, [{ permission: "write_calendar", account: "theirs" }, { permission: "read_calendar", account: "Ezra" }]);
    expect(reviews).toEqual([]);
    expect(issue.access?.open).toEqual([{ permission: "write_calendar", account: "theirs" }, { permission: "read_calendar", account: "Ezra" }]);
    expect(issue.access?.allow).toEqual([]);
    expect(desk.repo.ledger().find((e) => e.slug === "ACCESS_REVIEW")?.result).toMatch(/allowed: add to or change their calendar; see Ezra's calendar/);
  });

  it("a person with a policy gets their own review: Jev reads their policy for needs on their things only", async () => {
    const { desk, host, reviews } = setup({ policies: { [EZRA]: "- Cleo can see and do everything, but not my work email." } });
    await request(desk, host, CLEO, [{ permission: "write_calendar", account: "theirs" }, { permission: "read_mail", account: "Ezra" }]);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.needs).toEqual([{ permission: "read_mail", account: "Ezra" }]);
    expect(reviews[0]!.policies).toEqual({ Ezra: "- Cleo can see and do everything, but not my work email." });
  });

  it("per call: her own calendar runs; Ezra's mail under his policy, unreviewed, asks Ezra, and only his yes runs it once", async () => {
    const { desk, host } = setup({ policies: { [EZRA]: "- Ask me before anyone reads my mail." }, decide: async (c) => ({ choices: c.needs.map(() => "ask_owner" as const), p: c.needs.map(() => 0.9) }) });
    const { issue, role, call: cleoCall } = await request(desk, host, CLEO, [{ permission: "write_calendar", account: "theirs" }, { permission: "read_mail", account: "Ezra" }]);
    expect(await role.access!(call("app_googlecalendar_create_event", "ca_cleo_cal"))).toBeUndefined();
    const read = call("app_gmail_fetch_emails", "ca_ezra_mail");
    expect((await role.access!(read))?.reason).toMatch(/Ezra's yes/);
    const id = desk.repo.issue(issue.id)!.confirmation!.id;
    expect(() => desk.confirm(issue.id, cleoCall.id, id)).toThrow();
    const { call: ezraCall } = desk.startCall({ callSid: "CA-ezra", phone: EZRA, channel: "voice" });
    desk.confirm(issue.id, ezraCall.id, id);
    expect(await role.access!(read)).toBeUndefined();
    expect((await role.access!(read))?.block).toBe(true);
  });

  it("a denied need is refused and recorded", async () => {
    const { desk, host } = setup({ policies: { [EZRA]: "- Nobody reads my work email." }, decide: async (c) => ({ choices: c.needs.map(() => "deny" as const), p: c.needs.map(() => 0.95) }) });
    const { role } = await request(desk, host, CLEO, [{ permission: "read_mail", account: "Ezra" }]);
    expect((await role.access!(call("app_gmail_fetch_emails", "ca_ezra_mail")))?.reason).toMatch(/Not allowed: read Ezra's email/);
    expect(desk.repo.ledger().some((e) => e.slug === "ACCESS_BLOCKED")).toBe(true);
  });

  it("owners share everything with each other: no review, nobody asked, whatever either policy says", async () => {
    const { desk, host, reviews } = setup({ coOwner: true, policies: { [EZRA]: "- Cleo: she can see and do everything.", [CLEO]: "- Ask me first." } });
    const cleo = await request(desk, host, CLEO, [{ permission: "read_mail", account: "Ezra" }], "Find the daycare email in Ezra's inbox");
    expect(reviews).toEqual([]);
    expect(cleo.role.access).toBeUndefined(); // an owner keeps the owner policy
    // 2026-11-09 (#697): a lookup with no account was taken for Ezra's, and he was asked three times.
    expect(await cleo.role.guard!("app_composio_search_tools", { queries: [{ use_case: "search gmail" }] })).toBeUndefined();
    expect(await cleo.role.guard!("app_composio_remote_workbench", { code: "print(1)" })).toBeUndefined();
    expect(await cleo.role.guard!("app_gmail_fetch_emails", { account: "ca_ezra_mail" })).toBeUndefined();
    expect(await cleo.role.guard!("app_gmail_move_to_trash", { account: "ca_ezra_mail" })).toBeUndefined();
    const ezra = await request(desk, host, EZRA, [{ permission: "read_mail", account: "Cleo" }], "What did the school email Cleo?");
    expect(await ezra.role.guard!("app_gmail_fetch_emails", { account: "ca_cleo_mail" })).toBeUndefined();
    expect(reviews).toEqual([]);
    expect(desk.repo.issue(cleo.issue.id)!.confirmation).toBeUndefined();
    expect(desk.repo.issue(ezra.issue.id)!.confirmation).toBeUndefined();
  });

  it("an owner reaching a member's things answers to that member's policy; only the member's yes settles it", async () => {
    const { desk, host, reviews } = setup({ policies: { [CLEO]: "- Ezra can't read my email." }, decide: async (c) => ({ choices: c.needs.map(() => "ask_owner" as const), p: c.needs.map(() => 0.9) }) });
    const { issue, role, call: ezraCall } = await request(desk, host, EZRA, [{ permission: "read_mail", account: "Cleo" }], "What did the school email Cleo?");
    expect(reviews).toHaveLength(1);
    const asked = await role.guard!("app_gmail_fetch_emails", { account: "ca_cleo_mail" });
    expect(asked?.reason).toMatch(/Cleo's yes/);
    const id = desk.repo.issue(issue.id)!.confirmation!.id;
    expect(() => desk.confirm(issue.id, ezraCall.id, id)).toThrow(/Cleo/);
    // His own mail needs nobody's yes.
    expect(await role.guard!("app_gmail_fetch_emails", { account: "ca_ezra_mail" })).toBeUndefined();
  });

  it("a member's call the PM didn't list goes to the review, which reads the policy: allowed runs with nobody asked", async () => {
    const { desk, host, reviews } = setup({ policies: { [EZRA]: "- Dad may read my mail and see my calendar." } });
    const { issue, role } = await request(desk, host, DAD, [], "When did Ezra's flight confirmation come?");
    expect(reviews).toEqual([]);
    expect(await role.access!(call("app_composio_search_tools", ""))).toBeUndefined();
    expect(await role.access!(call("app_gmail_fetch_emails", "ca_ezra_mail"))).toBeUndefined();
    expect(reviews.map((r) => r.needs)).toEqual([[{ permission: "read_mail", account: "Ezra" }]]);
    expect(reviews[0]!.policies).toEqual({ Ezra: "- Dad may read my mail and see my calendar." });
    // Reviewed once: the same permission again is held to that review.
    expect(await role.access!(call("app_gmail_fetch_emails", "ca_ezra_mail"))).toBeUndefined();
    expect(reviews).toHaveLength(1);
    expect(desk.repo.issue(issue.id)!.confirmation).toBeUndefined();
  });

  it("a member's unlisted call the review won't allow still asks the person, or is refused", async () => {
    const ask = setup({ policies: { [EZRA]: "- Ask me first." }, decide: async (c) => ({ choices: c.needs.map(() => "ask_owner" as const), p: c.needs.map(() => 0.9) }) });
    const a = await request(ask.desk, ask.host, DAD, []);
    expect((await a.role.access!(call("app_gmail_fetch_emails", "ca_ezra_mail")))?.reason).toMatch(/Ezra's yes/);
    const deny = setup({ policies: { [EZRA]: "- Nobody reads my mail." }, decide: async (c) => ({ choices: c.needs.map(() => "deny" as const), p: c.needs.map(() => 0.95) }) });
    const d = await request(deny.desk, deny.host, DAD, []);
    expect((await d.role.access!(call("app_gmail_fetch_emails", "ca_ezra_mail")))?.reason).toMatch(/Not allowed: read Ezra's email/);
  });

  it("fails closed: a failed review asks the person whose things it is", async () => {
    const { desk, host } = setup({ policies: { [EZRA]: "- Ask me first about my calendar." }, decide: async () => Promise.reject(new Error("timeout")) });
    const { issue, role } = await request(desk, host, CLEO, [{ permission: "write_calendar", account: "Ezra" }]);
    expect(issue.access?.ask).toEqual([{ permission: "write_calendar", account: "Ezra" }]);
    expect((await role.access!(call("app_googlecalendar_create_event", "ca_ezra_cal")))?.reason).toMatch(/Ezra's yes/);
  });

  it("assigning again reviews only needs it hasn't seen", async () => {
    const { desk, host, reviews } = setup({ policies: { [EZRA]: "- Ask me first." } });
    const { issue } = await request(desk, host, CLEO, [{ permission: "read_calendar", account: "Ezra" }]);
    desk.repo.saveIssue({ ...desk.repo.issue(issue.id)!, status: "resolved" });
    desk.assign(issue.id, "ops", "Also email Ezra about it", [], undefined, { needs: [{ permission: "read_calendar", account: "Ezra" }, { permission: "send_mail", account: "Ezra" }] });
    await settle();
    expect(reviews.map((r) => r.needs.map((n) => n.permission))).toEqual([["read_calendar"], ["send_mail"]]);
  });
});

describe("the floor", () => {
  it("owner-only capabilities are refused for anyone else; money always asks an owner", async () => {
    const { desk, host } = setup();
    const { role } = await request(desk, host, CLEO, [{ permission: "spend", account: "Ezra" }]);
    expect((await role.access!({ toolName: "bash", args: { cmd: "ls" }, capabilities: ["computer.use"], summary: "run ls" }))?.reason).toMatch(/only an owner/);
    expect((await role.access!({ toolName: "pay", args: { amount: 5 }, capabilities: ["purchase"], summary: "pay $5" }))?.reason).toMatch(/yes/);
  });

  it("the public never gets more than an owner's calendar, whatever the review says", async () => {
    const { desk, host } = setup();
    const { role } = await request(desk, host, "+14155550177", [{ permission: "read_contacts", account: "Ezra" }], "What's Ezra's address?");
    expect((await role.access!({ toolName: "contacts_search", args: { q: "Ezra" }, capabilities: ["contacts.read"], summary: "search contacts" }))?.reason).toMatch(/only the family/);
    expect((await role.access!({ toolName: "ask_instinct", args: {}, capabilities: ["network.ask"], summary: "ask another agent" }))?.reason).toMatch(/only the family/);
  });

  it("a batch app call is judged by its inner calls", async () => {
    const { desk, host } = setup({ policies: { [EZRA]: "- Ask me first." }, decide: async (c) => ({ choices: c.needs.map(() => "ask_owner" as const), p: c.needs.map(() => 0.9) }) });
    const { role } = await request(desk, host, CLEO, [{ permission: "write_calendar", account: "theirs" }]);
    const batch = (account: string) => ({ toolName: "app_composio_multi_execute_tool", args: { tools: [{ tool_slug: "GOOGLECALENDAR_CREATE_EVENT", account, arguments: {} }] }, capabilities: ["apps.use", "calendar.write"] as Capability[], summary: "add the event" });
    expect(await role.access!(batch("ca_cleo_cal"))).toBeUndefined();
    expect((await role.access!(batch("ca_ezra_cal")))?.reason).toMatch(/Ezra's yes/);
  });

  it("leave to read doesn't cover trashing: on Ezra's mail under his policy it asks him; under a silent policy it's open", async () => {
    const trash = call("app_gmail_move_to_trash", "ca_ezra_mail");
    const strict = setup({ policies: { [EZRA]: "- Cleo may read my mail." } });
    const a = await request(strict.desk, strict.host, CLEO, [{ permission: "read_mail", account: "Ezra" }]);
    expect((await a.role.access!(trash))?.reason).toMatch(/Ezra's yes/);
    const open = setup();
    const b = await request(open.desk, open.host, CLEO, [{ permission: "read_mail", account: "Ezra" }]);
    expect(await b.role.access!(trash)).toBeUndefined();
  });

  it("desk workers can't text anyone on the side", async () => {
    const { desk, host } = setup();
    const { role } = await request(desk, host, CLEO, []);
    const tool = (name: string) => ({ spec: { name, meta: { capabilities: [] } } }) as never;
    expect(role.visible!(tool("notify_owner"))).toBe(false);
    expect(role.visible!(tool("send_to_caller"))).toBe(true);
  });
});

describe("what the PM lists", () => {
  it("names the PM might use are read as permissions; unknown ones are dropped", () => {
    expect(toNeeds([{ permission: "purchase", account: "owner" }, { permission: "Calendar write", account: "theirs" }, { permission: "teleport", account: "owner" }, { permission: "read_mail", account: "" }, "write_calendar", null])).toEqual([
      { permission: "spend", account: "owner" },
      { permission: "write_calendar", account: "theirs" },
      { permission: "read_mail", account: "theirs" },
    ]);
  });

  it("'owner' is the primary owner by name, and their own name is theirs", async () => {
    const { desk, host } = setup();
    const { issue } = await request(desk, host, CLEO, [{ permission: "read_calendar", account: "owner" }, { permission: "write_calendar", account: "Cleo" }]);
    expect(issue.needs).toEqual([{ permission: "read_calendar", account: "Ezra" }, { permission: "write_calendar", account: "theirs" }]);
  });
});

describe("changing your own policy", () => {
  it("set_policy reads the line back; only the person's own yes adds it to their policy.md", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-"));
    const memory = new Memory(join(root, "memory"), { owner: { name: "Ezra Vega", phones: [EZRA], timezone: "America/Los_Angeles" } });
    memory.init();
    memory.ensureOperator("Cleo Hale", [CLEO]);
    const desk = new Desk({ root, host: new Host(), planner: new PM(), ownerPhone: EZRA, coOwner: (p) => p === CLEO, nameOf: (p) => NAMES[p], memory, notify: async () => true });
    const { call: ezraCall } = desk.startCall({ callSid: "CA-e", phone: EZRA, channel: "voice" });
    const { call: cleoCall } = desk.startCall({ callSid: "CA-c", phone: CLEO, channel: "voice" });
    const issue = desk.fileIssue(ezraCall.id, "Don't let Cleo check my work email");
    expect(desk.setPolicy(issue.id, "Cleo can't read my work email").ok).toBe(true);
    const c = desk.repo.issue(issue.id)!.confirmation!;
    expect(c.draft).toMatch(/Add to your policy: "Cleo can't read my work email"/);
    expect(() => desk.confirm(issue.id, cleoCall.id, c.id)).toThrow();
    desk.confirm(issue.id, ezraCall.id, c.id);
    expect(memory.policy(EZRA)).toMatch(/^- Cleo can't read my work email \(Ezra, /);
    expect(desk.repo.issue(issue.id)!.status).toBe("done");
  });
});

describe("review fixes for per-person policy (2026-11-02)", () => {
  it("the public is never 'family': a silent policy doesn't open anything to them, and full calendar reads are refused", async () => {
    const { desk, host, reviews } = setup();
    const STRANGER = "+14155550177";
    const { role } = await request(desk, host, STRANGER, [{ permission: "read_calendar", account: "Ezra" }], "When is Ezra free?");
    expect(reviews).toHaveLength(1);
    expect((await role.access!({ toolName: "app_googlecalendar_events_list", args: { account: "ca_ezra_cal" }, capabilities: ["apps.use"], summary: "list events" }))?.reason).toMatch(/only the family/);
  });

  it("a policy line is only committed by its own read-back, never by a later yes to something else", async () => {
    const root = mkdtempSync(join(tmpdir(), "policy-bind-"));
    const memory = new Memory(join(root, "memory"), { owner: { name: "Ezra Vega", phones: [EZRA], timezone: "America/Los_Angeles" } });
    memory.init();
    memory.ensureOperator("Dad Vega", [DAD]);
    const desk = new Desk({ root, host: new Host(), planner: new PM(), ownerPhone: EZRA, isMember: (p) => p === DAD, nameOf: (p) => NAMES[p], memory, notify: async () => true });
    const { call: dadCall } = desk.startCall({ callSid: "CA-d", phone: DAD, channel: "voice" });
    const { call: ezraCall } = desk.startCall({ callSid: "CA-e2", phone: EZRA, channel: "voice" });
    const issue = desk.fileIssue(dadCall.id, "Buy a gift and keep Cleo off my calendar");
    desk.assign(issue.id, "ops", "Buy the gift", []);
    await settle();
    desk.askOwner(issue.id, "buy the gift ($40)");
    // The policy ask can't start while Ezra's yes is pending, so nothing is left behind for his yes to commit.
    expect(desk.setPolicy(issue.id, "Cleo can't see my calendar").ok).toBe(false);
    desk.confirm(issue.id, ezraCall.id, desk.repo.issue(issue.id)!.confirmation!.id);
    expect(memory.policy(DAD)).toBe("");
  });

  it("people are told apart by phone, not first name", async () => {
    const OTHER = "+14155550188";
    NAMES[OTHER] = "Cleo";
    try {
      const { desk, host } = setup({ coOwner: true, policies: { [OTHER]: "- Nobody touches my things." } });
      const { role } = await request(desk, host, EZRA, [], "Read Cleo's mail");
      // Cleo (co-owner, empty policy) is open to Ezra, whatever the other Cleo's policy says.
      expect(await role.guard!("app_gmail_fetch_emails", { account: "ca_cleo_mail" })).toBeUndefined();
    } finally {
      delete NAMES[OTHER];
    }
  });

  it("one call on two people's things is split, never settled by one person's yes", async () => {
    const { desk, host } = setup({ coOwner: true, policies: { [CLEO]: "- Ask me first.", [EZRA]: "- Ask me first." }, decide: async (c) => ({ choices: c.needs.map(() => "ask_owner" as const), p: c.needs.map(() => 0.9) }) });
    const { role } = await request(desk, host, DAD, [], "Move both calendars");
    const batch = { toolName: "app_composio_multi_execute_tool", args: { tools: [{ tool_slug: "GOOGLECALENDAR_CREATE_EVENT", account: "ca_cleo_cal", arguments: {} }, { tool_slug: "GOOGLECALENDAR_CREATE_EVENT", account: "ca_ezra_cal", arguments: {} }] }, capabilities: ["apps.use", "calendar.write"] as Capability[], summary: "add to both" };
    expect((await role.access!(batch))?.reason).toMatch(/one call per person/);
  });
});
