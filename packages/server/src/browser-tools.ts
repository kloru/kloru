/**
 * The browser: headless Chromium on Kloru's own machine (playwright-core, Debian's chromium), one
 * profile per person so a site stays signed in. A worker drives it with Playwright directly:
 * browser_run runs its code against this task's page, in a child process with no environment (none
 * of Kloru's keys), connected over CDP. Secrets never enter that code: fillSecret(selector, ref) asks
 * this process to fill a login's value, and only on that login's own site. Cards go in only through
 * browser_pay, within the card's own limits, recorded with the merchant, the total and the check.
 * Everything a script returns or prints is scrubbed of vault values.
 */
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { createRequire } from "node:module";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import type { Desk, Issue, Vault } from "@kloru/desk";
import { chromium, type BrowserContext, type Frame, type Page } from "playwright-core";
import { Type } from "@earendil-works/pi-ai";
import { openSteel } from "./steel.js";

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const MAX_OUT = 20_000;
const IDLE_MS = 10 * 60_000;
const CAPTCHA = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i;
const PLAYWRIGHT = pathToFileURL(createRequire(import.meta.url).resolve("playwright-core")).href;

/**
 * A browser step that can hang (a page stuck on a Cloudflare check never answers page.title(), #493):
 * it ends at its deadline, or as soon as the worker's run is stopped. Without this a stopped worker
 * waited on the page forever, and every later run on its issue waited behind it.
 */
export function bounded<T>(p: Promise<T>, ms: number, signal?: AbortSignal, what = "the browser"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    const done = () => (clearTimeout(timer), signal?.removeEventListener("abort", stop));
    const stop = () => (done(), reject(new Error("stopped")));
    const timer = setTimeout(() => (done(), reject(new Error(`${what} didn't answer within ${Math.round(ms / 1000)} s`))), ms);
    signal?.addEventListener("abort", stop, { once: true });
    p.then((v) => (done(), resolve(v)), (e: unknown) => (done(), reject(e)));
  });
}

/** The child: connects to this person's browser, finds this task's page, runs the worker's code. */
const RUNNER = `
const pw = await import(process.env.KLORU_PW);
const chromium = pw.chromium ?? pw.default.chromium;
const { readFileSync } = await import("node:fs");
const code = readFileSync(process.argv[2], "utf8");
const browser = await chromium.connectOverCDP(process.env.KLORU_CDP);
const context = browser.contexts()[0];
let page;
for (const p of context.pages()) {
  const s = await context.newCDPSession(p);
  const { targetInfo } = await s.send("Target.getTargetInfo");
  await s.detach().catch(() => {});
  if (targetInfo.targetId === process.env.KLORU_TARGET) page = p;
}
const pending = new Map();
let n = 0;
process.on("message", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
});
const fillSecret = (selector, ref) => new Promise((resolve, reject) => {
  const id = ++n;
  pending.set(id, { resolve, reject });
  process.send({ id, op: "fillSecret", selector, ref });
});
const AsyncFunction = (async () => {}).constructor;
const out = (m) => new Promise((r) => process.send(m, () => r()));
try {
  // Trying out an app: the page and the app's frame, nothing of anyone's.
  const value = process.env.KLORU_APP
    ? await new AsyncFunction("page", "app", code)(page, page.frameLocator("#kloru-app"))
    : await new AsyncFunction("page", "context", "fillSecret", code)(page, context, fillSecret);
  let text;
  try { text = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { text = String(value); }
  await out({ done: true, value: text });
} catch (e) {
  await out({ done: true, error: String((e && e.stack) || e) });
}
process.exit(0);
`;

export interface BrowserOptions {
  desk: Desk;
  vault?: Vault;
  /** Where each person's browser profile lives. */
  profilesDir: string;
  executablePath: string;
  log: (m: string) => void;
  /** Where a person adds a card or login (kloru.com/vault), for when none is saved. */
  vaultUrl?: string;
  /** The website, for takeover links (https://kloru.com). */
  publicUrl?: string;
  /** Run browsers on Steel (steel.dev) instead of this machine. */
  steelApiKey?: string;
}

/** A person finishing one step in Kloru's browser by hand, through a link only they can open. */
export interface Takeover {
  token: string;
  issue: Issue;
  reason: string;
  expires: number;
  done: boolean;
  touched: boolean;
  /** They are pressing on the tab now. */
  pressed?: boolean;
  /** How many of each thing they did reached the tab, for the log: "nothing happened" has two causes. */
  inputs: Record<string, number>;
}

/**
 * Where typing goes on the tab as it shows now: the fields of the page and of the frames in it. A
 * phone raises its keyboard only inside a tap, so the takeover page must know before the tap lands.
 */
async function typingFields(page: Page): Promise<Box[]> {
  // Runs in the tab, so it is text here: this package is not compiled against the DOM.
  const inFrame = `[...document.querySelectorAll("input, textarea, select, [contenteditable]:not([contenteditable=false])")]
    .filter((el) => el.tagName !== "INPUT" || !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"].includes(el.type))
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight)
    .slice(0, 40)
    .map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))`;
  const all = await Promise.all(
    page.frames().slice(0, 12).map(async (f) => {
      const at = f === page.mainFrame() ? { x: 0, y: 0 } : await (await f.frameElement()).boundingBox();
      return at ? ((await f.evaluate(inFrame)) as Box[]).map((b) => ({ ...b, x: b.x + Math.round(at.x), y: b.y + Math.round(at.y) })) : [];
    }).map((p) => p.catch(() => [] as Box[])),
  );
  return all.flat();
}

/**
 * What the takeover page shows and sends: a frame of the tab, and a tap, typing, a key or a scroll.
 * A press that stays down goes as it happens (down, move, up), so the tab is held for as long as
 * their finger is: Zillow's "press and hold" check got taps and stayed put (2026-11-12).
 */
export type TakeoverInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "down" | "move" | "up"; x: number; y: number }
  | { kind: "drag"; x: number; y: number; toX: number; toY: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "scroll"; dy: number; dx?: number; x?: number; y?: number }
  | { kind: "view"; width: number; height: number };
type Box = { x: number; y: number; w: number; h: number };
const TAKEOVER_MS = 10 * 60_000;
const PHONE_VIEW = { width: 430, height: 860 };
const KEYS = new Set(["Enter", "Backspace", "Delete", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export class BrowserPool {
  private readonly contexts = new Map<string, { ctx: BrowserContext; cdp: string; close: () => Promise<void>; timer?: ReturnType<typeof setTimeout> }>();
  private readonly pages = new Map<number, Page>();
  private readonly tests = new Map<number, Page>();
  constructor(private readonly o: BrowserOptions) {}

  private async contextFor(phone: string): Promise<BrowserContext> {
    const key = phone.replace(/\D/g, "");
    const have = this.contexts.get(key);
    // A Steel session ends at its time limit; then the next use starts a new one with the profile.
    if (have && have.ctx.browser()?.isConnected() !== false) {
      this.touch(key);
      return have.ctx;
    }
    if (have) await this.closeKey(key);
    const dir = join(this.o.profilesDir, key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (this.o.steelApiKey) {
      const steel = await openSteel({ apiKey: this.o.steelApiKey, dir, log: this.o.log });
      this.o.log(`browser: Steel session ${steel.sessionId} for ${key.slice(-4)}`);
      this.contexts.set(key, { ctx: steel.ctx, cdp: steel.cdp, close: steel.close });
      this.touch(key);
      return steel.ctx;
    }
    // A debugging port on localhost (written to DevToolsActivePort) lets a worker's script attach.
    rmSync(join(dir, "DevToolsActivePort"), { force: true });
    const ctx = await chromium.launchPersistentContext(dir, { executablePath: this.o.executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], viewport: { width: 1280, height: 900 } });
    this.contexts.set(key, { ctx, cdp: await devtoolsUrl(dir), close: () => ctx.close() });
    this.touch(key);
    return ctx;
  }

  /**
   * A throwaway phone-sized browser for trying out an app this task made: no profile, no sign-ins,
   * and it loads the app's own site and the public web over https, as the app's frame does; never
   * this machine or its network. Closed with the task, or after ten quiet minutes.
   */
  async attachTest(issue: Issue, origin: string): Promise<{ page: Page; cdp: string; target: string }> {
    const key = `test-${issue.id}`;
    let have = this.contexts.get(key);
    if (have && have.ctx.browser()?.isConnected() === false) {
      await this.closeKey(key);
      have = undefined;
    }
    if (!have) {
      const dir = join(this.o.profilesDir, `.${key}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tidy = () => rmSync(dir, { recursive: true, force: true });
      if (this.o.steelApiKey) {
        const steel = await openSteel({ apiKey: this.o.steelApiKey, dir, log: this.o.log, throwaway: PHONE_VIEW });
        have = { ctx: steel.ctx, cdp: steel.cdp, close: () => steel.close().finally(tidy) };
      } else {
        const ctx = await chromium.launchPersistentContext(dir, { executablePath: this.o.executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"], viewport: PHONE_VIEW, isMobile: true, hasTouch: true });
        have = { ctx, cdp: await devtoolsUrl(dir), close: () => ctx.close().finally(tidy) };
      }
      await have.ctx.route("**/*", async (route) => ((await mayLoad(route.request().url(), origin)) ? route.continue() : route.abort("blockedbyclient")));
      this.contexts.set(key, have);
    }
    this.touch(key);
    let page = this.tests.get(issue.id);
    if (!page || page.isClosed()) {
      page = have.ctx.pages()[0] ?? (await have.ctx.newPage());
      await page.setViewportSize(PHONE_VIEW).catch(() => undefined);
      this.tests.set(issue.id, page);
    }
    return { page, cdp: have.cdp, target: await targetOf(page) };
  }

  /** Close a person's browser after ten quiet minutes; the profile (and its sign-ins) stays. */
  private touch(key: string): void {
    const c = this.contexts.get(key);
    if (!c) return;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => void this.closeKey(key), IDLE_MS);
    c.timer.unref?.();
  }

  private async closeKey(key: string): Promise<void> {
    const c = this.contexts.get(key);
    this.contexts.delete(key);
    for (const [id, p] of this.pages) if (p.context() === c?.ctx) this.pages.delete(id);
    for (const [id, p] of this.tests) if (p.context() === c?.ctx) this.tests.delete(id);
    await c?.close().catch(() => undefined);
  }

  async page(issue: Issue): Promise<Page> {
    const have = this.pages.get(issue.id);
    if (have && !have.isClosed()) return have;
    const ctx = await this.contextFor(issue.filedBy.phone);
    const page = await ctx.newPage();
    this.pages.set(issue.id, page);
    return page;
  }

  /** Where a script attaches to this page's browser, and which tab is this task's. */
  async attach(issue: Issue): Promise<{ page: Page; cdp: string; target: string }> {
    const page = await this.page(issue);
    const c = this.contexts.get(issue.filedBy.phone.replace(/\D/g, ""))!;
    return { page, cdp: c.cdp, target: await targetOf(page) };
  }

  private readonly takeovers = new Map<string, Takeover>();

  /** A link for the person who asked to finish a step by hand; the tab turns phone-sized meanwhile. */
  async startTakeover(issue: Issue, reason: string): Promise<Takeover> {
    for (const [k, t] of this.takeovers) if (t.issue.id === issue.id) this.takeovers.delete(k);
    const t: Takeover = { token: randomBytes(24).toString("base64url"), issue, reason, expires: Date.now() + TAKEOVER_MS, done: false, touched: false, inputs: {} };
    this.takeovers.set(t.token, t);
    await this.existing(issue)?.setViewportSize(PHONE_VIEW).catch(() => undefined);
    return t;
  }

  /** The takeover, only for the person it's for and only while it's open. */
  takeover(token: string, phone: string): Takeover | undefined {
    const t = this.takeovers.get(token);
    const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);
    if (!t || t.done || Date.now() > t.expires || last10(t.issue.filedBy.phone) !== last10(phone)) return undefined;
    return t;
  }

  async takeoverFrame(token: string, phone: string): Promise<{ image: string; width: number; height: number; url: string; title: string; reason: string; fields: Box[] } | undefined> {
    const t = this.takeover(token, phone);
    const page = t ? this.existing(t.issue) : undefined;
    if (!t || !page) return undefined;
    const image = (await page.screenshot({ type: "jpeg", quality: 60, timeout: 10_000 })).toString("base64");
    const size = page.viewportSize() ?? PHONE_VIEW;
    return { image, width: size.width, height: size.height, url: page.url(), title: await page.title().catch(() => ""), reason: t.reason, fields: await typingFields(page) };
  }

  async takeoverInput(token: string, phone: string, e: TakeoverInput): Promise<boolean> {
    const t = this.takeover(token, phone);
    const page = t ? this.existing(t.issue) : undefined;
    if (!t || !page) return false;
    if (e.kind === "view") {
      // The tab takes the size of the screen it is shown on, so the page is laid out for that screen
      // and a tap lands where it looks. Sizing it is not yet touching it.
      const fit = (v: unknown, min: number, max: number) => Math.round(Math.max(min, Math.min(max, Number(v) || min)));
      await page.setViewportSize({ width: fit(e.width, 320, 1280), height: fit(e.height, 400, 1400) }).catch(() => undefined);
      return true;
    }
    t.touched = true;
    t.inputs[e.kind] = (t.inputs[e.kind] ?? 0) + 1;
    if (e.kind === "click") await page.mouse.click(Number(e.x), Number(e.y));
    else if (e.kind === "type") await page.keyboard.type(String(e.text).slice(0, 500));
    else if (e.kind === "key" && KEYS.has(e.key)) await page.keyboard.press(e.key);
    else if (e.kind === "down" || e.kind === "move" || e.kind === "up") {
      if (e.kind !== "down" && !t.pressed) return true;
      await page.mouse.move(Number(e.x), Number(e.y), e.kind === "move" ? { steps: 3 } : {});
      if (e.kind === "down") await page.mouse.down();
      if (e.kind === "up") await page.mouse.up();
      t.pressed = e.kind !== "up";
    } else if (e.kind === "drag") {
      await page.mouse.move(Number(e.x), Number(e.y));
      await page.mouse.down();
      await page.mouse.move(Number(e.toX), Number(e.toY), { steps: 8 });
      await page.mouse.up();
    } else if (e.kind === "scroll") {
      // A wheel turns whatever is under the pointer, and a tab nobody has tapped has no pointer:
      // on Steel the scroll then did nothing (CARTO's key form, 2026-11-12). Point first.
      const size = page.viewportSize() ?? PHONE_VIEW;
      const within = (v: unknown, max: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== null ? Math.max(0, Math.min(max - 1, Number(v))) : max / 2);
      const delta = (v: unknown) => Math.max(-2000, Math.min(2000, Number(v) || 0));
      await page.mouse.move(within(e.x, size.width), within(e.y, size.height));
      await page.mouse.wheel(delta(e.dx), delta(e.dy));
    }
    return true;
  }

  finishTakeover(token: string, phone: string): boolean {
    const t = this.takeover(token, phone);
    if (!t) return false;
    t.done = true;
    return true;
  }

  /** Until they tap Done, the challenge they were asked about is gone, or the link expires. */
  async waitTakeover(t: Takeover, page: Page, hadCaptcha: boolean): Promise<"done" | "cleared" | "expired"> {
    while (!t.done && Date.now() < t.expires) {
      await new Promise((r) => setTimeout(r, 2_000));
      if (hadCaptcha && t.touched && !(await captchaNote(page))) {
        t.done = true;
        await new Promise((r) => setTimeout(r, 1_500));
        return "cleared";
      }
    }
    this.takeovers.delete(t.token);
    this.o.log(`browser: takeover for #${t.issue.id} ${t.done ? "done" : "expired"}; reached the tab: ${Object.entries(t.inputs).map(([k, n]) => `${k} ${n}`).join(", ") || "nothing"}`);
    if (t.pressed) await page.mouse.up().catch(() => undefined);
    await page.setViewportSize({ width: 1280, height: 900 }).catch(() => undefined);
    return t.done ? "done" : "expired";
  }

  existing(issue: Issue): Page | undefined {
    const p = this.pages.get(issue.id);
    return p && !p.isClosed() ? p : undefined;
  }

  async closeIssue(issueId: number): Promise<void> {
    await this.pages.get(issueId)?.close().catch(() => undefined);
    this.pages.delete(issueId);
    if (this.contexts.has(`test-${issueId}`)) await this.closeKey(`test-${issueId}`);
  }

  async closeAll(): Promise<void> {
    for (const key of [...this.contexts.keys()]) await this.closeKey(key);
  }
}

/** The tab's id in the browser, by which a script finds it. */
async function targetOf(page: Page): Promise<string> {
  const s = await page.context().newCDPSession(page);
  const { targetInfo } = (await s.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } };
  await s.detach().catch(() => undefined);
  return targetInfo.targetId;
}

/** Whether a request stays on the app's own site (or never leaves the page: data:, blob:, about:). */
export function onSite(url: string, origin: string): boolean {
  if (/^(data|blob|about):/i.test(url)) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Addresses that are this machine, its network, or nobody's: never the public web. */
const INSIDE = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) INSIDE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) INSIDE.addSubnet(net, bits, "ipv6");

function inside(address: string): boolean {
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1];
  if (mapped && isIP(mapped) === 4) return INSIDE.check(mapped, "ipv4");
  const kind = isIP(address);
  return kind === 0 || INSIDE.check(address, kind === 4 ? "ipv4" : "ipv6");
}

const resolve = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

/**
 * Whether a browser trying out an app may make this request: the app's own site, or the public web
 * over https (a library, map tiles, an API), which is what the app's frame allows. A name that is,
 * or resolves to, an address inside is refused, so an app can't use the test to reach Kloru's network.
 */
export async function mayLoad(url: string, origin: string, lookup: (host: string) => Promise<string[]> = resolve): Promise<boolean> {
  if (onSite(url, origin)) return true;
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    return false;
  }
  if (at.protocol !== "https:" && at.protocol !== "wss:") return false;
  const host = at.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (isIP(host)) return !inside(host);
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return false;
  const found = await lookup(host).catch(() => []);
  return found.length > 0 && !found.some(inside);
}

/** Chromium writes its debugging port to DevToolsActivePort in the profile once it's listening. */
async function devtoolsUrl(dir: string): Promise<string> {
  const file = join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) {
      const port = readFileSync(file, "utf8").split("\n")[0]?.trim();
      if (port) return `http://127.0.0.1:${port}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the browser didn't open its debugging port");
}

/** The first frame (the page, then its iframes, e.g. a card form) where a selector finds something. */
async function find(page: Page, selector: string): Promise<{ frame: Frame; selector: string } | undefined> {
  // "iframe[name=card-number] >> #field": the field inside that iframe (card forms put each field in one).
  const [outer, ...rest] = selector.split(">>").map((x) => x.trim());
  if (rest.length && /^iframe\b/i.test(outer!)) {
    for (const frame of page.frames()) {
      const box = frame.locator(outer!).first();
      if (!(await box.count().catch(() => 0))) continue;
      const inner = await (await box.elementHandle().catch(() => null))?.contentFrame();
      if (inner) return find({ frames: () => [inner, ...inner.childFrames()] } as unknown as Page, rest.join(" >> "));
    }
    return undefined;
  }
  for (const frame of page.frames()) if ((await frame.locator(selector).count().catch(() => 0)) > 0) return { frame, selector };
  return undefined;
}

/**
 * A line for a page with a CAPTCHA a person must do. Only a challenge they'd see counts: a checkbox,
 * an image grid or a "verify you're human" page. The invisible reCAPTCHA badge ("protected by
 * reCAPTCHA", 256x60) asks nothing, and flagging it stopped the SFO parking checkout (2026-11-03).
 */
async function captchaNote(page: Page): Promise<string> {
  const visible = `(() => [...document.querySelectorAll("iframe")].some((f) => {
    if (!${CAPTCHA}.test((f.src || "") + " " + (f.title || "")) || f.closest(".grecaptcha-badge")) return false;
    const r = f.getBoundingClientRect(), st = getComputedStyle(f);
    return r.width > 0 && r.height > 70 && r.bottom > 0 && st.visibility !== "hidden" && st.display !== "none";
  }))()`;
  const seen = (await Promise.all(page.frames().map((f) => f.evaluate(visible).catch(() => false)))).some(Boolean);
  const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  return seen || /verify (that )?you('| a)re (a )?human|are you a robot/i.test(text)
    ? "\n\nA CAPTCHA or human check is showing on this page. Don't try to solve it: ask the person to finish this step on their phone, then continue."
    : "";
}

export function browserTools(o: BrowserOptions): { tools: RegisteredTool[]; pool: BrowserPool } {
  const pool = new BrowserPool(o);
  const issueOf = (ctx?: { conversationKey?: string }) => o.desk.issueOfKey(ctx?.conversationKey);
  const scrub = (t: string) => (o.vault ? o.vault.scrub(t) : t);
  /** Every tool call ends: at its deadline or when the run is stopped, and a tab that stopped answering is closed so the next call opens a fresh one. */
  const guard = <T>(issue: Issue, ms: number, signal: AbortSignal | undefined, f: () => Promise<T>) =>
    bounded(f(), ms, signal).catch((e: unknown) => {
      const why = e instanceof Error ? e.message : String(e);
      if (/stopped|didn't answer/.test(why)) void bounded(pool.closeIssue(issue.id), 5_000).catch(() => undefined);
      return failed(`The browser couldn't do that: ${scrub(why)}`.slice(0, 1500));
    });
  /** What page the tab is on, and whether a human check shows; a page that won't say is skipped. */
  const whereNow = async (page: Page) => `(page: ${await bounded(page.title(), 5_000).catch(() => "")} — ${page.url()})${await bounded(captchaNote(page), 10_000).catch(() => "")}`;

  /** A login's value into a field, asked for by a script: only the asker's own, only on its own site. */
  async function fillSecret(issue: Issue, page: Page, selector: string, ref: string): Promise<string> {
    const [name, field = "password"] = ref.replace(/^\{\{vault:|\}\}$/g, "").split(".");
    const e = name && o.vault ? o.vault.get(name) : undefined;
    if (!o.vault) throw new Error("The vault isn't set up here.");
    if (!e) throw new Error(`no vault entry ${name}; the ticket lists what this request may use`);
    if (e.kind === "card") throw new Error("Card details go in with browser_pay, which checks the card's limits and records the purchase.");
    if (e.kind === "api_key") throw new Error("API keys go to an API with script_run, never into a page.");
    if (!o.desk.maySecret(issue, e.owner)) {
      o.desk.recordSecret(issue, "browser_run", [e.name], false, "refused: someone else's secret");
      throw new Error(`${e.name} isn't this request's to use; ask its owner to share it.`);
    }
    const at = await find(page, selector);
    if (!at) throw new Error(`nothing on the page matches ${selector}`);
    // Judged by the frame being filled, so a page can't ask for another site's password.
    const host = hostOf(at.frame.url());
    if (e.kind === "login" && !sameSite(host, e.meta.site)) {
      o.desk.recordSecret(issue, "browser_run", [e.name], false, `refused: ${host} isn't ${e.meta.site}`, { site: host });
      throw new Error(`${e.name} is the login for ${e.meta.site}, and this field is on ${host}. If the site moved, ask the person to update the login's site in the Vault.`);
    }
    const value = o.vault.value(e.name, field);
    if (value === undefined) throw new Error(`${e.name} has no ${field}`);
    await fillField(at, value);
    o.desk.recordSecret(issue, "browser_run", [e.name], true, `typed into ${host}`, { site: host });
    return `filled ${e.name}.${field}`;
  }

  /** Run a worker's Playwright code against one tab, in a child process with none of Kloru's environment. */
  async function runScript(code: string, timeout: number, signal: AbortSignal | undefined, at: { cdp: string; target: string; app?: boolean }, fill?: (selector: string, ref: string) => Promise<string>): Promise<{ result: { value?: string; error?: string }; logs: string }> {
    const dir = mkdtempSync(join(o.profilesDir, ".run-"));
    writeFileSync(join(dir, "runner.mjs"), RUNNER);
    writeFileSync(join(dir, "code.js"), code);
    // No environment but what it needs: none of Kloru's own keys.
    const child = fork(join(dir, "runner.mjs"), [join(dir, "code.js")], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: dir, NODE_NO_WARNINGS: "1", KLORU_PW: PLAYWRIGHT, KLORU_CDP: at.cdp, KLORU_TARGET: at.target, ...(at.app ? { KLORU_APP: "1" } : {}) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
    });
    const kill = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", kill, { once: true });
    let logs = "";
    child.stdout?.on("data", (b: Buffer) => (logs += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (logs += b.toString()));
    const result = await new Promise<{ value?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => (child.kill("SIGKILL"), resolve({ error: `timed out after ${timeout / 1000} s` })), timeout);
      child.on("message", (m: { done?: boolean; value?: string; error?: string; id?: number; op?: string; selector?: string; ref?: string }) => {
        if (m.done) return clearTimeout(timer), resolve(m);
        if (m.op === "fillSecret")
          void (fill ? fill(String(m.selector), String(m.ref)) : Promise.reject(new Error("no saved logins here"))).then(
            (value) => child.send({ id: m.id, value }),
            (e: unknown) => child.send({ id: m.id, error: e instanceof Error ? e.message : String(e) }),
          );
      });
      child.on("exit", (c) => (clearTimeout(timer), resolve({ error: `the script exited (${c}) before finishing` })));
    });
    signal?.removeEventListener("abort", kill);
    child.kill();
    rmSync(dir, { recursive: true, force: true });
    return { result, logs };
  }

  const tools: RegisteredTool[] = [
    defineTool({
      name: "browser_run",
      label: "Run Playwright",
      description:
        "Drive this person's browser (signed-in sites stay signed in) with Playwright. `code` is the body of an async function given `page` (this task's tab, kept between runs), " +
        "`context`, and `fillSecret(selector, 'name.field')`, which fills a saved login's value that you never see. Return what you need, e.g. " +
        "`await page.goto(url); return await page.locator('body').ariaSnapshot()`. Cards go in with browser_pay.",
      parameters: Type.Object({
        code: Type.String({ description: "Playwright code, the body of an async function; return a value to see it" }),
        timeout_seconds: Type.Optional(Type.Number({ description: "default 60, at most 300" })),
      }),
      meta: { capabilities: ["computer.use" as const], group: "web" as const },
      execute: async ({ code, timeout_seconds }, ctx, signal) => {
        const issue = issueOf(ctx);
        if (!issue) return failed("Only desk workers use the browser.");
        const timeout = Math.min(Math.max(timeout_seconds ?? 60, 1), 300) * 1000;
        return guard(issue, timeout + 60_000, signal, async () => {
          const { page, cdp, target } = await bounded(pool.attach(issue), 30_000, signal, "the tab");
          const { result, logs } = await runScript(code, timeout, signal, { cdp, target }, (selector, ref) => fillSecret(issue, page, selector, ref));
          if (signal?.aborted) throw new Error("stopped");
          const where = `\n\n${await whereNow(page)}`;
          const body = scrub(`${result.error ? `Error: ${result.error}` : result.value || "(returned nothing)"}${logs.trim() ? `\n\nconsole:\n${logs.trim()}` : ""}`).slice(0, MAX_OUT);
          return result.error ? failed(body + scrub(where)) : textResult(body + scrub(where));
        });
      },
    }),
    defineTool({
      name: "app_test",
      label: "Try an app",
      description:
        "Try an app you made, in a phone-sized browser, before you send its link. It opens the app fresh on scratch data (nothing people entered is seen or changed), then runs `code`: the body of an async function given `app` (the app, a Playwright frame locator) and `page`. Use it like a person would and return what you see, e.g. " +
        "`await app.getByPlaceholder('Add an item').fill('Milk'); await app.getByRole('button', { name: 'Add' }).click(); return await app.locator('body').ariaSnapshot()`. The result ends with any script errors the app threw.",
      parameters: Type.Object({
        id: Type.String({ description: "the app id" }),
        code: Type.String({ description: "Playwright code, the body of an async function; return a value to see it" }),
        timeout_seconds: Type.Optional(Type.Number({ description: "default 60, at most 300" })),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id, code, timeout_seconds }, ctx, signal) => {
        const issue = issueOf(ctx);
        if (!issue) return failed("Only desk workers try apps.");
        const link = o.desk.appTestUrl(id, issue.filedBy.phone);
        if (!link.ok) return failed(link.error);
        const timeout = Math.min(Math.max(timeout_seconds ?? 60, 1), 300) * 1000;
        return guard(issue, timeout + 90_000, signal, async () => {
          const { page, cdp, target } = await bounded(pool.attachTest(issue, new URL(link.value).origin), 45_000, signal, "the browser");
          await bounded(page.goto(link.value, { waitUntil: "load" }), 30_000, signal, "the app");
          await bounded(page.frameLocator("#kloru-app").locator("body").waitFor({ state: "attached" }), 20_000, signal, "the app's frame");
          const { result, logs } = await runScript(code, timeout, signal, { cdp, target, app: true });
          if (signal?.aborted) throw new Error("stopped");
          // The app reports its own script errors through its page; give the last one a moment to land.
          await new Promise((r) => setTimeout(r, 500));
          const read = o.desk.readApp(id, issue.filedBy.phone);
          const errors = read.ok ? read.value.errors : [];
          const thrown = errors.length ? `\n\nScript errors in this version:\n${errors.map((e) => `- ${e}`).join("\n")}` : "\n\nNo script errors.";
          const body = `${result.error ? `Error: ${result.error}` : result.value || "(returned nothing)"}${logs.trim() ? `\n\nconsole:\n${logs.trim()}` : ""}`.slice(0, MAX_OUT) + thrown;
          return result.error ? failed(body) : textResult(body);
        });
      },
    }),
    defineTool({
      name: "browser_takeover",
      label: "Ask them to finish a step",
      description:
        "For a step only the person can do in this tab (a CAPTCHA they'd see, a code sent to their phone, a bank's card check): texts them a link to this tab, waits until they've done it (up to 10 minutes), then you carry on with browser_run.",
      parameters: Type.Object({ reason: Type.String({ description: "what they need to do, e.g. 'SFO parking needs you to tick the I'm-not-a-robot box'" }) }),
      meta: { capabilities: ["computer.use" as const], group: "web" as const },
      execute: async ({ reason }, ctx, signal) => {
        const issue = issueOf(ctx);
        const page = issue ? pool.existing(issue) : undefined;
        if (!issue || !page) return failed("No page is open; open it with browser_run first.");
        return guard(issue, TAKEOVER_MS + 60_000, signal, async () => {
          const hadCaptcha = !!(await bounded(captchaNote(page), 10_000).catch(() => ""));
          const t = await pool.startTakeover(issue, reason);
          const url = `${(o.publicUrl ?? "https://kloru.com").replace(/\/+$/, "")}/b/${t.token}`;
          const told = o.desk.needsPerson(issue.id, `${reason}. Open ${url} on your phone (it's Kloru's browser, signed in as you), do that step, then tap Done.`);
          if (!told.ok) return failed(told.error);
          const how = await pool.waitTakeover(t, page, hadCaptcha);
          const where = await whereNow(page);
          return how === "expired"
            ? failed(scrub(`They didn't finish it within 10 minutes; the link has expired. Tell them where it stands. ${where}`))
            : textResult(scrub(`${how === "cleared" ? "The check is cleared" : "They tapped Done"}. Carry on in this tab with browser_run. ${where}`));
        });
      },
    }),
    defineTool({
      name: "browser_pay",
      label: "Pay with a saved card",
      description:
        "At checkout, fill a saved card into the payment fields (CSS selectors on the page or its card iframe). Needs the merchant, the order total in USD, and one line on what the buying-safely check found. Then place the order with browser_run.",
      parameters: Type.Object({
        card: Type.String({ description: "the card's vault name, e.g. ezra-credit-card" }),
        merchant: Type.String({ description: "who you're buying from, e.g. Uncommon Goods (uncommongoods.com)" }),
        total_usd: Type.Number({ description: "the order total shown at checkout, in USD" }),
        checked: Type.String({ description: "one line: what the buying-safely check found, e.g. 'Trustpilot 4.6 from 12k reviews; domain since 1999'" }),
        number: Type.String({ description: "selector of the card number field" }),
        exp: Type.Optional(Type.String({ description: "selector of the expiry field (MM/YY)" })),
        cvc: Type.Optional(Type.String({ description: "selector of the security code field" })),
        name: Type.Optional(Type.String({ description: "selector of the name-on-card field" })),
        zip: Type.Optional(Type.String({ description: "selector of the billing ZIP field" })),
      }),
      meta: { capabilities: ["purchase" as const], group: "web" as const, amountUsd: (a: unknown) => Number((a as { total_usd?: number }).total_usd) || undefined },
      execute: async (a, ctx, signal) => {
        const issue = issueOf(ctx);
        const page = issue ? pool.existing(issue) : undefined;
        if (!issue || !page) return failed("No page is open; open the checkout with browser_run first.");
        if (!o.vault) return failed("The vault isn't set up here.");
        const card = o.vault.get(a.card);
        if (!card || card.kind !== "card") {
          const cards = o.vault.list().filter((e) => e.kind === "card" && o.desk.maySecret(issue, e.owner)).map((e) => e.name);
          return failed(cards.length ? `No saved card ${a.card}; this request may use ${cards.join(", ")}.` : `No card is saved for this request. Leave the checkout as it is and send the person ${o.vaultUrl ?? "the Vault on kloru.com"} to add one; then you can finish.`);
        }
        const site = hostOf(page.url());
        const record = (ok: boolean, result: string) => o.desk.recordSecret(issue, "browser_pay", [a.card], ok, result, { merchant: a.merchant, site, totalUsd: a.total_usd, checked: a.checked });
        if (!o.desk.maySecret(issue, card.owner)) {
          record(false, "refused: someone else's card");
          return failed(`${a.card} isn't this request's to use; ask its owner.`);
        }
        if (!(a.total_usd > 0)) return failed("Give the order total in USD.");
        if (!a.checked.trim()) return failed("Say in one line what the buying-safely check found before paying.");
        // The card's own limits: per purchase, and per day across this card's purchases.
        const lim = card.meta.limits ?? {};
        if (lim.perPurchaseUsd !== undefined && a.total_usd > lim.perPurchaseUsd) {
          record(false, `over the card's $${lim.perPurchaseUsd} per-purchase limit`);
          return failed(`Not paid: $${a.total_usd} is over ${a.card}'s limit of $${lim.perPurchaseUsd} a purchase. Tell them, and offer another card or a smaller order.`);
        }
        if (lim.perDayUsd !== undefined) {
          const today = new Date().toISOString().slice(0, 10);
          const spent = o.desk.repo
            .ledger()
            .filter((e) => e.slug === "PURCHASE" && e.ok && e.at.startsWith(today) && (e.args as { secrets?: string[] })?.secrets?.includes(a.card))
            .reduce((n, e) => n + (Number((e.args as { totalUsd?: number }).totalUsd) || 0), 0);
          if (spent + a.total_usd > lim.perDayUsd) {
            record(false, `over the card's $${lim.perDayUsd} daily limit ($${spent} already today)`);
            return failed(`Not paid: that would take ${a.card} past its $${lim.perDayUsd} daily limit ($${spent} spent today). Tell them.`);
          }
        }
        const fields: Array<[string | undefined, string]> = [[a.number, "number"], [a.exp, "exp"], [a.cvc, "cvc"], [a.name, "name"], [a.zip, "zip"]];
        return guard(issue, 2 * 60_000, signal, async () => {
          for (const [selector, field] of fields) {
            if (!selector) continue;
            const value = o.vault!.value(a.card, field);
            if (value === undefined) continue;
            const at = await find(page, selector);
            if (!at) return failed(`Nothing on the page matches ${selector}; look again with browser_run.`);
            await fillField(at, value);
          }
          record(true, `card filled at ${site} for $${a.total_usd}`);
          return textResult(`Filled ${a.card} at ${site} for $${a.total_usd}. Check the order on the page, then place it with browser_run.`);
        });
      },
    }),
  ];
  return { tools, pool };
}

/** Debian's chromium, or a Chrome on this machine for development. */
/** Type into a field; a date picker's read-only field is set as the picker would, and the page hears the change. */
async function fillField(at: { frame: Frame; selector: string }, value: string): Promise<void> {
  const field = at.frame.locator(at.selector);
  // A dropdown: pick the option by its label (or value), matched loosely ("11:30 AM" finds "11:30 am").
  const options = await field.evaluate((el) => (el.tagName === "SELECT" ? [...(el as unknown as { options: Array<{ text: string; value: string }> }).options].map((o) => ({ text: o.text.trim(), value: o.value })) : undefined));
  if (options) {
    const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
    const want = norm(value);
    const hit = options.find((o) => norm(o.text) === want || norm(o.value) === want) ?? options.find((o) => norm(o.text).includes(want) || want.includes(norm(o.text)));
    if (!hit) throw new Error(`no option "${value}"; the options are ${options.slice(0, 30).map((o) => o.text).join(" | ")}`);
    return void (await at.frame.selectOption(at.selector, hit.value, { timeout: 10_000 }));
  }
  const readOnly = await field.evaluate((el) => (el as unknown as { readOnly?: boolean }).readOnly === true).catch(() => false);
  if (!readOnly) return void (await at.frame.fill(at.selector, value, { timeout: 10_000 }));
  await field.evaluate((el, v) => {
    const input = el as unknown as { value: string; removeAttribute(n: string): void; dispatchEvent(e: unknown): boolean };
    input.removeAttribute("readonly");
    input.value = v;
    for (const type of ["input", "change", "blur"]) input.dispatchEvent(new Event(type, { bubbles: true }));
  }, value);
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};
/** pge.com, www.pge.com and m.pge.com are one site; the stored site may be a bare host or a URL. */
export function sameSite(host: string, site: string | undefined): boolean {
  if (!host || !site) return false;
  const s = hostOf(site.includes("://") ? site : `https://${site}`).replace(/^www\./, "");
  const base = (h: string) => h.split(".").slice(-2).join(".");
  return host === s || host.endsWith(`.${s}`) || (s.includes(".") && base(host) === base(s) && !/^\d+$/.test(base(s).split(".")[1] ?? ""));
}

export function findChromium(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = [env.KLORU_CHROMIUM?.trim(), "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p));
}
