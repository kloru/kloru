import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Memory } from "../src/memory.js";
import { memoryTools } from "../src/memory-tools.js";

const EZRA = "+14155550190";

class Host implements WorkerHost {
  runs: Array<{ issue: number; role: WorkerRole; prompt: string; phone?: string; finish: (t: string) => void; fail: (e: Error) => void }> = [];
  run(issue: number, role: WorkerRole, prompt: string, phone?: string): Promise<string> {
    return new Promise((finish, fail) => this.runs.push({ issue, role, prompt, ...(phone ? { phone } : {}), finish, fail }));
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 5));
};

function setup(legacy = "") {
  const root = mkdtempSync(join(tmpdir(), "desk-mem-"));
  const memory = new Memory(join(root, "memory"), { owner: { name: "Ezra Vega", phones: [EZRA] } });
  memory.init();
  const host = new Host();
  const triggers: Trigger[] = [];
  const planner: Planner = { handle: async (ts) => void triggers.push(...ts) };
  const desk = new Desk({ root, host, planner, memory, legacyMemory: () => legacy });
  return { desk, host, memory, triggers };
}

const tool = (name: string) => memoryTools(new Memory("/nonexistent", { owner: { name: "x", phones: [] } })).find((t) => t.spec.name === name)!;

function talk(desk: Desk, text = "Pick up Nora from daycare at 4:30") {
  const { call } = desk.startCall({ callSid: `CA${Math.random()}`, phone: EZRA, channel: "voice" });
  desk.addTurn(call.id, { role: "caller", text });
  desk.addTurn(call.id, { role: "kloru", text: "Sure. How old is Nora?" });
  desk.addTurn(call.id, { role: "caller", text: "She's three, at Little Pines." });
  return call;
}

describe("memory after every call", () => {
  it("an ended call files a memory ops issue that runs as the memory worker, with the transcript", async () => {
    const { desk, host, triggers } = setup();
    const call = talk(desk);
    desk.endCall(call.id);
    await settle();
    const issue = desk.repo.issues((i) => i.purpose === "memory")[0]!;
    expect(issue).toMatchObject({ kind: "ops", status: "executing", filedBy: { call: call.id } });
    const run = host.runs.at(-1)!;
    expect(run.role.name).toBe("memory");
    expect(run.phone).toBeUndefined(); // household memory is written as the owner, whoever called
    expect(run.prompt).toContain("She's three, at Little Pines.");
    expect(triggers).toEqual([]); // the PM isn't involved
    expect(desk.openIssues()).toEqual([]); // nor is the talking model
  });

  it("a finished run is one commit in the ledger; a revert undoes it", async () => {
    const { desk, host, memory } = setup();
    const call = talk(desk);
    desk.endCall(call.id);
    await settle();
    memory.save("household/people/nora.md", "---\nid: nora\ntype: person\n---\n- Ezra's daughter, 3\n");
    host.runs.at(-1)!.finish("Added Nora.");
    await settle();
    const issue = desk.repo.issues((i) => i.purpose === "memory")[0]!;
    expect(issue.status).toBe("done");
    const [entry] = desk.repo.ledger(issue.id);
    expect(entry).toMatchObject({ slug: "MEMORY_COMMIT", ok: true });
    expect(memory.open("household/people/nora.md")).toBeDefined();
    const undo = desk.fileOps({ spec: "Undo that memory change", resources: [], reverts: issue.id });
    expect(undo.ok).toBe(true);
    expect(memory.open("household/people/nora.md")).toBeUndefined();
    expect(desk.repo.issue(issue.id)!.status).toBe("reverted");
  });

  it("memory runs one at a time, oldest call first", async () => {
    const { desk, host } = setup();
    const a = talk(desk, "first call");
    const b = talk(desk, "second call");
    desk.endCall(a.id);
    desk.endCall(b.id);
    await settle();
    expect(host.runs.filter((r) => r.role.name === "memory")).toHaveLength(1);
    host.runs.at(-1)!.finish("Nothing new.");
    await settle();
    const memRuns = host.runs.filter((r) => r.role.name === "memory");
    expect(memRuns).toHaveLength(2);
    expect(memRuns[1]!.prompt).toContain("second call");
  });

  it("a failed run drops its half-written files and doesn't block the next", async () => {
    const { desk, host, memory } = setup();
    desk.endCall(talk(desk, "first").id);
    desk.endCall(talk(desk, "second").id);
    await settle();
    memory.save("household/people/half.md", "---\nid: half\ntype: person\n---\n- x\n");
    host.runs.at(-1)!.fail(new Error("429"));
    await settle();
    expect(memory.open("household/people/half.md")).toBeUndefined();
    expect(host.runs.filter((r) => r.role.name === "memory")).toHaveLength(2);
  });

  it("a call where the caller said nothing files no memory issue, and each call files one at most", async () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "CA0", phone: EZRA, channel: "voice" });
    desk.endCall(call.id);
    const c = talk(desk);
    desk.endCall(c.id);
    desk.endCall(c.id);
    expect(desk.repo.issues((i) => i.purpose === "memory")).toHaveLength(1);
  });

  it("'remember that…' during a call reaches the memory worker as a note", async () => {
    const { desk, host } = setup();
    const call = talk(desk);
    desk.noteForMemory(call.id, "Nora is allergic to peanuts");
    desk.endCall(call.id);
    await settle();
    expect(host.runs.at(-1)!.prompt).toContain("allergic to peanuts");
  });
});

describe("the brief", () => {
  it("startCall returns what Kloru knows, before the first word", () => {
    const { desk, memory } = setup();
    memory.save("household/people/nora.md", "---\nid: nora\ntype: person\n---\n- Ezra's daughter, 3\n");
    memory.commit("x");
    const out = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    expect(out.brief).toContain("Nora");
    expect(out.brief).toContain("Ezra Vega");
  });

  it("the brief includes what this phone's last call asked for", () => {
    const { desk } = setup();
    const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "Find us a pediatric dentist" });
    desk.fileIssue(call.id, "Find a pediatric dentist near Maplewood");
    desk.endCall(call.id);
    const empty = desk.startCall({ callSid: "CA-hangup", phone: EZRA, channel: "voice" }).call; // said nothing
    desk.endCall(empty.id);
    expect(desk.startCall({ callSid: "CA2", phone: EZRA, channel: "voice" }).brief).toContain("pediatric dentist");
  });
});

describe("recent tasks", () => {
  const CLEO = "+14155550191";
  function finished(desk: Desk, phone: string, request: string, result: string, o: { daysAgo?: number; purpose?: "memory" } = {}) {
    const { call } = desk.startCall({ callSid: `CA${Math.random()}`, phone, channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: request });
    const issue = desk.fileIssue(call.id, request);
    desk.endCall(call.id);
    const i = desk.repo.issue(issue.id)!;
    i.status = "merged";
    i.prs.push({ at: i.createdAt, body: result, baseTurn: 0, status: "merged" });
    if (o.purpose) i.purpose = o.purpose;
    if (o.daysAgo) i.updatedAt = new Date(Date.now() - o.daysAgo * 86_400_000).toISOString();
    desk.repo.saveIssue(i, false);
    return i;
  }

  it("the brief lists the caller's tasks from the last week with what each found, newest first, from every call", () => {
    const { desk } = setup();
    finished(desk, EZRA, "Find passion fruit chocolates", "Done. I emailed three bonbon links from Casa de Chocolates.");
    finished(desk, EZRA, "Look up Portland bulky-item pickup", "Done. I emailed the Portland bulky-item pickup instructions.");
    finished(desk, EZRA, "Plan the Tucson flights", "Found a 6 pm Delta flight.", { daysAgo: 9 });
    finished(desk, CLEO, "Find a pediatric dentist", "Emailed Cleo two dentists.");
    finished(desk, EZRA, "Update memory from the call", "Saved.", { purpose: "memory" });
    const brief = desk.startCall({ callSid: "CA9", phone: EZRA, channel: "voice" }).brief;
    expect(brief).toContain("Recent tasks");
    expect(brief).toContain("bonbon links");
    expect(brief.indexOf("bulky-item pickup instructions")).toBeLessThan(brief.indexOf("bonbon links"));
    expect(brief).not.toContain("Delta");
    expect(brief).not.toContain("dentist");
    expect(brief).not.toContain("Update memory");
  });

  it("recentTasks gives the fast path a longer window and the whole result", () => {
    const { desk } = setup();
    const long = `Done. ${"Details about the flight. ".repeat(20)}Confirmation DL123.`;
    finished(desk, EZRA, "Plan the Tucson flights", long, { daysAgo: 9 });
    const lines = desk.recentTasks(EZRA, { days: 30, limit: 15 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("DL123");
    expect(desk.recentTasks(EZRA, { days: 7, limit: 6 })).toEqual([]);
  });
});

describe("backfill", () => {
  it("files one memory issue per past call, oldest first, with the old MEMORY.md facts on the first", async () => {
    const { desk, host } = setup("Ezra prefers concise updates.");
    const calls = [talk(desk, "one"), talk(desk, "two")];
    for (const c of calls) desk.repo.endCall(c.id); // ended before memory existed: no issues yet
    expect(desk.backfillMemory()).toBe(2);
    expect(desk.backfillMemory()).toBe(0);
    await settle();
    expect(host.runs.at(-1)!.prompt).toContain("Ezra prefers concise updates.");
  });
});

describe("backfill again", () => {
  it("files a fresh memory issue for every past call when asked, so a better worker can fill gaps", async () => {
    const { desk, host } = setup();
    const c = talk(desk, "one");
    desk.endCall(c.id);
    await settle();
    expect(desk.backfillMemory({ again: true })).toBe(0); // still running
    host.runs.at(-1)!.finish("Saved Nora.");
    await settle();
    expect(desk.backfillMemory()).toBe(0);
    expect(desk.backfillMemory({ again: true })).toBe(1);
  });

  it("the memory worker files every person, place and plan, by the names people use", async () => {
    const { desk, host } = setup();
    desk.endCall(talk(desk).id);
    await settle();
    expect(host.runs.at(-1)!.role.prompt).toMatch(/every person, place and plan/);
    expect(host.runs.at(-1)!.role.prompt).not.toMatch(/apps already hold/);
  });
});

describe("the day view", () => {
  it("what's on today and tomorrow is in the brief before the first word, so the commonest questions need no lookup", () => {
    const root = mkdtempSync(join(tmpdir(), "desk-day-"));
    const memory = new Memory(join(root, "memory"), { owner: { name: "Ezra Vega", phones: [EZRA] } });
    memory.init();
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} }, memory, dayView: (phone) => (phone === EZRA ? "Today (Thu): 8:00 AM drop-off; 4:30 PM pickup\nUnread: Cleo, Dinner Saturday?" : "") });
    const brief = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" }).brief;
    expect(brief).toContain("Today (Thu): 8:00 AM drop-off");
    expect(brief).toContain("Ezra Vega");
  });
});
