/**
 * The state directory. Everything the agent persists lives under one root
 * (`/data` on Maritime, `./.instinct` locally). All stores in core take a
 * StateDir instead of touching the filesystem on their own so tests can run
 * against a temp directory and so nothing in core reads process.env.
 */
import fs from "node:fs";
import path from "node:path";

/** Pick the data directory from the environment. Only the server passes env in. */
export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.INSTINCT_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  if (fs.existsSync("/data") && fs.statSync("/data").isDirectory()) return "/data";
  return path.resolve(".instinct");
}

export class StateDir {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Create the root and the subdirectories other packages expect to exist. */
  ensure(): void {
    for (const sub of ["", "memory", "memory/journal", "sessions", "workspace", "inbox"]) {
      fs.mkdirSync(path.join(this.root, sub), { recursive: true });
    }
  }

  path(...parts: string[]): string {
    const target = path.resolve(this.root, ...parts);
    // Refuse to escape the root: file names come from conversation keys and tool args.
    if (target !== this.root && !target.startsWith(this.root + path.sep)) {
      throw new Error(`path escapes state dir: ${parts.join("/")}`);
    }
    return target;
  }

  exists(name: string): boolean {
    return fs.existsSync(this.path(name));
  }

  readJson<T>(name: string, fallback: T): T {
    const file = this.path(name);
    if (!fs.existsSync(file)) return fallback;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      // A truncated write should not take the agent down. Callers get the fallback
      // and the next save repairs the file.
      return fallback;
    }
  }

  writeJson(name: string, value: unknown): void {
    this.writeText(name, JSON.stringify(value, null, 2) + "\n");
  }

  appendLine(name: string, line: string): void {
    const file = this.path(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line.replace(/\r?\n$/, "") + "\n", "utf8");
  }

  readLines(name: string): string[] {
    const text = this.readText(name, "");
    if (!text) return [];
    return text.split("\n").filter((l) => l.length > 0);
  }

  readText(name: string, fallback = ""): string {
    const file = this.path(name);
    if (!fs.existsSync(file)) return fallback;
    return fs.readFileSync(file, "utf8");
  }

  writeText(name: string, text: string): void {
    const file = this.path(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write to a sibling and rename so readers never see a half-written file.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, file);
  }
}
