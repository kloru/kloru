/**
 * The takeover page in a real browser, driving a real tab of Kloru's: the website's own page, script
 * and styles, with this test standing in for the web server between them. Skipped without a browser.
 *
 * 2026-11-12: the page had scroll buttons under the picture and a box to type in. They were missed,
 * and a CAPTCHA below the fold went unseen. The tab is now used as a page.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Desk, type Planner, type WorkerHost } from "@kloru/desk";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { takeoverPage } from "../../web/src/pages.js";
import { browserTools, findChromium } from "../src/browser-tools.js";

const chrome = findChromium(process.env);
const EZRA = "+14155550190";
const STATIC = join(import.meta.dirname, "../../web/static");
// A long page with a field at the top, as a sign-up form is.
const SITE = `<body style="margin:0"><input id="name" style="position:absolute;left:20px;top:40px;width:200px;height:30px"><div style="height:3000px"></div>` +
  // And a button to press and hold, as some "are you human" checks are.
  `<button id="hold" style="position:fixed;left:20px;top:150px;width:200px;height:60px">Press and hold</button>` +
  `<script>window.held={down:false,ms:0,clicks:0};{let t=0;const b=document.getElementById("hold");b.addEventListener("mousedown",()=>{held.down=true;t=performance.now()});addEventListener("mouseup",()=>{if(held.down)held.ms=performance.now()-t;held.down=false});b.addEventListener("click",()=>held.clicks++)}</script></body>`;

class Host implements WorkerHost {
  run(): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

describe.skipIf(!chrome)("the takeover page, used as a page (2026-11-12)", () => {
  const root = mkdtempSync(join(tmpdir(), "takeover-"));
  const desk = new Desk({ root, host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EZRA });
  const { tools, pool } = browserTools({ desk, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
  const t = Object.fromEntries(tools.map((x) => [x.spec.name, x]));
  const { call } = desk.startCall({ callSid: "CA9", phone: EZRA, channel: "voice" });
  const ctx = { conversationKey: `desk:issue:${desk.fileIssue(call.id, "Get a key").id}:engineer` } as never;
  /** What the tab itself says. What they did takes a moment to arrive, so ask until it has (expect.poll). */
  const tab = async (): Promise<{ scrollY: number; name: string; width: number; height: number }> =>
    JSON.parse(String((await t.browser_run!.spec.execute({ code: `return JSON.stringify(await page.evaluate(() => ({ scrollY, name: document.getElementById("name").value, width: innerWidth, height: innerHeight })))` }, ctx)).content[0]?.text).split("\n\n(page:")[0]!);
  let person: Browser;
  let server: http.Server;
  let link = "";
  let waiting: Promise<unknown>;

  beforeAll(async () => {
    await t.browser_run!.spec.execute({ code: `await page.setContent(${JSON.stringify(SITE)})` }, ctx);
    const told: string[] = [];
    const needs = desk.needsPerson.bind(desk);
    desk.needsPerson = (id, msg) => (told.push(msg), needs(id, msg));
    waiting = t.browser_takeover!.spec.execute({ reason: "Fill in the form" }, ctx);
    await new Promise((r) => setTimeout(r, 300));
    const token = /\/b\/([A-Za-z0-9_-]+)/.exec(told[0] ?? "")?.[1] ?? "";
    server = http.createServer(async (req, res) => {
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const path = (req.url ?? "").split("?")[0]!;
      if (path.startsWith("/static/")) return res.writeHead(200, { "content-type": path.endsWith(".css") ? "text/css" : "text/javascript" }).end(readFileSync(join(STATIC, path.slice(8))));
      if (path === `/b/${token}`) return res.writeHead(200, { "content-type": "text/html" }).end(takeoverPage(token, "key"));
      if (path === `/b/${token}/frame`) {
        const f = await pool.takeoverFrame(token, EZRA);
        return f ? json(200, f) : json(404, {});
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (path === `/b/${token}/input`) return json((await pool.takeoverInput(token, EZRA, JSON.parse(Buffer.concat(chunks).toString() || "{}"))) ? 200 : 404, {});
      if (path === `/b/${token}/done`) return json(pool.finishTakeover(token, EZRA) ? 200 : 404, {});
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    link = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b/${token}`;
    person = await chromium.launch({ executablePath: chrome!, headless: true, args: ["--no-sandbox"] });
  }, 60_000);

  afterAll(async () => {
    await person?.close();
    server?.close();
    await pool.closeAll();
  });

  it("on a phone: the tab fits the screen, a swipe scrolls it, a tap on a field brings up the keyboard and what they type goes in", async () => {
    const phone = await person.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
    await page.goto(link);
    await page.waitForFunction(() => (document.getElementById("screen") as HTMLImageElement).naturalWidth > 0);
    const room = await page.evaluate(() => ({ width: document.querySelector("main")!.clientWidth, height: document.querySelector("main")!.clientHeight, page: document.documentElement.scrollHeight - innerHeight }));
    expect(room).toMatchObject({ width: 390, page: 0 });
    await expect.poll(tab, { timeout: 10_000 }).toMatchObject({ width: 390, height: room.height });
    expect(await page.locator("footer, [data-scroll], #typing").count()).toBe(0);

    // A swipe up the picture, as on any page.
    const box = (await page.locator("#screen").boundingBox())!;
    const cdp = await phone.newCDPSession(page);
    const touch = (type: string, y?: number) => cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: y === undefined ? [] : [{ x: box.x + 200, y: box.y + y }] });
    await touch("touchStart", 500);
    for (const y of [440, 380, 320, 260, 200]) {
      await touch("touchMove", y);
      await page.waitForTimeout(120);
    }
    await touch("touchEnd");
    await expect.poll(async () => (await tab()).scrollY, { timeout: 10_000 }).toBe(300);
    // Back to the top, then a tap on the field: this page's unseen field takes the phone's keyboard.
    await touch("touchStart", 200);
    for (const y of [300, 400, 500, 600]) {
      await touch("touchMove", y);
      await page.waitForTimeout(120);
    }
    await touch("touchEnd");
    await expect.poll(async () => (await tab()).scrollY, { timeout: 10_000 }).toBe(0);
    await page.waitForTimeout(900);
    await page.touchscreen.tap(box.x + 60, box.y + 55);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("keys");
    await page.keyboard.type("Ezraa");
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await tab()).name, { timeout: 10_000 }).toBe("Ezra");
    // A tap anywhere else puts the keyboard away.
    await page.touchscreen.tap(box.x + 300, box.y + 300);
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("keys");
    await phone.close();
  }, 60_000);

  it("a press that is held is held on the tab for as long as the finger is down (2026-11-12)", async () => {
    const held = async (): Promise<{ down: boolean; ms: number; clicks: number }> =>
      JSON.parse(String((await t.browser_run!.spec.execute({ code: `return JSON.stringify(await page.evaluate(() => held))` }, ctx)).content[0]?.text).split("\n\n(page:")[0]!);
    const phone = await person.newContext({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true });
    const page = await phone.newPage();
    await page.goto(link);
    await page.waitForFunction(() => (document.getElementById("screen") as HTMLImageElement).naturalWidth > 0);
    await expect.poll(async () => (await tab()).width, { timeout: 10_000 }).toBe(390);
    const box = (await page.locator("#screen").boundingBox())!;
    const cdp = await phone.newCDPSession(page);
    const touch = (type: string, on = true) => cdp.send("Input.dispatchTouchEvent", { type: type as "touchStart", touchPoints: on ? [{ x: box.x + 100, y: box.y + 180 }] : [] });
    await touch("touchStart");
    // Down on the tab while the finger is still down here.
    await expect.poll(async () => (await held()).down, { timeout: 5_000 }).toBe(true);
    await page.waitForTimeout(1500);
    expect((await held()).down).toBe(true);
    await touch("touchEnd", false);
    await expect.poll(async () => (await held()).down, { timeout: 5_000 }).toBe(false);
    expect((await held()).ms).toBeGreaterThan(1200);
    // A quick tap is still a tap.
    await page.touchscreen.tap(box.x + 100, box.y + 180);
    await expect.poll(async () => (await held()).clicks, { timeout: 5_000 }).toBe(2);
    await phone.close();
  }, 60_000);

  it("at a desk: the wheel scrolls the tab under the pointer and the keyboard types into it; Done ends it", async () => {
    await t.browser_run!.spec.execute({ code: `await page.evaluate(() => { scrollTo(0, 0); document.getElementById("name").value = ""; })` }, ctx);
    const page = await (await person.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
    await page.goto(link);
    await page.waitForFunction(() => (document.getElementById("screen") as HTMLImageElement).naturalWidth > 0);
    await expect.poll(tab, { timeout: 10_000 }).toMatchObject({ width: 1000 });
    const box = (await page.locator("#screen").boundingBox())!;
    await page.mouse.click(box.x + 60, box.y + 55);
    await page.keyboard.type("Hi there");
    await expect.poll(async () => (await tab()).name, { timeout: 10_000 }).toBe("Hi there");
    await page.mouse.move(box.x + 400, box.y + 300);
    await page.mouse.wheel(0, 250);
    await expect.poll(async () => (await tab()).scrollY, { timeout: 10_000 }).toBe(250);
    await page.click("#done");
    await waiting;
    await page.waitForFunction(() => !document.getElementById("status")!.hidden);
    expect(await page.textContent("#status")).toContain("Kloru is carrying on");
  }, 60_000);
});
