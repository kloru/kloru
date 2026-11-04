import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, type AgentClient } from "../src/agent-client.js";
import { createConsole, type ConsoleOptions } from "../src/server.js";
import { SESSION_COOKIE, newSession, signSession } from "../src/session.js";
import { FileStore } from "../src/store.js";
import { MediaStore, Memory, Repo } from "@kloru/desk";
import { type PhoneVerifier, VerifyError } from "../src/verify.js";

const SECRET = "session-secret";
const STATIC = fileURLToPath(new URL("../static", import.meta.url));
const ADMIN = "+14155550190";

type Handler = (args: Record<string, unknown>) => unknown;
class FakeClient implements AgentClient {
  calls: Array<[string, Record<string, unknown>]> = [];
  constructor(public handlers: Record<string, Handler> = {}) {}
  async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push([op, args]);
    const h = this.handlers[op];
    if (!h) throw new AgentError(404, `no fake for ${op}`);
    return (await h(args)) as T;
  }
}

const POLICY = {
  capabilities: ["calendar.read", "calendar.write", "email.send", "purchase"],
  tiers: { owner: { "calendar.freebusy": "yes", "calendar.read": "yes", "calendar.write": "ask", "email.read": "yes", "email.send": "yes", "contacts.read": "yes", purchase: "limit", "travel.book": "limit", "phone.call": "ask", "computer.use": "yes", "web.read": "yes", "memory.write": "yes" } },
  grants: [{ id: "g_1", to: "contact:sam", capabilities: ["calendar.write"], createdAt: "x", note: "lunch" }],
};

class FakeVerifier implements PhoneVerifier {
  sent: string[] = [];
  failStart?: string;
  async start(phone: string) {
    if (this.failStart) throw new VerifyError(this.failStart);
    this.sent.push(phone);
  }
  async check(phone: string, code: string) {
    return this.sent.includes(phone) && code === "123456";
  }
}

let closeFn: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeFn?.();
  closeFn = undefined;
});

async function start(opts: { client?: FakeClient; verifier?: FakeVerifier; noAgent?: boolean; callLogPath?: string; transcriptsDir?: string; prefsPath?: string; deskDir?: string; alertsPath?: string; revokedPath?: string; publicUrl?: string; operator?: { contact?: string } } = {}) {
  const store = new FileStore(mkdtempSync(join(tmpdir(), "console-srv-")));
  const client = opts.client ?? new FakeClient();
  const verifier = opts.verifier ?? new FakeVerifier();
  const o: ConsoleOptions = {
    store,
    sessionSecret: SECRET,
    publicUrl: opts.publicUrl ?? "http://localhost:8790",
    ...(opts.operator ? { operator: opts.operator } : {}),
    adminPhones: [ADMIN],
    verifier,
    clientFor: () => (opts.noAgent ? undefined : client),
    pageClient: () => (opts.noAgent ? undefined : client),
    staticDir: STATIC,
    devAgent: { kind: "direct", url: "http://127.0.0.1:8080", tokenEnv: "INSTINCT_CHAT_TOKEN", secretEnv: "OWNER_API_SECRET" },
    ...(opts.callLogPath ? { callLogPath: opts.callLogPath } : {}),
    ...(opts.transcriptsDir ? { transcriptsDir: opts.transcriptsDir } : {}),
    ...(opts.prefsPath ? { prefsPath: opts.prefsPath } : {}),
    ...(opts.deskDir ? { deskDir: opts.deskDir } : {}),
    ...(opts.alertsPath ? { alertsPath: opts.alertsPath } : {}),
    ...(opts.deskDir ? { revokedArtifactsPath: opts.revokedPath ?? join(mkdtempSync(join(tmpdir(), "revoked-")), "revoked.json") } : {}),
  };
  const server = createConsole(o);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeFn = () => new Promise((r) => server.close(() => r()));
  const signedIn = async (phone = ADMIN) => {
    const user = await store.upsertUser({ phone });
    const s = newSession(user.id, user.phone);
    return { cookie: `${SESSION_COOKIE}=${signSession(SECRET, s)}`, csrf: s.csrf, user };
  };
  const get = (path: string, cookie?: string) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });
  const post = (path: string, form: Record<string, string | string[]>, cookie?: string) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
    return fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) }, body: body.toString() });
  };
  return { base, store, client, verifier, signedIn, get, post };
}

/** GET / to obtain the pre-sign-in cookie and token, then send a code. */
async function beginSignIn(c: Awaited<ReturnType<typeof start>>, phone: string, next = "") {
  const home = await c.get(`/signin${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  const pre = home.headers.get("set-cookie")!.split(";")[0]!;
  const token = /name="pre" value="([^"]+)"/.exec(await home.text())![1]!;
  const sent = await c.post("/signin/start", { phone, pre: token, next, consent: "yes" }, pre);
  return { pre, token, sent };
}

describe("console: texting consent (A2P opt-in)", () => {
  it("serves the opt-in screenshot the carrier reviewers are linked to", async () => {
    const res = await (await start()).get("/static/optin.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  // Twilio rejected campaign CM396018… on 2026-11-02 for forced consent: texts about tasks must be optional.
  it("the sign-in form's texting box is optional and not checked, with the full disclosure beside it", async () => {
    const page = await (await (await start()).get("/signin")).text();
    const box = /<input[^>]*name="consent"[^>]*>/.exec(page)?.[0];
    expect(box).toBeDefined();
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain("required");
    expect(box).not.toContain("checked");
    for (const words of ["Optional", "Message frequency varies", "Msg &amp; data rates may apply", "Reply STOP", "HELP", "without", 'href="/terms"', 'href="/privacy"']) expect(page).toContain(words);
  });

  it("a sign-in code is texted with the box left unticked", async () => {
    const c = await start();
    const home = await c.get("/signin");
    const pre = home.headers.get("set-cookie")!.split(";")[0]!;
    const token = /name="pre" value="([^"]+)"/.exec(await home.text())![1]!;
    const res = await c.post("/signin/start", { phone: ADMIN, pre: token }, pre);
    expect(res.status).toBe(200);
    expect(c.verifier.sent).toEqual([ADMIN]);
  });

  it("the choice is kept with the account: ticked is yes, unticked leaves a yes alone", async () => {
    const c = await start();
    const home = await c.get("/signin");
    const pre = home.headers.get("set-cookie")!.split(";")[0]!;
    const token = /name="pre" value="([^"]+)"/.exec(await home.text())![1]!;
    await c.post("/signin/start", { phone: ADMIN, pre: token }, pre);
    expect((await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: token }, pre)).status).toBe(303);
    expect((await c.store.userByPhone(ADMIN))!.textsOptIn).toMatchObject({ yes: false });
    await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: token, consent: "yes" }, pre);
    expect((await c.store.userByPhone(ADMIN))!.textsOptIn).toMatchObject({ yes: true });
    await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: token }, pre);
    expect((await c.store.userByPhone(ADMIN))!.textsOptIn).toMatchObject({ yes: true });
  });

  it("the code page carries their choice into checking and into asking for a new code", async () => {
    const c = await start();
    const { sent } = await beginSignIn(c, ADMIN);
    expect((await sent.text()).match(/name="consent" value="yes"/g)).toHaveLength(2);
    const home = await c.get("/signin");
    const pre = home.headers.get("set-cookie")!.split(";")[0]!;
    const token = /name="pre" value="([^"]+)"/.exec(await home.text())![1]!;
    expect(await (await c.post("/signin/start", { phone: ADMIN, pre: token }, pre)).text()).not.toMatch(/name="consent"/);
  });
});

describe("console: phone sign-in and access", () => {
  it("the home page explains Kloru for groups and links to sign in and the legal pages", async () => {
    const c = await start();
    const home = await c.get("/");
    expect(home.status).toBe(200);
    const page = await home.text();
    expect(page).toContain("Kloru is an assistant for your people");
    expect(page).toContain("order groceries");
    expect(page).toContain('href="/signin"');
    expect(page).toContain('href="/privacy"');
    expect(page).toContain('href="/terms"');
    expect(page).toContain("© 2026 Kloru");
  });

  it("the sign-in page has the phone form and protected pages redirect to it", async () => {
    const c = await start();
    const res = await c.get("/signin");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain('name="phone"');
    expect(page).toContain("Text me a sign-in code");
    expect(res.headers.get("set-cookie")).toMatch(/^kloru_pre=.+HttpOnly; SameSite=Lax/);
    expect((await c.get("/connections")).headers.get("location")).toBe("/signin");
  });

  it("signed-in visitors skip the home and sign-in pages", async () => {
    const c = await start({ client: new FakeClient({ "apps.list": () => [] }) });
    const { cookie } = await c.signedIn();
    expect((await c.get("/", cookie)).headers.get("location")).toBe("/start");
    expect((await c.get("/signin", cookie)).headers.get("location")).toBe("/start");
  });

  it("the why page is public and in Evan's words", async () => {
    const c = await start();
    const res = await c.get("/why");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("I&#39;m Evan. I&#39;m a real person.");
    expect(page).toContain("stepstool");
  });

  it("privacy and terms are public, name the contacts, the services and the rules", async () => {
    const c = await start();
    const privacy = await (await c.get("/privacy")).text();
    for (const must of ["privacy@kloru.com", "Twilio", "Deepgram", "Cartesia", "OpenRouter", "Composio", "Google", "Fly.io", "Neon", "Cloudflare", "do not sell", "18", "delete", "log of calls to Kloru numbers", "Help improve Kloru for everyone", "Langfuse"]) expect(privacy).toContain(must);
    const terms = await (await c.get("/terms")).text();
    for (const must of ["legal@kloru.com", "18", "California", "Santa Clara County", "Privacy Policy"]) expect(terms).toContain(must);
    const signedIn = await (await c.get("/privacy", (await c.signedIn()).cookie)).text();
    expect(signedIn).toContain("privacy@kloru.com");
  });

  it("texting consent and the carrier-required SMS terms are public", async () => {
    const c = await start();
    const signin = await (await c.get("/signin")).text();
    for (const must of ["Optional", "Message frequency varies", "Msg &amp; data rates may apply", "Reply STOP", "HELP", 'href="/terms"', 'href="/privacy"']) expect(signin).toContain(must);
    const privacy = await (await c.get("/privacy")).text();
    expect(privacy).toContain("not be shared with third parties or affiliates for marketing or promotional purposes");
    expect(privacy).toContain("text messaging originator opt-in data and consent");
    const terms = await (await c.get("/terms")).text();
    for (const must of ["Kloru text messages", "optional", "not a condition of using Kloru", "Message frequency varies", "Message and data rates may apply", "Reply STOP", "HELP", "support@kloru.com", "Carriers are not liable"]) expect(terms).toContain(must);
    // Agreeing to texts is never bundled into using the site.
    expect(terms).not.toContain("By entering your phone number on kloru.com or texting Kloru, you agree to receive texts");
  });

  it("security headers are on every page", async () => {
    const c = await start();
    const res = await c.get("/");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves static files and nothing else from /static", async () => {
    const c = await start();
    const css = await c.get("/static/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await c.get("/static/package.json")).status).toBe(404);
    expect((await c.get("/static/%2e%2e%2fpackage.json")).status).toBe(404);
    expect((await c.get("/static/../package.json")).status).not.toBe(200);
  });

  it("an admin texts themselves a code, enters it, and is signed in with the dev agent", async () => {
    const c = await start();
    const { pre, token, sent } = await beginSignIn(c, "(415) 555-0190", "/permissions");
    expect(sent.status).toBe(200);
    expect(c.verifier.sent).toEqual([ADMIN]);
    const codePage = await sent.text();
    expect(codePage).toContain('name="code"');
    expect(codePage).toContain("•••• 0190");
    const wrong = await c.post("/signin/check", { phone: ADMIN, code: "000000", pre: token, next: "/permissions" }, pre);
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("didn&#39;t match");
    const ok = await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: token, next: "/permissions" }, pre);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/permissions");
    expect(ok.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    expect((await c.store.userByPhone(ADMIN))?.agent).toMatchObject({ kind: "direct", url: "http://127.0.0.1:8080" });
  });

  it("never texts a number that isn't invited", async () => {
    const c = await start();
    const { sent } = await beginSignIn(c, "+14155550100");
    expect(sent.status).toBe(403);
    expect(await sent.text()).toContain("isn&#39;t invited");
    expect(c.verifier.sent).toEqual([]);
  });

  it("an invited number signs in without an agent", async () => {
    const c = await start();
    await c.store.invite("+14155550100", ADMIN);
    const { pre, token } = await beginSignIn(c, "415-555-0100");
    expect((await c.post("/signin/check", { phone: "+14155550100", code: "123456", pre: token }, pre)).status).toBe(303);
    expect((await c.store.userByPhone("+14155550100"))?.agent).toBeUndefined();
  });

  it("refuses sign-in posts without the pre-sign-in token, and junk numbers", async () => {
    const c = await start();
    expect((await c.post("/signin/start", { phone: ADMIN, pre: "x" })).status).toBe(403);
    const { pre, token } = await beginSignIn(c, ADMIN);
    expect((await c.post("/signin/start", { phone: "12", pre: token }, pre)).status).toBe(400);
    expect((await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: "wrong" }, pre)).status).toBe(403);
  });

  it("limits codes per number and wrong guesses", async () => {
    const c = await start();
    const { pre, token } = await beginSignIn(c, ADMIN);
    await c.post("/signin/start", { phone: ADMIN, pre: token, consent: "yes" }, pre);
    await c.post("/signin/start", { phone: ADMIN, pre: token, consent: "yes" }, pre);
    const fourth = await c.post("/signin/start", { phone: ADMIN, pre: token, consent: "yes" }, pre);
    expect(fourth.status).toBe(429);
    expect(c.verifier.sent).toHaveLength(3);
    for (let i = 0; i < 5; i++) await c.post("/signin/check", { phone: ADMIN, code: "000000", pre: token }, pre);
    expect((await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: token }, pre)).status).toBe(429);
  });

  it("behind Fly, limits count per Fly-Client-IP, not per proxy", async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), "console-ip-")));
    const verifier = new FakeVerifier();
    const server = createConsole({ store, sessionSecret: SECRET, publicUrl: "http://localhost:8790", adminPhones: ["+14155550190", "+14155550100", "+12125550199", "+13105550123"], verifier, clientFor: () => undefined, staticDir: STATIC, trustProxy: true });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const home = await fetch(base + "/signin");
      const pre = home.headers.get("set-cookie")!.split(";")[0]!;
      const token = /name="pre" value="([^"]+)"/.exec(await home.text())![1]!;
      const send = (phone: string, ip: string) => fetch(base + "/signin/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: pre, "fly-client-ip": ip }, body: new URLSearchParams({ phone, pre: token, consent: "yes" }).toString() });
      const phones = ["+14155550190", "+14155550100", "+12125550199", "+13105550123"];
      for (let i = 0; i < 10; i++) expect((await send(phones[i % 4]!, "203.0.113.7")).status).not.toBe(500);
      expect((await send("+13105550123", "203.0.113.7")).status).toBe(429);
      expect((await send("+13105550123", "198.51.100.9")).status).toBe(200);
    } finally {
      await new Promise((r) => server.close(() => r(undefined)));
    }
  });

  it("a Twilio failure shows a message, not a 500", async () => {
    const verifier = new FakeVerifier();
    verifier.failStart = "Max send attempts reached";
    const c = await start({ verifier });
    const { sent } = await beginSignIn(c, ADMIN);
    expect(sent.status).toBe(502);
    expect(await sent.text()).toContain("couldn&#39;t send");
  });

  it("keeps a safe next through sign-in and drops an off-site one", async () => {
    const c = await start();
    const evil = await beginSignIn(c, ADMIN, "/\t/evil.com");
    expect((await c.post("/signin/check", { phone: ADMIN, code: "123456", pre: evil.token, next: "//evil.com" }, evil.pre)).headers.get("location")).toBe("/");
  });

  it("sessions from another secret or a deleted user read as signed out", async () => {
    const c = await start();
    const s = newSession("u_gone", ADMIN);
    expect((await c.get("/connections", `${SESSION_COOKIE}=${signSession("old-secret", s)}`)).headers.get("location")).toBe("/signin");
    expect((await c.get("/connections", `${SESSION_COOKIE}=${signSession(SECRET, s)}`)).headers.get("location")).toBe("/signin");
  });

  it("a removed invitee or demoted admin loses access on their next request", async () => {
    const c = await start({ client: new FakeClient({ "apps.list": () => [] }) });
    await c.store.invite("+14155550100", ADMIN);
    const sam = await c.signedIn("+14155550100");
    expect((await c.get("/connections", sam.cookie)).status).toBe(200);
    await c.store.removeInvite("+14155550100");
    expect((await c.get("/connections", sam.cookie)).headers.get("location")).toBe("/signin");
    const former = await c.signedIn("+12125550199");
    expect((await c.get("/connections", former.cookie)).headers.get("location")).toBe("/signin");
  });

  it("logout clears the cookie", async () => {
    const c = await start();
    const res = await c.get("/logout", (await c.signedIn()).cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("POSTs need a session and its CSRF token", async () => {
    const c = await start();
    const { cookie } = await c.signedIn();
    expect((await c.post("/permissions", { capability: "calendar.write", permission: "ask" })).status).toBe(302);
    expect((await c.post("/permissions", { capability: "calendar.write", permission: "ask", csrf: "wrong" }, cookie)).status).toBe(403);
    expect(c.client.calls).toHaveLength(0);
  });
});

describe("console: connections", () => {
  it("connected apps first; every other app Kloru supports is one click away", async () => {
    const client = new FakeClient({
      "apps.list": () => [
        { slug: "gmail", connected: true, accounts: [{ id: "ca_1", email: "evan@gmail.com", status: "connected" }] },
        { slug: "notion", connected: false, accounts: [] },
        { slug: "outlook", connected: false, accounts: [] },
        { slug: "someapp", connected: false, accounts: [] },
      ],
    });
    const c = await start({ client });
    const page = await (await c.get("/connections", (await c.signedIn()).cookie)).text();
    expect(page.indexOf("evan@gmail.com")).toBeLessThan(page.indexOf("Add an app"));
    expect(page).toContain("Notion");
    expect(page).toContain("Outlook");
    expect(page).toContain("Someapp");
    expect(page).toMatch(/name="toolkit" value="notion"/);
  });

  it("shows Kloru's texting number and whether this person has texted with it", async () => {
    const yes = new FakeClient({ "apps.list": () => [], "texting.status": () => ({ number: "+16504849720", handle: "kloru-marshalls", texted: "2026-10-31T09:00:00Z" }) });
    const c = await start({ client: yes });
    const page = await (await c.get("/connections", (await c.signedIn()).cookie)).text();
    expect(page).toContain("(650) 484-9720");
    expect(page).toContain("Texts work");
    expect(yes.calls.find(([op]) => op === "texting.status")![1]).toEqual({ phone: "+14155550190" });

    const no = new FakeClient({ "apps.list": () => [], "texting.status": () => ({ number: "+16504849720", handle: "kloru-marshalls" }) });
    const d = await start({ client: no });
    const page2 = await (await d.get("/connections", (await d.signedIn()).cookie)).text();
    expect(page2).toContain("Not yet");
    expect(page2).toContain("connect @kloru-marshalls");
    expect(page2).toContain("sms:+16504849720");
  });

  it("payments: connect Stripe Link from the page; a test wallet says so", async () => {
    const client = new FakeClient({ "apps.list": () => [], "payments.status": () => ({ configured: true, connected: false, test: true }), "payments.connect": () => ({ url: "https://login.link.com/authorize?x" }) });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const page = await (await c.get("/connections", cookie)).text();
    expect(page).toContain("Payments");
    expect(page).toContain("Connect Stripe Link");
    expect(page).toContain("Test mode");
    const res = await c.post("/connections/payments", { csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://login.link.com/authorize?x");
  });

  it("payments not set up on the agent: the page says so and offers no button", async () => {
    const client = new FakeClient({ "apps.list": () => [], "payments.status": () => ({ configured: false, connected: false }) });
    const c = await start({ client });
    const page = await (await c.get("/connections", (await c.signedIn()).cookie)).text();
    expect(page).toContain("Payments");
    expect(page).not.toContain("Connect Stripe Link");
  });

  it("lists apps and connect redirects to Composio with our return URL", async () => {
    const client = new FakeClient({ "apps.list": () => [{ slug: "googlecalendar", connected: false }, { slug: "gmail", connected: true }], "apps.connect": () => ({ url: "https://connect.composio.dev/x" }) });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const page = await (await c.get("/connections", cookie)).text();
    expect(page).toContain("Google Calendar");
    expect(page).toContain("Gmail");
    expect(page).toContain("Connected");
    expect(page).toContain(`name="csrf" value="${csrf}"`);
    const res = await c.post("/connections/connect", { toolkit: "googlecalendar", csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://connect.composio.dev/x");
    expect(client.calls.at(-1)).toEqual(["apps.connect", { toolkit: "googlecalendar", callbackUrl: "http://localhost:8790/connections/return?toolkit=googlecalendar" }]);
  });

  it("shows every connected account by its address, and how to add another", async () => {
    const client = new FakeClient({
      "apps.list": () => [
        { slug: "gmail", connected: true, accounts: [{ id: "ca_1", email: "evan@gmail.com", status: "connected" }, { id: "ca_2", email: "evan@work.example.com", status: "connected" }] },
        { slug: "googlecalendar", connected: true, accounts: [{ id: "ca_3", email: "evan@gmail.com", status: "connected" }, { id: "ca_4", status: "expired" }] },
        { slug: "googledrive", connected: false, accounts: [] },
      ],
    });
    const c = await start({ client });
    const page = await (await c.get("/connections", (await c.signedIn()).cookie)).text();
    expect(page).toContain("evan@gmail.com");
    expect(page).toContain("evan@work.example.com");
    expect(page).toContain("Add another Gmail account");
    expect(page).toContain("Add another Google Calendar account");
    expect(page).toContain("Needs reconnecting");
    expect(page).toContain("Connect Google Drive");
    expect(page).toContain(`name="account" value="ca_2"`);
    expect(page).toContain("Disconnect evan@work.example.com from Gmail?");
  });

  it("disconnecting one account names it", async () => {
    const client = new FakeClient({ "apps.disconnect": () => ({ ok: true, removed: 1 }), "apps.list": () => [] });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    expect((await c.post("/connections/disconnect", { toolkit: "gmail", account: "ca_2", csrf }, cookie)).status).toBe(303);
    expect(client.calls.at(-1)).toEqual(["apps.disconnect", { toolkit: "gmail", account: "ca_2" }]);
  });

  it("coming back from sign-in names the account that was added", async () => {
    const client = new FakeClient({ "apps.list": () => [{ slug: "gmail", connected: true, accounts: [{ id: "ca_1", email: "evan@gmail.com", status: "connected" }, { id: "ca_2", email: "evan@work.example.com", status: "connected" }] }] });
    const c = await start({ client });
    const page = await (await c.get("/connections/return?toolkit=gmail&status=success&connected_account_id=ca_2", (await c.signedIn()).cookie)).text();
    expect(page).toContain("evan@work.example.com is connected to Gmail.");
  });

  it("disconnect calls the agent and comes back with a banner", async () => {
    const client = new FakeClient({ "apps.disconnect": () => ({ ok: true, removed: 1 }), "apps.list": () => [] });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const res = await c.post("/connections/disconnect", { toolkit: "gmail", csrf }, cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/connections?done=disconnected");
    expect(await (await c.get("/connections?done=disconnected", cookie)).text()).toContain("Disconnected");
  });

  it("the return page reports the app's state", async () => {
    const client = new FakeClient({ "apps.list": () => [{ slug: "googlecalendar", connected: true }] });
    const c = await start({ client });
    const page = await (await c.get("/connections/return?toolkit=googlecalendar", (await c.signedIn()).cookie)).text();
    expect(page).toContain("Google Calendar is connected");
  });

  it("the return page without a session sends you to sign in and back", async () => {
    const c = await start();
    const res = await c.get("/connections/return?toolkit=gmail");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/signin?next=${encodeURIComponent("/connections/return?toolkit=gmail")}`);
  });

  it("an unreachable agent shows a banner, not an error", async () => {
    const client = new FakeClient({ "apps.list": () => { throw new AgentError(0, "fetch failed"); } });
    const c = await start({ client });
    const res = await c.get("/connections", (await c.signedIn()).cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("isn&#39;t responding");
  });

  it("a user without an agent is told to ask an admin", async () => {
    const c = await start({ noAgent: true });
    await c.store.invite("+14155550100", ADMIN);
    expect(await (await c.get("/connections", (await c.signedIn("+14155550100")).cookie)).text()).toContain("No agent is assigned");
  });
});

describe("console: permissions", () => {
  it("shows the agent's own permissions with the current choice checked", async () => {
    const c = await start({ client: new FakeClient({ "policy.get": () => POLICY }) });
    const page = await (await c.get("/permissions", (await c.signedIn()).cookie)).text();
    expect(page).toContain("Create and change events");
    expect(page).toMatch(/name="permission" value="ask" checked/);
    expect(page).toContain("Within spend limits");
  });

  it("saves a choice and shows agent refusals as an escaped banner", async () => {
    const client = new FakeClient({ "policy.setPermission": () => ({ ok: true }), "policy.get": () => POLICY });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const res = await c.post("/permissions", { capability: "calendar.write", permission: "no", csrf }, cookie);
    expect(res.status).toBe(303);
    expect(client.calls[0]).toEqual(["policy.setPermission", { tier: "owner", capability: "calendar.write", permission: "no" }]);
    client.handlers["policy.setPermission"] = () => { throw new AgentError(400, "unknown <permission>"); };
    const bad = await c.post("/permissions", { capability: "calendar.write", permission: "maybe", csrf }, cookie);
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain("unknown &lt;permission&gt;");
  });
});

describe("console: approvals", () => {
  const pending = [{ token: "AB12", summary: "Create event <Lunch>", capability: "calendar.write", createdAt: "2026-10-27T10:00:00Z" }, { token: "CD34", summary: "Buy tickets", capability: "purchase", amountUsd: 40, createdAt: "2026-10-27T10:00:00Z" }];

  it("lists pending approvals, escaped, and never pre-fills confirm", async () => {
    const c = await start({ client: new FakeClient({ "approvals.list": () => pending }) });
    const page = await (await c.get("/approvals", (await c.signedIn()).cookie)).text();
    expect(page).toContain("Create event &lt;Lunch&gt;");
    expect(page).toContain("$40");
    expect(page).not.toContain('name="confirm"');
  });

  it("approving money shows a server-side confirmation step that carries confirm", async () => {
    const client = new FakeClient({ "approvals.settle": (a) => { if (!a.confirm) throw new AgentError(400, "this approval needs confirmation"); return { ok: true }; }, "approvals.list": () => pending });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const first = await c.post("/approvals/settle", { token: "CD34", decision: "approve", csrf }, cookie);
    expect(first.status).toBe(200);
    const page = await first.text();
    expect(page).toContain("Buy tickets");
    expect(page).toContain('name="confirm" value="1"');
    expect(page).toContain('name="token" value="CD34"');
    const second = await c.post("/approvals/settle", { token: "CD34", decision: "approve", confirm: "1", csrf }, cookie);
    expect(second.status).toBe(303);
  });

  it("approves, and sends confirm only when the form says so", async () => {
    const client = new FakeClient({ "approvals.settle": () => ({ ok: true, summary: "Create event", status: "approved" }), "approvals.list": () => [] });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const res = await c.post("/approvals/settle", { token: "AB12", decision: "approve", csrf }, cookie);
    expect(res.status).toBe(303);
    expect(client.calls[0]).toEqual(["approvals.settle", { token: "AB12", approved: true, confirm: false }]);
    await c.post("/approvals/settle", { token: "CD34", decision: "approve", confirm: "1", csrf }, cookie);
    expect(client.calls.at(-1)).toEqual(["approvals.settle", { token: "CD34", approved: true, confirm: true }]);
    await c.post("/approvals/settle", { token: "CD34", decision: "deny", csrf }, cookie);
    expect(client.calls.at(-1)![1]).toMatchObject({ approved: false });
  });
});

describe("console: contacts", () => {
  it("lists contacts with grants, escaping names", async () => {
    const client = new FakeClient({ "contacts.list": () => [{ id: "sam", name: "<script>x</script>", tier: "friend", phones: ["+14155550190"], emails: [] }], "policy.get": () => POLICY });
    const c = await start({ client });
    const page = await (await c.get("/contacts", (await c.signedIn()).cookie)).text();
    expect(page).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(page).not.toContain("<script>x");
    expect(page).toContain("+14155550190");
    expect(page).toContain("lunch");
  });

  it("adds a contact, splitting phones and emails", async () => {
    const client = new FakeClient({ "contacts.upsert": () => ({ id: "sam" }) });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const res = await c.post("/contacts", { name: "Sam", phones: "(415) 555-0190, +1 415 555 0100", emails: "sam@x.com", tier: "friend", csrf }, cookie);
    expect(res.status).toBe(303);
    expect(client.calls[0]).toEqual(["contacts.upsert", { name: "Sam", phones: ["(415) 555-0190", "+1 415 555 0100"], emails: ["sam@x.com"], tier: "friend" }]);
  });

  it("refuses a dollar cap that isn't a number instead of saving an uncapped grant", async () => {
    const client = new FakeClient({ "grants.add": () => ({ id: "g_2" }), "contacts.list": () => [], "policy.get": () => POLICY });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const res = await c.post("/contacts/grant", { contactId: "sam", capabilities: ["purchase"], maxUsd: "$50", csrf }, cookie);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("dollar cap");
    expect(client.calls.some(([op]) => op === "grants.add")).toBe(false);
  });

  it("grants and revokes per contact", async () => {
    const client = new FakeClient({ "grants.add": () => ({ id: "g_2" }), "grants.revoke": () => ({ ok: true }) });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    await c.post("/contacts/grant", { contactId: "sam", capabilities: ["calendar.write", "calendar.read"], windowFrom: "", windowTo: "", maxUsd: "", note: "lunch", csrf }, cookie);
    expect(client.calls[0]).toEqual(["grants.add", { to: "contact:sam", capabilities: ["calendar.write", "calendar.read"], note: "lunch" }]);
    await c.post("/contacts/revoke", { id: "g_1", csrf }, cookie);
    expect(client.calls[1]).toEqual(["grants.revoke", { id: "g_1" }]);
  });
});

describe("console: admin", () => {
  it("admins invite phone numbers; others get 403", async () => {
    const c = await start();
    const admin = await c.signedIn();
    expect((await c.post("/admin/invite", { phone: "(415) 555-0100", csrf: admin.csrf }, admin.cookie)).status).toBe(303);
    expect(await c.store.isInvited("+14155550100")).toBe(true);
    expect(await (await c.get("/admin", admin.cookie)).text()).toContain("+14155550100");
    expect((await c.post("/admin/invite", { phone: "nope", csrf: admin.csrf }, admin.cookie)).status).toBe(200);
    const sam = await c.signedIn("+14155550100");
    expect((await c.get("/admin", sam.cookie)).status).toBe(403);
    expect((await c.post("/admin/invite", { phone: "+12125550199", csrf: sam.csrf }, sam.cookie)).status).toBe(403);
  });

  it("admins see the call log: weekly counts and recent calls, with hang-ups on the owner's number called out", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "calls-")), "calls.jsonl");
    const now = Date.now();
    const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(file, [
      JSON.stringify({ at: at(30), call_sid: "CA1", from: "+14155550190", verstat: "TN-Validation-Passed-A", outcome: "connected" }),
      JSON.stringify({ at: at(20), call_sid: "CA2", from: "+14155550190", verstat: "TN-Validation-Passed-C", outcome: "hung_up_attestation" }),
      JSON.stringify({ at: at(10), call_sid: "CA3", from: "+19995550000", verstat: "", outcome: "refused_unknown" }),
    ].join("\n"));
    const c = await start({ callLogPath: file });
    const admin = await c.signedIn();
    const page = await (await c.get("/admin", admin.cookie)).text();
    expect(page).toContain("<h2>Calls</h2>");
    expect(page).toContain("1 connected");
    expect(page).toContain("1 hung up: carrier didn&#39;t vouch for caller ID");
    expect(page).toContain("1 refused: unknown number");
    expect(page).toContain("+19995550000");
    expect(page).toContain("TN-Validation-Passed-C");
    expect(page).toMatch(/class="call warn"[^]*CA2|CA2[^]*class="call warn"/);
  });

  it("without a call log the admin page says so", async () => {
    const c = await start();
    const admin = await c.signedIn();
    expect(await (await c.get("/admin", admin.cookie)).text()).toContain("No calls logged yet.");
  });

  it("admins read a connected call's transcript; others can't", async () => {
    const sid = "CA341913eaade29d7559d4762f3287d05e";
    const root = mkdtempSync(join(tmpdir(), "voice-"));
    const file = join(root, "calls.jsonl");
    const tx = join(root, "transcripts");
    const at = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    writeFileSync(file, JSON.stringify({ at, call_sid: sid, from: "+14155550190", verstat: "TN-Validation-Passed-A", outcome: "connected" }));
    mkdirSync(join(tx, at.slice(0, 10)), { recursive: true });
    writeFileSync(join(tx, at.slice(0, 10), `${sid}.jsonl`), [
      { at, kind: "call_started", call_sid: sid, from: "+14155550190" },
      { at, kind: "caller", text: "Who's doing drop-off <Wednesday>?" },
      { at, kind: "task_started", task: 2, request: "Identify who drops Maya off on Oct 28", size: "quick" },
      { at, kind: "kloru", text: "Let me check", interrupted: true },
      { at, kind: "task_finished", task: 2, status: "done", result: "It doesn't say who.", after_call: true },
      { at, kind: "call_ended" },
    ].map((e) => JSON.stringify(e)).join("\n"));
    const c = await start({ callLogPath: file, transcriptsDir: tx });
    const admin = await c.signedIn();
    expect(await (await c.get("/admin", admin.cookie)).text()).toContain(`href="/admin/calls/${sid}"`);
    const res = await c.get(`/admin/calls/${sid}`, admin.cookie);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Who&#39;s doing drop-off &lt;Wednesday&gt;?");
    expect(page).toContain("Identify who drops Maya off on Oct 28");
    expect(page).toContain("cut off");
    expect(page).toContain("after the call ended");
    expect((await c.get("/admin/calls/CA0000000000000000000000000000000f", admin.cookie)).status).toBe(404);
    await c.store.invite("+14155550100", "+14155550190");
    const sam = await c.signedIn("+14155550100");
    expect((await c.get(`/admin/calls/${sid}`, sam.cookie)).status).toBe(403);
  });
});

describe("console: settings", () => {
  it("help improve Kloru is on by default and each person can turn it off and back on", async () => {
    const prefs = join(mkdtempSync(join(tmpdir(), "prefs-")), "prefs.json");
    const c = await start({ prefsPath: prefs });
    const me = await c.signedIn();
    let page = await (await c.get("/settings", me.cookie)).text();
    expect(page).toContain("Help improve Kloru for everyone");
    expect(page).toMatch(/name="improve"[^>]*checked/);
    expect(page).toContain('href="/settings"');
    expect((await c.post("/settings", { sent: "1", csrf: me.csrf }, me.cookie)).headers.get("location")).toBe("/settings?done=saved");
    page = await (await c.get("/settings", me.cookie)).text();
    expect(page).not.toMatch(/name="improve"[^>]*checked/);
    expect(JSON.parse(readFileSync(prefs, "utf8")).transcriptsOff).toEqual([ADMIN]);
    await c.post("/settings", { sent: "1", improve: "on", csrf: me.csrf }, me.cookie);
    expect(JSON.parse(readFileSync(prefs, "utf8")).transcriptsOff).toEqual([]);
    expect((await c.post("/settings", { sent: "1", csrf: "wrong" }, me.cookie)).status).toBe(403);
    expect((await c.get("/settings")).headers.get("location")).toBe("/signin");
  });
});


describe("console: the desk, read-only", () => {
  /** A small desk like production's: one call, an issue with a thread and a ledger change, memory. */
  function desk() {
    const dir = join(mkdtempSync(join(tmpdir(), "desk-")), "repo");
    const repo = new Repo(dir);
    const call = repo.startCall({ callSid: "CA393c42478ffcd5855c7dfd5d38fe7007", phone: ADMIN, channel: "voice" });
    repo.addTurn(call.id, { role: "caller", text: "What's on <tomorrow>?" });
    const issue = repo.newIssue({ kind: "work", request: "Look up tomorrow", filedBy: { phone: ADMIN, call: call.id }, baseTurn: 1, baseHash: repo.head(call.id), resources: ["calendar:2026-10-29"] });
    issue.thread.push({ at: new Date().toISOString(), by: "pm", text: "Assigned to an engineer: read-only lookup" });
    issue.status = "merged";
    issue.prs.push({ at: new Date().toISOString(), body: "Drop-off at 8, interview at 2:30", baseTurn: 1, status: "merged" });
    repo.saveIssue(issue);
    repo.appendLedger({ issue: issue.id, call: call.id, phone: ADMIN, tool: "app_googlecalendar_create_event", slug: "GOOGLECALENDAR_CREATE_EVENT", args: { summary: "Pickup" }, ok: true, result: "created evt_123" });
    repo.appendInbox(call.id, { kind: "info", text: "Drop-off at 8", issue: issue.id });
    const memory = new Memory(join(dir, "memory"), { owner: { name: "Evan Marshall", phones: [ADMIN] } });
    memory.init();
    memory.save("household/people/maya.md", "---\nid: maya\ntype: person\n---\n- Evan's daughter, 3\n");
    const commit = memory.commit("Update memory from call: Maya")!;
    return { dir, call, issue, commit };
  }

  it("an admin sees open and closed issues, calls, failed call checks and whether the chains verify", async () => {
    const d = desk();
    const alerts = join(mkdtempSync(join(tmpdir(), "alerts-")), "alerts.jsonl");
    writeFileSync(alerts, JSON.stringify({ call_sid: "CA84bd0d64d995a627cb77ef3d54c38d89", failures: [{ name: "no_audio", detail: "2 replies written that the caller never heard" }] }) + "\n");
    const c = await start({ deskDir: d.dir, alertsPath: alerts });
    const admin = await c.signedIn();
    expect(await (await c.get("/admin", admin.cookie)).text()).toContain('href="/admin/desk"');
    const page = await (await c.get("/admin/desk", admin.cookie)).text();
    expect(page).toContain(`href="/admin/desk/issues/${d.issue.id}"`);
    expect(page).toContain("Look up tomorrow");
    expect(page).toContain("no_audio");
    expect(page).toContain(`href="/admin/desk/calls/${d.call.id}"`);
    expect(page).toContain("Ledger: 1 change, chain verifies");
    expect(page).toMatch(/Root [0-9a-f]{12}/);
  });

  it("an issue page shows the request, the thread, the result and what changed in the world", async () => {
    const d = desk();
    const c = await start({ deskDir: d.dir });
    const admin = await c.signedIn();
    const page = await (await c.get(`/admin/desk/issues/${d.issue.id}`, admin.cookie)).text();
    expect(page).toContain("Assigned to an engineer: read-only lookup");
    expect(page).toContain("Drop-off at 8, interview at 2:30");
    expect(page).toContain("GOOGLECALENDAR_CREATE_EVENT");
    expect(page).toContain("created evt_123");
    expect((await c.get("/admin/desk/issues/999", admin.cookie)).status).toBe(404);
  });

  it("a call page shows the turns, escaped, with what was filed and what came back", async () => {
    const d = desk();
    const c = await start({ deskDir: d.dir });
    const admin = await c.signedIn();
    const page = await (await c.get(`/admin/desk/calls/${d.call.id}`, admin.cookie)).text();
    expect(page).toContain("What&#39;s on &lt;tomorrow&gt;?");
    expect(page).toContain("Look up tomorrow");
    expect(page).toContain("Drop-off at 8");
    expect(page).toContain("1 turn, chain verifies");
    expect((await c.get("/admin/desk/calls/..%2F..%2Fetc", admin.cookie)).status).toBe(404);
  });

  it("a call whose turns were edited after the fact says so", async () => {
    const d = desk();
    const file = join(d.dir, "calls", d.call.id, "transcript.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace("tomorrow", "today"));
    const c = await start({ deskDir: d.dir });
    const admin = await c.signedIn();
    expect(await (await c.get(`/admin/desk/calls/${d.call.id}`, admin.cookie)).text()).toContain("chain broken at turn 1");
  });

  it("memory: the files as written, and each commit's diff; nothing outside memory is readable", async () => {
    const d = desk();
    const c = await start({ deskDir: d.dir });
    const admin = await c.signedIn();
    const tree = await (await c.get("/admin/desk/memory", admin.cookie)).text();
    expect(tree).toContain("household/people/maya.md");
    expect(tree).toContain(`href="/admin/desk/memory/commits/${d.commit}"`);
    const file = await (await c.get("/admin/desk/memory?file=household/people/maya.md", admin.cookie)).text();
    expect(file).toContain("Evan&#39;s daughter, 3");
    const diff = await (await c.get(`/admin/desk/memory/commits/${d.commit}`, admin.cookie)).text();
    expect(diff).toContain("+- Evan&#39;s daughter, 3");
    expect((await c.get("/admin/desk/memory?file=../issues/1.json", admin.cookie)).status).toBe(404);
    expect((await c.get("/admin/desk/memory/commits/HEAD", admin.cookie)).status).toBe(404);
  });

  it("the ledger lists every change, newest first", async () => {
    const d = desk();
    const c = await start({ deskDir: d.dir });
    const admin = await c.signedIn();
    const page = await (await c.get("/admin/desk/ledger", admin.cookie)).text();
    expect(page).toContain("GOOGLECALENDAR_CREATE_EVENT");
    expect(page).toContain(`href="/admin/desk/issues/${d.issue.id}"`);
  });

  it("only admins can look, and nothing here changes anything", async () => {
    const d = desk();
    const c = await start({ deskDir: d.dir });
    await c.store.invite("+14155550100", ADMIN);
    const sam = await c.signedIn("+14155550100");
    for (const path of ["/admin/desk", `/admin/desk/issues/${d.issue.id}`, `/admin/desk/calls/${d.call.id}`, "/admin/desk/ledger", "/admin/desk/memory"]) {
      expect((await c.get(path, sam.cookie)).status).toBe(403);
    }
    const admin = await c.signedIn();
    expect((await c.post("/admin/desk", { csrf: admin.csrf }, admin.cookie)).status).not.toBe(200);
  });
});

describe("artifact pages: anyone with the link", () => {
  function published() {
    const dir = join(mkdtempSync(join(tmpdir(), "desk-")), "repo");
    const repo = new Repo(dir);
    const call = repo.startCall({ callSid: "CA393c42478ffcd5855c7dfd5d38fe7007", phone: ADMIN, channel: "voice" });
    const issue = repo.newIssue({ request: "Compare dentists", filedBy: { phone: ADMIN, call: call.id }, baseTurn: 0 });
    const id = "Qm9vZ2xlR29vZ2xlR29vZ2";
    repo.saveArtifact({ id, title: "Pediatric dentists <near> Rockridge", markdown: "| Name | Stars |\n|---|---|\n| Rockridge Kids | 4.9 |\n\n<script>alert(1)</script>", issue: issue.id, call: call.id, phone: ADMIN, createdAt: new Date().toISOString() });
    return { dir, id, issue };
  }

  it("opens without signing in, rendered safely and kept out of search engines", async () => {
    const p = published();
    const c = await start({ deskDir: p.dir });
    const res = await c.get(`/a/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await res.text();
    expect(page).toContain("Pediatric dentists &lt;near&gt; Rockridge");
    expect(page).toContain("<td>Rockridge Kids</td>");
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("Sign out"); // no console chrome
  });

  it("a wrong or malformed id finds nothing", async () => {
    const p = published();
    const c = await start({ deskDir: p.dir });
    expect((await c.get("/a/Qm9vZ2xlR29vZ2xlR29vZ3")).status).toBe(404);
    expect((await c.get("/a/..%2F..%2Fcounters")).status).toBe(404);
  });

  it("the Desk lists pages, and an admin can take one down for good", async () => {
    const p = published();
    const c = await start({ deskDir: p.dir });
    const admin = await c.signedIn();
    const desk = await (await c.get("/admin/desk", admin.cookie)).text();
    expect(desk).toContain(`href="/a/${p.id}"`);
    expect(desk).toContain(`href="/admin/desk/issues/${p.issue.id}"`);
    await c.store.invite("+14155550100", ADMIN);
    const sam = await c.signedIn("+14155550100");
    expect((await c.post("/admin/desk/artifacts/revoke", { id: p.id, csrf: sam.csrf }, sam.cookie)).status).toBe(403);
    expect((await c.get(`/a/${p.id}`)).status).toBe(200);
    expect((await c.post("/admin/desk/artifacts/revoke", { id: p.id, csrf: admin.csrf }, admin.cookie)).status).toBe(303);
    const gone = await c.get(`/a/${p.id}`);
    expect(gone.status).toBe(410);
    expect(await (await c.get("/admin/desk", admin.cookie)).text()).toContain("taken down");
  });
});

describe("the desk page also shows the store and automations", () => {
  it("each source's last sync, counts and errors, and every automation with when it runs next", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "desk-")), "repo");
    new Repo(dir);
    const agentDir = join(dir, "..");
    const { Store } = await import("@kloru/store");
    const store = new Store(join(agentDir, "store", "store.db"));
    store.upsert([{ source: "googlecalendar", account: "evan@example.com", kind: "event", externalId: "e1", title: "Dentist", body: "", people: [], data: {} }]);
    store.setSyncState("googlecalendar", "evan@example.com", { lastOkAt: new Date().toISOString() });
    store.setSyncState("gmail", "evan@example.com", { lastError: "rate limited", lastErrorAt: new Date().toISOString() });
    store.close();
    writeFileSync(join(agentDir, "schedules.json"), JSON.stringify([{ id: "s1", name: "Morning debrief", enabled: true, cron: "0 7 * * 1-5", tz: "America/Los_Angeles", nextRunAt: "2026-10-30T14:00:00Z", prompt: "Debrief Evan on today", createdAt: "2026-10-29T00:00:00Z", target: "desk", phone: ADMIN }]));
    const c = await start({ deskDir: dir });
    const admin = await c.signedIn();
    const page = await (await c.get("/admin/desk", admin.cookie)).text();
    expect(page).toContain("<h2>Store</h2>");
    expect(page).toContain("event: 1");
    expect(page).toContain("rate limited");
    expect(page).toContain("<h2>Automations</h2>");
    expect(page).toContain("Morning debrief");
    expect(page).toContain("weekdays at 7:00 AM");
  });
});

describe("console: a family member connects her own accounts by link", () => {
  const CARA = { id: "cara", name: "Cara", tier: "partner", phones: ["+14155550191"], emails: [] };

  async function linkFor(c: Awaited<ReturnType<typeof start>>) {
    const { cookie, csrf } = await c.signedIn();
    const res = await c.post("/contacts/connect-link", { contactId: "cara", name: "Cara", csrf }, cookie);
    expect(res.status).toBe(200);
    const url = /(http:\/\/localhost:8790\/connect\/[A-Za-z0-9._-]+)/.exec(await res.text())?.[1];
    expect(url).toBeDefined();
    return new URL(url!).pathname;
  }

  it("Evan makes a link on People; opening it (no sign-in) offers Gmail and Calendar, and connecting tags the account as hers", async () => {
    const client = new FakeClient({ "contacts.list": () => [CARA], "policy.get": () => POLICY, "apps.connect": () => ({ url: "https://connect.composio.dev/x" }) });
    const c = await start({ client });
    const people = await (await c.get("/contacts", (await c.signedIn()).cookie)).text();
    expect(people).toContain('action="/contacts/connect-link"');
    const path = await linkFor(c);
    const page = await (await c.get(path)).text();
    expect(page).toContain("Cara");
    expect(page).toContain("Gmail");
    const go = await c.post(path, { toolkit: "gmail" });
    expect(go.status).toBe(303);
    expect(go.headers.get("location")).toBe("https://connect.composio.dev/x");
    expect(client.calls.at(-1)).toEqual(["apps.connect", { toolkit: "gmail", person: "cara", callbackUrl: `http://localhost:8790${path}/done` }]);
    expect((await (await c.get(`${path}/done`)).text())).toContain("connected");
  });

  it("a member's page offers mail and calendar apps (Outlook too), shows whether her texts work, and refuses other apps", async () => {
    const client = new FakeClient({ "contacts.list": () => [CARA], "policy.get": () => POLICY, "apps.connect": () => ({ url: "https://connect.composio.dev/x" }), "texting.status": () => ({ number: "+16504849720", handle: "kloru-marshalls" }) });
    const c = await start({ client });
    const path = await linkFor(c);
    const page = await (await c.get(path)).text();
    expect(page).toContain("Outlook");
    expect(page).toContain("(650) 484-9720");
    expect(page).toContain("connect @kloru-marshalls");
    expect(client.calls.find(([op]) => op === "texting.status")![1]).toEqual({ person: "cara" });
    expect((await c.post(path, { toolkit: "outlook" })).status).toBe(303);
    expect((await c.post(path, { toolkit: "notion" })).status).toBe(400);
  });

  it("a tampered, unknown or expired link shows a plain error and no connect button", async () => {
    const client = new FakeClient({ "contacts.list": () => [CARA], "policy.get": () => POLICY, "apps.connect": () => ({ url: "https://x" }) });
    const c = await start({ client });
    const path = await linkFor(c);
    const tampered = path.slice(0, -2) + (path.endsWith("AA") ? "BB" : "AA");
    for (const p of [tampered, "/connect/nope"]) {
      const res = await c.get(p);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("Gmail");
      expect((await c.post(p, { toolkit: "gmail" })).status).toBe(404);
    }
    expect(client.calls.filter(([op]) => op === "apps.connect")).toEqual([]);
  });
});

describe("console: automations (recurring jobs)", () => {
  const list = [
    { id: "s_1", name: "Morning <debrief>", when: "weekdays at 7:00 AM", request: "Text me my day", enabled: true, nextRunAt: "2026-11-02T15:00:00.000Z", for: "Evan" },
    { id: "s_2", name: "Rent reminder", when: "on the 1st", request: "Remind me to pay rent", enabled: false, for: "Evan" },
  ];

  it("lists them in words, escaped, with pause or resume and delete", async () => {
    const c = await start({ client: new FakeClient({ "automations.list": () => list }) });
    const page = await (await c.get("/automations", (await c.signedIn()).cookie)).text();
    expect(page).toContain("Morning &lt;debrief&gt;");
    expect(page).toContain("weekdays at 7:00 AM");
    expect(page).toContain("Text me my day");
    expect(page).toMatch(/name="enabled" value="false"[^>]*>\s*pause/i);
    expect(page).toMatch(/name="enabled" value="true"[^>]*>\s*resume/i);
    expect(page).toContain('action="/automations/delete"');
    expect(page).toContain('href="/automations"');
  });

  it("with none, says how to make one", async () => {
    const c = await start({ client: new FakeClient({ "automations.list": () => [] }) });
    const page = await (await c.get("/automations", (await c.signedIn()).cookie)).text();
    expect(page).toMatch(/every weekday at 7/i);
  });

  it("pause and delete call the agent and come back to the list", async () => {
    const client = new FakeClient({ "automations.pause": () => ({ ok: true }), "automations.delete": () => ({ ok: true }), "automations.list": () => list });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn();
    const r1 = await c.post("/automations/pause", { id: "s_1", enabled: "false", csrf }, cookie);
    expect(r1.status).toBe(303);
    expect(client.calls.at(-1)).toEqual(["automations.pause", { id: "s_1", enabled: false }]);
    const r2 = await c.post("/automations/delete", { id: "s_1", csrf }, cookie);
    expect(r2.status).toBe(303);
    expect(r2.headers.get("location")).toMatch(/^\/automations/);
    expect(client.calls.at(-1)).toEqual(["automations.delete", { id: "s_1" }]);
  });
});

describe("artifact pages: Notion-style, editable by the family", () => {
  function published(markdown = "# Flights\n\n- Delta 2:08 PM\n\n![Tour](/m/m_0123456789abcdef.mp4)\n\n</script><script>alert(1)</script>") {
    const dir = join(mkdtempSync(join(tmpdir(), "desk-")), "repo");
    const repo = new Repo(dir);
    const call = repo.startCall({ callSid: "imessage:1", phone: ADMIN, channel: "imessage" });
    const issue = repo.newIssue({ request: "Flights", filedBy: { phone: ADMIN, call: call.id }, baseTurn: 0 });
    const id = "Qm9vZ2xlR29vZ2xlR29vZ2";
    repo.saveArtifact({ id, title: "Atlanta flights", markdown, issue: issue.id, call: call.id, phone: ADMIN, createdAt: new Date().toISOString() });
    return { dir, id };
  }
  const data = (html: string) => JSON.parse(/<script type="application\/json" id="kloru-page-data">([\s\S]*?)<\/script>/.exec(html)![1]!);

  it("anyone with the link can edit, without signing in, using that page's own edit key", async () => {
    const p = published();
    const client = new FakeClient({ "artifacts.update": () => ({ ok: true, version: 2 }) });
    const c = await start({ deskDir: p.dir, client });
    const d = data(await (await c.get(`/a/${p.id}`)).text());
    expect(d.editable).toBe(true);
    expect(d.csrf).toMatch(/^[\w-]{20,}$/);
    const save = (key: string, id = p.id) => fetch(`${c.base}/a/${id}/edit`, { method: "POST", headers: { "content-type": "application/json", "x-csrf": key }, body: JSON.stringify({ markdown: "# Flights\n\n- United 1:15 PM" }) });
    expect((await save(d.csrf)).status).toBe(200);
    expect(client.calls.at(-1)).toEqual(["artifacts.update", { id: p.id, markdown: "# Flights\n\n- United 1:15 PM", phone: ADMIN, by: "link" }]);
    expect((await save("not-the-key")).status).toBe(403);
    expect((await save("")).status).toBe(403);
  });

  it("an upload without signing in works with the page's key, and belongs to the page's owner", async () => {
    const p = published();
    const c = await start({ deskDir: p.dir });
    const d = data(await (await c.get(`/a/${p.id}`)).text());
    const res = await fetch(`${c.base}/a/${p.id}/upload`, { method: "POST", headers: { "x-csrf": d.csrf, "content-type": "image/png", "x-filename": "x.png" }, body: new Uint8Array([1, 2]) });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(new MediaStore(join(p.dir, "media")).get(url.slice(3))?.item.phone).toBe(ADMIN);
  });

  it("loads the editor for anyone with the link, with the page's Markdown safely embedded", async () => {
    const p = published();
    const c = await start({ deskDir: p.dir });
    const res = await c.get(`/a/${p.id}`);
    const html = await res.text();
    expect(html).toMatch(/<script type="module" src="\/static\/editor\.js(\?v=[0-9a-f]{12})?"><\/script>/);
    expect(html).toMatch(/href="\/static\/editor\.css(\?v=[0-9a-f]{12})?"/);
    expect(html).not.toMatch(/<\/script><script>alert/);
    expect(data(html)).toMatchObject({ id: p.id, title: "Atlanta flights", editable: true });
    expect(data(html).markdown).toContain("</script><script>alert(1)</script>");
    expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self'/);
    expect(html).toContain('id="kloru-fallback"');
  });

  it("is editable when a family member is signed in; edits save through the agent as Markdown", async () => {
    const p = published();
    const client = new FakeClient({ "artifacts.update": () => ({ ok: true, version: 2 }) });
    const c = await start({ deskDir: p.dir, client });
    const { cookie, csrf } = await c.signedIn();
    expect(data(await (await c.get(`/a/${p.id}`, cookie)).text())).toMatchObject({ editable: true });
    const key = data(await (await c.get(`/a/${p.id}`, cookie)).text()).csrf as string;
    const save = (headers: Record<string, string>) => fetch(`${c.base}/a/${p.id}/edit`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ markdown: "# Flights\n\n- United 1:15 PM" }) });
    expect((await save({ cookie, "x-csrf": key })).status).toBe(200);
    expect(client.calls.at(-1)).toEqual(["artifacts.update", { id: p.id, markdown: "# Flights\n\n- United 1:15 PM", phone: ADMIN, by: ADMIN }]);
    expect((await save({ cookie, "x-csrf": "wrong" })).status).toBe(403);
  });

  it("an uploaded file goes in the media store and comes back as a /m/ link", async () => {
    const p = published();
    const c = await start({ deskDir: p.dir });
    const { cookie } = await c.signedIn();
    const key = data(await (await c.get(`/a/${p.id}`, cookie)).text()).csrf as string;
    const res = await fetch(`${c.base}/a/${p.id}/upload`, { method: "POST", headers: { cookie, "x-csrf": key, "content-type": "image/png", "x-filename": "receipt.png" }, body: new Uint8Array([137, 80, 78, 71]) });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    expect(url).toMatch(/^\/m\/m_[0-9a-f]{16}\.png$/);
    expect(new MediaStore(join(p.dir, "media")).get(url.slice(3))?.item).toMatchObject({ mime: "image/png", name: "receipt.png", phone: ADMIN });
  });

  it("media is served by id with its type: pictures and players inline, anything else as a download", async () => {
    const p = published();
    const store = new MediaStore(join(p.dir, "media"));
    const png = store.put(new Uint8Array([1, 2, 3]), { mime: "image/png", name: "a.png", phone: ADMIN });
    const svg = store.put(new TextEncoder().encode("<svg onload=alert(1)/>"), { mime: "image/svg+xml", name: "b.svg", phone: ADMIN });
    const c = await start({ deskDir: p.dir });
    const r1 = await c.get(`/m/${png.id}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("image/png");
    expect(r1.headers.get("content-disposition")).toMatch(/^inline/);
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await c.get(`/m/${svg.id}`)).headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await c.get("/m/m_ffffffffffffffff.png")).status).toBe(404);
    expect((await c.get("/m/..%2Fissues")).status).toBe(404);
  });
});

describe("console: everyone in the family signs in (2026-11-02)", () => {
  const CARA = "+14155550191";
  const DAD = "+14155550123";
  const STRANGER = "+14155550199";
  const family = () =>
    new FakeClient({
      "family.lookup": (a) => (a.phone === CARA ? { role: "owner", name: "Cara" } : a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null),
      "apps.list": () => [{ slug: "gmail", connected: false, accounts: [] }],
      "texting.status": () => ({ number: "+16504849720", connected: false }),
      "apps.connect": () => ({ url: "https://composio.example/connect" }),
    });
  const preOf = async (c: Awaited<ReturnType<typeof start>>) => {
    const home = await c.get("/signin");
    return { pre: home.headers.get("set-cookie")!.split(";")[0]!, token: /name="pre" value="([^"]+)"/.exec(await home.text())![1]! };
  };

  it("an owner and a member get a code with no invite; a stranger doesn't", async () => {
    const c = await start({ client: family() });
    const { pre, token } = await preOf(c);
    for (const phone of [CARA, DAD]) expect((await c.post("/signin/start", { phone, pre: token }, pre)).status).toBe(200);
    expect((await c.post("/signin/start", { phone: STRANGER, pre: token }, pre)).status).toBe(403);
    expect(c.verifier.sent).toEqual([CARA, DAD]);
  });

  it("signing in links the family's Kloru; a co-owner sees the owners' pages", async () => {
    const c = await start({ client: family() });
    const { pre, token } = await preOf(c);
    await c.post("/signin/start", { phone: CARA, pre: token }, pre);
    expect((await c.post("/signin/check", { phone: CARA, code: "123456", pre: token }, pre)).status).toBe(303);
    expect((await c.store.userByPhone(CARA))!.agent).toBeDefined();
    const page = await (await c.get("/connections", (await c.signedIn(CARA)).cookie)).text();
    expect(page).not.toContain("Owners only");
    expect(page).not.toContain("Hi Cara");
  });

  it("a member linked to the family's Kloru never reaches the owners' pages, even when the lookup fails (review, 2026-11-02)", async () => {
    let down = false;
    const client = new FakeClient({
      "family.lookup": (a) => {
        if (down) throw new AgentError(502, "agent down");
        return a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null;
      },
      "policy.get": () => POLICY,
      "texting.status": () => ({}),
    });
    const c = await start({ client });
    await c.store.invite(DAD, ADMIN);
    const dad = await c.signedIn(DAD);
    const u = (await c.store.userByPhone(DAD))!;
    await c.store.upsertUser({ ...u, agent: { kind: "direct", url: "http://127.0.0.1:8080", tokenEnv: "INSTINCT_CHAT_TOKEN", secretEnv: "OWNER_API_SECRET" } });
    expect((await c.get("/permissions", dad.cookie)).status).toBe(403);
    down = true;
    await new Promise((r) => setTimeout(r, 5));
    const res = await c.get("/permissions", dad.cookie);
    expect(res.status).toBe(403);
    expect(client.calls.filter(([op]) => op === "policy.get")).toEqual([]);
  });

  it("a member gets their own accounts and nothing of the owners'", async () => {
    const client = family();
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn(DAD);
    const mine = await (await c.get("/connections", cookie)).text();
    expect(mine).toContain("Hi Dad");
    expect(mine).toContain(`name="csrf" value="${csrf}"`);
    expect((await c.get("/permissions", cookie)).status).toBe(403);
    expect((await c.get("/admin", cookie)).status).toBe(403);
    expect((await c.post("/connections", { toolkit: "gmail", csrf: "wrong" }, cookie)).status).toBe(403);
    const go = await c.post("/connections", { toolkit: "gmail", csrf }, cookie);
    expect(go.status).toBe(303);
    expect(client.calls.find(([op]) => op === "apps.connect")?.[1]).toMatchObject({ toolkit: "gmail", person: "dad" });
  });
});

describe("console: each person's own policy (2026-11-02)", () => {
  const DAD = "+14155550123";
  it("anyone in the family reads and saves only their own policy", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const client = new FakeClient({
      "family.lookup": (a) => (a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null),
      "mypolicy.get": (a) => ({ text: a.phone === DAD ? "- Evan can add to my calendar." : "" }),
      "mypolicy.set": (a) => (saved.push(a), { commit: "abc" }),
    });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn(DAD);
    const page = await (await c.get("/policy", cookie)).text();
    expect(page).toContain("- Evan can add to my calendar.");
    expect((await c.post("/policy", { text: "x", csrf: "wrong" }, cookie)).status).toBe(403);
    expect((await c.post("/policy", { text: "- Nobody reads my mail.", csrf, phone: "+14155550190" }, cookie)).status).toBe(303);
    expect(saved).toEqual([{ phone: DAD, text: "- Nobody reads my mail." }]);
  });
});

describe("console: the vault (2026-11-02)", () => {
  const DAD = "+14155550123";
  it("a person saves a card; the page shows only its last 4, and the agent gets it for their phone", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const removed: Array<Record<string, unknown>> = [];
    const client = new FakeClient({
      "family.lookup": (a) => (a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null),
      "vault.list": () => [{ name: "dad-visa", kind: "card", meta: { brand: "Visa", last4: "4242", limits: { perPurchaseUsd: 50 } }, createdAt: "2026-11-02T00:00:00Z" }],
      "vault.add": (a) => (saved.push(a), { saved: true }),
      "vault.remove": (a) => (removed.push(a), { removed: true }),
    });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn(DAD);
    const page = await (await c.get("/vault", cookie)).text();
    expect(page).toContain("Visa ending 4242");
    expect(page).toContain("up to $50 a purchase");
    expect((await c.post("/vault/add", { csrf: "nope", kind: "card", name: "x" }, cookie)).status).toBe(403);
    const res = await c.post("/vault/add", { csrf, kind: "card", name: "dad-visa", number: "4242 4242 4242 4242", exp: "12/29", cvc: "123", cardname: "Dad", zip: "94105", brand: "Visa", per_purchase: "50", phone: "+14155550190" }, cookie);
    expect(res.status).toBe(303);
    expect(saved).toEqual([{ phone: DAD, entry: { name: "dad-visa", kind: "card", meta: { brand: "Visa", expYear: "2029", limits: { perPurchaseUsd: 50 } }, secret: { number: "4242424242424242", exp: "12/29", cvc: "123", name: "Dad", zip: "94105" } } }]);
    await c.post("/vault/remove", { csrf, name: "dad-visa" }, cookie);
    expect(removed).toEqual([{ phone: DAD, name: "dad-visa" }]);
  });
  it("a person exports their own vault as a CSV a password manager imports, and only by a fresh POST", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const client = new FakeClient({
      "family.lookup": (a) => (a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null),
      "vault.list": () => [{ name: "dad-acme", kind: "login", meta: { site: "acme.com", username: "dad@x.com" }, createdAt: "2026-11-02T00:00:00Z", createdBy: "kloru" }],
      "vault.export": (a) => (asked.push(a), [
        { name: "dad-acme", kind: "login", meta: { site: "acme.com", username: "dad@x.com" }, secret: { password: 'p,"w' }, createdBy: "kloru" },
        { name: "dad-visa", kind: "card", meta: { brand: "Visa" }, secret: { number: "4242424242424242", exp: "12/29", cvc: "123" }, createdBy: DAD },
      ]),
    });
    const c = await start({ client });
    const { cookie, csrf } = await c.signedIn(DAD);
    const page = await (await c.get("/vault", cookie)).text();
    expect(page).toContain("made by Kloru");
    expect(page).toContain('action="/vault/export"');
    expect((await c.get("/vault/export", cookie)).status).not.toBe(200);
    expect((await c.post("/vault/export", { csrf: "nope" }, cookie)).status).toBe(403);
    const res = await c.post("/vault/export", { csrf, phone: "+14155550190" }, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="kloru-vault-/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toBe("name,url,username,password,note,kind,card_number,card_exp,card_cvc,card_name,card_zip,api_key,made_by");
    expect(csv).toContain('dad-acme,https://acme.com,dad@x.com,"p,""w",,login,');
    expect(csv).toContain("4242424242424242,12/29,123");
    expect(asked).toEqual([{ phone: DAD }]);
  });
});

describe("a takeover link (2026-11-03)", () => {
  const DAD = "+14155550123";
  const TOKEN = "Abc_def-ghijklmnopqrstuvwxyz012345";
  it("only the signed-in person drives the tab: frames and taps go to the agent with their own phone, taps need the page's key", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const client = new FakeClient({
      "family.lookup": (a) => (a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null),
      "takeover.frame": (a) => (calls.push(["frame", a]), { image: "AAAA", width: 430, height: 860, url: "https://parking.flysfo.com", title: "Pay", reason: "Tick the box" }),
      "takeover.input": (a) => (calls.push(["input", a]), { ok: true }),
      "takeover.done": (a) => (calls.push(["done", a]), { done: true }),
    });
    const c = await start({ client });
    expect((await c.get(`/b/${TOKEN}`)).headers.get("location")).toBe(`/signin?next=${encodeURIComponent(`/b/${TOKEN}`)}`);
    const { cookie, csrf } = await c.signedIn(DAD);
    const page = await (await c.get(`/b/${TOKEN}`, cookie)).text();
    expect(page).toContain(`data-token="${TOKEN}"`);
    expect(page).toContain("/static/takeover.js");
    expect(await (await c.get(`/b/${TOKEN}/frame`, cookie)).json()).toMatchObject({ reason: "Tick the box", width: 430 });
    const tap = (key: string) => fetch(`${c.base}/b/${TOKEN}/input`, { method: "POST", headers: { cookie, "x-csrf": key, "content-type": "application/json" }, body: JSON.stringify({ kind: "click", x: 10, y: 20, phone: "+14155550190" }) });
    expect((await tap("nope")).status).toBe(403);
    expect((await tap(csrf)).status).toBe(200);
    await fetch(`${c.base}/b/${TOKEN}/done`, { method: "POST", headers: { cookie, "x-csrf": csrf } });
    expect(calls).toEqual([
      ["frame", { token: TOKEN, phone: DAD }],
      ["input", { token: TOKEN, phone: DAD, input: { kind: "click", x: 10, y: 20, phone: "+14155550190" } }],
      ["done", { token: TOKEN, phone: DAD, input: {} }],
    ]);
  });
});

describe("admin metrics (2026-11-03)", () => {
  const day = (date: string, models: number) => ({ date, cost: { models, phone: 0.5, browser: null, speech: 0.1, hosting: 0.52 }, modelSource: "openrouter" as const, desk: { engineer: models / 2 }, requests: { filed: 3, finished: 2, failed: 0 }, actions: { "emails handled": 12 }, minutesSaved: 45 });
  const report = { generatedAt: "2026-11-03T20:00:00Z", days: [day("2026-11-02", 6.75), day("2026-11-03", 16.52)], totals: { today: 17.64, week: 31.6, month: 31.6, requestsFinished: 4, minutesSaved: 90, activePeople: 2 }, people: [{ name: "Evan", phone: "…0190", conversations: 12, requests: 30, minutesSaved: 80, costUsd: 20.1 }], recent: [{ id: 269, at: "2026-11-03T06:47:00Z", who: "Evan", request: "Book SFO long term parking", outcome: "resolved", costUsd: 0.42, minutes: 15 }], sources: ["Models: OpenRouter's usage for Kloru's keys, recorded hourly."] };
  it("an admin sees cost, what got done, time saved and who; the rest of the family doesn't", async () => {
    const DAD = "+14155550123";
    const client = new FakeClient({ "metrics.get": () => report, "family.lookup": (a) => (a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null) });
    const c = await start({ client });
    const html = await (await c.get("/admin/metrics", (await c.signedIn()).cookie)).text();
    expect(html).toContain("$17.64");
    expect(html).toContain("1.5 h");
    expect(html).toContain("Browser usage isn't available.");
    expect(html).toContain('href="/admin/desk/issues/269"');
    expect(html).toContain("<svg class=\"m-chart\"");
    expect(html).toContain("usage for Kloru&#39;s keys");
    expect((await c.get("/admin/metrics", (await c.signedIn(DAD)).cookie)).status).toBe(403);
  });
});

describe("Get started (2026-11-03)", () => {
  const fresh = { apps: [], family: 0, texting: { number: "+14155550199", handle: "jordan-kloru" }, vault: 0, policy: false, conversations: 0 };
  it("a new owner gets the checklist; each step links to the page that does it", async () => {
    const client = new FakeClient({ "setup.status": () => fresh });
    const c = await start({ client });
    const html = await (await c.get("/start", (await c.signedIn()).cookie)).text();
    expect(html).toContain("4 steps to go");
    expect(html).toContain('href="/connections">Connect Gmail and Google Calendar');
    expect(html).toContain('href="/contacts">Add people');
    expect(html).toContain("connect @jordan-kloru");
    expect(html).toContain('href="/vault"');
  });

  it("a member's checklist has no 'add your family', and a finished one steps aside", async () => {
    const DAD = "+14155550123";
    let status: typeof fresh = { ...fresh };
    const client = new FakeClient({ "setup.status": () => status, "family.lookup": (a) => (a.phone === DAD ? { role: "member", name: "Dad", person: "dad" } : null) });
    const c = await start({ client });
    const dad = (await c.signedIn(DAD)).cookie;
    expect(await (await c.get("/start", dad)).text()).not.toContain("Add your family");
    status = { ...fresh, apps: ["gmail"], texting: { ...fresh.texting, texted: "2026-11-03T20:00:00Z" }, conversations: 2 };
    expect((await c.get("/start", dad)).headers.get("location")).toBe("/connections");
    expect((await c.get("/start?show=1", dad)).status).toBe(200);
  });
});

describe("a self-hosted Kloru's legal pages (2026-11-03)", () => {
  it("name its own site and contact address", async () => {
    const c = await start({ publicUrl: "https://kloru.example.com", operator: { contact: "sam@example.com" } });
    const html = await (await c.get("/privacy")).text();
    expect(html).toContain("sam@example.com");
    expect(html).not.toMatch(/privacy@kloru\.com|[^.]kloru\.com/);
    expect(html).toContain("kloru.example.com");
  });
});
