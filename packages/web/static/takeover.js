// Kloru's browser tab, live: a fresh frame twice a second; taps, typing, keys and scrolls go back to the tab.
(() => {
  const body = document.body;
  const token = body.dataset.token;
  const csrf = body.dataset.csrf;
  const img = document.getElementById("screen");
  const status = document.getElementById("status");
  const reason = document.getElementById("reason");
  let size = { width: 430, height: 860 };
  let ended = false;
  const end = (text) => {
    ended = true;
    status.textContent = text;
    reason.textContent = "All set";
  };
  const send = async (path, payload) => {
    if (ended) return;
    const r = await fetch(`/b/${token}/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf": csrf }, body: JSON.stringify(payload || {}) });
    if (!r.ok) end((await r.json().catch(() => ({}))).error || "This link has ended.");
    else frame();
  };
  const frame = async () => {
    if (ended) return;
    const r = await fetch(`/b/${token}/frame`, { cache: "no-store" }).catch(() => undefined);
    if (!r || !r.ok) return end("This link has ended. Kloru carries on from here.");
    const f = await r.json();
    size = { width: f.width, height: f.height };
    img.src = `data:image/jpeg;base64,${f.image}`;
    reason.textContent = f.reason;
  };
  img.addEventListener("click", (e) => {
    const box = img.getBoundingClientRect();
    send("input", { kind: "click", x: Math.round(((e.clientX - box.left) / box.width) * size.width), y: Math.round(((e.clientY - box.top) / box.height) * size.height) });
  });
  document.getElementById("typing").addEventListener("submit", (e) => {
    e.preventDefault();
    const field = document.getElementById("text");
    if (field.value) send("input", { kind: "type", text: field.value });
    field.value = "";
  });
  for (const b of document.querySelectorAll("[data-key]")) b.addEventListener("click", () => send("input", { kind: "key", key: b.dataset.key }));
  for (const b of document.querySelectorAll("[data-scroll]")) b.addEventListener("click", () => send("input", { kind: "scroll", dy: Number(b.dataset.scroll) }));
  document.getElementById("done").addEventListener("click", async () => {
    await send("done");
    end("Thanks. Kloru is carrying on; you'll get a text when it's done.");
  });
  frame();
  setInterval(frame, 700);
})();
