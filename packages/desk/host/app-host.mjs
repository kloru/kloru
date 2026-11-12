// One app's server: a process of its own that loads the app's server.js and answers its requests.
// Kloru's agent starts it (packages/desk/src/app-servers.ts), hands it its secrets over the pipe
// between them (never the environment of anything else), and the website sends it what arrives at
// /a/<id>/api/. Plain JavaScript with nothing to build, so it runs the same from src and dist.
//
// server.js may export either or both:
//   export default async (request, kloru) => Response   a web-standard handler (or { fetch })
//   export function listen(server, kloru)                the Node http.Server, for express, ws, anything
import { createReadStream, mkdirSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const home = process.argv[2];
const code = join(home, "code");
const dataDir = join(home, "data");
mkdirSync(dataDir, { recursive: true });

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".pdf": "application/pdf", ".woff2": "font/woff2", ".wasm": "application/wasm",
  ".geojson": "application/geo+json", ".xml": "application/xml", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".webmanifest": "application/manifest+json",
};

// Questions for the agent (the app's records, a word for the family) go over the pipe and come back by number.
const waiting = new Map();
let asked = 0;
const ask = (op, args = {}) =>
  new Promise((resolve, reject) => {
    const n = ++asked;
    waiting.set(n, { resolve, reject });
    process.send({ n, op, ...args });
  });
const words = (e) => (e && e.stack ? String(e.stack) : String(e));
const report = (e) => {
  console.error(words(e));
  try {
    process.send({ op: "error", message: String(e && e.message ? e.message : e).slice(0, 300) });
  } catch {}
};
process.on("uncaughtException", report);
process.on("unhandledRejection", report);

const MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const span = (every) => {
  if (typeof every === "number") return every;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/.exec(String(every).trim());
  if (!m) throw new Error(`kloru.every: "${every}" isn't a time like "30s", "5m", "1h" or "1d"`);
  return Number(m[1]) * MS[m[2]];
};

function makeKloru(start) {
  let db;
  return {
    /** The app's id, its address (https://…/a/<id>/api) and whether this is the scratch copy app_test runs on. */
    id: start.id,
    url: start.url,
    test: start.test,
    /** A folder that is the app's to keep files in. It is also where the process runs. */
    dir: dataDir,
    /** The vault entries the app was given, by name: a string for an API key, an object for a login. */
    secrets: start.secrets,
    /** The same records the page reads with kloru.list. */
    data: {
      list: (collection) => ask("list", { collection }),
      put: (collection, record) => ask("put", { collection, record }),
      remove: (collection, id) => ask("remove", { collection, id }),
    },
    /** The app's own SQLite database (node:sqlite), for anything the records don't fit. */
    get db() {
      if (!db) {
        const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
        db = new DatabaseSync(join(dataDir, "app.db"));
        db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      }
      return db;
    },
    /** Who sent a request: { name, id, family } as the website knows them, or null for someone not signed in. */
    user(request) {
      const h = request && request.headers;
      const raw = h && typeof h.get === "function" ? h.get("x-kloru-user") : h && h["x-kloru-user"];
      try {
        return raw ? JSON.parse(decodeURIComponent(String(raw))) : null;
      } catch {
        return null;
      }
    },
    /** Run fn now and then: kloru.every("5m", fn). What it throws is logged, and it runs again next time. */
    every(every, fn) {
      const timer = setInterval(() => Promise.resolve().then(fn).catch(report), span(every));
      return () => clearInterval(timer);
    },
    /** Tell Kloru something, in words. Kloru decides what to do with it, as with anything the family says. */
    tell: (text) => ask("tell", { text: String(text) }),
  };
}

/** A file under public/, when the request names one. */
function publicFile(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://app").pathname);
  } catch {
    return undefined;
  }
  const root = join(code, "public");
  const file = normalize(join(root, path.endsWith("/") ? `${path}index.html` : path));
  if (!file.startsWith(root + sep)) return undefined;
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** What a handler returned, as a Response: a Response, or text, or anything else as JSON. */
function asResponse(out) {
  if (out instanceof Response) return out;
  if (out === undefined || out === null) return new Response(null, { status: 204 });
  if (typeof out === "string") return new Response(out, { headers: { "content-type": "text/plain; charset=utf-8" } });
  return Response.json(out);
}

async function answer(handler, kloru, origin, req, res) {
  const file = publicFile(req);
  if (file) {
    res.writeHead(200, { "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
    return void (req.method === "HEAD" ? res.end() : createReadStream(file).pipe(res));
  }
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) headers.append(k, one);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(origin + req.url, { method: req.method, headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}) });
    const response = asResponse(await handler(request, kloru));
    const out = {};
    response.headers.forEach((v, k) => {
      if (k !== "set-cookie") out[k] = v;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(response.status, out);
    if (!response.body || req.method === "HEAD") return void res.end();
    Readable.fromWeb(response.body).on("error", () => res.destroy()).pipe(res);
  } catch (e) {
    report(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
}

async function start(m) {
  for (const [name, value] of Object.entries(m.secrets ?? {})) if (typeof value === "string") process.env[name.toUpperCase().replace(/-/g, "_")] = value;
  process.chdir(dataDir);
  const kloru = makeKloru(m);
  globalThis.kloru = kloru;
  const mod = await import(pathToFileURL(join(code, "server.js")).href);
  const server = http.createServer();
  if (typeof mod.listen === "function") await mod.listen(server, kloru);
  const handler = typeof mod.default === "function" ? mod.default : mod.default && typeof mod.default.fetch === "function" ? mod.default.fetch.bind(mod.default) : undefined;
  if (handler) server.on("request", (req, res) => void answer(handler, kloru, new URL(m.url).origin, req, res));
  else if (!server.listenerCount("request")) throw new Error("server.js answers nothing: export default async (request, kloru) => Response, or export function listen(server, kloru)");
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  process.send({ type: "ready", port: server.address().port });
}

process.on("message", (m) => {
  if (m && m.type === "start") {
    start(m).catch((e) => {
      console.error(words(e));
      process.send({ type: "failed", error: words(e).slice(0, 2000) }, () => process.exit(1));
    });
    return;
  }
  const w = m && waiting.get(m.n);
  if (!w) return;
  waiting.delete(m.n);
  if (m.ok) w.resolve(m.value);
  else w.reject(new Error(m.error || "Kloru couldn't do that"));
});
// The agent went away: so does this.
process.on("disconnect", () => process.exit(0));
