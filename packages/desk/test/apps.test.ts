/**
 * Apps are artifacts of a second kind: one HTML file a worker writes with a tool call, served by the
 * website with a data store. Same link, versions and follow-ups as a page (issue #43).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { describe, expect, it } from "vitest";
import { appTools, checkApp } from "../src/apps.js";
import { artifactTools } from "../src/artifacts.js";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";

class Host implements WorkerHost {
  run(_: number, __: WorkerRole, ___: string): Promise<string> {
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
const SAM = "+14155550192";
const ctx = (issue: number) => ({ conversationKey: `desk:issue:${issue}:engineer` }) as never;
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const failed = (r: unknown) => !!(r as { isError?: boolean }).isError;
const LIST = `<!doctype html>\n<title>Groceries</title>\n<ul id="items"></ul>\n<script>\nasync function draw() {\n  const items = await kloru.list("items");\n  document.getElementById("items").textContent = items.length;\n}\nkloru.onChange(draw);\ndraw();\n</script>\n`;

function setup(errors: Record<string, string[]> = {}) {
  const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "apps-")), host: new Host(), planner: new PM(), ownerPhone: EZRA, isMember: (p) => p === CLEO, appErrors: (id, version) => errors[`${id}:${version}`] ?? [] });
  const tools = Object.fromEntries([...appTools(desk), ...artifactTools(desk)].map((t) => [t.spec.name, t]));
  const file = (phone: string, request: string, sid: string) => desk.fileIssue(desk.startCall({ callSid: sid, phone, channel: "imessage" }).call.id, request);
  const issue = file(CLEO, "Make us a shared grocery list", "CA1");
  const run = (name: string, args: Record<string, unknown>, issueId = issue.id) => tools[name]!.spec.execute(args as never, ctx(issueId));
  return { desk, tools, issue, file, run, errors };
}

async function created(s: ReturnType<typeof setup>) {
  return /a\/([\w-]{22})/.exec(text(await s.run("app_create", { title: "Groceries", html: LIST })))![1]!;
}

describe("apps (2026-11-09)", () => {
  it("app_create saves an app on the issue, private to the family, and returns its link", async () => {
    const s = setup();
    const id = await created(s);
    expect(s.desk.repo.issue(s.issue.id)!.artifact).toBe(id);
    expect(s.desk.repo.artifact(id)).toMatchObject({ kind: "app", title: "Groceries", html: LIST, markdown: "", version: 1, phone: CLEO });
    expect(s.desk.repo.artifact(id)!.visitors).toBeUndefined();
    expect(s.desk.repo.artifactVersions(id)).toMatchObject([{ version: 1, html: LIST }]);
  });

  it("a follow-up changes the same app by one exact replacement, keeping the old version", async () => {
    const s = setup();
    const id = await created(s);
    const follow = s.file(CLEO, "Add a quantity field to the grocery list", "CA2");
    const out = await s.run("app_update", { id, replace: { old: "items.length", new: "items.length + ' items'" } }, follow.id);
    expect(text(out)).toContain(`a/${id}`);
    expect(text(out)).toContain("version 2");
    expect(s.desk.repo.artifact(id)).toMatchObject({ version: 2 });
    expect(s.desk.repo.artifact(id)!.html).toContain("items.length + ' items'");
    expect(s.desk.repo.artifactVersions(id).map((v) => v.version)).toEqual([1, 2]);
    expect(s.desk.repo.issue(follow.id)!.artifact).toBe(id);
  });

  it("a replacement must match exactly once", async () => {
    const s = setup();
    const id = await created(s);
    expect(text(await s.run("app_update", { id, replace: { old: "nowhere", new: "x" } }))).toMatch(/isn't in the file/);
    expect(text(await s.run("app_update", { id, replace: { old: "items", new: "x" } }))).toMatch(/\d+ places/);
    expect(s.desk.repo.artifact(id)!.version).toBe(1);
  });

  it("a whole new file, a title and who may visit can each change", async () => {
    const s = setup();
    const id = await created(s);
    await s.run("app_update", { id, html: LIST.replace("Groceries", "Potluck"), title: "Potluck", visitors: "all" });
    expect(s.desk.repo.artifact(id)).toMatchObject({ title: "Potluck", visitors: "all", version: 2 });
    await s.run("app_update", { id, visitors: "none" });
    expect(s.desk.repo.artifact(id)).toMatchObject({ visitors: "none", version: 3 });
    expect(failed(await s.run("app_update", { id }))).toBe(true);
  });

  it("anyone in the family can change an app, whoever made it; someone outside can't", async () => {
    const s = setup();
    const id = await created(s);
    const ezra = s.file(EZRA, "Add a store field", "CA3");
    expect(failed(await s.run("app_update", { id, title: "Our groceries" }, ezra.id))).toBe(false);
    const sam = s.file(SAM, "Change the grocery list", "CA4");
    expect(failed(await s.run("app_update", { id, title: "Sam's" }, sam.id))).toBe(true);
    expect(failed(await s.run("app_read", { id }, sam.id))).toBe(true);
    expect(s.desk.repo.artifact(id)!.title).toBe("Our groceries");
  });

  it("a file whose script doesn't parse is refused, naming the line", async () => {
    const s = setup();
    const bad = "<!doctype html>\n<p>hi</p>\n<script>\nconst a = 1;\nfunction (\n</script>";
    const out = await s.run("app_create", { title: "Broken", html: bad });
    expect(failed(out)).toBe(true);
    expect(text(out)).toMatch(/line 5/);
    expect(s.desk.repo.artifacts()).toHaveLength(0);
    const id = await created(s);
    expect(failed(await s.run("app_update", { id, replace: { old: "draw();\n</script>", new: "draw(;\n</script>" } }))).toBe(true);
    expect(s.desk.repo.artifact(id)!.version).toBe(1);
  });

  it("checkApp: empty, too long, and scripts or styles loaded from elsewhere are refused; data and module scripts are left alone", () => {
    expect(checkApp(" ").ok).toBe(false);
    expect(checkApp("x".repeat(512_001)).ok).toBe(false);
    expect(checkApp(`<script src="https://cdn.example/vue.js"></script>`)).toMatchObject({ ok: false, error: expect.stringMatching(/one file/) });
    expect(checkApp(`<link rel="stylesheet" href="https://cdn.example/a.css">`).ok).toBe(false);
    expect(checkApp(`<script type="application/json">{not json</script><script type="module">await 1;</script><p>ok</p>`).ok).toBe(true);
    expect(checkApp(LIST).ok).toBe(true);
  });

  it("app_read gives the file and the errors browsers reported for this version", async () => {
    const s = setup();
    const id = await created(s);
    expect(text(await s.run("app_read", { id }))).toContain("kloru.onChange(draw)");
    expect(text(await s.run("app_read", { id }))).not.toMatch(/Errors/);
    s.errors[`${id}:1`] = ["TypeError: items.map is not a function (line 6)"];
    expect(text(await s.run("app_read", { id }))).toMatch(/Errors people's browsers reported[\s\S]*items\.map is not a function/);
  });

  it("pages are untouched: the page tools refuse an app, and find lists it as one", async () => {
    const s = setup();
    const id = await created(s);
    expect(text(await s.run("artifact_read", { id }))).toMatch(/app_read/);
    expect(failed(await s.run("artifact_update", { id, markdown: "# hi" }))).toBe(true);
    expect(s.desk.repo.artifact(id)!.kind).toBe("app");
    expect(text(await s.run("artifact_find", { query: "groceries" }))).toMatch(new RegExp(`${id} "Groceries" \\(app`));
    // Another family member finds the family's app; they don't find each other's pages.
    const ezra = s.file(EZRA, "x", "CA5");
    const cleo2 = s.file(CLEO, "y", "CA6");
    await s.run("artifact_create", { title: "Ezra's week", markdown: "# Week" }, ezra.id);
    expect(text(await s.run("artifact_find", { query: "week groceries" }, cleo2.id))).not.toContain("Ezra's week");
    expect(s.desk.brief(EZRA)).toContain("Groceries (app)");
  });

  it("an app has a test link: its own key, the same across updates, and only for someone who may see it", async () => {
    const s = setup();
    const id = await created(s);
    const link = s.desk.appTestUrl(id, CLEO);
    expect(link).toMatchObject({ ok: true, value: expect.stringMatching(new RegExp(`/${id}\\?test=[A-Za-z0-9_-]{22}$`)) });
    await s.run("app_update", { id, title: "Grocery list" });
    expect(s.desk.appTestUrl(id, EZRA)).toEqual(link);
    expect(s.desk.appTestUrl("nope-nope-nope-nope-00", CLEO).ok).toBe(false);
    // An app made before test keys existed gets one the first time it's tried.
    const { testKey: _old, ...before } = s.desk.repo.artifact(id)!;
    s.desk.repo.saveArtifact(before);
    const later = s.desk.appTestUrl(id, CLEO);
    expect(later.ok && later.value !== (link.ok && link.value)).toBe(true);
    expect(s.desk.appTestUrl(id, CLEO)).toEqual(later);
  });
});
