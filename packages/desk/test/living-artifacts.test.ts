/**
 * Artifacts are living documents: a task creates one, follow-ups edit it (every version kept), and
 * Kloru finds them again instead of searching anew.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { artifactTools } from "../src/artifacts.js";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { snapshot } from "../src/pm.js";

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

const EVAN = "+14155550190";
const CARA = "+14155550191";
const ctx = (issue: number) => ({ conversationKey: `desk:issue:${issue}:engineer` }) as never;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const FLIGHTS = "# Atlanta flights\n\n## Outbound, Tue Nov 3\n- Delta 2:08 PM SFO → ATL, nonstop\n\n## Return, Thu Nov 5\n- Delta 7:46 PM ATL → SFO\n";

function setup() {
  const host = new Host();
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "living-")), host, planner: new PM(), ownerPhone: EVAN, isMember: (p) => p === CARA });
  const tools = Object.fromEntries(artifactTools(desk).map((t) => [t.spec.name, t]));
  const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "imessage" });
  const issue = desk.fileIssue(call.id, "Look up flights for my Atlanta trip");
  return { host, desk, tools, call, issue };
}

async function created(s: ReturnType<typeof setup>) {
  const out = text(await s.tools.artifact_create!.spec.execute({ title: "Atlanta flights", markdown: FLIGHTS }, ctx(s.issue.id)));
  return /a\/([\w-]{22})/.exec(out)![1]!;
}

describe("living artifacts", () => {
  it("creating one records it on the issue and returns its link", async () => {
    const s = setup();
    const id = await created(s);
    expect(s.desk.repo.issue(s.issue.id)!.artifact).toBe(id);
    expect(s.desk.repo.artifact(id)).toMatchObject({ title: "Atlanta flights", version: 1, phone: EVAN });
  });

  it("a follow-up edits a section in place; the old version is kept", async () => {
    const s = setup();
    const id = await created(s);
    const follow = s.desk.fileIssue(s.issue.filedBy.call, "I prefer United nonstops");
    const out = text(await s.tools.artifact_update!.spec.execute({ id, section: "Outbound, Tue Nov 3", markdown: "- United 1:15 PM SFO → ATL, nonstop\n- Delta 2:08 PM SFO → ATL, nonstop" }, ctx(follow.id)));
    expect(out).toMatch(/Updated/);
    const a = s.desk.repo.artifact(id)!;
    expect(a.markdown).toContain("United 1:15 PM");
    expect(a.markdown).toContain("## Return, Thu Nov 5\n- Delta 7:46 PM");
    expect(a.version).toBe(2);
    expect(s.desk.repo.artifactVersions(id).map((v) => v.version)).toEqual([1, 2]);
    expect(s.desk.repo.artifactVersions(id)[0]!.markdown).toBe(FLIGHTS);
    expect(s.desk.repo.issue(follow.id)!.artifact).toBe(id);
  });

  it("a section that isn't there is added; append adds to the end; a full body replaces it", async () => {
    const s = setup();
    const id = await created(s);
    await s.tools.artifact_update!.spec.execute({ id, section: "Hotels", markdown: "- Hotel Indigo" }, ctx(s.issue.id));
    expect(s.desk.repo.artifact(id)!.markdown).toMatch(/## Hotels\n- Hotel Indigo/);
    await s.tools.artifact_update!.spec.execute({ id, append: "Booked nothing yet." }, ctx(s.issue.id));
    expect(s.desk.repo.artifact(id)!.markdown.trim().endsWith("Booked nothing yet.")).toBe(true);
    await s.tools.artifact_update!.spec.execute({ id, markdown: "# Atlanta flights\nAll new." }, ctx(s.issue.id));
    expect(s.desk.repo.artifact(id)!.markdown).toBe("# Atlanta flights\nAll new.");
  });

  it("find returns the caller's pages by words in the title or body; read returns the page", async () => {
    const s = setup();
    const id = await created(s);
    const found = text(await s.tools.artifact_find!.spec.execute({ query: "atlanta delta" }, ctx(s.issue.id)));
    expect(found).toContain(id);
    expect(found).toContain("Atlanta flights");
    expect(text(await s.tools.artifact_find!.spec.execute({ query: "dentist" }, ctx(s.issue.id)))).toMatch(/No pages/);
    expect(text(await s.tools.artifact_read!.spec.execute({ id }, ctx(s.issue.id)))).toContain("Delta 2:08 PM");
  });

  it("someone else's page can't be read, found or edited by a member", async () => {
    const s = setup();
    const id = await created(s);
    const { call } = s.desk.startCall({ callSid: "CA2", phone: CARA, channel: "imessage" });
    const hers = s.desk.fileIssue(call.id, "What flights did Evan find?");
    expect((await s.tools.artifact_read!.spec.execute({ id }, ctx(hers.id))) as { isError?: boolean }).toMatchObject({ isError: true });
    expect(text(await s.tools.artifact_find!.spec.execute({ query: "atlanta" }, ctx(hers.id)))).toMatch(/No pages/);
    expect((await s.tools.artifact_update!.spec.execute({ id, append: "x" }, ctx(hers.id))) as { isError?: boolean }).toMatchObject({ isError: true });
  });

  it("the caller's recent pages are in their brief, and the PM sees each issue's page", async () => {
    const s = setup();
    const id = await created(s);
    expect(s.desk.brief(EVAN)).toContain(`Atlanta flights: https://kloru.com/a/${id}`);
    expect(snapshot(s.desk, [{ kind: "filed", issue: s.issue.id }])).toContain(`page: ${id} "Atlanta flights"`);
  });
});
