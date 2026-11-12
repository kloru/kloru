import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Repo, type AppVisitors } from "@kloru/desk";
import type { AgentClient } from "../src/agent-client.js";
import { FRAME_CSP, FRAME_SANDBOX } from "../src/app-pages.js";
import { AppStore } from "@kloru/desk";
import { revokeArtifact } from "../src/desk-pages.js";
import { createConsole } from "../src/server.js";
import { SESSION_COOKIE, newSession, signSession } from "../src/session.js";
import { FileStore } from "../src/store.js";

const SECRET = "session-secret";
const STATIC = fileURLToPath(new URL("../static", import.meta.url));
const EZRA = "+14155550190";
const CLEO = "+14155550191";
const APP = "Qm9vZ2xlR29vZ2xlR29vZ2";
const PAGE = "UGFnZVBhZ2VQYWdlUGFnZV";
const TEST_KEY = "dGVzdGtleXRlc3RrZXl0ZXN0";
const HTML = `<!doctype html><title>Groceries</title><ul id="list"></ul><script>kloru.list("items").then((items) => { document.title = items.length; });</script>`;

let closeFn: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeFn?.();
  closeFn = undefined;
});

/** A website over a desk with one app (and one page of Ezra's), Cleo a family member. */
async function start(visitors?: AppVisitors) {
  const dir = join(mkdtempSync(join(tmpdir(), "desk-")), "repo");
  const repo = new Repo(dir);
  const call = repo.startCall({ callSid: "CA393c42478ffcd5855c7dfd5d38fe7007", phone: EZRA, channel: "sms" });
  const issue = repo.newIssue({ request: "Make us a shared grocery list", filedBy: { phone: EZRA, call: call.id }, baseTurn: 0 });
  const at = "2026-11-09T18:00:00.000Z";
  repo.saveArtifact({ id: APP, kind: "app", title: "Grocery list", markdown: "", html: HTML, ...(visitors ? { visitors } : {}), testKey: TEST_KEY, issue: issue.id, call: call.id, phone: EZRA, createdAt: at, version: 1 });
  repo.saveArtifact({ id: PAGE, title: "Ezra's week", markdown: "# Week", issue: issue.id, call: call.id, phone: EZRA, createdAt: at });
  const store = new FileStore(mkdtempSync(join(tmpdir(), "console-srv-")));
  const appsDbPath = join(mkdtempSync(join(tmpdir(), "apps-db-")), "apps.db");
  const revokedPath = join(mkdtempSync(join(tmpdir(), "revoked-")), "revoked.json");
  const client: AgentClient = {
    call: async <T>(op: string, args: Record<string, unknown> = {}) => (op === "family.lookup" && args.phone === CLEO ? { role: "member", name: "Cleo" } : null) as T,
  };
  const server = createConsole({
    store,
    sessionSecret: SECRET,
    publicUrl: "http://localhost:8790",
    adminPhones: [EZRA],
    verifier: { start: async () => {}, check: async () => true },
    clientFor: () => client,
    pageClient: () => client,
    staticDir: STATIC,
    deskDir: dir,
    revokedArtifactsPath: revokedPath,
    appsDbPath,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeFn = () => new Promise((r) => server.close(() => r()));
  const signedIn = async (phone: string, name?: string) => {
    const user = await store.upsertUser({ phone, ...(name ? { name } : {}) });
    const s = newSession(user.id, user.phone);
    return { cookie: `${SESSION_COOKIE}=${signSession(SECRET, s)}`, key: s.csrf };
  };
  /** One browser: who it is (a cookie, a guest's token) and the key its shell page was given. */
  const as = (who: { cookie?: string; key?: string; visitor?: string; test?: string }) => {
    const headers = { "content-type": "application/json", ...(who.cookie ? { cookie: who.cookie } : {}), ...(who.key ? { "x-csrf": who.key } : {}), ...(who.visitor ? { "x-visitor": who.visitor } : {}), ...(who.test ? { "x-test": who.test } : {}) };
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}/a/${APP}${path}`, { method, redirect: "manual", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> };
    };
    return { list: (c: string) => call("GET", `/data/${c}`), put: (c: string, r: unknown) => call("PUT", `/data/${c}`, r), remove: (c: string, id: string) => call("DELETE", `/data/${c}/${id}`), rev: () => call("GET", "/data"), error: (message: string, version = 1) => call("POST", "/errors", { message, version }) };
  };
  const get = (path: string, cookie?: string) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const attr = (html: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(/<iframe[^>]*>/.exec(html)?.[0] ?? "")?.[1];
  return { base, repo, revokedPath, appsDbPath, signedIn, as, get, attr };
}

describe("apps on the website (2026-11-09, #43)", () => {
  it("a family app sends someone who isn't signed in to sign in, and back", async () => {
    const c = await start();
    const res = await c.get(`/a/${APP}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/signin?next=${encodeURIComponent(`/a/${APP}`)}`);
    const guest = c.as({ visitor: "v".repeat(24) });
    expect((await guest.list("items")).status).toBe(401);
    expect((await guest.put("items", { name: "Milk" })).status).toBe(401);
    expect((await guest.rev()).status).toBe(401);
  });

  it("the shell is Kloru's page around a sandboxed frame; the frame holds the app, with no Kloru origin, and may use the web over https", async () => {
    const c = await start();
    const cleo = await c.signedIn(CLEO, "Cleo");
    const res = await c.get(`/a/${APP}`, cleo.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    const shell = await res.text();
    expect(shell).toContain(`sandbox="${FRAME_SANDBOX}"`);
    expect(shell).not.toContain("kloru.list"); // the app's file is never part of Kloru's own page
    expect(c.attr(shell, "data-key")).toBe(cleo.key);
    expect(JSON.parse(c.attr(shell, "name")!.replace(/&quot;/g, '"'))).toEqual({ me: { name: "Cleo" } });

    const src = c.attr(shell, "src")!.replace(/&amp;/g, "&");
    const frame = await c.get(src); // the frame is sandboxed: it sends no cookie
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-security-policy")).toBe(FRAME_CSP);
    expect(FRAME_CSP).toContain(`sandbox ${FRAME_SANDBOX};`);
    expect(FRAME_CSP).toContain("default-src 'none'");
    // No Kloru origin, and no way to move the page around it: the frame is cut off from the site.
    expect(FRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(FRAME_SANDBOX).not.toContain("allow-top-navigation");
    // Links open in a new tab, as an ordinary page.
    expect(FRAME_SANDBOX.split(" ")).toEqual(expect.arrayContaining(["allow-scripts", "allow-forms", "allow-popups", "allow-popups-to-escape-sandbox"]));
    // Libraries, styles, fonts, pictures, map tiles and public APIs load over https and nothing else.
    const policy = Object.fromEntries(FRAME_CSP.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));
    for (const d of ["script-src", "style-src", "img-src", "font-src", "media-src", "connect-src", "frame-src"]) expect(policy[d], d).toContain("https:");
    expect(FRAME_CSP).not.toMatch(/\shttp:|\sws:|\s\*/);
    expect(policy["base-uri"]).toEqual(["'none'"]);
    expect(policy["form-action"]).toEqual(["'none'"]);
    expect(policy["frame-ancestors"]).toEqual(["'self'"]);
    expect(frame.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    const body = await frame.text();
    expect(body.indexOf("window.kloru")).toBeGreaterThan(-1);
    expect(body.indexOf("window.kloru")).toBeLessThan(body.indexOf('kloru.list("items")'));
    expect((await c.get(`/a/${APP}/app?k=wrong`)).status).toBe(403);
    expect((await c.get(`/a/${APP}/app`)).status).toBe(403);
  });

  it("the family add to and tick off one list: each record says who added it, and every change moves rev", async () => {
    const c = await start();
    const cleo = c.as(await c.signedIn(CLEO, "Cleo"));
    const ezra = c.as(await c.signedIn(EZRA, "Ezra"));
    expect((await cleo.rev()).json).toEqual({ rev: 0, version: 1 });
    const milk = await cleo.put("items", { name: "Milk", done: false });
    expect(milk).toMatchObject({ status: 200, json: { record: { name: "Milk", by: "Cleo" } } });
    const ticked = await ezra.put("items", { ...milk.json.record, done: true });
    expect(ticked.json.record).toMatchObject({ id: milk.json.record.id, done: true, by: "Cleo" });
    expect((await ezra.list("items")).json.records).toHaveLength(1);
    expect((await ezra.rev()).json.rev).toBe(2);
    expect((await ezra.remove("items", milk.json.record.id)).json).toEqual({ ok: true });
    expect((await cleo.list("items")).json.records).toEqual([]);
    expect((await cleo.put("Items!", { a: 1 })).status).toBe(400);
    expect((await cleo.put("items", { note: "x".repeat(17_000) })).status).toBe(413);
  });

  it("a write needs the key the shell page was given: another site, with only the cookie, can't write", async () => {
    const c = await start();
    const cleo = await c.signedIn(CLEO, "Cleo");
    expect((await c.as({ cookie: cleo.cookie }).put("items", { name: "Milk" })).status).toBe(403);
    expect((await c.as({ cookie: cleo.cookie, key: "wrong" }).put("items", { name: "Milk" })).status).toBe(403);
    expect((await c.as({ cookie: cleo.cookie }).remove("items", "x")).status).toBe(403);
    expect((await c.as(cleo).put("items", { name: "Milk" })).status).toBe(200);
  });

  it("visitors: add lets a guest in to add entries and see only their own; the family sees them all", async () => {
    const c = await start("add");
    const shell = await (await c.get(`/a/${APP}`)).text();
    expect(c.attr(shell, "data-visitor")).toBe("1");
    expect(JSON.parse(c.attr(shell, "name")!.replace(/&quot;/g, '"'))).toEqual({ me: null });
    const key = c.attr(shell, "data-key")!;
    const sam = c.as({ key, visitor: "s".repeat(24) });
    const ria = c.as({ key, visitor: "r".repeat(24) });
    const cleo = c.as(await c.signedIn(CLEO, "Cleo"));
    const mine = await sam.put("rsvps", { name: "Sam" });
    expect(mine).toMatchObject({ status: 200, json: { record: { name: "Sam", by: "Guest" } } });
    await cleo.put("rsvps", { name: "Cleo" });
    expect((await sam.list("rsvps")).json.records.map((r: { name: string }) => r.name)).toEqual(["Sam"]);
    expect((await ria.list("rsvps")).json.records).toEqual([]);
    expect((await ria.put("rsvps", { id: mine.json.record.id, name: "Hacked" })).status).toBe(403);
    expect((await ria.remove("rsvps", mine.json.record.id)).json).toEqual({ ok: false });
    expect((await cleo.list("rsvps")).json.records.map((r: { name: string }) => r.name)).toEqual(["Sam", "Cleo"]);
    // No key, a wrong key, or no way to tell this browser apart: no write.
    expect((await c.as({ visitor: "s".repeat(24) }).put("rsvps", { name: "x" })).status).toBe(403);
    expect((await c.as({ key }).put("rsvps", { name: "x" })).status).toBe(400);
  });

  it("visitors: all lets guests see and change everything, at most 30 changes a minute from one address", async () => {
    const c = await start("all");
    const key = c.attr(await (await c.get(`/a/${APP}`)).text(), "data-key")!;
    const sam = c.as({ key, visitor: "s".repeat(24) });
    const cleo = c.as(await c.signedIn(CLEO, "Cleo"));
    const dish = await cleo.put("dishes", { name: "Salad" });
    expect((await sam.list("dishes")).json.records).toHaveLength(1);
    expect((await sam.put("dishes", { ...dish.json.record, name: "Big salad" })).status).toBe(200);
    for (let i = 0; i < 29; i++) await sam.put("dishes", { i });
    expect((await sam.put("dishes", { name: "one too many" })).status).toBe(429);
    expect((await cleo.put("dishes", { name: "the family isn't limited" })).status).toBe(200);
  });

  it("a worker's test link opens the app on scratch data: nothing people entered is seen or changed", async () => {
    const c = await start();
    const cleo = c.as(await c.signedIn(CLEO, "Cleo"));
    await cleo.put("items", { name: "Milk" });
    const res = await c.get(`/a/${APP}?test=${TEST_KEY}`);
    expect(res.status).toBe(200);
    const shell = await res.text();
    expect(c.attr(shell, "data-test")).toBe("1");
    const worker = c.as({ key: c.attr(shell, "data-key")!, test: c.attr(shell, "data-key")! });
    expect((await worker.list("items")).json.records).toEqual([]);
    expect((await worker.put("items", { name: "Test eggs" })).json.record).toMatchObject({ by: "Test" });
    expect((await worker.list("items")).json.records).toHaveLength(1);
    expect((await cleo.list("items")).json.records.map((r: { name: string }) => r.name)).toEqual(["Milk"]);
    expect((await cleo.rev()).json.rev).toBe(1);
    expect((await c.get(`/a/${APP}?test=wrong`)).status).toBe(302);
    expect((await c.as({ key: "wrong", test: "wrong" }).list("items")).status).toBe(401);
  });

  it("keeps script errors for the version being served", async () => {
    const c = await start();
    const cleo = c.as(await c.signedIn(CLEO, "Cleo"));
    expect((await cleo.error("TypeError: items.map is not a function (line 6)")).status).toBe(200);
    expect((await cleo.error("from an old tab", 7)).status).toBe(200);
    expect((await c.as({}).error("not signed in")).status).toBe(401);
    // Where the agent reads them for the engineer's next look.
    expect(AppStore.openReadOnly(c.appsDbPath)!.errors(APP, 1)).toEqual(["TypeError: items.map is not a function (line 6)"]);
  });

  it("taken down, every route answers gone", async () => {
    const c = await start("all");
    const cleo = await c.signedIn(CLEO, "Cleo");
    const shell = await (await c.get(`/a/${APP}`, cleo.cookie)).text();
    revokeArtifact(c.revokedPath, APP);
    expect((await c.get(`/a/${APP}`, cleo.cookie)).status).toBe(410);
    expect((await c.get(`/a/${APP}`)).status).toBe(410);
    expect((await c.get(c.attr(shell, "src")!.replace(/&amp;/g, "&"))).status).toBe(410);
    expect((await c.get(`/a/${APP}?test=${TEST_KEY}`)).status).toBe(410);
    const browser = c.as(cleo);
    expect((await browser.list("items")).status).toBe(410);
    expect((await browser.put("items", { name: "Milk" })).status).toBe(410);
    expect((await browser.rev()).status).toBe(410);
    expect((await browser.error("x")).status).toBe(410);
  });

  it("an app can't be saved over as a page, and a page has no app routes", async () => {
    const c = await start();
    const edit = await fetch(`${c.base}/a/${APP}/edit`, { method: "POST", headers: { "content-type": "application/json", "x-csrf": "anything" }, body: JSON.stringify({ markdown: "# Mine now" }) });
    expect(edit.status).not.toBe(200);
    expect(c.repo.artifact(APP)?.html).toBe(HTML);
    expect((await c.get(`/a/${PAGE}/app`)).status).toBe(404);
    expect((await c.get(`/a/${PAGE}/data/items`)).status).toBe(404);
    expect((await c.get(`/a/${PAGE}`)).status).toBe(200); // a page still opens for anyone with the link
  });

  it("Pages lists the family's apps for everyone in it, and each person's own pages", async () => {
    const c = await start();
    const cleo = await c.signedIn(CLEO, "Cleo");
    const ezra = await c.signedIn(EZRA, "Ezra");
    const hers = await (await c.get("/pages", cleo.cookie)).text();
    expect(hers).toContain(`href="/a/${APP}"`);
    expect(hers).not.toContain("Ezra's week");
    const his = await (await c.get("/pages", ezra.cookie)).text();
    expect(his).toContain(`href="/a/${APP}"`);
    expect(his).toContain("Ezra&#39;s week");
    expect(his).toContain('href="/pages"');
    revokeArtifact(c.revokedPath, APP);
    expect(await (await c.get("/pages", cleo.cookie)).text()).not.toContain(`href="/a/${APP}"`);
    expect((await c.get("/pages")).status).toBe(302);
  });
});
