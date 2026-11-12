/**
 * Apps with a server side. An app may carry code of its own (Artifact.server); Kloru runs it here,
 * one process per app, on this machine: no other company hosts it.
 *
 * - Its home is <root>/<app id>/: code/ (rewritten on every change), data/ (the app's to keep:
 *   files and a SQLite database), log, and host.json (its state and port, which the website reads
 *   to send it what arrives at /a/<id>/api/).
 * - Its secrets are vault entries it names. They go to the process over the pipe when it starts and
 *   nowhere else; the process gets none of Kloru's own environment.
 * - The scratch copy app_test runs on (<app id>~test) is a second process with its own home and
 *   records, so trying an app never touches what the family entered. It stops when nobody uses it.
 *
 * A host moves through: installing (npm) → starting → running, or failed with the reason. A
 * running one that dies is started again, a little later each time.
 */
import { type ChildProcess, fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppStore } from "./app-store.js";
import { err, ok, type Result } from "./result.js";
import type { AppServer, Artifact } from "./types.js";

export type HostState = "installing" | "starting" | "running" | "failed" | "stopped";

/** What host.json holds, for the website and for a worker asking how the server is. */
export interface HostStatus {
  state: HostState;
  rev: number;
  port?: number;
  pid?: number;
  error?: string;
  at: string;
}

/** The moves a host may make. */
const NEXT: Record<HostState, readonly HostState[]> = {
  installing: ["starting", "failed", "stopped"],
  starting: ["running", "failed", "stopped"],
  running: ["starting", "stopped"],
  failed: ["installing", "starting", "stopped"],
  stopped: ["installing", "starting"],
};

/** The files a server may have: plain relative paths, and nothing npm owns. */
export const SERVER_FILE = /^(?!node_modules\/)(?!package(-lock)?\.json$)[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
/** All of a server's files together. */
export const SERVER_MAX = 4_000_000;

/** An app's scratch copy, under a name no app id can be. */
export const spaceOf = (id: string, test: boolean) => (test ? `${id}~test` : id);

/** What host.json says, when a server is up at that revision: how the website finds the port. */
export function readHost(root: string, space: string): HostStatus | undefined {
  try {
    return JSON.parse(readFileSync(join(root, space, "host.json"), "utf8")) as HostStatus;
  } catch {
    return undefined;
  }
}

export interface AppServersOptions {
  /** Where the homes are. */
  root: string;
  app(id: string): Artifact | undefined;
  /** The vault entries by these names, as the code gets them: a string for an API key, the fields for anything else. */
  secrets?(names: string[], app: Artifact): Record<string, unknown>;
  store?(): AppStore | undefined;
  /** The app's public address, https://…/a/<id>/api. */
  url(id: string): string;
  /** The app has something to say to Kloru (kloru.tell). */
  tell?(id: string, text: string): void;
  log?(message: string): void;
  now?(): Date;
}

interface Host {
  space: string;
  id: string;
  test: boolean;
  rev: number;
  state: HostState;
  child?: ChildProcess;
  port?: number;
  error?: string;
  /** Settles when this start has run or failed. */
  ready?: Promise<Result<{ port: number }>>;
  deaths: number;
  upAt: number;
  usedAt: number;
  again?: NodeJS.Timeout;
}

const LOG_MAX = 1_000_000;
const START_MS = 60_000;
const INSTALL_MS = 300_000;
/** A scratch copy nobody has used for this long stops. */
const TEST_IDLE_MS = 15 * 60_000;
/** A server that failed to start is tried again only after this long (or when its code changes). */
const RETRY_FAILED_MS = 30_000;

export class AppServers {
  private readonly hosts = new Map<string, Host>();
  private readonly log: (m: string) => void;
  private readonly now: () => Date;
  private readonly idle: NodeJS.Timeout;
  private closed = false;
  /** The npm to install packages with. */
  npm = process.env.KLORU_NPM?.trim() || "npm";
  hostPath = fileURLToPath(new URL("../host/app-host.mjs", import.meta.url));

  constructor(private readonly o: AppServersOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    // Whatever ran before this process is gone: no host.json may still name its port.
    // (The homes are made when the first server starts; until then there may be no folder at all.)
    for (const space of existsSync(o.root) ? readdirSync(o.root) : []) rmSync(join(o.root, space, "host.json"), { force: true });
    this.idle = setInterval(() => this.stopIdle(), 60_000);
    this.idle.unref();
  }

  /** The port of an app's server, started first when it isn't up or its code has changed. */
  async ensure(id: string, test = false): Promise<Result<{ port: number }>> {
    const app = this.o.app(id);
    if (!app || app.kind !== "app" || !app.server) return err("this app has no server");
    if (this.closed) return err("Kloru is stopping");
    const space = spaceOf(id, test);
    const h = this.hosts.get(space);
    if (h && h.rev === app.server.rev) {
      h.usedAt = this.now().getTime();
      if (h.state === "running" && h.port) return ok({ port: h.port });
      if ((h.state === "installing" || h.state === "starting") && h.ready) return h.ready;
      if (h.state === "failed" && this.now().getTime() - h.upAt < RETRY_FAILED_MS) return err(h.error ?? "the server didn't start");
    }
    return this.start(app, app.server, test);
  }

  /** Start every app's server (at boot), one after another. */
  async startAll(apps: Artifact[]): Promise<void> {
    for (const a of apps) {
      if (a.kind !== "app" || !a.server || this.closed) continue;
      const up = await this.ensure(a.id);
      if (!up.ok) this.log(`apps: ${a.title} (${a.id}) didn't start: ${up.error.split("\n")[0]}`);
    }
  }

  status(id: string, test = false): HostStatus | undefined {
    return readHost(this.o.root, spaceOf(id, test));
  }

  /** The end of what the server printed (and what it threw). */
  logs(id: string, test = false, max = 8_000): string {
    try {
      const text = readFileSync(join(this.o.root, spaceOf(id, test), "log"), "utf8");
      return text.length > max ? text.slice(-max) : text;
    } catch {
      return "";
    }
  }

  /** Stop an app's servers (it was taken down, or its server removed). */
  async stop(id: string): Promise<void> {
    await Promise.all([false, true].map((test) => this.end(spaceOf(id, test))));
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    clearInterval(this.idle);
    await Promise.all([...this.hosts.keys()].map((space) => this.end(space)));
  }

  private home(space: string): string {
    return join(this.o.root, space);
  }

  private move(h: Host, to: HostState, error?: string): void {
    if (!NEXT[h.state].includes(to)) throw new Error(`an app's server can't go from ${h.state} to ${to}`);
    h.state = to;
    h.error = to === "failed" ? error : undefined;
    if (to !== "running") h.port = undefined;
    const status: HostStatus = { state: to, rev: h.rev, ...(h.port ? { port: h.port } : {}), ...(h.child?.pid && to !== "stopped" && to !== "failed" ? { pid: h.child.pid } : {}), ...(h.error ? { error: h.error } : {}), at: this.now().toISOString() };
    const file = join(this.home(h.space), "host.json");
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify(status));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.log(`apps: ${h.space}: host.json not written: ${(error as Error).message}`);
    }
  }

  private write(space: string, text: string): void {
    const file = join(this.home(space), "log");
    try {
      // Keep the end: the newest lines are the ones a worker reads.
      if (existsSync(file) && statSync(file).size > LOG_MAX) writeFileSync(file, readFileSync(file, "utf8").slice(-LOG_MAX / 4));
      appendFileSync(file, text);
    } catch {}
  }

  private async start(app: Artifact, server: AppServer, test: boolean): Promise<Result<{ port: number }>> {
    const space = spaceOf(app.id, test);
    await this.end(space);
    const h: Host = { space, id: app.id, test, rev: server.rev, state: "stopped", deaths: this.hosts.get(space)?.deaths ?? 0, upAt: this.now().getTime(), usedAt: this.now().getTime() };
    this.hosts.set(space, h);
    h.ready = this.run(h, app, server).catch((error: unknown) => this.fail(h, error instanceof Error ? error.message : String(error)));
    return h.ready;
  }

  private fail(h: Host, error: string): Result<{ port: number }> {
    h.upAt = this.now().getTime();
    this.write(h.space, `[kloru] didn't start: ${error}\n`);
    if (h.state !== "failed" && h.state !== "stopped") this.move(h, "failed", error);
    return err(error);
  }

  private async run(h: Host, app: Artifact, server: AppServer): Promise<Result<{ port: number }>> {
    const home = this.home(h.space);
    const code = join(home, "code");
    mkdirSync(join(home, "data"), { recursive: true });
    // The code is exactly this revision's files; what npm installed stays.
    mkdirSync(code, { recursive: true });
    for (const name of readdirSync(code)) if (name !== "node_modules" && name !== "package-lock.json" && name !== ".installed") rmSync(join(code, name), { recursive: true, force: true });
    for (const [path, body] of Object.entries(server.files)) {
      if (!SERVER_FILE.test(path)) return this.fail(h, `${path} isn't a file name a server can have`);
      mkdirSync(dirname(join(code, path)), { recursive: true });
      writeFileSync(join(code, path), body);
    }
    const packages = server.packages ?? {};
    writeFileSync(join(code, "package.json"), JSON.stringify({ name: "app", private: true, type: "module", dependencies: packages }, null, 2));
    this.write(h.space, `[kloru] ${this.now().toISOString()} starting revision ${server.rev}\n`);

    if (Object.keys(packages).length) {
      const want = createHash("sha256").update(JSON.stringify(Object.entries(packages).sort())).digest("hex");
      const marker = join(code, ".installed");
      // A backup leaves node_modules out, so a restored home has the marker and nothing installed.
      if (!existsSync(marker) || !existsSync(join(code, "node_modules")) || readFileSync(marker, "utf8") !== want) {
        this.move(h, "installing");
        const installed = await this.install(h, code);
        if (!installed.ok) return this.fail(h, installed.error);
        writeFileSync(marker, want);
      }
    }
    if (this.hosts.get(h.space) !== h || this.closed) return err("stopped");

    this.move(h, "starting");
    const child = fork(this.hostPath, [home], { cwd: join(home, "data"), silent: true, env: appEnv(process.env) });
    h.child = child;
    child.stdout?.on("data", (b: Buffer) => this.write(h.space, b.toString()));
    child.stderr?.on("data", (b: Buffer) => this.write(h.space, b.toString()));
    child.on("message", (m: HostMessage) => void this.heard(h, app, m));

    const started = await new Promise<Result<{ port: number }>>((resolve) => {
      const timer = setTimeout(() => resolve(err(`the server didn't start within ${START_MS / 1000} seconds`)), START_MS);
      child.on("message", (m: HostMessage) => {
        if (m.type === "ready" && typeof m.port === "number") resolve(ok({ port: m.port }));
        else if (m.type === "failed") resolve(err(String(m.error ?? "the server didn't start")));
        else return;
        clearTimeout(timer);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(err(`the server stopped as it started (exit ${code ?? "by signal"})${this.tail(h.space)}`));
      });
      child.once("error", (error) => resolve(err(error.message)));
      const secrets = server.secrets?.length && this.o.secrets ? this.o.secrets(server.secrets, app) : {};
      child.send({ type: "start", id: app.id, url: this.o.url(app.id), test: h.test, secrets });
    });
    if (!started.ok) {
      child.removeAllListeners("exit");
      child.kill("SIGKILL");
      h.child = undefined;
      return this.fail(h, started.error);
    }
    if (this.hosts.get(h.space) !== h || this.closed) {
      child.kill("SIGKILL");
      return err("stopped");
    }
    h.port = started.value.port;
    h.upAt = this.now().getTime();
    this.move(h, "running");
    child.removeAllListeners("exit");
    child.once("exit", (code) => this.died(h, app.id, code));
    this.log(`apps: ${app.title} (${h.space}) is up, revision ${server.rev}, port ${h.port}`);
    return started;
  }

  private tail(space: string): string {
    const end = this.logs(space.replace(/~test$/, ""), space.endsWith("~test"), 1_500).trim();
    return end ? `\n${end}` : "";
  }

  private install(h: Host, code: string): Promise<Result<true>> {
    return new Promise((resolve) => {
      const child = spawn(this.npm, ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: code, env: appEnv(process.env), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const take = (b: Buffer) => {
        out = (out + b.toString()).slice(-2_000);
        this.write(h.space, b.toString());
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill("SIGKILL"), INSTALL_MS);
      child.once("error", (error) => (clearTimeout(timer), resolve(err(`npm couldn't run: ${error.message}`))));
      child.once("exit", (status) => (clearTimeout(timer), resolve(status === 0 ? ok(true) : err(`npm install failed:\n${out.trim()}`))));
    });
  }

  /** The process asks for the app's records, or has something to say. */
  private async heard(h: Host, app: Artifact, m: HostMessage): Promise<void> {
    if (m.op === "error") {
      try {
        this.o.store?.()?.reportError(h.id, this.o.app(h.id)?.version ?? 1, `server: ${String(m.message ?? "").slice(0, 280)}`);
      } catch {}
      return;
    }
    if (m.n === undefined || !m.op) return;
    const reply = (r: Result<unknown>) => h.child?.connected && h.child.send(r.ok ? { n: m.n, ok: true, value: r.value } : { n: m.n, ok: false, error: r.error });
    try {
      if (m.op === "tell") {
        // The scratch copy speaks to nobody.
        if (!h.test) this.o.tell?.(h.id, String(m.text ?? "").slice(0, 4_000));
        return void reply(ok(!h.test && !!this.o.tell));
      }
      const store = this.o.store?.();
      if (!store) return void reply(err("this Kloru has nowhere to keep app data"));
      const collection = String(m.collection ?? "");
      if (m.op === "list") return void reply(ok(store.list(h.space, collection)));
      if (m.op === "put") {
        const put = store.put(h.space, collection, m.record, { by: app.title, owner: "app" });
        return void reply(put.ok ? ok(put.record) : err(put.error));
      }
      if (m.op === "remove") return void reply(ok(store.remove(h.space, collection, String(m.id ?? ""))));
      reply(err(`kloru has no ${m.op}`));
    } catch (error) {
      reply(err(error instanceof Error ? error.message : String(error)));
    }
  }

  /** A running server died on its own: start it again, a little later each time it does. */
  private died(h: Host, id: string, code: number | null): void {
    if (this.hosts.get(h.space) !== h || this.closed || h.state !== "running") return;
    const now = this.now().getTime();
    h.deaths = now - h.upAt > 60_000 ? 1 : h.deaths + 1;
    const wait = Math.min(250 * 2 ** (h.deaths - 1), 60_000);
    this.write(h.space, `[kloru] ${this.now().toISOString()} stopped (exit ${code ?? "by signal"}); starting again in ${wait} ms\n`);
    this.log(`apps: ${h.space} stopped (exit ${code ?? "by signal"}); again in ${wait} ms`);
    h.child = undefined;
    this.move(h, "starting");
    h.again = setTimeout(() => {
      const app = this.o.app(id);
      if (this.hosts.get(h.space) !== h || this.closed || !app?.server) return;
      void this.start(app, app.server, h.test);
    }, wait);
    // Anyone who asks meanwhile waits for the new one.
    h.ready = new Promise((resolve) => {
      const check = setInterval(() => {
        const cur = this.hosts.get(h.space);
        if (cur === h) return;
        clearInterval(check);
        resolve(cur?.ready ?? err("stopped"));
      }, 50);
    });
  }

  private async end(space: string): Promise<void> {
    const h = this.hosts.get(space);
    if (!h) return;
    this.hosts.delete(space);
    clearTimeout(h.again);
    const child = h.child;
    h.child = undefined;
    if (h.state !== "stopped") {
      try {
        this.move(h, "stopped");
      } catch {}
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.removeAllListeners("exit");
    await new Promise<void>((resolve) => {
      const hard = setTimeout(() => child.kill("SIGKILL"), 3_000);
      child.once("exit", () => (clearTimeout(hard), resolve()));
      child.kill("SIGTERM");
    });
  }

  private stopIdle(): void {
    const now = this.now().getTime();
    for (const h of this.hosts.values()) if (h.test && h.state === "running" && now - h.usedAt > TEST_IDLE_MS) void this.end(h.space);
  }
}

interface HostMessage {
  type?: string;
  port?: number;
  error?: string;
  n?: number;
  op?: string;
  collection?: unknown;
  record?: unknown;
  id?: unknown;
  text?: unknown;
  message?: unknown;
}

/** What an app's process inherits: enough to run node and npm, and none of Kloru's keys. */
function appEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "TZ", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}
