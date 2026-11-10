// Kloru's side of an app, put first in its frame. The frame is sandboxed (no cookies, no network),
// so everything goes through the page around it: window.kloru asks, the shell answers.
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
  window.kloru = Object.freeze({
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
