import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Memory, parseFile } from "../src/memory.js";
import { memoryTools } from "../src/memory-tools.js";

const EVAN = "+14155550190";

function fresh() {
  const m = new Memory(join(mkdtempSync(join(tmpdir(), "mem-")), "memory"), { owner: { name: "Evan Marshall", phones: [EVAN], timezone: "America/Los_Angeles" } });
  m.init();
  return m;
}

const maya = `---
id: maya
type: person
aliases: [Mimi, our daughter]
---
- Evan's daughter, 3 years old (Evan, 2026-10-28)
- Goes to [[household/little-oaks]] (Evan, 2026-10-28)
`;

describe("Memory: layout", () => {
  it("seeds a household directory and the owner's directory, found by phone", () => {
    const m = fresh();
    expect(m.operatorFor(EVAN)).toBe("evan");
    expect(m.operatorFor("+14155550123")).toBeUndefined();
    expect(m.open("evan/profile.md")).toMatchObject({ id: "evan", type: "profile" });
    expect(m.list().map((f) => f.path)).toEqual(["evan/profile.md"]);
    expect(m.log()).toHaveLength(1);
  });

  it("init is idempotent", () => {
    const m = fresh();
    m.init();
    expect(m.log()).toHaveLength(1);
  });

  it("parses frontmatter: id, type, aliases and the body", () => {
    expect(parseFile("household/people/maya.md", maya)).toMatchObject({ id: "maya", type: "person", aliases: ["Mimi", "our daughter"], body: expect.stringContaining("3 years old") });
  });
});

describe("Memory: writes", () => {
  it("saves a file with frontmatter, commits once, and reverts the commit", () => {
    const m = fresh();
    expect(m.save("household/people/maya.md", maya).ok).toBe(true);
    const c = m.commit("#5 memory from call A");
    expect(c).toMatch(/^[0-9a-f]{40}$/);
    expect(m.commit("nothing changed")).toBeUndefined();
    expect(m.open("household/people/maya.md")?.aliases).toContain("Mimi");
    const undo = m.revert(c!);
    expect(undo).toMatch(/^[0-9a-f]{40}$/);
    expect(m.open("household/people/maya.md")).toBeUndefined();
  });

  it("refuses paths outside household/ and operator directories, and files without frontmatter", () => {
    const m = fresh();
    expect(m.save("../escape.md", maya).ok).toBe(false);
    expect(m.save(".git/config", maya).ok).toBe(false);
    expect(m.save("strangers/x.md", maya).ok).toBe(false);
    expect(m.save("household/people/x.txt", maya).ok).toBe(false);
    const r = m.save("household/people/x.md", "just text");
    expect(!r.ok && r.error).toContain("frontmatter");
  });

  it("moves a finished project to done/ and discards uncommitted changes on demand", () => {
    const m = fresh();
    m.save("evan/projects/atlanta-trip.md", "---\nid: atlanta-trip\ntype: project\nends: 2026-11-05\n---\n- Fly out Nov 3 evening\n");
    m.commit("add trip");
    expect(m.move("evan/projects/atlanta-trip.md", "evan/projects/done/atlanta-trip.md").ok).toBe(true);
    m.discard();
    expect(m.open("evan/projects/atlanta-trip.md")).toBeDefined();
  });
});

describe("Memory: reading", () => {
  function family() {
    const m = fresh();
    m.save("household/people/maya.md", maya);
    m.save("household/people/cara.md", "---\nid: cara\ntype: person\naliases: [my wife]\n---\n- Evan's wife; works with [[household/maya]]'s daycare on Wednesdays\n");
    m.save("household/places/little-oaks.md", "---\nid: little-oaks\ntype: place\naliases: [daycare]\n---\n- Maya's daycare, pickup 4:30\n");
    m.save("evan/preferences/email.md", "---\nid: email\ntype: preference\n---\n- Delete clear promotions without asking\n");
    m.save("evan/projects/atlanta-trip.md", "---\nid: atlanta-trip\ntype: project\nends: 2026-11-05\n---\n- Fly out Nov 3 evening, back Nov 5 afternoon\n");
    m.save("evan/projects/done/old.md", "---\nid: old\ntype: project\n---\n- finished thing\n");
    m.commit("family");
    return m;
  }

  it("searches names, aliases and text across the caller's directory and household/", () => {
    const m = family();
    expect(m.search(EVAN, "daycare").map((f) => f.path)).toEqual(expect.arrayContaining(["household/places/little-oaks.md"]));
    expect(m.search(EVAN, "mimi").map((f) => f.path)).toEqual(["household/people/maya.md"]);
    expect(m.search(EVAN, "zzz")).toEqual([]);
  });

  it("lists every known name and alias, so Kloru can tell who's new", () => {
    expect(family().knownNames(EVAN)).toEqual(expect.arrayContaining(["Maya", "Mimi", "Cara", "Little Oaks", "daycare"]));
  });

  it("builds a short brief: caller, people, places, preferences, active projects, known names; not finished ones", () => {
    const m = family();
    const brief = m.brief(EVAN, new Date("2026-10-28T20:00:00Z"));
    expect(brief).toContain("Evan Marshall");
    expect(brief).toContain("Maya");
    expect(brief).toContain("Little Oaks");
    expect(brief).toContain("Delete clear promotions");
    expect(brief).toContain("Atlanta");
    expect(brief).not.toContain("finished thing");
    expect(brief.split(/\s+/).length).toBeLessThan(260);
  });

  it("drops projects whose end date has passed from the brief", () => {
    const brief = family().brief(EVAN, new Date("2026-11-20T20:00:00Z"));
    expect(brief).not.toMatch(/^Plans:.*Atlanta/m);
    expect(brief).not.toMatch(/Atlanta/);
  });

  it("an unknown caller gets no brief", () => {
    expect(family().brief("+14155550123")).toBe("");
  });
});

describe("Memory: a short brief", () => {
  it("never repeats a name as its own alias, cuts facts at a word, and stays under ~150 words", () => {
    const m = fresh();
    m.save("household/people/cara.md", "---\nid: cara\ntype: person\naliases: [Cara]\n---\n- Sometimes picks up Maya from day care; her calendar or event notes may show when she is doing pickup and many more words here.\n");
    m.save("evan/projects/trip.md", "---\nid: trip\ntype: project\naliases: [the trip, Atlanta trip]\nends: 2026-11-05\n---\n- Fly out Nov 3.\n- Back Nov 5.\n");
    m.save("evan/profile.md", "---\nid: evan\ntype: profile\nname: Evan\nphones: [+14155550190]\n---\n- Lives in Oakland, California.\n");
    m.commit("x");
    const brief = m.brief(EVAN, new Date("2026-10-28T20:00:00Z"));
    expect(brief).not.toContain("Cara (Cara)");
    expect(brief).not.toContain(".;");
    expect(brief).toMatch(/Cara: Sometimes picks up Maya[^|\n]*…/);
    expect(brief).not.toMatch(/Known names:.*the trip/);
    expect(brief.split(/\s+/).length).toBeLessThan(150);
  });
});

describe("reading memory history", () => {
  it("shows what a commit changed, and refuses anything that isn't a commit id", () => {
    const m = fresh();
    m.save("household/people/maya.md", maya);
    const commit = m.commit("Maya")!;
    const shown = m.show(commit)!;
    expect(shown).toContain("household/people/maya.md");
    expect(shown).toContain("+id: maya");
    expect(m.show("HEAD; rm -rf /")).toBeUndefined();
    expect(m.show("0".repeat(40))).toBeUndefined();
  });
});

describe("a person's guidelines", () => {
  it("are their guidelines.md, in full, for the phone that calls", () => {
    const m = fresh();
    expect(m.guidelines(EVAN)).toBe("");
    m.save("evan/guidelines.md", "---\nid: guidelines\ntype: guidelines\n---\n- Never spell out links; email them.\n- Emails to me need no yes.\n");
    expect(m.guidelines(EVAN)).toBe("- Never spell out links; email them.\n- Emails to me need no yes.");
    expect(m.guidelines("+14155550000")).toBe("");
  });
});

describe("a family member's own memory", () => {
  it("a new member gets their own folder, found by their number, made once", () => {
    const m = fresh();
    expect(m.ensureOperator("Cara Marshall", ["+14155550191"])).toBe("cara");
    expect(m.operatorFor("+14155550191")).toBe("cara");
    expect(m.ensureOperator("Cara Marshall", ["+14155550191"])).toBe("cara");
    expect(m.operators().sort()).toEqual(["cara", "evan"]);
  });

  it("two members with one first name get separate folders", () => {
    const m = fresh();
    m.ensureOperator("Sam Lee", ["+14155550100"]);
    expect(m.ensureOperator("Sam Park", ["+14155550101"])).toBe("sam-park");
  });
});

describe("Memory: each person's own policy and private folder (2026-11-02)", () => {
  const CARA = "+14155550191";
  const note = (id: string) => `---\nid: ${id}\ntype: note\naliases: []\n---\n- private note\n`;

  it("a policy is the person's own: lines added on their yes, and no memory write can touch it", () => {
    const m = fresh();
    expect(m.policy(EVAN)).toBe("");
    expect(m.addPolicy(EVAN, "Cara can't read my work email", new Date("2026-11-02T12:00:00Z")).ok).toBe(true);
    expect(m.policy(EVAN)).toBe("- Cara can't read my work email (Evan, 2026-11-02)");
    expect(m.save("evan/policy.md", note("policy")).ok).toBe(false);
    expect(m.remove("evan/policy.md").ok).toBe(false);
    expect(m.setPolicy(EVAN, "- Nobody reads my journal.").ok).toBe(true);
    expect(m.policy(EVAN)).toBe("- Nobody reads my journal.");
  });

  it("private/ is only ever read for its owner's own requests", async () => {
    const m = fresh();
    m.ensureOperator("Cara Marshall", [CARA]);
    expect(m.save("cara/private/journal.md", note("journal")).ok).toBe(true);
    const tools = (who: string | undefined) => Object.fromEntries(memoryTools(m, () => who).map((t) => [t.spec.name, t]));
    const text = (r: unknown) => JSON.stringify(r);
    const ctx = { conversationKey: "desk:issue:1:engineer" } as never;
    expect(text(await tools(CARA).memory_open!.spec.execute({ path: "cara/private/journal.md" }, ctx))).toContain("private note");
    expect(text(await tools(EVAN).memory_open!.spec.execute({ path: "cara/private/journal.md" }, ctx))).toMatch(/No file/);
    expect(text(await tools(EVAN).memory_search!.spec.execute({ query: "private note" }, ctx))).toMatch(/Nothing in memory/);
    expect(text(await tools(EVAN).memory_open!.spec.execute({}, ctx))).not.toContain("cara/private");
  });
});

describe("Memory: private files and profiles can't be got around (review, 2026-11-02)", () => {
  const CARA = "+14155550191";
  const note = `---\nid: secret\ntype: note\naliases: []\n---\n- private note\n`;
  it("a path trick never reaches someone else's private folder", async () => {
    const m = fresh();
    m.ensureOperator("Cara Marshall", [CARA]);
    m.save("cara/private/secret.md", note);
    const open = Object.fromEntries(memoryTools(m, () => EVAN).map((t) => [t.spec.name, t])).memory_open!;
    const ctx = { conversationKey: "desk:issue:1:engineer" } as never;
    for (const path of ["cara/./private/secret.md", "cara//private/secret.md", "household/../cara/private/secret.md", "./cara/private/secret.md", "cara/Private/secret.md"]) {
      expect(JSON.stringify(await open.spec.execute({ path }, ctx)), path).toMatch(/No file/);
    }
    expect(m.open("../../etc/passwd")).toBeUndefined();
  });

  it("the memory worker can't remove a profile, change its phones, or move a private file out", async () => {
    const m = fresh();
    m.ensureOperator("Cara Marshall", [CARA]);
    m.save("cara/private/secret.md", note);
    expect(m.remove("cara/profile.md").ok).toBe(false);
    const profile = m.open("cara/profile.md")!;
    expect(m.save("cara/profile.md", `---\nid: cara\ntype: profile\nname: Cara Marshall\nphones: [+15555550100]\naliases: []\n---\n`).ok).toBe(false);
    expect(profile.meta.phones).toBeDefined();
    const tools = Object.fromEntries(memoryTools(m, () => CARA).map((t) => [t.spec.name, t]));
    const ctx = { conversationKey: "desk:issue:1:memory" } as never;
    expect(JSON.stringify(await tools.memory_move!.spec.execute({ from: "cara/private/secret.md", to: "household/leak.md" }, ctx))).toMatch(/private/);
    const evans = Object.fromEntries(memoryTools(m, () => EVAN).map((t) => [t.spec.name, t]));
    expect(JSON.stringify(await evans.memory_remove!.spec.execute({ path: "cara/private/secret.md" }, ctx))).toMatch(/No file/);
  });
});

describe("how each person likes messages (messages.md, 2026-11-03)", () => {
  it("dated lines, newest 40 kept, committed, and nothing for someone memory doesn't know", () => {
    const m = fresh();
    expect(m.messages(EVAN)).toBe("");
    expect(m.addMessagePreference(EVAN, "A reaction would have done for \"add milk\"", new Date("2026-11-03T12:00:00Z")).ok).toBe(true);
    expect(m.messages(EVAN)).toBe('- A reaction would have done for "add milk" (2026-11-03)');
    for (let i = 0; i < 45; i++) m.addMessagePreference(EVAN, `line ${i}`, new Date("2026-11-03T12:00:00Z"));
    const lines = m.messages(EVAN).split("\n");
    expect(lines).toHaveLength(40);
    expect(lines.at(-1)).toBe("- line 44 (2026-11-03)");
    expect(m.addMessagePreference("+15555550000", "x").ok).toBe(false);
  }, 30_000);
});
