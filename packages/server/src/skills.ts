/**
 * SKILL.md playbooks. The repo ships a `skills/` folder; the Docker image copies it
 * to /app/skills. The owner can add their own under `<data>/skills`; those are private
 * to the owner unless marked `visibility: public`. Loading is best effort: a missing
 * folder means no skills section.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { createSyntheticSourceInfo, loadSkillsFromDir, parseFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import { defineTool, textResult, type Principal, type RegisteredTool } from "@kloru/core";

export interface ResolveSkillsDirOptions {
  explicit?: string;
  env: NodeJS.ProcessEnv;
  /** `import.meta.url` of the calling module, used to find `<repo>/skills` relative to the package. */
  packageUrl?: string;
}

/** Explicit option, then INSTINCT_SKILLS_DIR, then `<repo>/skills` next to this package. */
export function resolveSkillsDir(opts: ResolveSkillsDirOptions): string | undefined {
  const candidates: string[] = [];
  if (opts.explicit) candidates.push(opts.explicit);
  if (opts.env.INSTINCT_SKILLS_DIR) candidates.push(opts.env.INSTINCT_SKILLS_DIR);
  if (opts.packageUrl) {
    // packages/server/{src,dist}/skills.js -> ../../../skills = <repo>/skills
    try {
      candidates.push(fileURLToPath(new URL("../../../skills", opts.packageUrl)));
    } catch {
      /* not a file URL; skip */
    }
  }
  return candidates.find(isDir);
}

function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The owner's own skills folder inside the data dir: survives image updates, re-read while running. */
export function ownerSkillsDir(dataDir: string): string {
  return join(dataDir, "skills");
}

/** How deep the owner folder is searched for SKILL.md: `<data>/skills/a/b/c/SKILL.md` at most. */
export const OWNER_SKILL_MAX_DEPTH = 3;
/** Folders visited in the owner folder per reload, so a huge clone cannot stall a turn. */
const OWNER_SKILL_MAX_DIRS = 500;
/** Largest SKILL.md that is indexed or returned by load_skill. */
export const SKILL_FILE_MAX_BYTES = 64 * 1024;

/**
 * A loaded skill and where it came from. Built-ins (the repo's `skills/`) are public
 * playbooks. Owner skills (`<data>/skills`) are the owner's and are private unless their
 * frontmatter says `visibility: public`.
 */
export interface LoadedSkill extends Skill {
  origin: "builtin" | "owner";
  visibility: "public" | "private";
}

/** The owner in their own thread. In a shared thread every reply is visible to all, so not there. */
function isOwner(principal: Pick<Principal, "kind" | "tier">): boolean {
  return principal.kind === "owner" && principal.tier === "owner";
}

/** Whether `principal` may see a skill in the index and load it. */
export function skillVisibleTo(skill: Skill, principal: Pick<Principal, "kind" | "tier">): boolean {
  const s = skill as Partial<LoadedSkill>;
  if (s.origin !== "owner" || s.visibility === "public") return true;
  return isOwner(principal);
}

/** The skills `principal` may see. */
export function skillsFor<T extends Skill>(skills: T[], principal: Pick<Principal, "kind" | "tier">): T[] {
  return skills.filter((s) => skillVisibleTo(s, principal));
}

/**
 * Built-in skills from one folder or several, or an empty list when none is readable.
 * On a name clash (case-insensitive) the first one wins.
 */
export function loadSkillList(dirs: string | string[] | undefined, logger?: (m: string) => void): LoadedSkill[] {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter((d): d is string => Boolean(d));
  const byName = new Map<string, LoadedSkill>();
  for (const dir of list) {
    for (const s of loadSkillsIn(dir, logger)) {
      const key = s.name.toLowerCase();
      if (byName.has(key)) logger?.(`skill warning: duplicate name "${s.name}" at ${s.filePath} ignored`);
      else byName.set(key, { ...s, origin: "builtin", visibility: "public" });
    }
  }
  return [...byName.values()];
}

/** Built-in skills in one folder via Pi's loader (the folder ships with the agent). */
function loadSkillsIn(dir: string, logger?: (m: string) => void): Skill[] {
  if (!isDir(dir)) return [];
  try {
    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "kloru" });
    for (const d of diagnostics) logger?.(`skill warning: ${JSON.stringify(d)}`);
    // load_skill looks skills up by lowercased name, so two names that differ only in case
    // would shadow each other. Keep the first and say so.
    const seen = new Set<string>();
    const unique = skills.filter((s) => {
      const key = s.name.toLowerCase();
      if (seen.has(key)) {
        logger?.(`skill warning: duplicate name "${s.name}" at ${s.filePath} ignored`);
        return false;
      }
      seen.add(key);
      return true;
    });
    if (unique.length > 0) logger?.(`loaded ${unique.length} skills from ${dir}`);
    return unique;
  } catch (err) {
    logger?.(`skills not loaded from ${dir}: ${(err as Error).message}`);
    return [];
  }
}

/**
 * The repo's skills plus the owner's `<data>/skills` (same SKILL.md format as OpenClaw,
 * Pi and Claude Code skills). Built-ins win: an owner skill named like one is skipped.
 */
export function loadAllSkills(opts: { builtinDirs?: string | string[]; ownerDir?: string }, logger?: (m: string) => void): LoadedSkill[] {
  const builtins = loadSkillList(opts.builtinDirs, logger);
  const taken = new Map(builtins.map((s) => [s.name.toLowerCase(), s]));
  const out = [...builtins];
  for (const s of opts.ownerDir ? loadOwnerSkills(opts.ownerDir, logger) : []) {
    const key = s.name.toLowerCase();
    const clash = taken.get(key);
    if (clash) {
      logger?.(`skill warning: owner skill "${s.name}" at ${s.filePath} ignored: ${clash.origin === "builtin" ? "a built-in skill has that name" : `duplicate of ${clash.filePath}`}`);
      continue;
    }
    taken.set(key, s);
    out.push(s);
  }
  return out;
}

/**
 * Skills under the owner's folder. Pi's loader follows symlinks and recurses without a
 * limit, so this walks the folder itself: symlinks are never followed (a skill folder, a
 * SKILL.md or the folder itself that is a symlink is skipped), the search stops at
 * OWNER_SKILL_MAX_DEPTH and OWNER_SKILL_MAX_DIRS, and loose files at the top level are
 * ignored, since a skill is always a folder with a SKILL.md.
 */
export function loadOwnerSkills(root: string, logger?: (m: string) => void): LoadedSkill[] {
  try {
    const st = lstatSync(root);
    if (st.isSymbolicLink()) {
      logger?.(`skill warning: ${root} is a symlink; owner skills not loaded`);
      return [];
    }
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }
  const files: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (++visited > OWNER_SKILL_MAX_DIRS) {
      if (visited === OWNER_SKILL_MAX_DIRS + 1) logger?.(`skill warning: stopped searching ${root} after ${OWNER_SKILL_MAX_DIRS} folders`);
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth > 0) {
      const md = entries.find((e) => e.name === "SKILL.md");
      if (md) {
        if (md.isFile()) files.push(join(dir, md.name));
        else logger?.(`skill warning: ${join(dir, md.name)} is not a regular file; skipped`);
        return;
      }
    }
    if (depth >= OWNER_SKILL_MAX_DEPTH) return;
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      // Dirent types come from lstat, so a symlink to a folder is neither isDirectory nor followed.
      if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      else if (e.isSymbolicLink()) logger?.(`skill warning: ${join(dir, e.name)} is a symlink; skipped`);
    }
  };
  walk(root, 0);
  const skills: LoadedSkill[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const skill = readOwnerSkill(file, logger);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) {
      logger?.(`skill warning: duplicate name "${skill.name}" at ${file} ignored`);
      continue;
    }
    seen.add(key);
    skills.push(skill);
  }
  if (skills.length > 0) logger?.(`loaded ${skills.length} owner skills from ${root}`);
  return skills;
}

function readOwnerSkill(file: string, logger?: (m: string) => void): LoadedSkill | undefined {
  let raw: string;
  try {
    const size = lstatSync(file).size;
    if (size > SKILL_FILE_MAX_BYTES) {
      logger?.(`skill warning: ${file} is ${Math.ceil(size / 1024)} KB, over the ${SKILL_FILE_MAX_BYTES / 1024} KB limit; skipped`);
      return undefined;
    }
    raw = readFileSync(file, "utf8");
  } catch (err) {
    logger?.(`skill warning: ${file}: ${(err as Error).message}`);
    return undefined;
  }
  let fm: Record<string, unknown>;
  try {
    fm = parseFrontmatter<Record<string, unknown>>(raw).frontmatter;
  } catch (err) {
    logger?.(`skill warning: ${file}: ${(err as Error).message}`);
    return undefined;
  }
  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) {
    logger?.(`skill warning: ${file}: description is required; skipped`);
    return undefined;
  }
  const baseDir = dirname(file);
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : basename(baseDir);
  return {
    name,
    description,
    filePath: file,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(file, { source: "kloru-owner", baseDir }),
    disableModelInvocation: fm["disable-model-invocation"] === true,
    origin: "owner",
    visibility: String(fm.visibility ?? "").trim().toLowerCase() === "public" ? "public" : "private",
  };
}

/**
 * The live skill list for a running server: re-read at most every `refreshMs`, so a skill
 * the owner installs after boot appears within that. A warning is logged once, when it
 * first shows up, not on every reload while the cause is still there.
 */
export function createSkillCatalog(opts: {
  builtinDirs?: string | string[];
  ownerDir?: string;
  log?: (m: string) => void;
  refreshMs?: number;
  now?: () => number;
}): { list: () => LoadedSkill[] } {
  const now = opts.now ?? Date.now;
  const refreshMs = opts.refreshMs ?? 30_000;
  let cache: { at: number; list: LoadedSkill[] } | undefined;
  let lastMessages = new Set<string>();
  const list = () => {
    const at = now();
    if (!cache || at - cache.at >= refreshMs) {
      const messages = new Set<string>();
      cache = { at, list: loadAllSkills(opts, (m) => messages.add(m)) };
      for (const m of messages) if (!lastMessages.has(m)) opts.log?.(m);
      lastMessages = messages;
    }
    return cache.list;
  };
  return { list };
}

export const LOAD_SKILL_TOOL = "load_skill";

/**
 * The skills index for the prompt. It points at load_skill rather than Pi's default
 * of the read tool: read is confined to workspace/ and is owner-only, so a skill
 * path outside the workspace could never be opened, and nobody but the owner could
 * open one at all.
 */
export function formatSkillsIndex(skills: Skill[]): string | undefined {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return undefined;
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    `When a task matches a skill's description, call ${LOAD_SKILL_TOOL} with its name and follow what it says.`,
    "",
    "<available_skills>",
  ];
  for (const s of visible) {
    lines.push("  <skill>", `    <name>${escapeXml(s.name)}</name>`, `    <description>${escapeXml(s.description)}</description>`, "  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Prompt section listing the skills, or undefined when there is nothing to show. */
export function loadSkillsPrompt(dirs: string | string[] | undefined, logger?: (m: string) => void): string | undefined {
  return formatSkillsIndex(loadSkillList(dirs, logger));
}

/**
 * Returns one skill's SKILL.md by name. Only a loaded skill can be named, so the model
 * never supplies a path; pass a function to serve skills installed after boot. Built-in
 * skills are public playbooks, so any principal who may converse may load one. An owner
 * skill is owner data: only the owner may load it unless it is marked `visibility: public`,
 * and to anyone else it does not exist.
 */
export function loadSkillTool(skills: Skill[] | (() => Skill[])): RegisteredTool {
  const current = () => (typeof skills === "function" ? skills() : skills);
  return defineTool({
    name: LOAD_SKILL_TOOL,
    label: "Load skill",
    description: "Load the full instructions of a skill listed in <available_skills>, by its name.",
    parameters: Type.Object({ name: Type.String({ description: "The skill's name, as listed in <available_skills>." }) }),
    meta: { capabilities: ["converse"], group: "system", describe: (args) => `${LOAD_SKILL_TOOL} ${String((args as { name?: unknown }).name ?? "")}` },
    execute: async ({ name }, ctx) => {
      const byName = new Map(skillsFor(current(), ctx.principal).map((s) => [s.name.toLowerCase(), s]));
      const skill = byName.get(name.trim().toLowerCase());
      if (!skill) {
        const known = [...byName.values()].map((s) => s.name).join(", ") || "none";
        return { content: [{ type: "text", text: `No skill named "${name}". Known skills: ${known}.` }], isError: true };
      }
      let size: number;
      try {
        size = statSync(skill.filePath).size;
      } catch (err) {
        return { content: [{ type: "text", text: `Skill "${skill.name}" could not be read: ${(err as Error).message}` }], isError: true };
      }
      if (size > SKILL_FILE_MAX_BYTES) {
        return {
          content: [{ type: "text", text: `Skill "${skill.name}" was not loaded: its SKILL.md is ${Math.ceil(size / 1024)} KB, over the ${SKILL_FILE_MAX_BYTES / 1024} KB limit. Ask the owner to shorten it.` }],
          isError: true,
        };
      }
      return textResult(readFileSync(skill.filePath, "utf8"));
    },
  });
}
