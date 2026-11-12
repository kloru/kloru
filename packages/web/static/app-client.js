// Kloru's side of an app, put first in its frame. The frame is sandboxed (no cookies, no origin),
// so its records go through the page around it: window.kloru asks, the shell answers. Its own
// server it calls itself, with a token the shell hands it.
(() => {
  const shell = window.parent;
  const waiting = new Map();
  const listeners = [];
  let next = 0;
  let me = null;
  try {
    me = JSON.parse(window.name || "{}").me || null;
  } catch {}
  const ask = (op, args) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      shell.postMessage({ kloru: 1, id, op, ...args }, "*");
    });
  const seen = new Set();
  const report = (message) => {
    const text = String(message || "").slice(0, 300);
    if (!text || seen.has(text) || seen.size >= 20) return;
    seen.add(text);
    shell.postMessage({ kloru: 1, op: "error", message: text }, "*");
  };
  window.addEventListener("error", (e) => report(`${e.message}${e.lineno ? ` (line ${e.lineno})` : ""}`));
  window.addEventListener("unhandledrejection", (e) => report(e.reason && e.reason.message ? e.reason.message : e.reason));
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (e.source !== shell || !m || m.kloru !== 1) return;
    if (m.type === "change") {
      for (const fn of listeners) {
        try {
          Promise.resolve(fn()).catch((err) => report(err && err.message ? err.message : err));
        } catch (err) {
          report(err && err.message ? err.message : err);
        }
      }
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.resolve(m.value);
    else w.reject(new Error(m.error || "That didn't save. Try again."));
  });
  // The app's own server, at /a/<id>/api. The frame has no cookies, so each call carries a token
  // the shell hands over: it says who is using the app, for an hour.
  const api = new URL(`/a/${(/^\/a\/([^/]+)/.exec(window.location.pathname) || [])[1]}/api`, window.location.href).href;
  const url = (path) => api + (String(path || "/").startsWith("/") ? "" : "/") + String(path || "/");
  let token = null;
  const held = (fresh) => {
    if (fresh || !token) token = ask("token", {}).catch((err) => ((token = null), Promise.reject(err)));
    return token;
  };
  const link = async (path, base = api) => {
    const u = new URL(url(path).replace(api, base));
    u.searchParams.set("kloru_token", await held(false));
    return u.href;
  };
  const call = async (path, init, fresh) => {
    const o = { ...(init || {}) };
    const headers = new Headers(o.headers || {});
    headers.set("authorization", `Bearer ${await held(fresh)}`);
    // A plain object as the body goes as JSON.
    if (Object.prototype.toString.call(o.body) === "[object Object]") {
      o.body = JSON.stringify(o.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return window.fetch(url(path), { ...o, headers });
  };
  window.kloru = Object.freeze({
    /** fetch() to the app's server: kloru.fetch("/routes", { method: "POST", body: { name } }). */
    fetch: async (path, init) => {
      const res = await call(path, init, false);
      return res.status === 401 ? call(path, init, true) : res;
    },
    /** The address of a path on the app's server (what is under /public needs nothing more). */
    url,
    /** The same address with the token in it, for an <img>, a download or an EventSource. */
    link: (path) => link(path),
    /** A WebSocket to the app's server. */
    socket: async (path, protocols) => new window.WebSocket(await link(path, api.replace(/^http/, "ws")), protocols),
    /** Who is using the app: { name }, or null for a guest. */
    me,
    /** Every record in a collection, oldest first. */
    list: (collection) => ask("list", { collection }),
    /** Add a record; with record.id, replace that one. Resolves to the stored record. */
    put: (collection, record) => ask("put", { collection, record }),
    remove: (collection, id) => ask("remove", { collection, id }),
    /** Call fn whenever anyone changes the app's data. */
    onChange: (fn) => {
      if (typeof fn === "function") listeners.push(fn);
    },
  });
})();
