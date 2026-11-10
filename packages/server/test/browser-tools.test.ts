/**
 * The browser tools on a real Chromium (this machine's Chrome, or Debian's chromium), against a
 * local page: secrets typed by reference never come back in what the page reads, card details go
 * in only through browser_pay, and the card's own limits hold. Skipped without a browser.
 */
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk, Vault, type Planner, type WorkerHost } from "@kloru/desk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bounded, browserTools, findChromium, onSite, sameSite } from "../src/browser-tools.js";

const chrome = findChromium(process.env);
const EZRA = "+14155550190";
const PAGE = `<!doctype html><title>Checkout</title><h1>Checkout: total $42.00</h1>
<form><label>Email <input name="email"></label><label>Password <input name="password" type="password"></label>
<label>Card number <input name="cc" autocomplete="cc-number"></label><label>Expiry <input name="exp" autocomplete="cc-exp"></label>
<label>CVC <input name="cvc" autocomplete="cc-csc"></label><label>Entry time <select name="entryTime" onchange="document.title='time '+this.value"><option value="1100">11:00 AM</option><option value="1130">11:30 AM</option></select></label><label>Entry date <input name="entryDate" readonly onchange="document.title='date '+this.value"></label><button type="button">Place order</button></form>`;

class Host implements WorkerHost {
  run(): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

describe("a browser step that hangs (#493: a page stuck on a Cloudflare check)", () => {
  it("ends at its deadline, or as soon as the run is stopped", async () => {
    const never = new Promise<string>(() => {});
    await expect(bounded(never, 30, undefined, "the page")).rejects.toThrow(/the page didn't answer within/);
    const stop = new AbortController();
    const waiting = bounded(never, 60_000, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toThrow(/stopped/);
    expect(await bounded(Promise.resolve("ok"), 30)).toBe("ok");
  });
});

describe("which site a login belongs to", () => {
  it("matches the site and its subdomains, not lookalikes", () => {
    expect(sameSite("www.pge.com", "pge.com")).toBe(true);
    expect(sameSite("m.pge.com", "https://www.pge.com/login")).toBe(true);
    expect(sameSite("pge.com.evil.io", "pge.com")).toBe(false);
    expect(sameSite("pge-login.com", "pge.com")).toBe(false);
    expect(sameSite("10.0.0.1", "192.168.0.1")).toBe(false);
    expect(sameSite("pge.com", undefined)).toBe(false);
  });
});

describe("where an app being tried out may load from", () => {
  it("its own site and what never leaves the page, nothing else", () => {
    expect(onSite("https://kloru.com/a/abc?test=k", "https://kloru.com")).toBe(true);
    expect(onSite("data:image/png;base64,AAAA", "https://kloru.com")).toBe(true);
    expect(onSite("about:blank", "https://kloru.com")).toBe(true);
    expect(onSite("https://kloru.com.evil.io/x", "https://kloru.com")).toBe(false);
    expect(onSite("http://kloru.com/a/abc", "https://kloru.com")).toBe(false);
    expect(onSite("not a url", "https://kloru.com")).toBe(false);
  });
});

describe.skipIf(!chrome)("trying an app in a throwaway phone-sized browser (app_test, #43)", () => {
  const APP = `<h1>Groceries</h1><input placeholder="Add an item"><button>Add</button><ul></ul><img src="https://example.com/leak.png">
<script>document.querySelector("button").onclick = () => { const li = document.createElement("li"); li.textContent = document.querySelector("input").value + " @" + innerWidth; document.querySelector("ul").append(li); };</script>`;
  let server: http.Server;
  let base = "";
  const asked: string[] = [];
  beforeAll(async () => {
    server = http.createServer((q, r) => {
      asked.push(q.url ?? "");
      r.setHeader("content-type", "text/html");
      r.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><iframe id="kloru-app" style="border:0;width:100vw;height:100vh" srcdoc="${APP.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("opens the app's test link fresh, hands the script the app, and reports what it threw; a member's task can use it", async () => {
    const CLEO = "+14155550191";
    const root = mkdtempSync(join(tmpdir(), "app-test-"));
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EZRA, artifactBaseUrl: `${base}/a/`, appErrors: () => ["ReferenceError: qty is not defined (line 3)"] });
    const { tools, pool } = browserTools({ desk, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
    const t = Object.fromEntries(tools.map((x) => [x.spec.name, x]));
    expect(t.app_test!.spec.meta?.capabilities).toEqual([]);
    const { call } = desk.startCall({ callSid: "CA1", phone: CLEO, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Make us a shared grocery list");
    const ctx = { conversationKey: `desk:issue:${issue.id}:engineer` } as never;
    const made = desk.publishApp(issue.id, "Grocery list", APP);
    if (!made.ok) throw new Error(made.error);
    const text = (r: unknown) => JSON.stringify(r);
    const run = (code: string) => t.app_test!.spec.execute({ id: made.value.id, code }, ctx);
    try {
      const out = text(await run(`await app.getByPlaceholder("Add an item").fill("Milk"); await app.getByRole("button", { name: "Add" }).click(); return await app.locator("li").innerText();`));
      expect(out).toContain("Milk @430"); // phone-sized
      expect(out).toContain("qty is not defined");
      expect(asked.at(-1)).toMatch(new RegExp(`^/a/${made.value.id}\\?test=[A-Za-z0-9_-]{16,}$`));
      // Each run starts from a fresh load, and the script has no saved logins or other tabs to reach.
      expect(text(await run(`return String(await app.locator("li").count()) + typeof fillSecret + typeof context`))).toContain("0undefinedundefined");
      // Nothing off the app's own site loads.
      expect(text(await run(`return await page.goto("https://example.com/").then(() => "left", () => "stayed")`))).toContain("stayed");
      expect(text(await t.app_test!.spec.execute({ id: "nope-nope-nope-nope-00", code: "return 1" }, ctx))).toMatch(/isError/);
    } finally {
      await pool.closeAll();
    }
  }, 90_000);
});

describe.skipIf(!chrome)("browser tools on a real Chromium", () => {
  let server: http.Server;
  let base = "";
  beforeAll(async () => {
    server = http.createServer((_q, r) => (r.setHeader("content-type", "text/html"), r.end(PAGE)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("runs Playwright directly; secrets go in from outside the script, cards within their limits, and nothing shows a value", async () => {
    process.env.KLORU_TEST_SECRET_ENV = "should-not-reach-scripts";
    const root = mkdtempSync(join(tmpdir(), "browser-"));
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EZRA });
    const vault = new Vault(join(root, "secrets", "vault.json"), Buffer.alloc(32, 3).toString("base64"));
    vault.put({ name: "ezra-shop-login", owner: EZRA, kind: "login", meta: { site: "127.0.0.1", username: "ezra@example.com" }, secret: { password: "correct-horse-battery" }, createdBy: EZRA });
    vault.put({ name: "ezra-pge-login", owner: EZRA, kind: "login", meta: { site: "pge.com", username: "ezra@example.com" }, secret: { password: "pge-only-secret" }, createdBy: EZRA });
    vault.put({ name: "ezra-visa", owner: EZRA, kind: "card", meta: { brand: "Visa", limits: { perPurchaseUsd: 40, perDayUsd: 100 } }, secret: { number: "4242424242424242", exp: "12/29", cvc: "123", name: "Ezra", zip: "94105" }, createdBy: EZRA });
    const { tools, pool } = browserTools({ desk, vault, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
    const t = Object.fromEntries(tools.map((x) => [x.spec.name, x]));
    const { call } = desk.startCall({ callSid: "CA1", phone: EZRA, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Buy the thing");
    const ctx = { conversationKey: `desk:issue:${issue.id}:engineer` } as never;
    const text = (r: unknown) => JSON.stringify(r);
    const run = (code: string) => t.browser_run!.spec.execute({ code }, ctx);
    try {
      expect(text(await run(`await page.goto(${JSON.stringify(base)}); return await page.locator("h1").innerText();`))).toContain("Checkout: total $42.00");
      // The page stays between runs, and plain Playwright handles dropdowns and read-only date fields.
      const picked = text(await run(`await page.selectOption("select[name=entryTime]", { label: "11:30 AM" }); await page.locator("[name=entryDate]").evaluate((e) => { e.value = "11/03/2026"; e.dispatchEvent(new Event("change")); }); return page.title();`));
      expect(picked).toContain("date 11/03/2026");
      // A login goes in from outside the script; reading it back shows only its reference.
      const typed = text(await run(`await fillSecret("[name=password]", "ezra-shop-login.password"); return await page.inputValue("[name=password]");`));
      expect(typed).not.toContain("correct-horse-battery");
      expect(typed).toContain("{{vault:ezra-shop-login.password}}");
      // Another site's password stays with that site; a card never goes in through a script.
      expect(text(await run(`return await fillSecret("[name=password]", "ezra-pge-login.password");`))).toMatch(/login for pge.com/);
      expect(text(await run(`return await fillSecret("[name=cc]", "ezra-visa.number");`))).toMatch(/browser_pay/);
      // The invisible reCAPTCHA badge asks nothing; a checkbox challenge is the person's to do.
      const badge = `<div class="grecaptcha-badge"><iframe title="reCAPTCHA" src="about:blank" width="256" height="60"></iframe></div>`;
      expect(text(await run(`await page.setContent(${JSON.stringify(badge)}); return "ok"`))).not.toMatch(/CAPTCHA or human check/);
      expect(text(await run(`await page.setContent('<iframe title="reCAPTCHA" src="about:blank" width="304" height="78"></iframe>'); return "ok"`))).toMatch(/CAPTCHA or human check/);
      await run(`await page.goto(${JSON.stringify(base)})`);
      // A takeover: they get a link, see the tab, tap it, and the worker carries on once they're done.
      await run(`await page.setContent('<button onclick="document.title=\\'tapped\\'" style="width:400px;height:200px">Tick</button>')`);
      const told: string[] = [];
      const needs = desk.needsPerson.bind(desk);
      desk.needsPerson = (id, msg) => (told.push(msg), needs(id, msg));
      const waiting = t.browser_takeover!.spec.execute({ reason: "Tick the box" }, ctx);
      await new Promise((r) => setTimeout(r, 300));
      const link = /\/b\/([A-Za-z0-9_-]+)/.exec(told[0] ?? "")?.[1] ?? "";
      expect(await pool.takeoverFrame(link, "+15555550000")).toBeUndefined();
      const frame = await pool.takeoverFrame(link, EZRA);
      expect(frame).toMatchObject({ width: 430, reason: "Tick the box" });
      expect(await pool.takeoverInput(link, EZRA, { kind: "click", x: 100, y: 50 })).toBe(true);
      expect(pool.finishTakeover(link, EZRA)).toBe(true);
      expect(text(await waiting)).toMatch(/They tapped Done.*tapped/s);
      await run(`await page.goto(${JSON.stringify(base)})`);
      // The script has none of Kloru's environment.
      expect(text(await run(`return process.env.KLORU_TEST_SECRET_ENV ?? "none"`))).toContain("none");
      const pay = (total: number) => t.browser_pay!.spec.execute({ card: "ezra-visa", merchant: "Test Shop (127.0.0.1)", total_usd: total, checked: "local test page", number: "[name=cc]", exp: "[name=exp]", cvc: "[name=cvc]" }, ctx);
      // A card field inside its own iframe, named the way card forms do it.
      await run(`await page.setContent('<iframe name="card-number" srcdoc="<input id=secure-payment-field>"></iframe>'); await page.waitForTimeout(200);`);
      expect(text(await t.browser_pay!.spec.execute({ card: "ezra-visa", merchant: "Test Shop (127.0.0.1)", total_usd: 5, checked: "local test page", number: 'iframe[name="card-number"] >> #secure-payment-field' }, ctx))).toMatch(/Filled ezra-visa/);
      expect(text(await run(`return await page.frame({ name: "card-number" }).inputValue("#secure-payment-field")`))).toContain("{{vault:ezra-visa.number}}");
      await run(`await page.goto(${JSON.stringify(base)})`);
      expect(text(await pay(42))).toMatch(/limit of \$40 a purchase/);
      expect(text(await pay(35))).toMatch(/Filled ezra-visa/);
      expect(text(await run(`return await page.inputValue("[name=cc]")`))).not.toMatch(/4242424242424242|4242 4242/);
      const purchase = desk.repo.ledger().find((e) => e.slug === "PURCHASE" && e.ok);
      expect(desk.repo.ledger().filter((e) => e.slug === "PURCHASE" && e.ok).map((e) => (e.args as { totalUsd: number }).totalUsd)).toEqual([5, 35]);
      expect(purchase?.args).toMatchObject({ merchant: "Test Shop (127.0.0.1)", checked: "local test page" });
      expect(text(desk.repo.ledger())).not.toContain("correct-horse-battery");
    } finally {
      await pool.closeAll();
    }
  }, 90_000);

  it("a run that never returns ends when the worker is stopped, not minutes later", async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-"));
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EZRA });
    const { tools, pool } = browserTools({ desk, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
    const run = tools.find((x) => x.spec.name === "browser_run")!;
    const { call } = desk.startCall({ callSid: "CA2", phone: EZRA, channel: "voice" });
    const issue = desk.fileIssue(call.id, "Read a page");
    const ctx = { conversationKey: `desk:issue:${issue.id}:engineer` } as never;
    try {
      await run.spec.execute({ code: `await page.goto(${JSON.stringify(base)})` }, ctx);
      const stop = new AbortController();
      const started = Date.now();
      const hung = run.spec.execute({ code: "await new Promise(() => {})", timeout_seconds: 300 }, ctx, stop.signal);
      setTimeout(() => stop.abort(), 500);
      expect(JSON.stringify(await hung)).toMatch(/stopped/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await pool.closeAll();
    }
  }, 60_000);
});
