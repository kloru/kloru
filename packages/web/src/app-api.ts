/**
 * An app's server, as the world reaches it: /a/<id>/api/… is carried to the process the agent runs
 * for that app, on this machine. The website decides who is asking and says so in one header the
 * app can trust (x-kloru-user); the app never sees this site's cookie or its tokens.
 *
 * Who may call: someone signed in (their cookie), the app's own page (a token its shell hands it,
 * since the page's frame has no cookies), a worker's test link (the scratch copy). Anyone at all
 * reaches /api/public/…, as nobody: that is where a webhook or an open page goes.
 *
 * 2026-11-12: apps got a server side of their own.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { readHost, spaceOf, type Artifact } from "@kloru/desk";
import { AgentError, type AgentClient } from "./agent-client.js";

/** Who the app's code is told is asking. */
export interface AppCaller {
  name: string;
  /** u:<phone> for the family, v:<hash> for a guest's browser, t for a worker's test. */
  id: string;
  family: boolean;
}

export interface AppApiOptions {
  secret: string;
  /** Where the agent keeps the apps' homes (host.json says which port each answers on). */
  root: string;
  publicUrl: string;
  client(): AgentClient | undefined;
  log(line: string): void;
  now?(): number;
}

/** A page keeps its token this long; its client asks for another when one is refused. */
export const APP_TOKEN_TTL_MS = 60 * 60_000;
export const API_PATH = /^\/a\/([A-Za-z0-9_-]{22})\/api(\/.*)?$/;
/** What the app's answer may do when a browser opens it on this site: run, but as no site at all. */
const ANSWER_CSP = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
/** Never passed on: this site's own credentials, and anything that claims to be from Kloru. */
const OURS = (name: string) => name === "cookie" || name === "x-test" || name === "x-visitor" || name === "x-csrf" || name === "host" || name.startsWith("x-kloru-");

interface TokenBody {
  a: string;
  n: string;
  o: string;
  f: boolean;
  t: boolean;
  e: number;
}

export interface Asking {
  who?: AppCaller;
  test: boolean;
  /** The request carried one of our tokens: it stays here. */
  token: boolean;
}

export function appApi(o: AppApiOptions) {
  const now = o.now ?? Date.now;
  const mac = (body: string) => createHmac("sha256", o.secret).update(`app-token:${body}`).digest("base64url");

  function token(app: string, who: AppCaller, test: boolean): string {
    const body = Buffer.from(JSON.stringify({ a: app, n: who.name, o: who.id, f: who.family, t: test, e: now() + APP_TOKEN_TTL_MS } satisfies TokenBody)).toString("base64url");
    return `${body}.${mac(body)}`;
  }

  function readToken(app: string, raw: string): { who: AppCaller; test: boolean } | undefined {
    const [body, sig] = raw.split(".");
    if (!body || !sig) return undefined;
    const want = mac(body);
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return undefined;
    try {
      const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenBody;
      if (t.a !== app || t.e < now()) return undefined;
      return { who: { name: t.n, id: t.o, family: t.f }, test: t.t };
    } catch {
      return undefined;
    }
  }

  /** Who a request is from: a token first (it names one app and one person), then a test key, then the session. */
  function asking(app: Artifact, req: http.IncomingMessage, url: URL, signedIn: AppCaller | undefined): Asking {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    const held = readToken(app.id, url.searchParams.get("kloru_token") ?? "") ?? (bearer ? readToken(app.id, bearer) : undefined);
    if (held) return { who: held.who, test: held.test, token: true };
    const key = String(req.headers["x-test"] ?? url.searchParams.get("test") ?? "");
    if (app.testKey && key.length === app.testKey.length && timingSafeEqual(Buffer.from(key), Buffer.from(app.testKey))) return { who: { name: "Test", id: "t", family: false }, test: true, token: false };
    return { ...(signedIn ? { who: signedIn } : {}), test: false, token: false };
  }

  /** The port the app's server answers on, started by the agent when it isn't up or isn't this version. */
  async function port(app: Artifact, test: boolean, fresh = false): Promise<{ port: number } | { error: string; status: number }> {
    const host = fresh ? undefined : readHost(o.root, spaceOf(app.id, test));
    if (host?.state === "running" && host.port && host.rev === app.server?.rev) return { port: host.port };
    const client = o.client();
    if (!client) return { error: "this Kloru has no agent to run the app's server", status: 503 };
    try {
      return await client.call<{ port: number }>("appserver.wake", { id: app.id, test });
    } catch (err) {
      o.log(`app ${app.id}: its server didn't start: ${(err as Error).message}`);
      return { error: (err as Error).message, status: err instanceof AgentError && err.status === 0 ? 504 : 502 };
    }
  }

  /** The path and query the app's code sees: what came after /api, without what was ours. */
  function inner(url: URL, rest: string | undefined): string {
    const q = new URLSearchParams(url.search);
    if (!q.has("kloru_token") && !q.has("test")) return (rest || "/") + url.search;
    q.delete("kloru_token");
    q.delete("test");
    const s = q.toString();
    return (rest || "/") + (s ? `?${s}` : "");
  }

  function forwarded(req: http.IncomingMessage, a: Asking): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || OURS(name) || HOP.has(name) || (name === "authorization" && a.token)) continue;
      out[name] = value;
    }
    const site = new URL(o.publicUrl);
    out.host = site.host;
    out["x-forwarded-host"] = site.host;
    out["x-forwarded-proto"] = site.protocol.replace(":", "");
    if (a.who) out["x-kloru-user"] = encodeURIComponent(JSON.stringify(a.who));
    return out;
  }

  const cors = (req: http.IncomingMessage): Record<string, string> => ({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": String(req.headers["access-control-request-headers"] ?? "authorization, content-type"),
    "access-control-expose-headers": "*",
    "access-control-max-age": "600",
  });

  function json(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", ...cors(req) });
    res.end(JSON.stringify(body));
  }

  /** One request, carried to the app's server and back as it comes. */
  async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL, app: Artifact | undefined, rest: string | undefined, o2: { gone: boolean; signedIn?: AppCaller }): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }
    if (o2.gone) return json(req, res, 410, { error: "this app was taken down" });
    if (!app?.server) return json(req, res, 404, { error: "this app has no server" });
    const a = asking(app, req, url, o2.signedIn);
    const open = rest === "/public" || !!rest?.startsWith("/public/");
    if (!a.who && !open) return json(req, res, 401, { error: "sign in to use this app" });
    const path = inner(url, rest);
    const headers = forwarded(req, a);

    const attempt = async (again: boolean): Promise<void> => {
      const up = await port(app, a.test, again);
      // Why it didn't start is for the people whose app it is.
      if ("error" in up) return json(req, res, up.status, { error: a.who?.family || a.test ? up.error : "this app isn't answering right now" });
      await new Promise<void>((done) => {
        let connected = false;
        const out = http.request({ host: "127.0.0.1", port: up.port, method: req.method, path, headers, agent: false }, (back) => {
          const h: Record<string, string | string[]> = {};
          for (const [name, value] of Object.entries(back.headers)) {
            if (value === undefined || HOP.has(name) || name === "set-cookie" || name.startsWith("access-control-")) continue;
            h[name] = value;
          }
          res.writeHead(back.statusCode ?? 502, { ...h, ...cors(req), "content-security-policy": ANSWER_CSP, "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow" });
          res.flushHeaders();
          back.pipe(res);
          back.on("end", done);
          back.on("error", () => (res.destroy(), done()));
        });
        // The body is sent once the server is there, so a server found gone can be started and asked again.
        out.on("socket", (s) => s.once("connect", () => ((connected = true), req.pipe(out))));
        out.on("error", (err) => {
          if (!connected && !again) return void attempt(true).then(done);
          o.log(`app ${app.id}: ${(err as Error).message}`);
          if (!res.headersSent) json(req, res, 502, { error: "this app isn't answering right now" });
          else res.destroy();
          done();
        });
        res.on("close", () => out.destroy());
      });
    };
    return attempt(false);
  }

  const refuse = (socket: Duplex, status: number, text: string) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

  /** A socket (WebSocket or anything else that upgrades), carried through byte for byte. */
  async function upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL, app: Artifact | undefined, rest: string | undefined, o2: { gone: boolean; signedIn?: AppCaller }): Promise<void> {
    if (o2.gone || !app?.server) return void refuse(socket, 404, "Not Found");
    const a = asking(app, req, url, o2.signedIn);
    if (!a.who && !(rest === "/public" || rest?.startsWith("/public/"))) return void refuse(socket, 401, "Unauthorized");
    const up = await port(app, a.test);
    if ("error" in up) return void refuse(socket, 502, "Bad Gateway");
    const there = net.connect(up.port, "127.0.0.1", () => {
      const lines = [`${req.method ?? "GET"} ${inner(url, rest)} HTTP/1.1`];
      for (const [name, value] of Object.entries({ ...forwarded(req, a), connection: "Upgrade", upgrade: String(req.headers.upgrade ?? "websocket") })) for (const v of [value].flat()) lines.push(`${name}: ${v}`);
      there.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) there.write(head);
      there.pipe(socket);
      socket.pipe(there);
    });
    there.on("error", () => (socket.writable ? refuse(socket, 502, "Bad Gateway") : socket.destroy()));
    socket.on("error", () => there.destroy());
    // Either side hanging up ends it: a socket half open is a socket nobody is using.
    for (const [one, other] of [[socket, there], [there, socket]] as const) for (const done of ["end", "close"]) one.on(done, () => other.destroy());
  }

  return { token, handle, upgrade };
}
