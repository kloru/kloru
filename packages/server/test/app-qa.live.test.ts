/**
 * QA on the real model, in the desk's own loop: an engineer played by the test ships a list whose
 * removed items come back on the next load (the grocery list of 2026-11-10), and QA has to find
 * that by using it; then the fix, and a list that was fine from the start, have to pass.
 *   set -a && . ./.instinct.env && set +a && cd packages/server && QA_MODEL=openrouter/openai/gpt-6-luna RUNS=5 npx vitest run test/app-qa.live.test.ts
 * BENCH_OUT keeps each run as a line of JSON.
 */
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chrome, key, setup } from "./apps-live.js";

const spec = process.env.QA_MODEL ?? "";
const RUNS = Number(process.env.RUNS ?? 1);
const ITEMS = ["Oat milk", "Sourdough", "Feta", "Bananas"];
const REQUEST = `Make us a shared grocery list app. Put these on it to start: ${ITEMS.join(", ")}.`;

/** A working list; `seed`: the items written into the script and put back on every load when they're missing. */
const list = (seed: string[]) => `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grocery list</title>
<style>body{font:17px system-ui;margin:16px}form{display:flex;gap:8px}input[type=text]{flex:1;font:inherit;padding:10px}button{font:inherit;padding:10px 14px}li{display:flex;gap:10px;align-items:center;padding:8px 0}li span{flex:1}.done span{text-decoration:line-through}ul{list-style:none;padding:0}</style>
<h1>Grocery list</h1>
<form id="add"><input type="text" id="name" aria-label="Add an item" placeholder="Add an item"><button>Add</button></form>
<ul id="items"></ul>
<script>
const SEED = ${JSON.stringify(seed)};
const ul = document.getElementById("items");
async function draw() {
  const items = await kloru.list("items");
  ul.textContent = "";
  for (const it of items) {
    const li = document.createElement("li");
    if (it.done) li.className = "done";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!it.done;
    box.setAttribute("aria-label", "Got " + it.name);
    box.onchange = async () => { await kloru.put("items", { ...it, done: box.checked }); draw(); };
    const name = document.createElement("span");
    name.textContent = it.name;
    const del = document.createElement("button");
    del.textContent = "Remove";
    del.setAttribute("aria-label", "Remove " + it.name);
    del.onclick = async () => { await kloru.remove("items", it.id); draw(); };
    li.append(box, name, del);
    ul.append(li);
  }
}
async function start() {
  const have = (await kloru.list("items")).map((i) => i.name);
  for (const name of SEED) if (!have.includes(name)) await kloru.put("items", { name, done: false });
  draw();
}
document.getElementById("add").onsubmit = async (e) => {
  e.preventDefault();
  const input = document.getElementById("name");
  const name = input.value.trim();
  if (!name) return;
  input.value = "";
  await kloru.put("items", { name, done: false });
  draw();
};
kloru.onChange(draw);
start();
</script>
`;

const idOf = (made: string) => /a\/([\w-]{22})/.exec(made)![1]!;

async function run(broken: boolean) {
  let id = "";
  const s = await setup({
    engineer: spec,
    qa: spec,
    script: async (tool, round) => {
      if (round === 0) {
        id = idOf(await tool("app_create", { title: "Grocery list", html: list(broken ? ITEMS : []) }));
        if (!broken) await tool("app_data", { id, action: "put", collection: "items", records: ITEMS.map((name) => ({ name, done: false })) });
        return `Made the grocery list with the ${ITEMS.length} items on it: ${s.desk.artifactUrl(id)}`;
      }
      // Sent back: the items leave the script and go into the store.
      await tool("app_update", { id, html: list([]) });
      await tool("app_data", { id, action: "put", collection: "items", records: ITEMS.map((name) => ({ name, done: false })) });
      return `Fixed: the starting items are in the app's data now, not in the script, so removing one stays removed. ${s.desk.artifactUrl(id)}`;
    },
  });
  try {
    const done = await s.request(REQUEST, "app");
    const notes = done.issue.thread.filter((e) => e.by === "qa" || (e.by === "system" && /QA/.test(e.text))).map((e) => e.text);
    return { rounds: done.issue.qa?.rounds ?? -1, usable: done.issue.qa?.verdict?.usable ?? null, notes, seconds: done.seconds, cost: s.spent.qa, tests: done.calls.filter((c) => c === "qa:app_test").length };
  } finally {
    await s.close();
  }
}

describe.skipIf(!key || !chrome || !spec)("QA uses an app before the PM sees it, live", () => {
  it(`${spec}: finds the items that come back and passes the fix; passes a list that works (${RUNS} runs)`, async () => {
    const results = [];
    for (let i = 0; i < RUNS; i++) {
      for (const broken of [true, false]) {
        const r = await run(broken).catch((error: unknown) => ({ rounds: -1, usable: null, notes: [error instanceof Error ? error.message : String(error)], seconds: 0, cost: 0, tests: 0 }));
        // The broken list is sent back once, for the items that come back, and its fix passes; the working one passes untouched.
        const pass = r.usable === true && (broken ? r.rounds === 1 && /back|return|reappear|again|restor|re-?add/i.test(r.notes[0] ?? "") : r.rounds === 0);
        const line = { model: spec, run: i + 1, case: broken ? "broken" : "works", pass, ...r };
        console.log(JSON.stringify(line));
        if (process.env.BENCH_OUT) appendFileSync(process.env.BENCH_OUT, `${JSON.stringify(line)}\n`);
        results.push(line);
      }
    }
    expect(results.filter((r) => !r.pass)).toEqual([]);
  }, RUNS * 1_800_000);
});
