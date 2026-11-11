/**
 * The cases the app engineer's model is chosen on (model-selection skill). "make": a shared list
 * that starts with the family's items, then a follow-up. "fix": the grocery list of 2026-11-10,
 * where removed items come back and a tick makes a double, with the family's doubled list in it.
 * Both are checked the way the family would find out: on their phone, on their own list.
 * "chores": a chart with more to it (people, days, counts, reassigning), in the desk's whole loop:
 * QA on one fixed model (QA_MODEL) uses it and sends it back, so the measure is how often the
 * first version is usable and how many rounds the rest take.
 *   set -a && . ./.instinct.env && set +a && cd packages/server && ENGINEER_MODEL=openrouter/openai/gpt-6-luna RUNS=5 npx vitest run test/app-bench.live.test.ts
 * CASE picks some (make, fix, chores); BENCH_OUT keeps each run's checks, seconds and cost as a line of JSON.
 */
import { appendFileSync } from "node:fs";
import type { AppRecord } from "@kloru/desk";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { describe, expect, it } from "vitest";
import { chrome, key, setup } from "./apps-live.js";

const spec = process.env.ENGINEER_MODEL ?? "";
const RUNS = Number(process.env.RUNS ?? 1);
const ITEMS = ["Oat milk", "Sourdough", "Cherry tomatoes", "Feta", "Coffee beans", "Dish soap", "Bananas", "Greek yogurt"];
const has = (text: string, item: string) => text.toLowerCase().includes(item.toLowerCase());
const CASES = (process.env.CASE ?? "make,fix,chores").split(",");
type Live = Awaited<ReturnType<typeof setup>>;

/** The family's phone, signed in, on the app's real data. */
async function phone(context: BrowserContext, s: Live, id: string) {
  await context.addCookies([await s.signedIn()]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const frame = page.frameLocator("#kloru-app");
  const open = async () => {
    await page.goto(s.desk.artifactUrl(id));
    await frame.locator("body").waitFor();
    await page.waitForTimeout(4000);
    return (await frame.locator("body").innerText().catch(() => "")) ?? "";
  };
  const until = async (f: () => boolean, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(250)) if (f()) return true;
    return f();
  };
  return { page, frame, open, until, errors };
}

const SEED = ["Oat milk", "Sourdough", "Feta", "Bananas", "Coffee beans"];
/** The list as it went wrong: the starting items are in the script and come back on every load, a tick saves a second record, and Remove only hides the row. */
const BROKEN = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grocery list</title>
<style>body{font:17px system-ui;margin:16px}form{display:flex;gap:8px}input[type=text]{flex:1;font:inherit;padding:10px}button{font:inherit;padding:10px 14px}li{display:flex;gap:10px;align-items:center;padding:8px 0}li span{flex:1}.done span{text-decoration:line-through}ul{list-style:none;padding:0}</style>
<h1>Grocery list</h1>
<form id="add"><input type="text" id="name" aria-label="Add an item" placeholder="Add an item"><button>Add</button></form>
<ul id="items"></ul>
<script>
const START = ${JSON.stringify(SEED)};
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
    box.onchange = async () => { await kloru.put("items", { name: it.name, done: box.checked }); draw(); };
    const name = document.createElement("span");
    name.textContent = it.name;
    const del = document.createElement("button");
    del.textContent = "Remove";
    del.setAttribute("aria-label", "Remove " + it.name);
    del.onclick = () => { li.remove(); kloru.remove("items", it.name).catch(() => {}); };
    li.append(box, name, del);
    ul.append(li);
  }
}
async function start() {
  const have = (await kloru.list("items")).map((i) => i.name);
  for (const name of START) if (!have.includes(name)) await kloru.put("items", { name, done: false });
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

async function fix(browser: Browser) {
  const s = await setup({ engineer: spec });
  const { desk, store } = s;
  const checks: Record<string, boolean> = {};
  const began = Date.now();
  try {
    const app = await s.plant("Grocery list", BROKEN);
    const cleo = { by: "Cleo", owner: "u:+14155550191" };
    // What the family's list looks like after a week of this.
    for (const [name, done] of [["Oat milk", false], ["Sourdough", false], ["Feta", false], ["Bananas", false], ["Coffee beans", false], ["Oat milk", true], ["Paprika", false], ["Feta", true], ["Oat milk", true]] as const) store.put(app.id, "items", { name, done }, cleo);
    const names = [...SEED, "Paprika"];
    const records = (): AppRecord[] => store.collections(app.id).flatMap((c) => store.list(app.id, c.collection));
    const named = (item: string) => records().filter((r) => has(JSON.stringify(r), item));

    const done = await s.request("Deleting things from the grocery list doesn't work: they come back. And ticking something off makes it show up twice. Fix it, and clean up the doubles that are on the list now.", "app", app.issue);
    const now = desk.repo.artifact(app.id)!;
    checks.changed = done.issue.status === "in_review" && desk.repo.artifacts().filter((a) => a.kind === "app").length === 1 && (now.version ?? 1) > 1;
    checks.deduped = names.every((n) => named(n).length === 1);

    const context = await browser.newContext({ viewport: { width: 430, height: 860 }, isMobile: true, hasTouch: true });
    const { page, frame, open, until, errors } = await phone(context, s, app.id);
    page.on("dialog", (d) => void d.accept());
    const shown = await open();
    checks.shown = names.every((n) => has(shown, n));
    const row = (item: string) => frame.locator("li, tr, [role=listitem]").filter({ hasText: item }).last();

    // Removing on the phone removes it, and it stays removed.
    const remove = frame.getByRole("button", { name: /(remove|delete).*sourdough/i }).first();
    if (await remove.count()) await remove.click({ timeout: 3000 }).catch(() => {});
    else await row("Sourdough").getByRole("button").last().click({ timeout: 3000 }).catch(() => {});
    checks.removes = await until(() => named("Sourdough").length === 0);
    await open();
    await open();
    checks.staysGone = named("Sourdough").length === 0;

    // A tick changes the one record, and is still there after a reload.
    const before = JSON.stringify(named("Bananas")[0] ?? {});
    await row("Bananas").locator('input[type="checkbox"], [role="checkbox"]').first().click({ timeout: 3000 }).catch(() => {});
    const ticked = () => named("Bananas").length === 1 && JSON.stringify(named("Bananas")[0]) !== before;
    checks.ticks = await until(ticked);
    await open();
    checks.tickStays = ticked() && names.filter((n) => n !== "Sourdough").every((n) => named(n).length === 1) && records().length === names.length - 1;
    checks.noErrors = errors.length === 0 && store.errors(app.id, now.version ?? 1).length === 0;
    await context.close();
    return { checks, seconds: Math.round((Date.now() - began) / 1000), cost: s.spent.engineer, versions: now.version ?? 1 };
  } finally {
    await s.close();
  }
}

async function chores(browser: Browser) {
  const s = await setup({ engineer: spec, qa: process.env.QA_MODEL ?? "openrouter/openai/gpt-6.1-terra" });
  const { desk, store } = s;
  const checks: Record<string, boolean> = {};
  const began = Date.now();
  try {
    const made = await s.request(
      "Make us a chore chart app for this week. Chores: Dishes, Trash, Laundry, Vacuum, Feed the cat. People: Ezra, Cleo, Sam. " +
        "Each chore on each day belongs to one person; tapping it marks it done, and tapping again undoes it. Show how many each person has done this week, and let us give a chore on a day to someone else. " +
        "Start it with Dishes for Cleo every day, Trash for Sam on Monday and Thursday, and Laundry for Ezra on Saturday.",
      "app",
    );
    const apps = desk.repo.artifacts().filter((a) => a.kind === "app");
    const app = apps[0];
    checks.made = made.issue.status === "in_review" && apps.length === 1;
    if (!app) return { checks, seconds: made.seconds, cost: s.spent.engineer, error: made.issue.thread.at(-1)?.text ?? "" };
    const data = JSON.stringify(store.collections(app.id).flatMap((c) => store.list(app.id, c.collection)));
    checks.seeded = ["Dishes", "Trash", "Laundry", "Cleo", "Sam", "Ezra"].every((w) => has(data, w));
    const context = await browser.newContext({ viewport: { width: 430, height: 860 }, isMobile: true, hasTouch: true });
    const { frame, open, errors } = await phone(context, s, app.id);
    const shown = await open();
    checks.shown = ["Dishes", "Trash", "Laundry", "Cleo", "Sam", "Ezra"].every((w) => has(shown, w));
    checks.noErrors = errors.length === 0 && store.errors(app.id, app.version ?? 1).length === 0;
    checks.fits = await frame.locator("html").evaluate((e) => e.scrollWidth <= e.clientWidth + 1).catch(() => false);
    await context.close();
    const qa = made.issue.qa;
    checks.usable = qa?.verdict?.usable === true;
    const sentBack = made.issue.thread.filter((e) => e.by === "qa" && e.text.startsWith("Sent back")).map((e) => e.text.slice(0, 400));
    return { checks, firstTry: checks.usable && (qa?.rounds ?? 0) === 0, rounds: qa?.rounds ?? -1, seconds: Math.round((Date.now() - began) / 1000), cost: s.spent.engineer, qaCost: s.spent.qa, versions: app.version ?? 1, sentBack };
  } finally {
    await s.close();
  }
}

async function make(browser: Browser) {
  const { desk, store, request, spent, signedIn, close } = await setup({ engineer: spec });
  const checks: Record<string, boolean> = {};
  const began = Date.now();
  try {
    const records = (id: string): AppRecord[] => store.collections(id).flatMap((c) => store.list(id, c.collection));
    const holds = (id: string, item: string) => records(id).some((r) => has(JSON.stringify(r), item));
    const apps = () => desk.repo.artifacts().filter((a) => a.kind === "app");

    const made = await request(`Make us a shared grocery list app. Put these on it to start: ${ITEMS.join(", ")}.`, "app");
    checks.made = made.issue.status === "in_review" && apps().length === 1;
    const app = apps()[0];
    if (!app) return { checks, seconds: Math.round((Date.now() - began) / 1000), cost: spent.engineer, error: made.issue.thread.at(-1)?.text ?? "" };
    checks.seeded = ITEMS.every((i) => holds(app.id, i)) && records(app.id).length === ITEMS.length;
    checks.notInFile = ITEMS.filter((i) => has(app.html ?? "", i)).length <= 1;

    // The family's phone, signed in, on the real list.
    const context = await browser.newContext({ viewport: { width: 430, height: 860 }, isMobile: true, hasTouch: true });
    await context.addCookies([await signedIn()]);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const frame = page.frameLocator("#kloru-app");
    const open = async () => {
      await page.goto(desk.artifactUrl(app.id));
      await frame.locator("body").waitFor();
      await page.waitForTimeout(4000);
      return (await frame.locator("body").innerText().catch(() => "")) ?? "";
    };
    const until = async (f: () => boolean, ms = 5000) => {
      for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(250)) if (f()) return true;
      return f();
    };
    const shown = await open();
    checks.shown = ITEMS.every((i) => has(shown, i));

    // Adding from the page saves.
    const input = frame.locator('input[type="text"], input:not([type]), textarea').first();
    await input.fill("Paprika").catch(() => {});
    await input.press("Enter").catch(() => {});
    if (!(await until(() => holds(app.id, "Paprika"), 2500))) {
      await frame.locator('button[type="submit"], button:has-text("Add"), button:has-text("+")').first().click({ timeout: 3000 }).catch(() => {});
    }
    checks.adds = await until(() => holds(app.id, "Paprika"));

    // Something taken off the list stays off, and opening the list again adds nothing.
    for (const c of store.collections(app.id)) for (const r of store.list(app.id, c.collection)) if (has(JSON.stringify(r), "Feta")) store.remove(app.id, c.collection, r.id);
    const before = records(app.id).length;
    await open();
    await open();
    checks.staysGone = !holds(app.id, "Feta") && records(app.id).length === before;
    checks.noErrors = errors.length === 0 && store.errors(app.id, app.version ?? 1).length === 0;

    const changed = await request("Add a store field to the grocery list, so we can say which store each item is from.", "app", made.issue.id);
    const now = apps()[0]!;
    checks.changed = changed.issue.status === "in_review" && apps().length === 1 && now.id === app.id && (now.version ?? 1) > (app.version ?? 1) && /store/i.test(now.html ?? "");
    const after = await open();
    checks.kept = ITEMS.filter((i) => i !== "Feta").every((i) => holds(app.id, i) && has(after, i)) && !holds(app.id, "Feta");
    await context.close();
    return { checks, seconds: Math.round((Date.now() - began) / 1000), cost: spent.engineer, versions: now.version ?? 1 };
  } finally {
    await close();
  }
}

describe.skipIf(!key || !chrome || !spec)("the app engineer's model, making apps and fixing one", () => {
  it(`${spec}: ${RUNS} runs`, async () => {
    const browser = await chromium.launch({ executablePath: chrome!, headless: true });
    const results = [];
    try {
      for (let i = 0; i < RUNS * CASES.length; i++) {
        const which = CASES[i % CASES.length]!;
        const r = await (which === "fix" ? fix : which === "chores" ? chores : make)(browser).catch((error: unknown) => ({ checks: { ran: false }, seconds: 0, cost: 0, error: error instanceof Error ? error.message : String(error) }));
        const line = { model: spec, case: which, run: Math.floor(i / CASES.length) + 1, pass: Object.values(r.checks).every(Boolean) && Object.keys(r.checks).length >= 6, ...r };
        console.log(JSON.stringify(line));
        if (process.env.BENCH_OUT) appendFileSync(process.env.BENCH_OUT, `${JSON.stringify(line)}\n`);
        results.push(line);
      }
    } finally {
      await browser.close();
    }
    expect(results.filter((r) => !r.pass)).toEqual([]);
  }, RUNS * CASES.length * 1_200_000);
});
