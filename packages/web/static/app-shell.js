// The page around an app. The app's frame can't reach the network, so it asks here, and this
// script asks the server for that one app's data, as whoever is looking at it.
(() => {
  const frame = document.getElementById("kloru-app");
  if (!frame) return;
  const { app, key, version } = frame.dataset;
  const base = `/a/${app}`;
  const headers = { "x-csrf": key, "content-type": "application/json" };
  // A worker trying the app out: the same app on scratch data, by its test key.
  if (frame.dataset.test) headers["x-test"] = key;
  if (frame.dataset.visitor) {
    // A guest is told apart by a random token kept in this browser, so "their own" entries stay theirs.
    let token = "";
    try {
      token = localStorage.getItem("kloru-visitor") || "";
      if (!/^[A-Za-z0-9_-]{22,64}$/.test(token)) {
        token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        localStorage.setItem("kloru-visitor", token);
      }
    } catch {}
    if (token) headers["x-visitor"] = token;
  }
  const part = (s) => encodeURIComponent(String(s ?? ""));
  let rev = -1;

  async function call(method, path, body) {
    const res = await fetch(base + path, { method, headers, credentials: "same-origin", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await res.json().catch(() => ({}));
    if (res.status === 401) location.reload(); // signed out: the reload goes to sign-in and back
    if (!res.ok) throw new Error(json.error || "That didn't go through. Try again.");
    return json;
  }

  const tell = (message) => frame.contentWindow && frame.contentWindow.postMessage({ kloru: 1, ...message }, "*");

  async function check() {
    try {
      const now = await call("GET", "/data");
      if (String(now.version) !== String(version)) return location.reload(); // the app itself changed
      if (rev !== -1 && now.rev !== rev) tell({ type: "change" });
      rev = now.rev;
    } catch {}
  }

  window.addEventListener("message", async (e) => {
    const m = e.data;
    if (e.source !== frame.contentWindow || !m || m.kloru !== 1) return;
    if (m.op === "error") return void call("POST", "/errors", { message: String(m.message || ""), version: Number(version) }).catch(() => {});
    try {
      let value;
      if (m.op === "list") value = (await call("GET", `/data/${part(m.collection)}`)).records;
      else if (m.op === "put") value = (await call("PUT", `/data/${part(m.collection)}`, m.record)).record;
      else if (m.op === "token") value = (await call("GET", "/token")).token;
      else if (m.op === "remove") value = (await call("DELETE", `/data/${part(m.collection)}/${part(m.id)}`)).ok;
      else throw new Error("unknown request");
      tell({ id: m.id, ok: true, value });
      if (m.op !== "list" && m.op !== "token") check();
    } catch (err) {
      tell({ id: m.id, ok: false, error: err && err.message ? err.message : "That didn't go through. Try again." });
    }
  });

  check();
  setInterval(() => {
    if (document.visibilityState === "visible") check();
  }, 2000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
})();
