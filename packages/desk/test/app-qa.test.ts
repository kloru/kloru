/**
 * A worker reaches an app's data (app_data), and QA uses an app the engineer made or changed
 * before the PM sees the result: real bugs go back to the engineer, a few times at most.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel, type WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { AppStore } from "../src/app-store.js";
import { appTools } from "../src/apps.js";
import { Desk, type Planner, type ResultCheck, type ResultDecision, type Trigger, type WorkerHost } from "../src/desk.js";

const EZRA = "+14155550190";
const CLEO = "+14155550191";
const SAM = "+14155550192";
const LIST = `<!doctype html>\n<title>Groceries</title>\n<ul id="items"></ul>\n<script>\nkloru.list("items").then((items) => { document.getElementById("items").textContent = items.length; });\n</script>\n`;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const failed = (r: unknown) => !!(r as { isError?: boolean }).isError;
const tick = () => new Promise((r) => setTimeout(r, 0));

interface Run {
  issue: number;
  role: WorkerRole;
  prompt: string;
  session: number | undefined;
  done: (text: string) => void;
  fail: (why: string) => void;
}

/** Workers the test plays by hand: each run waits until the test finishes it. */
class Host implements WorkerHost {
  readonly runs: Run[] = [];
  readonly steered: string[] = [];
  run(issue: number, role: WorkerRole, prompt: string, _phone?: string, session?: number): Promise<string> {
    return new Promise((done, fail) => this.runs.push({ issue, role, prompt, session, done, fail: (why) => fail(new Error(why)) }));
  }
  steer(_: number, text: string): boolean {
    this.steered.push(text);
    return true;
  }
  stop(): void {}
}
class PM implements Planner {
  readonly seen: Trigger[] = [];
  async handle(t: Trigger[]): Promise<void> {
    this.seen.push(...t);
  }
}

function setup(o: { qa?: boolean; store?: boolean; gate?: (c: ResultCheck) => Promise<ResultDecision>; notify?: boolean } = {}) {
  const host = new Host();
  const pm = new PM();
  const store = new AppStore(":memory:");
  const luna = resolveModel("openrouter/openai/gpt-6-luna", {});
  const terra = resolveModel("openrouter/openai/gpt-6.1-terra", {});
  const desk = new Desk({
    root: mkdtempSync(join(tmpdir(), "app-qa-")),
    host,
    planner: pm,
    ownerPhone: EZRA,
    isMember: (p) => p === CLEO,
    engineerModel: luna,
    appEngineerModel: terra,
    qa: o.qa ?? true,
    ...(o.store === false ? {} : { appStore: () => store }),
    ...(o.gate ? { decideResult: o.gate } : {}),
    ...(o.notify ? { notify: async () => true } : {}),
  });
  const tools = Object.fromEntries(appTools(desk).map((t) => [t.spec.name, t]));
  const as = (issue: number, role = "engineer") => (name: string, args: Record<string, unknown>) => tools[name]!.spec.execute(args as never, { conversationKey: `desk:issue:${issue}:${role}` } as never);
  const file = (phone: string, request: string) => desk.fileIssue(desk.startCall({ callSid: `imessage:${Math.random()}`, phone, channel: "imessage" }).call.id, request);
  /** A request the PM assigned to an engineer; `continues`: a follow-up in an earlier issue's conversation. */
  const assigned = (request: string, deliverable: "app" | "answer" = "app", continues?: number) => {
    const issue = file(CLEO, request);
    const r = desk.assign(issue.id, "work", request, [], { goal: request, doneWhen: "it works on a phone", deliverable }, continues !== undefined ? { continues } : {});
    if (!r.ok) throw new Error(r.error);
    return issue.id;
  };
  const last = () => host.runs.at(-1)!;
  const finish = async (reply: string) => {
    last().done(reply);
    await tick();
  };
  const now = (id: number) => desk.repo.issue(id)!;
  return { desk, host, pm, store, tools, as, file, assigned, last, finish, now, luna, terra };
}

/** The engineer makes the list app on its issue. */
async function made(s: ReturnType<typeof setup>, issue: number) {
  return /a\/([\w-]{22})/.exec(text(await s.as(issue)("app_create", { title: "Groceries", html: LIST })))![1]!;
}

describe("app_data: a worker reaches what an app holds", () => {
  it("puts a list someone sent into the app, as the page would read it, and says so on the issue", async () => {
    const s = setup();
    const issue = s.assigned("Make us a grocery list with milk and eggs on it");
    const id = await made(s, issue);
    const run = s.as(issue);
    expect(text(await run("app_data", { id, action: "list" }))).toMatch(/Nothing is in the app yet/);
    const put = await run("app_data", { id, action: "put", collection: "items", records: [{ name: "Milk" }, { name: "Eggs" }] });
    expect(text(put)).toMatch(/Saved 2 in items \(the app\)/);
    expect(s.store.list(id, "items")).toMatchObject([{ name: "Milk", by: "Kloru" }, { name: "Eggs", by: "Kloru" }]);
    expect(text(await run("app_data", { id, action: "list" }))).toBe("items: 2");
    expect(text(await run("app_data", { id, action: "list", collection: "items" }))).toMatch(/^2 in items:\n\[\{"name":"Milk"/);
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Changed the data in Groceries: put 2 in items" });
  });

  it("changes an entry by its id and removes by id", async () => {
    const s = setup();
    const issue = s.assigned("Make us a grocery list");
    const id = await made(s, issue);
    const run = s.as(issue);
    await run("app_data", { id, action: "put", collection: "items", records: [{ name: "Milk" }, { name: "Eggs" }] });
    const [milk, eggs] = s.store.list(id, "items");
    await run("app_data", { id, action: "put", collection: "items", records: [{ id: milk!.id, name: "Oat milk" }] });
    expect(s.store.list(id, "items").map((r) => r.name)).toEqual(["Oat milk", "Eggs"]);
    expect(text(await run("app_data", { id, action: "remove", collection: "items", ids: [eggs!.id, "nope"] }))).toBe("Removed 1 from items (the app); 1 weren't there.");
    expect(s.store.list(id, "items").map((r) => r.name)).toEqual(["Oat milk"]);
    expect(failed(await run("app_data", { id, action: "put", collection: "items" }))).toBe(true);
    expect(failed(await run("app_data", { id, action: "remove", collection: "items" }))).toBe(true);
    expect(failed(await run("app_data", { id, action: "put", records: [{ name: "x" }] }))).toBe(true);
  });

  it("scratch is the copy app_test runs on: it can be seeded and emptied; what the family entered can't be cleared", async () => {
    const s = setup();
    const issue = s.assigned("Make us a grocery list");
    const id = await made(s, issue);
    const run = s.as(issue);
    await run("app_data", { id, action: "put", collection: "items", records: [{ name: "Milk" }] });
    const notes = s.now(issue).thread.length;
    await run("app_data", { id, action: "put", collection: "items", records: [{ name: "Test" }, { name: "Test 2" }], scratch: true });
    expect(s.store.list(`${id}~test`, "items").map((r) => r.name)).toEqual(["Test", "Test 2"]);
    expect(s.store.list(id, "items").map((r) => r.name)).toEqual(["Milk"]);
    expect(s.now(issue).thread).toHaveLength(notes);
    expect(text(await run("app_data", { id, action: "clear", scratch: true }))).toBe("Emptied the scratch copy (2 records).");
    expect(text(await run("app_data", { id, action: "list", scratch: true }))).toMatch(/Nothing is in the scratch copy yet/);
    expect(failed(await run("app_data", { id, action: "clear" }))).toBe(true);
    expect(s.store.list(id, "items")).toHaveLength(1);
  });

  it("is for the family's apps only, and says when there is nowhere to keep data", async () => {
    const s = setup();
    const issue = s.assigned("Make us a grocery list");
    const id = await made(s, issue);
    const theirs = s.file(SAM, "What's on the grocery list?");
    expect(text(await s.as(theirs.id)("app_data", { id, action: "list" }))).toMatch(/no app/);
    expect(failed(await s.tools.app_data!.spec.execute({ id, action: "list" } as never, {} as never))).toBe(true);
    const bare = setup({ store: false });
    const other = bare.assigned("Make us a grocery list");
    expect(text(await bare.as(other)("app_data", { id: await made(bare, other), action: "list" }))).toMatch(/nowhere to keep app data/);
  });
});

describe("QA uses an app before the PM reviews it", () => {
  it("an engineer's app goes to QA on its own conversation, with only QA's tools; usable goes on to the PM", async () => {
    const s = setup();
    const issue = s.assigned("Make us a shared grocery list");
    expect(s.last().role).toMatchObject({ name: "engineer", model: s.terra });
    const id = await made(s, issue);
    await s.finish("Made the list: https://example.com/a/x");
    expect(s.now(issue).status).toBe("in_progress");
    const qa = s.last();
    expect(qa).toMatchObject({ issue, session: undefined, role: { name: "qa", model: s.terra } });
    expect(qa.prompt).toContain(`App id ${id}`);
    expect(qa.prompt).toContain("Make us a shared grocery list");
    const seen = Object.values(s.tools).filter((t) => qa.role.visible!(t)).map((t) => t.spec.name);
    expect(seen.sort()).toEqual(["app_data", "app_read", "app_verdict"]);
    expect(text(await s.as(issue, "qa")("app_verdict", { usable: true }))).toMatch(/Noted: usable/);
    await s.finish("Added, ticked and removed an item.");
    expect(s.now(issue)).toMatchObject({ status: "in_review", reviews: [{ kind: "result", how: "tried", askedBy: "gate", state: "passed", rounds: 0, version: 1 }] });
    expect(s.now(issue).qa).toBeUndefined();
    expect(s.now(issue).prs.at(-1)!.body).toBe("Made the list: https://example.com/a/x");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "qa", text: "Tried the app: usable." });
    expect(s.pm.seen.at(-1)).toMatchObject({ kind: "pr", issue });
  });

  it("bugs go back to the engineer, who fixes them, and QA tries the new version", async () => {
    const s = setup();
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Removed Milk, reloaded: Milk is back." });
    await s.finish("One bug.");
    expect(s.now(issue)).toMatchObject({ status: "in_progress", reviews: [{ state: "changes", rounds: 1, notes: "Removed Milk, reloaded: Milk is back." }] });
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "qa", text: "Sent back (1/3): Removed Milk, reloaded: Milk is back." });
    expect(s.last().role.name).toBe("engineer");
    expect(s.last().prompt).toContain("Removed Milk, reloaded: Milk is back.");
    await s.as(issue)("app_update", { id, replace: { old: "items.length", new: "items.length + 0" } });
    await s.finish("Fixed: removing stays removed.");
    expect(s.last().role.name).toBe("qa");
    expect(s.last().prompt).toContain("version 2");
    expect(s.last().prompt).toContain("You sent it back once already");
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Stays removed now.");
    expect(s.now(issue).status).toBe("in_review");
    expect(s.now(issue).prs.at(-1)!.body).toBe("Fixed: removing stays removed.");
  });

  it("after three rounds the PM hears what QA still finds", async () => {
    const s = setup();
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    await s.finish("Made the list.");
    for (let round = 1; round <= Desk.QA_ROUNDS; round++) {
      await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
      await s.finish("Still broken.");
      expect(s.last().role.name).toBe("engineer");
      await s.as(issue)("app_update", { id, replace: { old: "Groceries", new: `Groceries ${round}` } });
      await s.finish(`Fixed (${round}).`);
      expect(s.last().role.name).toBe("qa");
    }
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("Still broken.");
    expect(s.now(issue).status).toBe("in_review");
    expect(s.now(issue).prs.at(-1)!.body).toBe("Fixed (3).\n\nQA still finds, after 3 rounds of fixes: Add does nothing.");
    expect(s.host.runs.filter((r) => r.role.name === "qa")).toHaveLength(4);
    expect(s.now(issue).reviews).toMatchObject([{ state: "waived", rounds: 3, notes: "Add does nothing." }]);
  });

  it("an engineer sent back who changes nothing isn't tried again: the PM gets its answer", async () => {
    const s = setup();
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    await s.finish("Add works for me; nothing to change.");
    expect(s.now(issue).status).toBe("in_review");
    expect(s.host.runs.filter((r) => r.role.name === "qa")).toHaveLength(1);
    expect(s.now(issue).reviews).toMatchObject([{ state: "waived", rounds: 1, notes: "the engineer made no new version" }]);
  });

  it("QA that fails or gives no verdict doesn't hold the result up", async () => {
    const s = setup();
    const one = s.assigned("Make us a shared grocery list");
    await made(s, one);
    await s.finish("Made the list.");
    s.last().fail("browser didn't start");
    await tick();
    expect(s.now(one).status).toBe("in_review");
    expect(s.now(one).thread.at(-1)).toMatchObject({ by: "system", text: "QA couldn't try the app: browser didn't start" });
    expect(s.now(one).reviews).toMatchObject([{ state: "waived", notes: "couldn't try it: browser didn't start" }]);

    const two = s.assigned("Make us a chore chart");
    await made(s, two);
    await s.finish("Made the chart.");
    await s.finish("Looks fine to me.");
    expect(s.now(two).status).toBe("in_review");
    expect(s.now(two).prs.at(-1)!.body).toBe("Made the chart.");
    expect(s.now(two).reviews).toMatchObject([{ state: "waived", notes: "no verdict" }]);
  });

  it("only QA gives a verdict, a no needs its bugs, and QA changes only scratch data", async () => {
    const s = setup();
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    expect(failed(await s.as(issue)("app_verdict", { usable: true }))).toBe(true);
    expect(failed(await s.as(issue, "qa")("app_verdict", { usable: true }))).toBe(true); // QA isn't running yet
    await s.finish("Made the list.");
    const qa = s.as(issue, "qa");
    expect(failed(await qa("app_verdict", { usable: false }))).toBe(true);
    expect(failed(await qa("app_data", { id, action: "put", collection: "items", records: [{ name: "Milk" }] }))).toBe(true);
    expect(failed(await qa("app_data", { id, action: "list" }))).toBe(false);
    expect(failed(await qa("app_data", { id, action: "put", collection: "items", records: [{ name: "Milk" }], scratch: true }))).toBe(false);
    expect(s.store.list(id, "items")).toEqual([]);
  });

  it("what the caller says while QA has the app waits for the engineer's next run", async () => {
    const s = setup();
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    s.desk.comment(issue, s.now(issue).filedBy.call, "Also add a quantity field");
    expect(s.host.steered).toEqual([]);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    expect(s.now(issue).status).toBe("in_progress");
    expect(s.last().role.name).toBe("engineer");
    expect(s.last().prompt).toContain("Also add a quantity field");
  });

  it("a follow-up runs in the earlier conversation, on the app model, and QA tries the app it changed", async () => {
    const s = setup();
    const first = s.assigned("Make us a shared grocery list");
    const id = await made(s, first);
    await s.finish("Made the list.");
    await s.as(first, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    const follow = s.assigned("Add a quantity field to the grocery list", "answer", first);
    expect(s.last()).toMatchObject({ issue: follow, session: first, role: { name: "engineer", model: s.terra } });
    // The engineer's tools run in the first issue's conversation.
    await s.as(first)("app_update", { id, replace: { old: "items.length", new: "items.length + 0" } });
    await s.finish("Added quantity.");
    expect(s.last()).toMatchObject({ issue: follow, session: undefined, role: { name: "qa" } });
    expect(s.last().prompt).toContain("version 2");
  });

  it("no QA for work that isn't an app, an app left unchanged, or a desk with QA off", async () => {
    const s = setup();
    const answer = s.assigned("When is the dentist?", "answer");
    expect(s.last().role).toMatchObject({ name: "engineer", model: s.luna });
    await s.finish("Monday at 9.");
    expect(s.now(answer).status).toBe("in_review");

    const first = s.assigned("Make us a shared grocery list");
    await made(s, first);
    await s.finish("Made the list.");
    await s.as(first, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    const ask = s.assigned("What does the grocery list app do?", "answer", first);
    await s.finish("It keeps a shared list.");
    expect(s.now(ask).status).toBe("in_review");
    expect(s.host.runs.filter((r) => r.role.name === "qa")).toHaveLength(1);

    const off = setup({ qa: false });
    const issue = off.assigned("Make us a shared grocery list");
    await made(off, issue);
    await off.finish("Made the list.");
    expect(off.now(issue).status).toBe("in_review");
  });
});

describe("the result gate says whether a changed app needs trying", () => {
  it("none: the result goes straight to the PM, and the decision is on the thread", async () => {
    const seen: ResultCheck[] = [];
    const s = setup({ gate: async (c) => (seen.push(c), { check: "none", p: 0.9 }) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    expect(s.now(issue).status).toBe("in_review");
    expect(s.host.runs.filter((r) => r.role.name === "qa")).toHaveLength(0);
    expect(s.now(issue).reviews).toBeUndefined();
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Result check: none (0.90)" });
    expect(s.now(issue).prs.at(-1)!.body).toBe("Made the list.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ request: "Make us a shared grocery list", goal: "Make us a shared grocery list", doneWhen: "it works on a phone", deliverable: "app", result: "Made the list.", changed: 'app "Groceries": new, 7 lines', ledger: [] });
  });

  it("tried: QA uses the app, as without a gate", async () => {
    const s = setup({ gate: async () => ({ check: "tried", p: 0.95 }) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    expect(s.last().role.name).toBe("qa");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Result check: try the app (0.95)" });
    expect(s.now(issue).reviews).toMatchObject([{ kind: "result", how: "tried", askedBy: "gate", state: "open" }]);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    expect(s.now(issue).status).toBe("in_review");
  });

  it("a gate that fails means the app is tried", async () => {
    const s = setup({ gate: async () => { throw new Error("decision model 503"); } });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    expect(s.last().role.name).toBe("qa");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Result check: try the app" });
  });

  it("is asked once: after a version has been tried, each new one is", async () => {
    let asked = 0;
    const s = setup({ gate: async () => (asked++, { check: "tried" }) });
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    await s.as(issue)("app_update", { id, replace: { old: "items.length", new: "items.length + 0" } });
    await s.finish("Fixed.");
    expect(s.last().role.name).toBe("qa");
    expect(asked).toBe(1);
  });

  it("a small change to an app nobody has tried on this issue is asked about, with how much changed", async () => {
    const seen: ResultCheck[] = [];
    const s = setup({ gate: async (c) => (seen.push(c), { check: "none", p: 0.8 }) });
    const first = s.assigned("Make us a shared grocery list");
    const id = await made(s, first);
    await s.finish("Made the list.");
    const follow = s.assigned("Call the list Shopping", "app", first);
    await s.as(first)("app_update", { id, replace: { old: "<title>Groceries</title>", new: "<title>Shopping</title>" } });
    await s.finish("Renamed.");
    expect(s.now(follow).status).toBe("in_review");
    expect(seen.at(-1)!.changed).toBe('app "Groceries": version 1 → 2, 2 of 7 lines changed');
  });

  it("what the caller says while the gate decides reaches the engineer", async () => {
    let release!: (d: ResultDecision) => void;
    const s = setup({ gate: () => new Promise((r) => (release = r)) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    s.desk.comment(issue, s.now(issue).filedBy.call, "Also add a quantity field");
    expect(s.host.steered).toEqual([]);
    release({ check: "none", p: 0.9 });
    await tick();
    expect(s.now(issue).status).toBe("in_progress");
    expect(s.last().role.name).toBe("engineer");
    expect(s.last().prompt).toContain("Also add a quantity field");
  });

  it("an issue closed while the gate decides starts nothing", async () => {
    let release!: (d: ResultDecision) => void;
    const s = setup({ gate: () => new Promise((r) => (release = r)) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    const runs = s.host.runs.length;
    expect(s.desk.close(issue, "wont_do").ok).toBe(true);
    release({ check: "tried" });
    await tick();
    expect(s.host.runs).toHaveLength(runs);
    expect(s.now(issue).status).toBe("wont_do");
    expect(s.now(issue).prs).toHaveLength(0);
  });

  it("the sweeper doesn't call an issue stuck while the gate decides", async () => {
    let release!: (d: ResultDecision) => void;
    const s = setup({ gate: () => new Promise((r) => (release = r)) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    s.desk.sweep();
    expect(s.now(issue).status).toBe("in_progress");
    release({ check: "none" });
    await tick();
    expect(s.now(issue).status).toBe("in_review");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ text: "Result check: none" });
  });
});

describe("a worker's message about an app waits until the app has been checked", () => {
  const LINK = "Your list is ready: https://example.com/a/x";
  const inbox = (s: ReturnType<typeof setup>, issue: number) => s.desk.repo.inbox(s.now(issue).filedBy.call, 0).map((m) => m.text);
  const said = async (s: ReturnType<typeof setup>, issue: number, text: string) => {
    const r = await s.desk.messageCaller(issue, text);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("goes at once before there is an app; is kept once the app exists; goes when QA passes it", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    expect(await said(s, issue, "Starting on it.")).toBe("Passed on in their conversation.");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept: it goes to them once the app has been checked/);
    expect(inbox(s, issue)).toContain("Starting on it.");
    expect(inbox(s, issue)).not.toContain(LINK);
    expect(s.now(issue).heldMessages).toMatchObject([{ text: LINK }]);
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: `Kept until the app has been checked: ${LINK}` });
    await s.finish("Made the list.");
    expect(inbox(s, issue)).not.toContain(LINK);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
    expect(s.now(issue).heldMessages).toBeUndefined();
    expect(s.now(issue).status).toBe("in_review");
  });

  it("goes as soon as the engineer finishes when the gate says no check is needed", async () => {
    const s = setup({ notify: true, gate: async () => ({ check: "none", p: 0.9 }) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    await s.finish("Made the list.");
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
  });

  it("is kept through a send-back and goes when the fixed version passes", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    expect(await said(s, issue, LINK)).toMatch(/^Kept/); // the engineer, fixing, before it has changed anything
    await s.as(issue)("app_update", { id, replace: { old: "items.length", new: "items.length + 0" } });
    await s.finish("Fixed.");
    expect(inbox(s, issue)).not.toContain(LINK);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
  });

  it("is not sent when QA still finds bugs: the PM sees it on the thread", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    await s.finish("Add works for me; nothing to change."); // no new version: the review is waived with its bug
    await tick();
    expect(s.now(issue).status).toBe("in_review");
    expect(inbox(s, issue)).not.toContain(LINK);
    expect(s.now(issue).heldMessages).toBeUndefined();
    expect(s.now(issue).thread.map((e) => e.text)).toContain(`Not sent (the check found problems): ${LINK}`);
  });

  it("is not sent when the work fails", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    s.last().fail("model error");
    await tick();
    expect(s.now(issue).status).toBe("failed");
    expect(inbox(s, issue)).not.toContain(LINK);
    expect(s.now(issue).thread.map((e) => e.text)).toContain(`Not sent (the work failed): ${LINK}`);
  });

  it("QA that couldn't run doesn't keep the message back", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    await s.finish("Made the list.");
    s.last().fail("browser didn't start");
    await tick();
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
  });

  it("nothing is kept with QA off, for work that isn't an app, or for an app this run didn't change", async () => {
    const off = setup({ notify: true, qa: false });
    const a = off.assigned("Make us a shared grocery list");
    await made(off, a);
    expect(await said(off, a, LINK)).toBe("Passed on in their conversation.");

    const s = setup({ notify: true });
    const answer = s.assigned("When is the dentist?", "answer");
    expect(await said(s, answer, "Monday at 9.")).toBe("Passed on in their conversation.");
    await s.finish("Monday at 9.");

    const first = s.assigned("Make us a shared grocery list");
    await made(s, first);
    await s.finish("Made the list.");
    await s.as(first, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    const ask = s.assigned("What does the grocery list app do?", "answer", first);
    expect(await said(s, ask, "It keeps a shared list.")).toBe("Passed on in their conversation.");
  });
});
