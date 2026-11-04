/**
 * Kloru's memory: a git repo of short markdown files, one per person, place, preference,
 * routine or project.
 *
 *   memory/household/…   where people's lives intersect: shared people, places, routines, plans
 *   memory/<operator>/…  one directory per phone that operates Kloru; profile.md lists its phones
 *
 * Every file starts with frontmatter (id, type, aliases) and links to others with [[dir/id]].
 * Only the memory ops worker writes, once per call, as one commit; the commit is the undo.
 * The brief is built from the files without a model, so it costs nothing at call start.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { err, ok, type Result } from "./result.js";

export interface MemoryFile {
  path: string;
  id: string;
  type: string;
  name: string;
  aliases: string[];
  /** Other frontmatter (phones, ends, timezone…), as written. */
  meta: Record<string, string>;
  body: string;
}

export interface MemoryOwner {
  name: string;
  phones: string[];
  timezone?: string;
}

const HOUSEHOLD = "household";
/** Each person's own policy, in the root of their directory: what others may do with their things. */
export const POLICY = "policy.md";
/** Brief sections, by the directory a file sits in. */
const SECTIONS: Array<[dir: string, title: string, max: number]> = [
  ["people", "People", 6],
  ["places", "Places", 3],
  ["routines", "Routines", 2],
  ["preferences", "Preferences", 3],
  ["projects", "Plans", 4],
];

const title = (id: string) => id.split(/[-_]/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
const list = (v: string | undefined): string[] =>
  (v ?? "").replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

/** A memory file from its text; anything without frontmatter has no id. */
export function parseFile(path: string, text: string): MemoryFile {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  const meta: Record<string, string> = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  const id = meta.id ?? "";
  return { path, id, type: meta.type ?? "", name: meta.name || title(id), aliases: list(meta.aliases), meta, body: (m ? m[2]! : text).trim() };
}

/** Cut at a word, with an ellipsis. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  return `${text.slice(0, cut > max / 2 ? cut : max).replace(/[,;:.\s]+$/, "")}…`;
}

/** The facts of a file as short lines: no bullets, no "(who, when)" tags, links shown by name. */
function facts(f: MemoryFile, max: number): string {
  const text = f.body
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").replace(/\s*\([^()]*\d{4}-\d{2}-\d{2}[^()]*\)\s*\.?$/, "").replace(/\[\[(?:[\w-]+\/)*([\w-]+)\]\]/g, (_, id: string) => title(id)).trim().replace(/\.$/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .join("; ");
  return clip(text, max);
}

export class Memory {
  constructor(
    readonly root: string,
    private readonly o: { owner: MemoryOwner; now?: () => Date },
  ) {}

  private now(): Date {
    return this.o.now?.() ?? new Date();
  }

  private git(...args: string[]): string {
    // fsync what a commit writes: a machine stopped right after one (a deploy) left empty objects on Nov 2.
    return execFileSync("git", ["-C", this.root, "-c", `safe.directory=${this.root}`, "-c", "user.name=Kloru", "-c", "user.email=memory@kloru.com", "-c", "commit.gpgsign=false", "-c", "core.fsync=committed,index", "-c", "core.fsyncMethod=fsync", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  /** Create the repo, household/ and the owner's directory once. */
  init(): void {
    mkdirSync(join(this.root, HOUSEHOLD), { recursive: true });
    if (!existsSync(join(this.root, ".git"))) this.git("init", "-q", "-b", "main");
    const owner = this.o.owner;
    if (!this.operatorFor(owner.phones[0] ?? "")) {
      const dir = (owner.name.split(/\s+/)[0] ?? "owner").toLowerCase().replace(/[^a-z0-9-]/g, "") || "owner";
      const fm = [`id: ${dir}`, "type: profile", `name: ${owner.name}`, `phones: [${owner.phones.join(", ")}]`, ...(owner.timezone ? [`timezone: ${owner.timezone}`] : [])];
      this.write(`${dir}/profile.md`, `---\n${fm.join("\n")}\n---\n`);
    }
    writeFileSync(join(this.root, HOUSEHOLD, ".keep"), "");
    this.commit("Seed memory");
  }

  /**
   * A family member's own directory (profile.md with their phones), made once: found by any of their
   * phones, else named by first name (the full name if that's taken). Returns the directory.
   */
  ensureOperator(name: string, phones: string[]): string {
    for (const p of phones) {
      const found = this.operatorFor(p);
      if (found) return found;
    }
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const taken = new Set([HOUSEHOLD, ...this.operators()]);
    const first = slug(name.split(/\s+/)[0] ?? "") || "member";
    const dir = !taken.has(first) ? first : slug(name) && !taken.has(slug(name)) ? slug(name) : `${first}-${phones[0]?.replace(/\D/g, "").slice(-4) ?? "x"}`;
    this.write(`${dir}/profile.md`, `---\n${[`id: ${dir}`, "type: profile", `name: ${name}`, `phones: [${phones.join(", ")}]`].join("\n")}\n---\n`);
    this.commit(`Add ${name}`);
    return dir;
  }

  /** The operator directories: those with a profile.md. */
  operators(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((d) => d !== HOUSEHOLD && !d.startsWith(".") && existsSync(join(this.root, d, "profile.md")));
  }

  operatorFor(phone: string): string | undefined {
    const digits = phone.replace(/\D/g, "");
    if (!digits) return undefined;
    return this.operators().find((d) => list(this.open(`${d}/profile.md`)?.meta.phones).some((p) => p.replace(/\D/g, "") === digits));
  }

  /** A path inside household/ or an operator directory, ending in .md; or why not. A person's policy.md is theirs alone to change (addPolicy). */
  private check(path: string): Result<string> {
    const p = normalize(path).split(sep).join("/");
    const [top] = p.split("/");
    if (p.startsWith("/") || p.split("/").some((s) => s === ".." || s.startsWith("."))) return err(`not a memory path: ${path}`);
    if (!p.endsWith(".md")) return err("memory files are markdown: end the path in .md");
    if (top !== HOUSEHOLD && !this.operators().includes(top ?? "")) return err(`memory paths start with ${[HOUSEHOLD, ...this.operators()].map((d) => `${d}/`).join(" or ")}`);
    if (top !== HOUSEHOLD && p.toLowerCase() === `${top}/${POLICY}`) return err(`${p} is ${top}'s own policy: only they change it, by telling Kloru or on kloru.com`);
    return ok(p);
  }

  /** A path as memory keeps it ("cara/./private//x.md" is "cara/private/x.md"), or undefined when it leaves memory. */
  static clean(path: string): string | undefined {
    const p = normalize(path).split(sep).join("/").replace(/^\.\//, "");
    return !p || p.startsWith("/") || p === ".." || p.startsWith("../") ? undefined : p;
  }

  /** Whether this path is someone's private file, and so readable only by their own requests. */
  static privateOwner(path: string): string | undefined {
    const [top, second] = (Memory.clean(path) ?? path).split("/");
    return top && top !== HOUSEHOLD && second?.toLowerCase() === "private" ? top : undefined;
  }

  /** Whether a write must keep this file's identity: a person's profile names their phones, which decide whose policy and private folder is whose. */
  private keepsProfile(p: string): string | undefined {
    const [top, name] = p.split("/");
    return top && top !== HOUSEHOLD && name === "profile.md" && p.split("/").length === 2 ? top : undefined;
  }

  /** What this person says others may and may not do with their things (<operator>/policy.md), or "". */
  policy(phone: string): string {
    const op = this.operatorFor(phone);
    return op ? (this.open(`${op}/${POLICY}`)?.body ?? "").trim() : "";
  }

  /** Add one line to this person's policy, in their words, and commit it. Only the desk calls this, on their own yes. */
  addPolicy(phone: string, text: string, now: Date = this.now()): Result<string> {
    const op = this.operatorFor(phone);
    if (!op) return err(`no memory for ${phone}`);
    const line = text.trim().replace(/\s+/g, " ");
    if (!line) return err("nothing to add");
    const first = String(this.open(`${op}/profile.md`)?.meta.name ?? op).split(/\s+/)[0];
    const full = join(this.root, op, POLICY);
    const current = existsSync(full) ? readFileSync(full, "utf8") : `---\nid: policy\ntype: policy\naliases: [who may reach ${first}'s things]\n---\n`;
    this.write(`${op}/${POLICY}`, `${current.replace(/\s+$/, "")}\n- ${line} (${first}, ${now.toISOString().slice(0, 10)})\n`);
    return ok(this.commit(`Policy from ${first}: ${line.slice(0, 80)}`) ?? "");
  }

  /** How this person likes Kloru's messages (<operator>/messages.md): length, links, emoji, learned over time; or "". */
  messages(phone: string): string {
    const op = this.operatorFor(phone);
    return op ? (this.open(`${op}/messages.md`)?.body ?? "").trim() : "";
  }

  /** One dated line on how they like messages, from what they said or how they answered one; committed. */
  addMessagePreference(phone: string, text: string, now: Date = this.now()): Result<string> {
    const op = this.operatorFor(phone);
    if (!op) return err(`no memory for ${phone}`);
    const line = text.trim().replace(/\s+/g, " ");
    if (!line) return err("nothing to add");
    const first = String(this.open(`${op}/profile.md`)?.meta.name ?? op).split(/\s+/)[0];
    const full = join(this.root, op, "messages.md");
    const current = existsSync(full) ? readFileSync(full, "utf8") : `---\nid: messages\ntype: preferences\naliases: [how ${first} likes messages]\n---\n`;
    // The newest 40 lines are what the message shape reads; older ones stay in git.
    const lines = current.replace(/\s+$/, "").split("\n");
    const head = lines.slice(0, lines.indexOf("---", 1) + 1);
    const body = lines.slice(head.length).filter(Boolean).slice(-39);
    this.write(`${op}/messages.md`, `${[...head, ...body, `- ${line} (${now.toISOString().slice(0, 10)})`].join("\n")}\n`);
    return ok(this.commit(`How ${first} likes messages: ${line.slice(0, 80)}`) ?? "");
  }

  /** Replace this person's whole policy (they edited it on kloru.com) and commit it. */
  setPolicy(phone: string, body: string, message?: string): Result<string> {
    const op = this.operatorFor(phone);
    if (!op) return err(`no memory for ${phone}`);
    const first = String(this.open(`${op}/profile.md`)?.meta.name ?? op).split(/\s+/)[0];
    this.write(`${op}/${POLICY}`, `---\nid: policy\ntype: policy\naliases: [who may reach ${first}'s things]\n---\n${body.trim()}\n`);
    return ok(this.commit(message ?? `Policy edited by ${first} on kloru.com`) ?? "");
  }

  private write(path: string, text: string): void {
    const full = join(this.root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text.endsWith("\n") ? text : `${text}\n`);
  }

  open(path: string): MemoryFile | undefined {
    const p = Memory.clean(path);
    if (!p) return undefined;
    const full = join(this.root, p);
    if (!existsSync(full) || !statSync(full).isFile()) return undefined;
    return parseFile(p, readFileSync(full, "utf8"));
  }

  /** Every memory file under these directories (default: all). */
  list(dirs?: string[]): MemoryFile[] {
    const out: MemoryFile[] = [];
    const walk = (rel: string) => {
      const full = join(this.root, rel);
      if (!existsSync(full)) return;
      for (const name of readdirSync(full).sort()) {
        if (name.startsWith(".")) continue;
        const p = rel ? `${rel}/${name}` : name;
        if (statSync(join(this.root, p)).isDirectory()) walk(p);
        else if (name.endsWith(".md")) out.push(this.open(p)!);
      }
    };
    for (const d of dirs ?? [HOUSEHOLD, ...this.operators()]) walk(d);
    return out;
  }

  save(path: string, text: string): Result<MemoryFile> {
    const p = this.check(path);
    if (!p.ok) return p;
    const f = parseFile(p.value, text);
    if (!f.id || !f.type) return err("start the file with frontmatter: ---, id: <short-id>, type: person|place|routine|preference|project|note, aliases: [other names], ---");
    // A profile's phones say who the person is (whose policy and private folder): they stay as they are.
    const person = this.keepsProfile(p.value);
    const before = person ? this.open(p.value) : undefined;
    if (before && JSON.stringify(list(before.meta.phones)) !== JSON.stringify(list(f.meta.phones))) return err(`keep ${p.value}'s phones exactly as they are (${list(before.meta.phones).join(", ")}): they say who ${person} is`);
    this.write(p.value, text);
    return ok(f);
  }

  move(from: string, to: string): Result<string> {
    const a = this.check(from);
    const b = this.check(to);
    if (!a.ok) return a;
    if (!b.ok) return b;
    if (!existsSync(join(this.root, a.value))) return err(`no file ${from}`);
    if (this.keepsProfile(a.value)) return err(`${a.value} says who ${this.keepsProfile(a.value)} is: it stays where it is`);
    mkdirSync(dirname(join(this.root, b.value)), { recursive: true });
    renameSync(join(this.root, a.value), join(this.root, b.value));
    return ok(b.value);
  }

  remove(path: string): Result<string> {
    const p = this.check(path);
    if (!p.ok) return p;
    if (!existsSync(join(this.root, p.value))) return err(`no file ${path}`);
    if (this.keepsProfile(p.value)) return err(`${p.value} says who ${this.keepsProfile(p.value)} is: it can't be removed`);
    rmSync(join(this.root, p.value));
    return ok(p.value);
  }

  /** Commit everything changed; the commit hash, or undefined when nothing changed. */
  commit(message: string): string | undefined {
    this.git("add", "-A");
    if (!this.git("status", "--porcelain")) return undefined;
    this.git("commit", "-q", "-m", message);
    return this.git("rev-parse", "HEAD");
  }

  /** Undo a commit with a new one; undefined if it no longer applies cleanly. */
  revert(commit: string): string | undefined {
    try {
      this.git("revert", "--no-edit", commit);
      return this.git("rev-parse", "HEAD");
    } catch {
      try {
        this.git("revert", "--abort");
      } catch {
        // nothing to abort
      }
      return undefined;
    }
  }

  /** Drop uncommitted changes (a memory run that failed halfway). */
  discard(): void {
    this.git("reset", "-q", "--hard");
    this.git("clean", "-fdq");
  }

  /** One commit as git shows it (message, files, diff); undefined for anything but a known commit. */
  show(commit: string): string | undefined {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return undefined;
    try {
      return this.git("show", "--stat", "--patch", "--format=%H%n%ad%n%n%s%n", "--date=iso", commit, "--");
    } catch {
      return undefined;
    }
  }

  log(): Array<{ commit: string; message: string }> {
    const out = this.git("log", "--format=%H %s");
    return out ? out.split("\n").map((l) => ({ commit: l.slice(0, 40), message: l.slice(41) })) : [];
  }

  /** The directories a phone reads: household/ and its own. */
  /** Files a person's own requests may read: everything, but others' private/ folders. */
  visibleTo(files: MemoryFile[], phone: string | undefined): MemoryFile[] {
    const op = phone ? this.operatorFor(phone) : undefined;
    return files.filter((f) => {
      const owner = Memory.privateOwner(f.path);
      return !owner || owner === op;
    });
  }

  private dirsFor(phone: string): string[] | undefined {
    const op = this.operatorFor(phone);
    return op ? [HOUSEHOLD, op] : undefined;
  }

  /**
   * Add one line to how this person wants Kloru to work, now, and commit it: said once ("be more
   * concise"), it's in every agent's guidelines from here on. The end-of-call memory issue tidies it.
   */
  addGuideline(phone: string, text: string, now: Date = this.now()): Result<string> {
    const op = this.operatorFor(phone);
    if (!op) return err(`no memory for ${phone}`);
    const line = text.trim().replace(/\s+/g, " ");
    if (!line) return err("nothing to add");
    const path = `${op}/guidelines.md`;
    const full = join(this.root, path);
    const first = String(this.open(`${op}/profile.md`)?.meta.name ?? op).split(/\s+/)[0];
    const current = existsSync(full) ? readFileSync(full, "utf8") : `---\nid: guidelines\ntype: guidelines\naliases: [how ${first} wants Kloru to work]\n---\n`;
    this.write(path, `${current.replace(/\s+$/, "")}\n- ${line} (${first}, ${now.toISOString().slice(0, 10)})\n`);
    return ok(this.commit(`Guideline from ${first}: ${line.slice(0, 80)}`) ?? "");
  }

  /** How this person wants Kloru to work (<operator>/guidelines.md), in full: every agent gets it. */
  guidelines(phone: string): string {
    const op = this.operatorFor(phone);
    return op ? (this.open(`${op}/guidelines.md`)?.body ?? "") : "";
  }

  /** Files whose name, aliases or text mention every word of the query. */
  search(phone: string, query: string): MemoryFile[] {
    const dirs = this.dirsFor(phone);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!dirs || !words.length) return [];
    return this.list(dirs).filter((f) => {
      const hay = [f.id, f.name, ...f.aliases, f.body].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** Every person and place this caller's memory knows, by name and alias. */
  knownNames(phone: string): string[] {
    const dirs = this.dirsFor(phone);
    if (!dirs) return [];
    const kinds = new Set(["people", "places"]);
    return [...new Set(this.list(dirs).filter((f) => kinds.has(f.path.split("/")[1] ?? "")).flatMap((f) => [f.name, ...f.aliases]))];
  }

  /**
   * What Kloru knows before the first word: the caller, then the most linked people, places,
   * routines, preferences and current plans, then every known name. Finished or past plans
   * stay out.
   */
  brief(phone: string, now: Date = this.now()): string {
    const op = this.operatorFor(phone);
    if (!op) return "";
    const files = this.list([HOUSEHOLD, op]);
    const links = new Map<string, number>();
    for (const f of files) for (const m of f.body.matchAll(/\[\[(?:[\w-]+\/)*([\w-]+)\]\]/g)) links.set(m[1]!, (links.get(m[1]!) ?? 0) + 1);
    const today = now.toISOString().slice(0, 10);
    const profile = this.open(`${op}/profile.md`);
    const lines = [`Caller: ${profile?.name ?? title(op)}${profile?.body ? `. ${facts(profile, 100)}` : ""}`];
    for (const [dir, heading, max] of SECTIONS) {
      const picked = files
        .filter((f) => f.path.split("/")[1] === dir && !f.path.includes("/done/") && !(f.meta.ends && f.meta.ends < today))
        .sort((a, b) => (links.get(b.id) ?? 0) - (links.get(a.id) ?? 0) || a.path.localeCompare(b.path))
        .slice(0, max)
        .map((f) => {
          const alias = f.aliases.find((a) => a.toLowerCase() !== f.name.toLowerCase());
          return `${dir === "preferences" ? "" : `${f.name}${alias ? ` (${alias})` : ""}${f.meta.ends ? ` until ${f.meta.ends}` : ""}: `}${facts(f, 70)}`;
        });
      if (picked.length) lines.push(`${heading}: ${picked.join(" | ")}`);
    }
    const names = this.knownNames(phone);
    if (names.length) lines.push(`Known names: ${names.join(", ")}`);
    return lines.join("\n");
  }
}
