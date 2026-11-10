/**
 * "Be more concise": how someone wants Kloru to work is saved the moment they say it, in their
 * guidelines file, which every agent is given. Work already running hears it too.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Memory } from "../src/memory.js";

const EZRA = "+14155550190";

class Host implements WorkerHost {
  steered: Array<{ issue: number; text: string }> = [];
  run(_i: number, _r: WorkerRole): Promise<string> {
    return new Promise(() => {});
  }
  steer(issue: number, text: string): boolean {
    this.steered.push({ issue, text });
    return true;
  }
  stop(): void {}
}
class PM implements Planner {
  async handle(ts: Trigger[], d: Desk): Promise<void> {
    for (const t of ts) if (t.kind === "filed") d.assign(t.issue, "work", "Do it", []);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(isGuideline: (text: string) => Promise<boolean>) {
  const root = mkdtempSync(join(tmpdir(), "prefs-"));
  const memory = new Memory(join(root, "memory"), { owner: { name: "Ezra Vega", phones: [EZRA] } });
  memory.init();
  const host = new Host();
  const desk = new Desk({ root, host, planner: new PM(), memory, guidelines: (p) => memory.guidelines(p), isGuideline });
  return { desk, memory, host };
}

describe("a preference is saved the moment it's said", () => {
  it("'be more concise' goes into their guidelines at once, committed, and every new agent gets it", async () => {
    const { desk, memory } = setup(async () => true);
    const { call } = desk.startCall({ callSid: "imessage:1", phone: EZRA, channel: "imessage" });
    await desk.rememberNow(call.id, "Be more concise in all messages and writing.");
    expect(memory.guidelines(EZRA)).toMatch(/- Be more concise in all messages and writing\. \(Ezra, \d{4}-\d{2}-\d{2}\)/);
    expect(memory.log()[0]!.message).toMatch(/guideline/i);
    expect(desk.brief(EZRA)).toContain("Be more concise in all messages and writing.");
  });

  it("work already running for them is told", async () => {
    const { desk, host } = setup(async () => true);
    const { call } = desk.startCall({ callSid: "imessage:1", phone: EZRA, channel: "imessage" });
    const issue = desk.fileIssue(call.id, "Compare SFO parking");
    await settle();
    await desk.rememberNow(call.id, "Be more concise in all messages and writing.");
    expect(host.steered).toContainEqual({ issue: issue.id, text: expect.stringContaining("Be more concise") });
  });

  it("a fact that isn't about how they want Kloru to work is kept for the end-of-call memory, not the guidelines", async () => {
    const { desk, memory } = setup(async () => false);
    const { call } = desk.startCall({ callSid: "imessage:1", phone: EZRA, channel: "imessage" });
    await desk.rememberNow(call.id, "Cleo's birthday is March 3.");
    expect(memory.guidelines(EZRA)).not.toContain("March 3");
    expect(desk.repo.call(call.id)!.notes).toContain("Cleo's birthday is March 3.");
  });

  it("if the check fails, it's still kept for the end-of-call memory", async () => {
    const { desk } = setup(async () => Promise.reject(new Error("503")));
    const { call } = desk.startCall({ callSid: "imessage:1", phone: EZRA, channel: "imessage" });
    await desk.rememberNow(call.id, "Be concise.");
    expect(desk.repo.call(call.id)!.notes).toContain("Be concise.");
  });
});

describe("Memory: adding a guideline", () => {
  it("appends a dated line, keeping the file's header, and starts the file when there isn't one", () => {
    const memory = new Memory(join(mkdtempSync(join(tmpdir(), "prefs-")), "memory"), { owner: { name: "Ezra Vega", phones: [EZRA] } });
    memory.init();
    const r1 = memory.addGuideline(EZRA, "Text me, don't email.", new Date("2026-11-01T18:30:00Z"));
    expect(r1.ok).toBe(true);
    memory.addGuideline(EZRA, "Be concise.", new Date("2026-11-01T18:31:00Z"));
    const g = memory.guidelines(EZRA);
    expect(g).toContain("- Text me, don't email. (Ezra, 2026-11-01)\n- Be concise. (Ezra, 2026-11-01)");
    expect(memory.open("ezra/guidelines.md")?.type).toBe("guidelines");
  });
});
