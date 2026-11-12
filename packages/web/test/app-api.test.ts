/**
 * An app's server, reached through the website at /a/<id>/api/: the page's calls arrive as whoever
 * is using it, the world reaches only /api/public/, and the code runs in the agent's process tree.
 *
 * 2026-11-12: apps got a server side of their own.
 */
import { mkdtempSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AppServers, AppStore, Repo, type AppServer, type AppVisitors } from "@kloru/desk";
import { AgentError, type AgentClient } from "../src/agent-client.js";
import { createConsole } from "../src/server.js";
import { SESSION_COOKIE, newSession, signSession } from "../src/session.js";
import { FileStore } from "../src/store.js";

const SECRET = "session-secret";
const STATIC = fileURLToPath(new URL("../static", import.meta.url));
const EZRA = "+14155550190";
const CLEO = "+14155550191";
const APP = "Qm9vZ2xlR29vZ2xlR29vZ2";
const TEST_KEY = "dGVzdGtleXRlc3RrZXl0ZXN0";
const SERVER = `export default async (request, kloru) => {
  const url = new URL(request.url);
  if (url.pathname === "/cookie") return new Response("ok", { headers: { "set-cookie": "kloru_session=stolen; Path=/", "content-type": "text/html" } });
  if (url.pathname === "/slow") return new Response(new ReadableStream({ async start(c) { c.enqueue(new TextEncoder().encode("one\\n")); await new Promise((r) => setTimeout(r, 300)); c.enqueue(new TextEncoder().encode("two\\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  return Response.json({
    method: request.method, path: url.pathname, query: url.search, user: kloru.user(request), test: kloru.test,
    body: request.method === "GET" ? null : await request.text(),
    auth: request.headers.get("authorization"), cookie: request.headers.get("cookie"), forged: request.headers.get("x-kloru-admin"),
  }, { status: url.pathname === "/made" ? 201 : 200, headers: { "x-app": "yes" } });
};
export function listen(server) {
  server.on("upgrade", (req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n" + "hello " + req.url + "\\n");
    socket.on("data", (d) => socket.write("said " + d));
  });
}`;

let closeFn: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeFn?.();
  closeFn = undefined;
});

async function start(o: { visitors?: AppVisitors; server?: AppServer | null } = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "desk-")), "repo");
  const repo = new Repo(dir);
  const call = repo.startCall({ callSid: "CA393c42478ffcd5855c7dfd5d38fe7007", phone: EZRA, channel: "sms" });
  const issue = repo.newIssue({ request: "Make a map of my commute", filedBy: { phone: EZRA, call: call.id }, baseTurn: 0 });
  const server = o.server === null ? undefined : (o.server ?? { files: { "server.js": SERVER }, rev: 1 });
  const save = (s: AppServer | undefined) => repo.saveArtifact({ id: APP, kind: "app", title: "Commute", markdown: "", html: "<p>", ...(o.visitors ? { visitors: o.visitors } : {}), testKey: TEST_KEY, issue: issue.id, call: call.id, phone: EZRA, createdAt: "2026-11-12T18:00:00.000Z", version: 1, ...(s ? { server: s } : {}) });
  save(server);
  const store = new FileStore(mkdtempSync(join(tmpdir(), "console-srv-")));
  const appsDbPath = join(mkdtempSync(join(tmpdir(), "apps-db-")), "apps.db");
  const records = new AppStore(appsDbPath);
  const servers = new AppServers({ root: join(dirname(appsDbPath), "app-servers"), app: (id) => new Repo(dir).artifact(id), store: () => records, url: (id) => `http://localhost:8790/a/${id}/api`, log: () => {} });
  const wakes: Array<Record<string, unknown>> = [];
  const client: AgentClient = {
    call: async <T>(op: string, args: Record<string, unknown> = {}) => {
      if (op === "family.lookup") return (args.phone === CLEO ? { role: "member", name: "Cleo" } : null) as T;
      if (op === "appserver.wake") {
        wakes.push(args);
        const up = await servers.ensure(String(args.id), args.test === true);
        if (!up.ok) throw new AgentError(409, up.error);
        return up.value as T;
      }
      return null as T;
    },
  };
  const web = createConsole({ store, sessionSecret: SECRET, publicUrl: "http://localhost:8790", adminPhones: [EZRA], verifier: { start: async () => {}, check: async () => true }, clientFor: () => client, pageClient: () => client, staticDir: STATIC, deskDir: dir, revokedArtifactsPath: join(mkdtempSync(join(tmpdir(), "revoked-")), "revoked.json"), appsDbPath });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  const port = (web.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  closeFn = async () => {
    await new Promise((r) => web.close(() => r(undefined)));
    await servers.closeAll();
    records.close();
  };
  const signedIn = async (phone: string, name?: string) => {
    const user = await store.upsertUser({ phone, ...(name ? { name } : {}) });
    const s = newSession(user.id, user.phone);
    return { cookie: `${SESSION_COOKIE}=${signSession(SECRET, s)}`, key: s.csrf };
  };
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}/a/${APP}/api${path}`, { redirect: "manual", ...init });
  /** The token the shell hands the app's page for whoever is looking at it. */
  const token = async (headers: Record<string, string>) => ((await (await fetch(`${base}/a/${APP}/token`, { headers })).json()) as { token: string }).token;
  return { base, port, repo, save, servers, wakes, signedIn, api, token };
}

describe("an app's server on the website (2026-11-12)", () => {
  it("the page's calls arrive as the person using it, with the path, query and body they sent", async () => {
    const c = await start();
    const cleo = await c.signedIn(CLEO, "Cleo");
    const token = await c.token({ cookie: cleo.cookie });
    const res = await c.api("/routes/3?from=home", { method: "POST", body: "hello", headers: { authorization: `Bearer ${token}`, cookie: cleo.cookie, "x-kloru-admin": "1" } });
    expect([res.status, res.headers.get("x-app"), res.headers.get("access-control-allow-origin")]).toEqual([200, "yes", "*"]);
    expect(await res.json()).toEqual({ method: "POST", path: "/routes/3", query: "?from=home", user: { name: "Cleo", id: `u:${CLEO}`, family: true }, test: false, body: "hello", auth: null, cookie: null, forged: null });
    expect((await c.api("/made", { headers: { authorization: `Bearer ${token}` } })).status).toBe(201);
    expect(c.wakes).toEqual([{ id: APP, test: false }]);
  });

  it("someone signed in reaches it with their cookie alone; a token also goes in the address, for an image or a socket", async () => {
    const c = await start();
    const ezra = await c.signedIn(EZRA, "Ezra");
    expect(((await (await c.api("/who", { headers: { cookie: ezra.cookie } })).json()) as { user: unknown }).user).toEqual({ name: "Ezra", id: `u:${EZRA}`, family: true });
    const token = await c.token({ cookie: ezra.cookie });
    expect(await (await c.api(`/tile.png?z=3&kloru_token=${token}`)).json()).toMatchObject({ path: "/tile.png", query: "?z=3", user: { name: "Ezra" } });
  });

  it("the world reaches only /api/public/, as nobody, with its own headers", async () => {
    const c = await start();
    const res = await c.api("/routes");
    expect(res.status).toBe(401);
    expect(c.wakes).toEqual([]);
    expect((await c.api("/routes", { headers: { authorization: "Bearer forged.token" } })).status).toBe(401);
    const hook = await c.api("/public/hooks/stripe?x=1", { method: "POST", body: `{"paid":true}`, headers: { authorization: "Bearer whsec_123" } });
    expect(await hook.json()).toMatchObject({ method: "POST", path: "/public/hooks/stripe", query: "?x=1", user: null, body: `{"paid":true}`, auth: "Bearer whsec_123" });
  });

  it("a guest of an app that lets guests in is told apart, and is no one's family", async () => {
    const c = await start({ visitors: "all" });
    const token = await c.token({ "x-visitor": "v".repeat(24) });
    const { user } = (await (await c.api("/who", { headers: { authorization: `Bearer ${token}` } })).json()) as { user: { name: string; id: string; family: boolean } };
    expect(user).toMatchObject({ name: "Guest", family: false });
    expect(user.id).toMatch(/^v:/);
  });

  it("a worker's test link reaches the scratch copy", async () => {
    const c = await start();
    const token = await c.token({ "x-test": TEST_KEY });
    expect(await (await c.api("/who", { headers: { authorization: `Bearer ${token}` } })).json()).toMatchObject({ test: true, user: { name: "Test" } });
    expect(c.wakes).toEqual([{ id: APP, test: true }]);
    expect(c.servers.status(APP)).toBeUndefined();
  });

  it("a token is one app's, and stops working when it is old", async () => {
    const c = await start();
    const cleo = await c.signedIn(CLEO, "Cleo");
    const token = await c.token({ cookie: cleo.cookie });
    const [body, mac] = token.split(".");
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), n: "Ezra" })).toString("base64url");
    expect((await c.api("/who", { headers: { authorization: `Bearer ${other}.${mac}` } })).status).toBe(401);
    expect((await fetch(`${c.base}/a/${APP}/token`)).status).toBe(401);
  });

  it("what the server sends back can't set this site's cookies or run as this site", async () => {
    const c = await start();
    const ezra = await c.signedIn(EZRA);
    const res = await c.api("/cookie", { headers: { cookie: ezra.cookie } });
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("a browser's preflight is answered here, and a stream arrives as it is sent", async () => {
    const c = await start();
    const pre = await c.api("/routes", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect([pre.status, pre.headers.get("access-control-allow-origin"), pre.headers.get("access-control-allow-headers")]).toEqual([204, "*", "authorization,content-type"]);
    expect(c.wakes).toEqual([]);
    const ezra = await c.signedIn(EZRA);
    const res = await c.api("/slow", { headers: { cookie: ezra.cookie } });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("one\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("two\n");
  });

  it("a changed server is the one that answers next; one that doesn't start says so to the family only", async () => {
    const c = await start();
    const ezra = await c.signedIn(EZRA);
    await c.api("/who", { headers: { cookie: ezra.cookie } });
    c.save({ files: { "server.js": `export default () => "second"` }, rev: 2 });
    expect(await (await c.api("/who", { headers: { cookie: ezra.cookie } })).text()).toBe("second");
    c.save({ files: { "server.js": `throw new Error("no route table")` }, rev: 3 });
    const broken = await c.api("/who", { headers: { cookie: ezra.cookie } });
    expect(broken.status).toBe(502);
    expect(((await broken.json()) as { error: string }).error).toContain("no route table");
    const outside = await c.api("/public/x");
    expect(outside.status).toBe(502);
    expect(((await outside.json()) as { error: string }).error).not.toContain("no route table");
  });

  it("a socket is carried through to the server", async () => {
    const c = await start();
    const ezra = await c.signedIn(EZRA);
    const token = await c.token({ cookie: ezra.cookie });
    const got = await new Promise<string>((resolve, reject) => {
      const s = net.connect(c.port, "127.0.0.1", () => s.write(`GET /a/${APP}/api/live?room=1&kloru_token=${token} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`));
      let all = "";
      s.on("data", (d) => {
        all += d.toString();
        if (all.includes("hello /live?room=1\n") && !all.includes("said")) s.write("ping");
        if (all.includes("said ping")) (s.end(), resolve(all));
      });
      s.on("error", reject);
      setTimeout(() => reject(new Error(`no echo: ${all}`)), 5_000);
    });
    expect(got).toContain("HTTP/1.1 101");
    // Without a token, a socket outside /public/ is refused.
    const refused = await new Promise<string>((resolve) => {
      const s = net.connect(c.port, "127.0.0.1", () => s.write(`GET /a/${APP}/api/live HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`));
      let all = "";
      s.on("data", (d) => (all += d.toString()));
      s.on("close", () => resolve(all));
    });
    expect(refused).toContain("401");
  });

  it("an app with no server has nothing at /api", async () => {
    const c = await start({ server: null });
    const ezra = await c.signedIn(EZRA);
    expect((await c.api("/who", { headers: { cookie: ezra.cookie } })).status).toBe(404);
  });
});
