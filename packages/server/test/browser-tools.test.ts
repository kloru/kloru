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
import { browserTools, findChromium, sameSite } from "../src/browser-tools.js";

const chrome = findChromium(process.env);
const EVAN = "+14155550190";
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
    const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EVAN });
    const vault = new Vault(join(root, "secrets", "vault.json"), Buffer.alloc(32, 3).toString("base64"));
    vault.put({ name: "evan-shop-login", owner: EVAN, kind: "login", meta: { site: "127.0.0.1", username: "evan@example.com" }, secret: { password: "correct-horse-battery" }, createdBy: EVAN });
    vault.put({ name: "evan-pge-login", owner: EVAN, kind: "login", meta: { site: "pge.com", username: "evan@example.com" }, secret: { password: "pge-only-secret" }, createdBy: EVAN });
    vault.put({ name: "evan-visa", owner: EVAN, kind: "card", meta: { brand: "Visa", limits: { perPurchaseUsd: 40, perDayUsd: 100 } }, secret: { number: "4242424242424242", exp: "12/29", cvc: "123", name: "Evan", zip: "94105" }, createdBy: EVAN });
    const { tools, pool } = browserTools({ desk, vault, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
    const t = Object.fromEntries(tools.map((x) => [x.spec.name, x]));
    const { call } = desk.startCall({ callSid: "CA1", phone: EVAN, channel: "voice" });
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
      const typed = text(await run(`await fillSecret("[name=password]", "evan-shop-login.password"); return await page.inputValue("[name=password]");`));
      expect(typed).not.toContain("correct-horse-battery");
      expect(typed).toContain("{{vault:evan-shop-login.password}}");
      // Another site's password stays with that site; a card never goes in through a script.
      expect(text(await run(`return await fillSecret("[name=password]", "evan-pge-login.password");`))).toMatch(/login for pge.com/);
      expect(text(await run(`return await fillSecret("[name=cc]", "evan-visa.number");`))).toMatch(/browser_pay/);
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
      const frame = await pool.takeoverFrame(link, EVAN);
      expect(frame).toMatchObject({ width: 430, reason: "Tick the box" });
      expect(await pool.takeoverInput(link, EVAN, { kind: "click", x: 100, y: 50 })).toBe(true);
      expect(pool.finishTakeover(link, EVAN)).toBe(true);
      expect(text(await waiting)).toMatch(/They tapped Done.*tapped/s);
      await run(`await page.goto(${JSON.stringify(base)})`);
      // The script has none of Kloru's environment.
      expect(text(await run(`return process.env.KLORU_TEST_SECRET_ENV ?? "none"`))).toContain("none");
      const pay = (total: number) => t.browser_pay!.spec.execute({ card: "evan-visa", merchant: "Test Shop (127.0.0.1)", total_usd: total, checked: "local test page", number: "[name=cc]", exp: "[name=exp]", cvc: "[name=cvc]" }, ctx);
      // A card field inside its own iframe, named the way card forms do it.
      await run(`await page.setContent('<iframe name="card-number" srcdoc="<input id=secure-payment-field>"></iframe>'); await page.waitForTimeout(200);`);
      expect(text(await t.browser_pay!.spec.execute({ card: "evan-visa", merchant: "Test Shop (127.0.0.1)", total_usd: 5, checked: "local test page", number: 'iframe[name="card-number"] >> #secure-payment-field' }, ctx))).toMatch(/Filled evan-visa/);
      expect(text(await run(`return await page.frame({ name: "card-number" }).inputValue("#secure-payment-field")`))).toContain("{{vault:evan-visa.number}}");
      await run(`await page.goto(${JSON.stringify(base)})`);
      expect(text(await pay(42))).toMatch(/limit of \$40 a purchase/);
      expect(text(await pay(35))).toMatch(/Filled evan-visa/);
      expect(text(await run(`return await page.inputValue("[name=cc]")`))).not.toMatch(/4242424242424242|4242 4242/);
      const purchase = desk.repo.ledger().find((e) => e.slug === "PURCHASE" && e.ok);
      expect(desk.repo.ledger().filter((e) => e.slug === "PURCHASE" && e.ok).map((e) => (e.args as { totalUsd: number }).totalUsd)).toEqual([5, 35]);
      expect(purchase?.args).toMatchObject({ merchant: "Test Shop (127.0.0.1)", checked: "local test page" });
      expect(text(desk.repo.ledger())).not.toContain("correct-horse-battery");
    } finally {
      await pool.closeAll();
    }
  }, 90_000);
});
