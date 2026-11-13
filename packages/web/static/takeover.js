// Kloru's browser tab, used as a page: taps, swipes, the wheel and the keyboard go to the tab, and
// the tab is sized to this screen. A fresh frame comes back at once after each, and twice a second otherwise.
(() => {
  const body = document.body;
  const token = body.dataset.token;
  const csrf = body.dataset.csrf;
  const main = document.querySelector("main");
  const img = document.getElementById("screen");
  const keys = document.getElementById("keys");
  const status = document.getElementById("status");
  const reason = document.getElementById("reason");
  const KEYS = ["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
  let size = { width: 430, height: 860 };
  let fields = [];
  let ended = false;
  const end = (text) => {
    ended = true;
    keys.blur();
    status.textContent = text;
    status.hidden = false;
    reason.textContent = "All set";
  };
  const post = async (path, payload) => {
    const r = await fetch(`/b/${token}/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-csrf": csrf }, body: JSON.stringify(payload || {}) }).catch(() => undefined);
    if (r && !r.ok) end((await r.json().catch(() => ({}))).error || "This link has ended.");
  };

  // Frames: one at a time, back to back for a moment after anything they do.
  let lively = 0;
  let wake = () => {};
  const stir = () => {
    lively = Date.now() + 2000;
    wake();
  };
  const frame = async () => {
    const r = await fetch(`/b/${token}/frame`, { cache: "no-store" }).catch(() => undefined);
    if (!r) return;
    if (!r.ok) return end("This link has ended. Kloru carries on from here.");
    const f = await r.json();
    size = { width: f.width, height: f.height };
    fields = f.fields || [];
    img.src = `data:image/jpeg;base64,${f.image}`;
    reason.textContent = f.reason;
  };
  const watch = async () => {
    while (!ended) {
      await frame();
      await new Promise((r) => ((wake = r), setTimeout(r, Date.now() < lively ? 100 : 700)));
    }
  };

  // What they do goes to the tab in order; typing and scrolling that pile up while one is on its way go as one.
  const queue = [];
  let sending = false;
  const send = async (input) => {
    if (ended) return;
    const last = queue[queue.length - 1];
    if (last && last.kind === "type" && input.kind === "type" && last.text.length < 400) last.text += input.text;
    else if (last && last.kind === "scroll" && input.kind === "scroll") Object.assign(last, { dx: last.dx + input.dx, dy: last.dy + input.dy });
    else if (last && (last.kind === "view" || last.kind === "move") && input.kind === last.kind) Object.assign(last, input);
    else queue.push(input);
    if (sending) return;
    sending = true;
    while (queue.length && !ended) {
      await post("input", queue.shift());
      stir();
    }
    sending = false;
  };

  // The tab is as big as the room this page has for it, so nothing is scaled and nothing is cut off.
  let fitted = "";
  let fitting;
  const fit = () => {
    const view = window.visualViewport;
    if (view) document.documentElement.style.setProperty("--h", `${Math.round(view.height)}px`);
    clearTimeout(fitting);
    fitting = setTimeout(() => {
      const want = { kind: "view", width: main.clientWidth, height: main.clientHeight };
      if (`${want.width}x${want.height}` === fitted || !want.width || !want.height) return;
      fitted = `${want.width}x${want.height}`;
      send(want);
    }, 150);
  };
  (window.visualViewport || window).addEventListener("resize", fit);

  // A point on the picture, as a point on the tab.
  const at = (e) => {
    const box = img.getBoundingClientRect();
    const scale = size.width / (box.width || size.width);
    return { x: Math.round((e.clientX - box.left) * scale), y: Math.round((e.clientY - box.top) * scale), scale };
  };
  const typesAt = (p) => fields.some((f) => p.x >= f.x && p.x <= f.x + f.w && p.y >= f.y && p.y <= f.y + f.h);

  // Taps, swipes and drags. A finger that moves scrolls; a mouse that moves with the button down drags.
  // A press that stays where it is is held on the tab from then until it lifts, and moves with it.
  const HOLD_MS = 250;
  let press;
  const lift = (to) => {
    clearTimeout(press.holding);
    clearInterval(press.showing);
    if (press.held) send({ kind: "up", x: to.x, y: to.y });
  };
  img.addEventListener("pointerdown", (e) => {
    if (e.button) return;
    e.preventDefault();
    img.setPointerCapture(e.pointerId);
    const p = (press = { id: e.pointerId, start: at(e), x: e.clientX, y: e.clientY, moved: false, held: false, touch: e.pointerType !== "mouse", speed: 0, when: e.timeStamp });
    p.holding = setTimeout(() => {
      p.held = true;
      send({ kind: "down", x: p.start.x, y: p.start.y });
      // What the tab does while it is held shows as it happens.
      p.showing = setInterval(stir, 1000);
    }, HOLD_MS);
  });
  img.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (press.held) {
      const to = at(e);
      return void send({ kind: "move", x: to.x, y: to.y });
    }
    const dx = e.clientX - press.x;
    const dy = e.clientY - press.y;
    if (!press.moved && Math.hypot(dx, dy) < 8) return;
    press.moved = true;
    clearTimeout(press.holding);
    if (!press.touch) return;
    const { scale } = at(e);
    press.speed = dy / Math.max(1, e.timeStamp - press.when);
    Object.assign(press, { x: e.clientX, y: e.clientY, when: e.timeStamp });
    send({ kind: "scroll", dx: -dx * scale, dy: -dy * scale, x: press.start.x, y: press.start.y });
  });
  img.addEventListener("pointerup", (e) => {
    if (!press || e.pointerId !== press.id) return;
    const p = press;
    const to = at(e);
    lift(to);
    press = undefined;
    if (p.held) {
      if (p.touch && typesAt(to)) keys.focus({ preventScroll: true });
    } else if (!p.moved) {
      // A phone shows its keyboard only when asked inside the tap, so ask here when the tap is on a field.
      if (p.touch && typesAt(p.start)) keys.focus({ preventScroll: true });
      else if (p.touch) keys.blur();
      send({ kind: "click", x: p.start.x, y: p.start.y });
    } else if (!p.touch) send({ kind: "drag", x: p.start.x, y: p.start.y, toX: to.x, toY: to.y });
    // A flick carries on a little after the finger lifts.
    else if (Math.abs(p.speed) > 0.4 && e.timeStamp - p.when < 80) send({ kind: "scroll", dx: 0, dy: -p.speed * 350 * to.scale, x: p.start.x, y: p.start.y });
  });
  img.addEventListener("pointercancel", () => {
    if (press) lift(press.start);
    press = undefined;
  });
  // A phone that lifts a picture to drag it takes the press away.
  img.addEventListener("dragstart", (e) => e.preventDefault());
  img.addEventListener("contextmenu", (e) => e.preventDefault());
  main.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = at(e);
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.height : 1;
      send({ kind: "scroll", dx: e.deltaX * unit * p.scale, dy: e.deltaY * unit * p.scale, x: p.x, y: p.y });
    },
    { passive: false },
  );

  // A keyboard on a desk types straight into the tab.
  document.addEventListener("keydown", (e) => {
    if (ended || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    if (e.target === keys && (e.key === "Enter" || e.key === "Backspace" || e.key.length === 1 || e.key === "Unidentified")) return;
    if (KEYS.includes(e.key)) send({ kind: "key", key: e.key });
    else if (e.key.length === 1) send({ kind: "type", text: e.key });
    else return;
    e.preventDefault();
  });
  document.addEventListener("paste", (e) => {
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    if (text) send({ kind: "type", text: text.slice(0, 2000) });
    e.preventDefault();
  });
  // A phone's keyboard types into the unseen field, and what changes there goes to the tab. The
  // field keeps one space so that Backspace has something to take.
  let typed = (keys.value = " ");
  const relay = (settled) => {
    const now = keys.value;
    let same = 0;
    while (same < typed.length && same < now.length && typed[same] === now[same]) same++;
    for (let n = typed.length - same; n > 0; n--) send({ kind: "key", key: "Backspace" });
    now.slice(same).split("\n").forEach((part, i) => {
      if (i) send({ kind: "key", key: "Enter" });
      if (part) send({ kind: "type", text: part });
    });
    typed = now;
    if (settled) typed = keys.value = " ";
  };
  keys.addEventListener("input", (e) => relay(!e.isComposing));
  keys.addEventListener("compositionend", () => relay(true));

  document.getElementById("done").addEventListener("click", async () => {
    await post("done");
    end("Thanks. Kloru is carrying on; you'll get a text when it's done.");
  });
  fit();
  watch();
})();
