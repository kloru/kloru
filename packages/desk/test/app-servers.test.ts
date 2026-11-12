/**
 * An app's own server: code a worker wrote, run by Kloru in a process of its own, with the vault
 * entries it was given, the app's records and a folder to keep things in.
 *
 * 2026-11-12: a map app needed a key its page could not hold. Apps had no server side, and the
 * only one on offer was someone else's service.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppServers } from "../src/app-servers.js";
import { AppStore } from "../src/app-store.js";
import type { AppServer, Artifact } from "../src/types.js";

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const HELLO = `export default async (request, kloru) => {
  const url = new URL(request.url);
  if (url.pathname === "/who") return { user: kloru.user(request), test: kloru.test };
  if (url.pathname === "/key") return { key: kloru.secrets["cleo-carto-key"], env: process.env.CLEO_CARTO_KEY ?? null, kloru: Object.keys(process.env).filter((k) => /KLORU|OPENROUTER/.test(k)) };
  if (url.pathname === "/add") return kloru.data.put("items", await request.json());
  if (url.pathname === "/items") return kloru.data.list("items");
  if (url.pathname === "/count") {
    kloru.db.exec("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
    kloru.db.prepare("INSERT INTO hits VALUES (1)").run();
    return { hits: kloru.db.prepare("SELECT count(*) AS c FROM hits").get().c, dir: kloru.dir, cwd: process.cwd() };
  }
  if (url.pathname === "/tell") return { told: await kloru.tell("The oven is still on") };
  if (url.pathname === "/die") process.exit(3);
  if (url.pathname === "/throw") throw new Error("no such street");
  return new Response("hello " + url.pathname + url.search, { status: 201, headers: { "x-app": "1" } });
};`;

function setup(server: Partial<AppServer> = {}) {
  const root = mkdtempSync(join(tmpdir(), "app-servers-"));
  const store = new AppStore(join(root, "apps.db"));
  const app: Artifact = { id: ID, kind: "app", title: "Commute", markdown: "", html: "<p>", issue: 1, call: "c", phone: "+14155550191", createdAt: "2026-11-12T00:00:00Z", version: 1, server: { files: { "server.js": HELLO }, rev: 1, ...server } };
  const told: string[] = [];
  const servers = new AppServers({
    root: join(root, "homes"),
    app: (id) => (id === ID ? app : undefined),
    secrets: (names) => Object.fromEntries(names.map((n) => [n, n === "cleo-carto-key" ? "sk-carto-123" : { username: "cleo", password: "pw" }])),
    store: () => store,
    url: (id) => `https://kloru.test/a/${id}/api`,
    tell: (id, text) => void told.push(`${id}: ${text}`),
    log: () => {},
  });
  const get = async (path: string, test = false, init?: RequestInit) => {
    const up = await servers.ensure(ID, test);
    if (!up.ok) throw new Error(up.error);
    return fetch(`http://127.0.0.1:${up.value.port}${path}`, init);
  };
  return { root, store, app, servers, told, get };
}

describe("an app's own server (2026-11-12)", () => {
  let s: ReturnType<typeof setup>;
  afterEach(async () => {
    await s.servers.closeAll();
    s.store.close();
  });

  it("answers requests with what its handler returns: a Response, or anything else as JSON", async () => {
    s = setup();
    const r = await s.get("/streets?near=3");
    expect([r.status, r.headers.get("x-app"), await r.text()]).toEqual([201, "1", "hello /streets?near=3"]);
    expect(await (await s.get("/who", false, { headers: { "x-kloru-user": encodeURIComponent(JSON.stringify({ name: "Cleo", id: "u:+14155550191", family: true })) } })).json()).toEqual({ user: { name: "Cleo", id: "u:+14155550191", family: true }, test: false });
    expect(s.servers.status(ID)).toMatchObject({ state: "running", rev: 1 });
    expect(JSON.parse(readFileSync(join(s.root, "homes", ID, "host.json"), "utf8"))).toMatchObject({ state: "running", rev: 1, port: expect.any(Number) });
  });

  it("is given the vault entries it names and nothing of Kloru's own", async () => {
    process.env.KLORU_VAULT_KEY = "not-for-apps";
    s = setup({ secrets: ["cleo-carto-key"] });
    expect(await (await s.get("/key")).json()).toEqual({ key: "sk-carto-123", env: "sk-carto-123", kloru: [] });
    delete process.env.KLORU_VAULT_KEY;
  });

  it("reads and writes the app's records, has a database and a folder of its own, and can tell Kloru something", async () => {
    s = setup();
    const put = await (await s.get("/add", false, { method: "POST", body: JSON.stringify({ name: "Milk" }) })).json();
    expect(put).toMatchObject({ name: "Milk", by: "Commute" });
    expect(s.store.list(ID, "items")).toMatchObject([{ name: "Milk" }]);
    expect(await (await s.get("/items")).json()).toMatchObject([{ name: "Milk" }]);
    await s.get("/count");
    const home = join(s.root, "homes", ID, "data");
    expect(await (await s.get("/count")).json()).toMatchObject({ hits: 2, dir: home });
    expect(existsSync(join(home, "app.db"))).toBe(true);
    expect(await (await s.get("/tell")).json()).toEqual({ told: true });
    expect(s.told).toEqual([`${ID}: The oven is still on`]);
  });

  it("serves what is under public/ as it is", async () => {
    s = setup({ files: { "server.js": HELLO, "public/logo.svg": "<svg/>", "public/docs/index.html": "<h1>Docs</h1>" } });
    const r = await s.get("/logo.svg");
    expect([r.headers.get("content-type"), await r.text()]).toEqual(["image/svg+xml", "<svg/>"]);
    expect(await (await s.get("/docs/")).text()).toBe("<h1>Docs</h1>");
    expect((await s.get("/../server.js")).status).toBe(201);
  });

  it("what a handler throws is a 500 with the reason, in the log and among the app's errors; the server stays up", async () => {
    s = setup();
    const r = await s.get("/throw");
    expect([r.status, await r.json()]).toEqual([500, { error: "no such street" }]);
    expect((await s.get("/ok")).status).toBe(201);
    expect(s.servers.logs(ID)).toContain("no such street");
    expect(s.store.errors(ID, 1)).toEqual(["server: no such street"]);
  });

  it("a changed server replaces the running one; one that doesn't start says why", async () => {
    s = setup();
    await s.get("/");
    s.app.server = { files: { "server.js": `export default () => "second"`, "lib/x.js": "export const x = 1;" }, rev: 2 };
    expect(await (await s.get("/")).text()).toBe("second");
    expect(existsSync(join(s.root, "homes", ID, "code", "lib", "x.js"))).toBe(true);
    s.app.server = { files: { "server.js": `import "./missing.js";` }, rev: 3 };
    const broken = await s.servers.ensure(ID);
    expect(broken).toMatchObject({ ok: false, error: expect.stringContaining("missing.js") });
    expect(existsSync(join(s.root, "homes", ID, "code", "lib", "x.js"))).toBe(false);
    expect(s.servers.status(ID)).toMatchObject({ state: "failed", rev: 3 });
    s.app.server = { files: { "server.js": `export const nothing = 1;` }, rev: 4 };
    expect(await s.servers.ensure(ID)).toMatchObject({ ok: false, error: expect.stringContaining("answers nothing") });
  });

  it("a server that dies is started again", async () => {
    s = setup();
    await s.get("/count");
    const first = s.servers.status(ID)?.pid;
    await s.get("/die").catch(() => {});
    // The same state as before it died, in a new process.
    await expect.poll(() => [s.servers.status(ID)?.state, s.servers.status(ID)?.pid !== first], { timeout: 10_000 }).toEqual(["running", true]);
    expect(await (await s.get("/count")).json()).toMatchObject({ hits: 2 });
  });

  it("the scratch copy is a process of its own, with its own records and files", async () => {
    s = setup();
    await s.get("/add", true, { method: "POST", body: JSON.stringify({ name: "Try" }) });
    expect(s.store.list(ID, "items")).toEqual([]);
    expect(s.store.list(`${ID}~test`, "items")).toMatchObject([{ name: "Try" }]);
    expect(await (await s.get("/who", true)).json()).toEqual({ user: null, test: true });
    expect(await (await s.get("/tell", true)).json()).toEqual({ told: false });
    expect(s.told).toEqual([]);
    expect((await s.get("/count", true).then((r) => r.json())).dir).toBe(join(s.root, "homes", `${ID}~test`, "data"));
  });

  it("listen(server) hands over the Node server, for anything that wants one", async () => {
    s = setup({ files: { "server.js": `export function listen(server) { server.on("request", (req, res) => res.end("node " + req.url)); }` } });
    expect(await (await s.get("/x")).text()).toBe("node /x");
  });

  it("installs the npm packages it names before it starts, once", async () => {
    s = setup({ files: { "server.js": `import pad from "leftpad";\nexport default () => pad("7", 3)` }, packages: { leftpad: "1.0.0" } });
    // npm, for this test: makes the package the way an install would, and counts its runs.
    const npm = join(s.root, "npm");
    writeFileSync(npm, `#!/bin/sh\necho run >> "${s.root}/npm-runs"\nmkdir -p node_modules/leftpad\necho 'export default (s, n) => String(s).padStart(n, "0");' > node_modules/leftpad/index.js\necho '{"name":"leftpad","type":"module","main":"index.js"}' > node_modules/leftpad/package.json\n`);
    chmodSync(npm, 0o755);
    s.servers.npm = npm;
    expect(await (await s.get("/")).text()).toBe("007");
    expect(JSON.parse(readFileSync(join(s.root, "homes", ID, "code", "package.json"), "utf8"))).toMatchObject({ type: "module", dependencies: { leftpad: "1.0.0" } });
    s.app.server = { ...s.app.server!, files: { "server.js": `import pad from "leftpad";\nexport default () => pad("8", 3)` }, rev: 2 };
    expect(await (await s.get("/")).text()).toBe("008");
    expect(readFileSync(join(s.root, "npm-runs"), "utf8").trim().split("\n")).toHaveLength(1);
    // A backup leaves node_modules out; after a restore they are installed again.
    await s.servers.stop(ID);
    rmSync(join(s.root, "homes", ID, "code", "node_modules"), { recursive: true });
    expect(await (await s.get("/")).text()).toBe("008");
    expect(readFileSync(join(s.root, "npm-runs"), "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("an app with no server has none to start", async () => {
    s = setup();
    delete s.app.server;
    expect(await s.servers.ensure(ID)).toEqual({ ok: false, error: "this app has no server" });
  });
});
