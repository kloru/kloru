/**
 * A worker gives an app a server: files it writes with a tool call, the vault entries the code may
 * use, npm packages. Kloru runs it and says whether it came up.
 *
 * 2026-11-12: a map app's worker had the key and nowhere to put it but the page. Now it saves the
 * key in the vault and the app's server uses it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerRole } from "@kloru/core";
import { afterEach, describe, expect, it } from "vitest";
import { AppServers } from "../src/app-servers.js";
import { AppStore } from "../src/app-store.js";
import { appTools } from "../src/apps.js";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Vault } from "../src/vault.js";
import { vaultTools } from "../src/vault-tools.js";

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
const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
const failed = (r: unknown) => !!(r as { isError?: boolean }).isError;
const PAGE = `<!doctype html><title>Commute</title><div id="map"></div>`;
const TILES = `export default async (request, kloru) => {
  const url = new URL(request.url);
  if (url.pathname === "/tell") return { told: await kloru.tell("The key stopped working") };
  if (url.pathname === "/add") return kloru.data.put("routes", { name: "Home" });
  return { path: url.pathname, key: kloru.secrets["cleo-carto-key"] ?? null, who: kloru.user(request)?.name ?? null, test: kloru.test };
};`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "app-server-tools-"));
  const store = new AppStore(join(root, "apps.db"));
  const desk = new Desk({ root, host: new Host(), planner: new PM(), ownerPhone: EZRA, isMember: (p) => p === CLEO, nameOf: (p) => (p === CLEO ? "Cleo" : p === EZRA ? "Ezra" : undefined), appStore: () => store, appErrors: (id, v) => store.errors(id, v) });
  const vault = new Vault(join(root, "secrets", "vault.json"), Buffer.alloc(32, 5).toString("base64"));
  desk.useVault(vault, (p) => (p === CLEO ? "Cleo" : "Ezra"), "https://kloru.test/vault");
  const servers = new AppServers({
    root: join(root, "app-servers"),
    app: (id) => desk.repo.artifact(id),
    secrets: (names) => desk.appSecrets(names),
    store: () => store,
    url: (id) => `${desk.artifactUrl(id)}/api`,
    tell: (id, said) => void desk.appSays(id, said),
    log: () => {},
  });
  const tools = Object.fromEntries([...appTools(desk, { servers }), ...vaultTools(desk, vault, () => "Cleo")].map((t) => [t.spec.name, t]));
  const file = (phone: string, request: string, sid: string) => desk.fileIssue(desk.startCall({ callSid: sid, phone, channel: "imessage" }).call.id, request);
  const issue = file(CLEO, "Make a map of my commute", "CA1");
  const run = (name: string, args: Record<string, unknown>, issueId = issue.id, role = "engineer") => tools[name]!.spec.execute(args as never, { conversationKey: `desk:issue:${issueId}:${role}` } as never);
  const make = async (issueId = issue.id) => /a\/([\w-]{22})/.exec(text(await run("app_create", { title: "Commute", html: PAGE }, issueId)))![1]!;
  return { root, desk, vault, store, servers, tools, issue, file, run, make };
}

describe("a worker gives an app a server (2026-11-12)", () => {
  let s: ReturnType<typeof setup>;
  afterEach(async () => {
    await s.servers.closeAll();
    s.store.close();
  });

  it("app_server writes the files, starts it and says where it answers; app_call reaches it as the person who asked", async () => {
    s = setup();
    const id = await s.make();
    const out = await s.run("app_server", { id, files: { "server.js": TILES } });
    expect(failed(out)).toBe(false);
    expect(text(out)).toContain("running");
    expect(text(out)).toContain(`a/${id}/api`);
    expect(s.desk.repo.artifact(id)).toMatchObject({ version: 2, server: { rev: 1, files: { "server.js": TILES } } });
    expect(s.desk.repo.artifactVersions(id).at(-1)).toMatchObject({ version: 2, server: { rev: 1 } });
    const called = text(await s.run("app_call", { id, path: "/tiles/3?x=1" }));
    expect(called).toContain("200");
    expect(called).toContain(`"path":"/tiles/3"`);
    expect(called).toContain(`"who":"Cleo"`);
  });

  it("a change to the page keeps the server; a change to the server keeps the page", async () => {
    s = setup();
    const id = await s.make();
    await s.run("app_server", { id, files: { "server.js": TILES, "lib/a.js": "export const a = 1;" } });
    await s.run("app_update", { id, replace: { old: "Commute", new: "My commute" } });
    expect(s.desk.repo.artifact(id)).toMatchObject({ version: 3, server: { rev: 1 } });
    const out = await s.run("app_server", { id, replace: { file: "server.js", old: `"Home"`, new: `"Work"` }, remove: ["lib/a.js"] });
    expect(failed(out)).toBe(false);
    const a = s.desk.repo.artifact(id)!;
    expect(a).toMatchObject({ version: 4, html: expect.stringContaining("My commute"), server: { rev: 2 } });
    expect(Object.keys(a.server!.files)).toEqual(["server.js"]);
    expect(a.server!.files["server.js"]).toContain(`"Work"`);
    expect(failed(await s.run("app_server", { id, replace: { file: "server.js", old: "not there", new: "x" } }))).toBe(true);
    expect(failed(await s.run("app_server", { id, files: { "../x.js": "1" } }))).toBe(true);
  });

  it("a key the worker got is saved in the vault as the person's, and the server is given it by name", async () => {
    s = setup();
    const id = await s.make();
    const saved = await s.run("vault_save_api_key", { name: "cleo-carto-key", service: "CARTO", key: "sk-carto-123" });
    expect(failed(saved)).toBe(false);
    expect(text(saved)).not.toContain("sk-carto-123");
    expect(s.vault.get("cleo-carto-key")).toMatchObject({ owner: CLEO, kind: "api_key", meta: { service: "CARTO" }, createdBy: "kloru" });
    expect(s.vault.value("cleo-carto-key", "key")).toBe("sk-carto-123");
    await s.run("app_server", { id, files: { "server.js": TILES }, secrets: ["cleo-carto-key"] });
    // What the code gets is the value; what a worker reads back is the name.
    const called = text(await s.run("app_call", { id, path: "/" }));
    expect(called).toContain(`"key":"{{vault:cleo-carto-key.key}}"`);
    expect(called).not.toContain("sk-carto-123");
    const direct = await fetch(`http://127.0.0.1:${s.servers.status(id)!.port}/`);
    expect(await direct.json()).toMatchObject({ key: "sk-carto-123" });
    expect(s.desk.repo.ledger().filter((l) => l.tool === "app_server")).toMatchObject([{ slug: "VAULT_USE", ok: true, args: { secrets: ["cleo-carto-key"] } }]);
  });

  it("a secret that isn't this request's to use is refused, and one that doesn't exist is named", async () => {
    s = setup();
    s.vault.put({ name: "cleo-carto-key", owner: CLEO, kind: "api_key", meta: { service: "CARTO" }, secret: { key: "sk-carto-123" }, createdBy: CLEO });
    const sams = s.file(SAM, "Make me a map", "CA2");
    const id = await s.make(sams.id);
    const out = await s.run("app_server", { id, files: { "server.js": TILES }, secrets: ["cleo-carto-key"] }, sams.id);
    expect(failed(out)).toBe(true);
    expect(text(out)).toContain("cleo-carto-key");
    expect(s.desk.repo.artifact(id)!.server).toBeUndefined();
    expect(text(await s.run("app_server", { id, files: { "server.js": TILES }, secrets: ["no-such-key"] }, sams.id))).toContain("no-such-key");
  });

  it("a server that doesn't start says why, and app_logs shows what it printed", async () => {
    s = setup();
    const id = await s.make();
    const out = await s.run("app_server", { id, files: { "server.js": `console.log("warming up");\nimport("./gone.js");\nthrow new Error("no route table");` } });
    expect(failed(out)).toBe(true);
    expect(text(out)).toContain("no route table");
    const logs = text(await s.run("app_logs", { id }));
    expect(logs).toContain("failed");
    expect(logs).toContain("warming up");
  });

  it("app_call with scratch reaches the copy app_test runs on; QA calls only that one", async () => {
    s = setup();
    const id = await s.make();
    await s.run("app_server", { id, files: { "server.js": TILES } });
    expect(text(await s.run("app_call", { id, path: "/add", method: "POST", scratch: true }))).toContain("Home");
    expect(s.store.list(id, "routes")).toEqual([]);
    expect(s.store.list(`${id}~test`, "routes")).toHaveLength(1);
    expect(failed(await s.run("app_call", { id, path: "/add", method: "POST" }, s.issue.id, "qa"))).toBe(true);
    expect(text(await s.run("app_call", { id, path: "/", scratch: true }, s.issue.id, "qa"))).toContain(`"test":true`);
  });

  it("app_read shows the server's files and how it is", async () => {
    s = setup();
    const id = await s.make();
    await s.run("app_server", { id, files: { "server.js": TILES }, packages: {} });
    const read = text(await s.run("app_read", { id }));
    expect(read).toContain("server.js");
    expect(read).toContain("kloru.data.put");
    expect(read).toContain("running");
    expect(read).toContain(PAGE);
  });

  it("what the server tells Kloru is filed as a request from the app's person, on the app", async () => {
    s = setup();
    const id = await s.make();
    await s.run("app_server", { id, files: { "server.js": TILES } });
    expect(text(await s.run("app_call", { id, path: "/tell" }))).toContain(`"told":true`);
    const filed = s.desk.repo.issues().at(-1)!;
    expect(filed).toMatchObject({ artifact: id, filedBy: { phone: CLEO } });
    expect(filed.request).toContain("Commute");
    expect(filed.request).toContain("The key stopped working");
  });

  it("off takes the server away and stops it", async () => {
    s = setup();
    const id = await s.make();
    await s.run("app_server", { id, files: { "server.js": TILES } });
    expect(failed(await s.run("app_server", { id, off: true }))).toBe(false);
    expect(s.desk.repo.artifact(id)!.server).toBeUndefined();
    expect(s.servers.status(id)?.state).toBe("stopped");
    expect(failed(await s.run("app_call", { id, path: "/" }))).toBe(true);
  });
});
