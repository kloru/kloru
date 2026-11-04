import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolResultLike } from "@kloru/core";
import {
  LOAD_SKILL_TOOL,
  SKILL_FILE_MAX_BYTES,
  createSkillCatalog,
  formatSkillsIndex,
  loadAllSkills,
  loadOwnerSkills,
  loadSkillList,
  loadSkillTool,
  loadSkillsPrompt,
  ownerSkillsDir,
  resolveSkillsDir,
  skillsFor,
} from "../src/skills.js";

const stranger = { principal: { kind: "stranger", id: "stranger:x", tier: "stranger", displayName: "x" }, conversationKey: "imessage:1", channel: "imessage", now: () => new Date() } as unknown as ToolContext;
const owner = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" }, conversationKey: "chat:main", channel: "chat", now: () => new Date() } as unknown as ToolContext;
// The owner speaking in a group thread acts at the lowest tier present, and every reply is seen by all.
const ownerInGroup = { ...owner, principal: { ...owner.principal, tier: "friend", cappedFrom: "owner" } } as unknown as ToolContext;
const textOf = (r: ToolResultLike) => (typeof r === "string" ? r : r.content.map((c) => (c.type === "text" ? c.text : "")).join(""));

describe("skills", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "instinct-skills-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves explicit, then env, then the repo folder, skipping missing dirs", () => {
    const a = join(dir, "a");
    const b = join(dir, "b");
    mkdirSync(a);
    mkdirSync(b);
    expect(resolveSkillsDir({ explicit: a, env: { INSTINCT_SKILLS_DIR: b } })).toBe(a);
    expect(resolveSkillsDir({ explicit: join(dir, "missing"), env: { INSTINCT_SKILLS_DIR: b } })).toBe(b);
    expect(resolveSkillsDir({ env: {} })).toBeUndefined();
    // The repo's own skills folder, relative to a module three levels down.
    const fakeModule = `file://${join(dir, "packages", "server", "dist", "boot.js")}`;
    mkdirSync(join(dir, "skills"));
    expect(resolveSkillsDir({ env: {}, packageUrl: fakeModule })).toBe(join(dir, "skills"));
  });

  it("formats SKILL.md files for the prompt and tolerates an empty or missing folder", () => {
    expect(loadSkillsPrompt(undefined)).toBeUndefined();
    expect(loadSkillsPrompt(join(dir, "nope"))).toBeUndefined();
    expect(loadSkillsPrompt(dir)).toBeUndefined();
    mkdirSync(join(dir, "dining"));
    writeFileSync(join(dir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables and pick restaurants\n---\n\nSteps here.\n");
    const prompt = loadSkillsPrompt(dir);
    expect(prompt).toContain("dining");
    expect(prompt).toContain("Book tables");
  });

  it("points the index at load_skill, not at a file path the read tool cannot open", () => {
    mkdirSync(join(dir, "dining"));
    writeFileSync(join(dir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables\n---\n\nSteps here.\n");
    const prompt = loadSkillsPrompt(dir)!;
    expect(prompt).toContain(LOAD_SKILL_TOOL);
    expect(prompt).not.toContain(join(dir, "dining"));
    expect(prompt).not.toMatch(/read tool/);
  });

  it("load_skill returns a loaded skill by name for any conversing principal and takes no paths", async () => {
    mkdirSync(join(dir, "dining"));
    writeFileSync(join(dir, "dining", "SKILL.md"), "---\nname: dining\ndescription: Book tables\n---\n\nSteps here.\n");
    writeFileSync(join(dir, "secret.txt"), "not a skill");
    const tool = loadSkillTool(loadSkillList(dir)).spec;
    expect(tool.meta.capabilities).toEqual(["converse"]);
    expect(textOf(await tool.execute({ name: "Dining" }, stranger))).toContain("Steps here.");
    for (const name of ["../secret.txt", join(dir, "secret.txt"), "nope"]) {
      const r = await tool.execute({ name }, stranger);
      expect(typeof r === "object" && r.isError, name).toBe(true);
      expect(textOf(r)).toContain("Known skills: dining");
    }
  });

  it("leaves hidden skills out of the index but still loads them by name", async () => {
    mkdirSync(join(dir, "nightly"));
    writeFileSync(join(dir, "nightly", "SKILL.md"), "---\nname: nightly\ndescription: Nightly wrap-up\ndisable-model-invocation: true\n---\n\nWrap up the day.\n");
    const list = loadSkillList(dir);
    expect(loadSkillsPrompt(dir)).toBeUndefined();
    expect(textOf(await loadSkillTool(list).spec.execute({ name: "nightly" }, stranger))).toContain("Wrap up the day.");
  });

  it("keeps the first of two skills whose names differ only in case", () => {
    for (const [folder, name] of [["a", "Dining"], ["b", "dining"]]) {
      mkdirSync(join(dir, folder));
      writeFileSync(join(dir, folder, "SKILL.md"), `---\nname: ${name}\ndescription: Book tables ${folder}\n---\n\nFrom ${folder}.\n`);
    }
    const logs: string[] = [];
    const list = loadSkillList(dir, (m) => logs.push(m));
    expect(list).toHaveLength(1);
    expect(logs.some((l) => l.includes("duplicate name"))).toBe(true);
  });
});

describe("owner skills folder", () => {
  let dir: string;
  let image: string;
  let data: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skills-owner-"));
    image = join(dir, "image");
    data = join(dir, "data", "skills");
    mkdirSync(image, { recursive: true });
    mkdirSync(data, { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const skill = (root: string, folder: string, description: string, extra = "", name = folder.split("/").pop()!) => {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nFrom ${root}/${folder}.\n`);
  };
  const indexFor = (ctx: ToolContext) => formatSkillsIndex(skillsFor(loadAllSkills({ builtinDirs: image, ownerDir: data }), ctx.principal)) ?? "";

  it("merges built-in and owner skills; a built-in wins a case-insensitive name clash, with a warning", () => {
    skill(image, "dining", "Built-in dining");
    skill(image, "travel", "Built-in travel");
    skill(data, "dining2", "Owner dining rules", "visibility: public\n", "Dining");
    skill(data, "haiku", "Write a haiku when asked", "visibility: public\n");
    const logs: string[] = [];
    const list = loadAllSkills({ builtinDirs: [image, join(dir, "missing")], ownerDir: data }, (m) => logs.push(m));
    expect(list.map((s) => `${s.name}:${s.origin}`)).toEqual(["dining:builtin", "travel:builtin", "haiku:owner"]);
    expect(list.find((s) => s.name === "dining")!.description).toBe("Built-in dining");
    expect(logs.some((l) => l.includes('owner skill "Dining"') && l.includes("built-in"))).toBe(true);
    expect(loadSkillsPrompt([join(dir, "missing")])).toBeUndefined();
    expect(ownerSkillsDir("/data")).toBe(join("/data", "skills"));
  });

  it("owner skills are private by default: a stranger neither sees nor loads one, but sees a public one", async () => {
    skill(image, "dining", "Built-in dining");
    skill(data, "diary", "Owner's private diary habits");
    skill(data, "haiku", "Write a haiku when asked", "visibility: public\n");
    const strangerIndex = indexFor(stranger);
    expect(strangerIndex).toContain("Built-in dining");
    expect(strangerIndex).toContain("Write a haiku");
    expect(strangerIndex).not.toContain("diary");
    const ownerIndex = indexFor(owner);
    expect(ownerIndex).toContain("diary");
    expect(ownerIndex).toContain("Write a haiku");
    expect(ownerIndex).toContain("Built-in dining");
    // Shared threads count as not-the-owner: the reply is visible to everyone in them.
    expect(indexFor(ownerInGroup)).not.toContain("diary");

    const tool = loadSkillTool(() => loadAllSkills({ builtinDirs: image, ownerDir: data })).spec;
    const denied = await tool.execute({ name: "diary" }, stranger);
    expect(typeof denied === "object" && denied.isError).toBe(true);
    expect(textOf(denied)).not.toContain("private diary");
    expect(textOf(denied)).toContain("Known skills: dining, haiku.");
    expect(textOf(await tool.execute({ name: "diary" }, ownerInGroup))).toContain('No skill named "diary"');
    expect(textOf(await tool.execute({ name: "haiku" }, stranger))).toContain(`From ${data}/haiku.`);
    expect(textOf(await tool.execute({ name: "dining" }, stranger))).toContain(`From ${image}/dining.`);
    expect(textOf(await tool.execute({ name: "Diary" }, owner))).toContain(`From ${data}/diary.`);
  });

  it("load_skill with a getter serves a skill installed after the tool was registered", async () => {
    const tool = loadSkillTool(() => loadAllSkills({ ownerDir: data })).spec;
    expect(textOf(await tool.execute({ name: "haiku" }, owner))).toContain("Known skills: none");
    skill(data, "haiku", "Write a haiku when asked");
    expect(textOf(await tool.execute({ name: "haiku" }, owner))).toContain(`From ${data}/haiku.`);
  });

  it("never follows symlinks and stops at depth 3, so a link to / or a loop cannot stall loading", () => {
    skill(data, "real", "A real skill");
    skill(data, "a/b/deep", "Three levels down");
    skill(data, "a/b/c/too-deep", "Four levels down");
    const outside = join(dir, "outside");
    skill(outside, "sneaky", "Lives outside the data dir");
    symlinkSync("/", join(data, "root"));
    symlinkSync(join(outside, "sneaky"), join(data, "sneaky"));
    symlinkSync(data, join(data, "a", "loop"));
    symlinkSync("..", join(data, "real", "up"));
    mkdirSync(join(data, "linked-md"));
    symlinkSync(join(outside, "sneaky", "SKILL.md"), join(data, "linked-md", "SKILL.md"));
    const logs: string[] = [];
    const started = Date.now();
    const names = loadOwnerSkills(data, (m) => logs.push(m)).map((s) => s.name);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(names.sort()).toEqual(["deep", "real"]);
    expect(logs.some((l) => l.includes(join(data, "root")) && l.includes("symlink"))).toBe(true);
    // A symlinked owner folder is not read at all.
    const linkedRoot = join(dir, "linked-root");
    symlinkSync(data, linkedRoot);
    expect(loadOwnerSkills(linkedRoot)).toEqual([]);
  });

  it("ignores loose .md files at the top of the owner folder", () => {
    writeFileSync(join(data, "notes.md"), "---\nname: notes\ndescription: Loose notes\n---\n\nNot a skill.\n");
    writeFileSync(join(data, "SKILL.md"), "---\nname: top\ndescription: Top-level file\n---\n\nNot a skill.\n");
    skill(data, "haiku", "Write a haiku when asked");
    expect(loadOwnerSkills(data).map((s) => s.name)).toEqual(["haiku"]);
  });

  it("refuses a SKILL.md over the size limit with a clear message, and skips an oversized owner skill", async () => {
    skill(image, "big", "Grows after boot");
    const list = loadSkillList(image);
    writeFileSync(join(image, "big", "SKILL.md"), `---\nname: big\ndescription: Grows after boot\n---\n\n${"x".repeat(SKILL_FILE_MAX_BYTES + 1)}`);
    const r = await loadSkillTool(list).spec.execute({ name: "big" }, stranger);
    expect(typeof r === "object" && r.isError).toBe(true);
    expect(textOf(r)).toMatch(/over the 64 KB limit/);
    expect(textOf(r).length).toBeLessThan(500);
    skill(data, "huge", "Too big", `pad: ${"y".repeat(SKILL_FILE_MAX_BYTES)}\n`);
    const logs: string[] = [];
    expect(loadOwnerSkills(data, (m) => logs.push(m))).toEqual([]);
    expect(logs.some((l) => l.includes("over the 64 KB limit"))).toBe(true);
  });

  it("the catalog re-reads on its interval and logs a clash once per change, not on every reload", () => {
    let t = 0;
    const logs: string[] = [];
    skill(image, "dining", "Built-in dining");
    const catalog = createSkillCatalog({ builtinDirs: image, ownerDir: data, log: (m) => logs.push(m), refreshMs: 30_000, now: () => t });
    expect(catalog.list().map((s) => s.name)).toEqual(["dining"]);
    skill(data, "dining", "Owner dining");
    skill(data, "haiku", "Write a haiku when asked");
    t = 10_000;
    expect(catalog.list().map((s) => s.name)).toEqual(["dining"]);
    t = 30_000;
    expect(catalog.list().map((s) => s.name)).toEqual(["dining", "haiku"]);
    const clash = () => logs.filter((l) => l.includes('owner skill "dining"')).length;
    expect(clash()).toBe(1);
    for (t = 60_000; t <= 300_000; t += 30_000) catalog.list();
    expect(clash()).toBe(1);
    rmSync(join(data, "dining"), { recursive: true });
    t += 30_000;
    catalog.list();
    skill(data, "dining", "Owner dining again");
    t += 30_000;
    catalog.list();
    expect(clash()).toBe(2);
  });
});
