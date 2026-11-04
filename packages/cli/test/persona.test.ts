import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_PERSONA, MemoryStore, StateDir } from "@kloru/core";
import { editorCommand } from "../src/commands/persona.js";
import { ownerPromptInput, renderLayerTable } from "../src/commands/prompt.js";
import { makeContext } from "../src/context.js";
import { makeIo, run, tmpDir } from "./helpers.js";

const personaFile = (dir: string) => path.join(dir, "PERSONA.md");

describe("persona", () => {
  it("show prints the built-in default before a file exists and says so", async () => {
    const dir = tmpDir();
    const r = await run(["persona", "show"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("built-in default");
    expect(r.out).toContain("## Voice");
    expect(r.out).toContain("Say less. Do more.");
    // Showing never creates the file.
    expect(fs.existsSync(personaFile(dir))).toBe(false);
    // Bare `persona` is `show`.
    expect((await run(["persona"], { INSTINCT_DATA_DIR: dir })).out).toContain("## Voice");
  });

  it("set writes PERSONA.md and show prints it back", async () => {
    const dir = tmpDir();
    const set = await run(["persona", "set", "You are Pip.", "Dry wit, short sentences, never emojis."], { INSTINCT_DATA_DIR: dir });
    expect(set.code, set.err).toBe(0);
    expect(set.out).toContain("Wrote");
    expect(set.out).toContain(personaFile(dir));
    expect(fs.readFileSync(personaFile(dir), "utf8")).toBe("You are Pip. Dry wit, short sentences, never emojis.\n");

    const show = await run(["persona", "show"], { INSTINCT_DATA_DIR: dir });
    expect(show.out).toContain(`# ${personaFile(dir)}`);
    expect(show.out).toContain("You are Pip. Dry wit, short sentences, never emojis.");
    expect(show.out).not.toContain("Say less. Do more.");
    expect(show.out).not.toContain("built-in default");
  });

  it("set refuses empty text with a usage error and leaves the file alone", async () => {
    const dir = tmpDir();
    await run(["persona", "set", "Keep me"], { INSTINCT_DATA_DIR: dir });
    const r = await run(["persona", "set", "   "], { INSTINCT_DATA_DIR: dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain('persona set "<text>"');
    expect(fs.readFileSync(personaFile(dir), "utf8")).toBe("Keep me\n");
    expect((await run(["persona", "set"], { INSTINCT_DATA_DIR: dir })).code).toBe(2);
  });

  it("reset restores the default over a custom persona", async () => {
    const dir = tmpDir();
    await run(["persona", "set", "Custom voice"], { INSTINCT_DATA_DIR: dir });
    const r = await run(["persona", "reset"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Reset");
    expect(fs.readFileSync(personaFile(dir), "utf8")).toBe(DEFAULT_PERSONA);
    const again = await run(["persona", "reset"], { INSTINCT_DATA_DIR: dir });
    expect(again.out).toContain("Already the default");
  });

  it("edit without an editor writes the default file and prints its path", async () => {
    const dir = tmpDir();
    const r = await run(["persona", "edit"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("No $EDITOR");
    expect(r.out).toContain(personaFile(dir));
    expect(fs.readFileSync(personaFile(dir), "utf8")).toBe(DEFAULT_PERSONA);
  });

  it("edit runs $EDITOR on the file and reports the result", async () => {
    const dir = tmpDir();
    // A tiny "editor": a shell one-liner that rewrites the file it is given.
    const editor = path.join(tmpDir(), "ed.sh");
    fs.writeFileSync(editor, '#!/bin/sh\nprintf "Edited by script\\n" > "$1"\n', { mode: 0o755 });
    const r = await run(["persona", "edit"], { INSTINCT_DATA_DIR: dir, EDITOR: editor });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Saved");
    expect(fs.readFileSync(personaFile(dir), "utf8")).toBe("Edited by script\n");

    const failing = path.join(tmpDir(), "bad.sh");
    fs.writeFileSync(failing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const bad = await run(["persona", "edit"], { INSTINCT_DATA_DIR: dir, EDITOR: failing });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("exited with 3");
    // The editor's failure never touches the file.
    expect(fs.readFileSync(personaFile(dir), "utf8")).toBe("Edited by script\n");
  });

  it("path prints the file and unknown subcommands are usage errors", async () => {
    const dir = tmpDir();
    expect((await run(["persona", "path"], { INSTINCT_DATA_DIR: dir })).out.trim()).toBe(personaFile(dir));
    const r = await run(["persona", "frob"], { INSTINCT_DATA_DIR: dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain("Unknown persona subcommand");
  });

  it("editorCommand prefers VISUAL, splits arguments and ignores blanks", () => {
    expect(editorCommand({ EDITOR: "vim" })).toEqual(["vim"]);
    expect(editorCommand({ VISUAL: "code --wait", EDITOR: "vim" })).toEqual(["code", "--wait"]);
    expect(editorCommand({ VISUAL: "  ", EDITOR: "nano" })).toEqual(["nano"]);
    expect(editorCommand({})).toBeUndefined();
  });
});

describe("prompt", () => {
  it("prints the system prompt with the persona, memory and owner details from the data dir", async () => {
    const dir = tmpDir();
    await run(["init", "--name", "Maria", "--phone", "+14155550100", "--agent-name", "Pip", "--timezone", "America/New_York"], { INSTINCT_DATA_DIR: dir });
    await run(["persona", "set", "You are Pip. Dry wit, short sentences, never emojis."], { INSTINCT_DATA_DIR: dir });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "Always confirm bookings by text.\n");
    new MemoryStore(new StateDir(dir)).appendDurable("- Likes window seats");

    const r = await run(["prompt", "--no-skills"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("# You are Pip");
    expect(r.out).toContain("Maria's personal agent");
    expect(r.out).toContain("You are Pip. Dry wit, short sentences, never emojis.");
    expect(r.out).toContain("# Standing instructions\nAlways confirm bookings by text.");
    expect(r.out).toContain("+14155550100");
    expect(r.out).toContain("Likes window seats");
    expect(r.out).toContain("# Channel: imessage");
    expect(r.out).toContain("America/New_York");
    expect(r.out).not.toContain("# Skills");
    expect(r.out).not.toContain("Say less. Do more.");
  });

  it("falls back to the default persona and honours --channel", async () => {
    const dir = tmpDir();
    const r = await run(["prompt", "--channel", "email", "--no-skills"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("Say less. Do more.");
    expect(r.out).toContain("# Channel: email");
    expect(r.out).not.toContain("# Standing instructions");
    expect(fs.existsSync(personaFile(dir))).toBe(false);
    expect((await run(["prompt", "--channel", "carrier-pigeon"], { INSTINCT_DATA_DIR: dir })).code).toBe(2);
  });

  it("--layers lists each section with its source and --json returns them as data", async () => {
    const dir = tmpDir();
    await run(["persona", "set", "Terse."], { INSTINCT_DATA_DIR: dir });
    const layers = await run(["prompt", "--layers", "--no-skills"], { INSTINCT_DATA_DIR: dir });
    expect(layers.code, layers.err).toBe(0);
    expect(layers.out).toContain("identity");
    expect(layers.out).toContain("PERSONA.md");
    expect(layers.out).toContain("rules");
    expect(layers.out).toContain("CUSTOMIZE.md");
    expect(layers.out).not.toContain("# You are");

    const asJson = await run(["prompt", "--json", "--no-skills"], { INSTINCT_DATA_DIR: dir });
    const parsed = JSON.parse(asJson.out) as { channel: string; layers: Array<{ id: string; source: string; text: string }> };
    expect(parsed.channel).toBe("imessage");
    expect(parsed.layers[0]).toMatchObject({ id: "identity", source: "<data>/PERSONA.md" });
    expect(parsed.layers[0]!.text).toContain("Terse.");
    expect(parsed.layers.map((l) => l.id)).toContain("now");
  });

  it("includes the skills index when a loader provides one", async () => {
    const dir = tmpDir();
    const { io } = makeIo();
    const ctx = makeContext({ INSTINCT_DATA_DIR: dir }, io);
    const input = await ownerPromptInput(ctx, { skills: async () => "<available_skills>dining</available_skills>", now: new Date("2026-10-03T16:30:00Z") });
    expect(input.skillsPrompt).toContain("dining");
    expect(input.principal.kind).toBe("owner");
    expect(input.capabilities).toContain("purchase");
    expect(input.now.toISOString()).toBe("2026-10-03T16:30:00.000Z");
    // A loader that throws is treated as "no skills", never as a failure.
    const broken = await ownerPromptInput(ctx, { skills: async () => Promise.reject(new Error("no pi")) });
    expect(broken.skillsPrompt).toBeUndefined();
    expect(renderLayerTable([{ id: "identity", source: "x", text: "abc" }])).toContain("3 chars");
  });

  it("loads the repository's skills by default", async () => {
    const dir = tmpDir();
    const r = await run(["prompt"], { INSTINCT_DATA_DIR: dir });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("# Skills");
    expect(r.out).toContain("dining");
  });
});
