/**
 * The Kloru console's HTTP server. Plain node:http, server-rendered pages.
 *
 * Sign-in: a phone number and a code texted through Twilio Verify. Codes only ever go to
 * admin or invited numbers, with per-number and per-address limits, so the form can't be
 * used to run up text charges. Access is re-checked on every request; every POST carries
 * the session's CSRF token (or, before sign-in, the pre-sign-in cookie's token).
 * Everything a page shows about the agent comes from that person's own agent, through
 * AgentClient; agent failures become banners, never error pages.
 */
import { makeConnectToken, readConnectToken } from "./connect-link.js";
import { readCalls } from "./calls.js";
import { readTranscript } from "./transcripts.js";
import { ARTIFACT_ID, MEDIA_ID, MediaStore } from "@kloru/desk";
import { automationsSection, storeSection, artifactGonePage, artifactPage, artifactsSection, revokeArtifact, revokedArtifacts, deskCallPage, deskPage, issuePage, ledgerPage, memoryCommitPage, memoryFile, memoryPage, openMemory, openRepo, publicDiff, readAlerts } from "./desk-pages.js";
import { improveKloru, setImproveKloru } from "./prefs.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { AgentError, type AgentClient } from "./agent-client.js";
import { type Banner, esc, layout } from "./html.js";
import { metricsPage, type MetricsView } from "./metrics-page.js";
import { setupDone, startPage, type SetupStatus } from "./start-page.js";
import { policyPage, takeoverPage, vaultPage, type VaultView,
  type ApprovalView,
  type AppStatus,
  type AppSearch,
  type CatalogHit,
  type ContactView,
  type PolicyView,
  adminPage,
  transcriptPage,
  settingsPage,
  approvalsPage,
  automationsPage,
  type AutomationView,
  codePage,
  confirmApprovalPage,
  connectionsPage,
  contactsPage,
  connectPage,
  MEMBER_APPS,
  type PaymentsView,
  type TextingView,
  homePage,
  messageBody,
  whyPage,
  permissionsPage,
  signInPage,
  toolkitName,
} from "./pages.js";
import { privacyPage, termsPage } from "./legal.js";
import { RateLimiter } from "./limits.js";
import { safeNext } from "./safe-next.js";
import { PRE_COOKIE, clearSessionCookie, cookieValue, newSession, readSession, sessionCookie, signSession, SESSION_TTL_MS } from "./session.js";
import { type AgentRef, type ConsoleStore, type ConsoleUser, isPhone, normPhone } from "./store.js";
import { type PhoneVerifier, VerifyError } from "./verify.js";

export interface ConsoleOptions {
  store: ConsoleStore;
  sessionSecret: string;
  /** Where people reach the console, e.g. https://app.kloru.com. Used for return URLs. */
  publicUrl: string;
  /** Who runs this Kloru, for the privacy and terms pages: kloru.com's own wording when unset. */
  operator?: { contact?: string };
  /** Admin phone numbers; always allowed to sign in. */
  adminPhones: string[];
  /** Texts and checks sign-in codes (Twilio Verify). */
  verifier: PhoneVerifier;
  /** The agent client for a user, or undefined when none is assigned. */
  clientFor(user: ConsoleUser): AgentClient | undefined;
  /** The agent whose desk holds the pages, for edits made by link without signing in. */
  pageClient?: () => AgentClient | undefined;
  /** Count sign-in attempts by Fly-Client-IP / X-Forwarded-For (only behind a proxy you run). */
  trustProxy?: boolean;
  staticDir: string;
  /** Assigned to an admin who signs in without an agent (local development). */
  devAgent?: AgentRef;
  /** The voice service's call log (JSON lines), shown on the Admin page. */
  callLogPath?: string;
  /** The voice service's per-call transcripts, readable from the Admin page. */
  transcriptsDir?: string;
  /** The agent's desk repository (calls, issues, ledger, memory), read-only on Admin › Desk. */
  deskDir?: string;
  /** The release this Kloru runs (git-<commit>, set by setup.py's deploys), shown on the Admin page. */
  version?: string;
  /** Failed after-call checks (voice/checks.py), shown on Admin › Desk. */
  alertsPath?: string;
  /** Artifact ids an admin took down; the website's own file (it never writes the desk). */
  revokedArtifactsPath?: string;
  /** Per-person voice preferences shared with the voice service. Unset: no Settings page. */
  prefsPath?: string;
  log?: (m: string) => void;
}

const FORM_LIMIT = 64 * 1024;
const CODES_PER_PHONE = 3; // per 10 minutes
const CODES_PER_ADDRESS = 10; // per hour
const CHECKS_PER_PHONE = 5; // per 10 minutes
const STATIC: Record<string, string> = { "app.css": "text/css; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "optin.png": "image/png", "editor.js": "text/javascript; charset=utf-8", "editor.css": "text/css; charset=utf-8", "takeover.js": "text/javascript; charset=utf-8", "takeover.css": "text/css; charset=utf-8" };
/** A page loads only its own editor script; media and PDFs come from this site. */
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self'; frame-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const UPLOAD_LIMIT = 25 * 1024 * 1024;
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; form-action 'self' https://*.composio.dev https://accounts.google.com; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const DONE: Record<string, string> = {
  saved: "Saved.",
  disconnected: "Disconnected.",
  deleted: "Deleted.",
  approved: "Approved. Your agent is carrying on.",
  denied: "Denied. Your agent has been told.",
  added: "Saved.",
  granted: "Allowed.",
  revoked: "Removed.",
  invited: "Invited.",
  uninvited: "Invite removed.",
};

type Section = "connections" | "permissions" | "approvals" | "contacts" | "automations";

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  user?: ConsoleUser;
  csrf?: string;
}

export function createConsole(o: ConsoleOptions): http.Server {
  const log = o.log ?? (() => {});
  const secure = o.publicUrl.startsWith("https://");
  const admins = new Set(o.adminPhones.map(normPhone));
  // Who a phone is in the family, from the agent: owners and members sign in without an invite.
  // Answers are kept a minute; a failed lookup isn't kept, and gives no one more than they'd get without it.
  type Family = { role: "owner" | "member"; name: string; person?: string };
  const FAMILY_TTL = 60_000;
  const families = new Map<string, { at: number; who: Family | undefined }>();
  const familyOf = async (phone: string): Promise<{ who?: Family; failed?: boolean }> => {
    const hit = families.get(phone);
    if (hit && Date.now() - hit.at < FAMILY_TTL) return hit.who ? { who: hit.who } : {};
    const client = o.pageClient?.();
    if (!client) return {};
    try {
      const who = (await client.call<Family | null>("family.lookup", { phone })) ?? undefined;
      if (families.size > 1000) families.clear();
      families.set(phone, { at: Date.now(), who });
      return who ? { who } : {};
    } catch (err) {
      families.delete(phone);
      // An agent that doesn't know the lookup (an older one) has no family to say; anything else is a failed check.
      return err instanceof AgentError && err.status === 404 ? {} : { failed: true };
    }
  };
  /** What this request found the phone to be (allowed() looks it up first, every request). */
  const familyNow = (phone: string): Family | undefined => {
    const hit = families.get(phone);
    return hit && Date.now() - hit.at < FAMILY_TTL ? hit.who : undefined;
  };
  // An owner (Evan, a co-owner) is an admin.
  const isAdmin = (u: ConsoleUser | undefined) => !!u && (admins.has(u.phone) || familyNow(u.phone)?.role === "owner");
  const memberOf = (u: ConsoleUser | undefined) => (u && !isAdmin(u) && familyNow(u.phone)?.role === "member" ? familyNow(u.phone) : undefined);
  const allowed = async (phone: string) => admins.has(phone) || !!(await familyOf(phone)).who || (await o.store.isInvited(phone));
  const sendsPerPhone = new RateLimiter(CODES_PER_PHONE, 10 * 60_000);
  const sendsPerAddress = new RateLimiter(CODES_PER_ADDRESS, 60 * 60_000);
  const checksPerPhone = new RateLimiter(CHECKS_PER_PHONE, 10 * 60_000);
  // Behind Fly, the edge sets Fly-Client-IP (it overwrites any client-sent value); elsewhere, the first X-Forwarded-For hop.
  const addressOf = (req: http.IncomingMessage): string => {
    if (!o.trustProxy) return req.socket.remoteAddress || "unknown";
    const fly = String(req.headers["fly-client-ip"] ?? "").trim();
    const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim();
    return fly || fwd || req.socket.remoteAddress || "unknown";
  };
  const staticFiles = new Map<string, Buffer>();
  /** A page's edit key: anyone holding the page can edit it; another site can't learn the key. */
  const editKey = (id: string) => createHmac("sha256", o.sessionSecret).update(`page-edit:${id}`).digest("base64url").slice(0, 32);
  const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  /** The editor's content hash, so a page always loads the editor it was served with. */
  let editorVersion = "";
  for (const name of Object.keys(STATIC)) {
    try {
      staticFiles.set(name, readFileSync(join(o.staticDir, name)));
    } catch {
      log(`static file missing: ${name}`);
    }
  }

  {
    const js = staticFiles.get("editor.js");
    if (js) editorVersion = createHash("sha256").update(js).update(staticFiles.get("editor.css") ?? "").digest("hex").slice(0, 12);
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS });
    res.end(JSON.stringify(body));
  }

  function send(res: http.ServerResponse, status: number, body: string, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }

  function redirect(res: http.ServerResponse, status: 302 | 303, location: string, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { location, "cache-control": "no-store", ...SECURITY_HEADERS, ...headers });
    res.end();
  }

  function page(ctx: Ctx, status: number, title: string, body: string, banner?: Banner, active?: string): void {
    send(ctx.res, status, layout({ title, body, ...(banner ? { banner } : {}), ...(active ? { active } : {}), ...(ctx.user ? { user: { label: ctx.user.name ?? ctx.user.phone, admin: isAdmin(ctx.user) } } : {}) }));
  }

  async function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error("too large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function readForm(req: http.IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > FORM_LIMIT) throw new Error("form too large");
      chunks.push(chunk as Buffer);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }

  function agentBanner(err: unknown): Banner {
    if (err instanceof AgentError) {
      if (err.status === 0) return { kind: "error", text: "Your agent isn't responding right now. Try again in a minute." };
      return { kind: "error", text: `That didn't go through: ${err.message}` };
    }
    log(`console error: ${(err as Error).message}`);
    return { kind: "error", text: "Something went wrong. Try again." };
  }

  const NO_AGENT: Banner = { kind: "error", text: "No agent is assigned to your account yet. Ask an admin to set one up." };

  /** Render one section's GET page, optionally with a banner (from ?done= or a failed POST). */
  async function renderSection(ctx: Ctx, section: Section, banner?: Banner, status = 200): Promise<void> {
    const titles: Record<Section, string> = { connections: "Connections", permissions: "Permissions", approvals: "Approvals", contacts: "Contacts", automations: "Automations" };
    const active = `/${section}`;
    const client = o.clientFor(ctx.user!);
    if (!client) return page(ctx, status, titles[section], `<h1>${titles[section]}</h1>`, NO_AGENT, active);
    const csrf = ctx.csrf!;
    try {
      let body: string;
      if (section === "connections") {
        const apps = await client.call<AppStatus[]>("apps.list");
        const back = ctx.url.pathname === "/connections/return" ? ctx.url.searchParams.get("toolkit") : null;
        if (back && !banner) {
          const app = apps.find((a) => a.slug === back);
          // Composio sends back the account it just connected: name it, so you know which one it was.
          const added = app?.accounts?.find((x) => x.id === ctx.url.searchParams.get("connected_account_id"))?.email;
          banner = app?.connected
            ? { kind: "ok", text: added ? `${added} is connected to ${toolkitName(back)}.` : `${toolkitName(back)} is connected.` }
            : { kind: "error", text: `${toolkitName(back)} is not connected yet. If you finished signing in, give it a moment and refresh.` };
        }
        // Optional parts: an agent without texting or payments (or an older one) just leaves them out.
        const [texting, payments] = await Promise.all([
          client.call<TextingView>("texting.status", { phone: ctx.user!.phone }).catch(() => undefined),
          client.call<PaymentsView>("payments.status").catch(() => undefined),
        ]);
        // The search box (?q=): the agent's catalog of every app it can connect.
        const q = ctx.url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
        const search: AppSearch | undefined = q
          ? await client.call<{ apps: CatalogHit[]; total: number }>("apps.catalog", { q }).then(
              (r) => ({ q, ...r }),
              (err: unknown) => ({ q, apps: [], total: 0, error: err instanceof Error ? err.message : String(err) }),
            )
          : undefined;
        body = connectionsPage(apps, csrf, { ...(texting ? { texting } : {}), ...(payments ? { payments } : {}), ...(search ? { search } : {}) });
      } else if (section === "permissions") {
        body = permissionsPage(await client.call<PolicyView>("policy.get"), csrf);
      } else if (section === "approvals") {
        body = approvalsPage(await client.call<ApprovalView[]>("approvals.list"), csrf);
      } else if (section === "automations") {
        body = automationsPage(await client.call<AutomationView[]>("automations.list"), csrf);
      } else {
        const [contacts, policy] = await Promise.all([client.call<ContactView[]>("contacts.list"), client.call<PolicyView>("policy.get")]);
        body = contactsPage(contacts, policy.grants, csrf);
      }
      return page(ctx, status, titles[section], body, banner, active);
    } catch (err) {
      return page(ctx, status, titles[section], `<h1>${titles[section]}</h1>`, banner ?? agentBanner(err), active);
    }
  }

  /** Run one agent operation for a POST; success redirects to `done`, failure re-renders the section with a banner. */
  async function act(ctx: Ctx, section: Section, op: string, args: Record<string, unknown>, done: string, onResult?: (result: unknown) => string | undefined): Promise<void> {
    const client = o.clientFor(ctx.user!);
    if (!client) return renderSection(ctx, section, NO_AGENT);
    try {
      const result = await client.call(op, args);
      const location = onResult?.(result) ?? `/${section}?done=${done}`;
      return redirect(ctx.res, 303, location);
    } catch (err) {
      return renderSection(ctx, section, agentBanner(err));
    }
  }

  const list = (v: string | null) => (v ?? "").split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

  async function route(ctx: Ctx): Promise<void> {
    const { req, res, url } = ctx;
    const method = req.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (method === "GET" && path.startsWith("/static/")) {
      const name = path.slice("/static/".length);
      const file = STATIC[name] ? staticFiles.get(name) : undefined;
      if (!file) return send(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
      res.writeHead(200, { "content-type": STATIC[name]!, "cache-control": "public, max-age=3600", ...SECURITY_HEADERS });
      res.end(file);
      return;
    }
    if (method === "GET" && path === "/health") return send(res, 200, '{"ok":true}', { "content-type": "application/json" });

    // Who is this? A valid session naming a user we still know.
    const session = readSession(o.sessionSecret, req.headers.cookie);
    const user = session ? await o.store.user(session.uid) : undefined;
    // Access is re-checked on every request, so removing an invite or an admin ends existing sessions too.
    if (session && user && user.phone === normPhone(session.phone) && await allowed(user.phone)) {
      ctx.user = user;
      ctx.csrf = session.csrf;
    }

    if (method === "GET" && path.startsWith("/a/")) {
      // Anyone with the link can read it; the family, signed in, can edit. Kept out of search engines.
      const headers = { "X-Robots-Tag": "noindex, nofollow", "Content-Security-Policy": PAGE_CSP };
      const id = path.slice(3);
      const found = o.deskDir && ARTIFACT_ID.test(id) ? openRepo(o.deskDir).artifact(id) : undefined;
      if (!found) return send(res, 404, messageBody("Not found", "There's nothing here."), headers);
      if (revokedArtifacts(o.revokedArtifactsPath).has(id)) return send(res, 410, artifactGonePage(), headers);
      // Anyone with the link can edit (like a doc shared that way); every edit is a new version.
      return send(res, 200, artifactPage(found, { assets: editorVersion, editable: true, csrf: editKey(id) }), headers);
    }
    const pageAction = /^\/a\/([A-Za-z0-9_-]{22})\/(edit|upload)$/.exec(path);
    if (method === "POST" && pageAction) {
      const id = pageAction[1]!;
      // The page's own edit key, served in the page: another site can't read it, so it can't edit for you.
      if (!safeEqual(String(req.headers["x-csrf"] ?? ""), editKey(id))) return sendJson(res, 403, { error: "this page expired; reload it" });
      const page = o.deskDir ? openRepo(o.deskDir).artifact(id) : undefined;
      if (!o.deskDir || !page || revokedArtifacts(o.revokedArtifactsPath).has(id)) return sendJson(res, 404, { error: "no such page" });
      const body = await readBytes(req, pageAction[2] === "upload" ? UPLOAD_LIMIT : FORM_LIMIT).catch(() => undefined);
      if (!body) return sendJson(res, 413, { error: "too large" });
      if (pageAction[2] === "upload") {
        try {
          const name = decodeURIComponent(String(req.headers["x-filename"] ?? "upload"));
          const item = new MediaStore(join(o.deskDir, "media")).put(new Uint8Array(body), { mime: String(req.headers["content-type"] ?? ""), name, phone: page.phone });
          return sendJson(res, 200, { url: `/m/${item.id}` });
        } catch (err) {
          return sendJson(res, 400, { error: (err as Error).message });
        }
      }
      const client = ctx.user ? o.clientFor(ctx.user) : o.pageClient?.();
      if (!client) return sendJson(res, 503, { error: "no agent" });
      const markdown = (() => { try { return String((JSON.parse(body.toString("utf8")) as { markdown?: unknown }).markdown ?? ""); } catch { return ""; } })();
      if (!markdown.trim()) return sendJson(res, 400, { error: "the page would be empty" });
      try {
        // Saved as the page's owner (who may edit it), recorded as who edited: the signed-in person, or "link".
        return sendJson(res, 200, await client.call("artifacts.update", { id, markdown, phone: page.phone, by: ctx.user?.phone ?? "link" }));
      } catch (err) {
        return sendJson(res, err instanceof AgentError && err.status ? err.status : 502, { error: (err as Error).message });
      }
    }
    if (method === "GET" && path.startsWith("/m/")) {
      // A photo or file on a page: unguessable by id, its type from the store, never sniffed or run.
      const id = path.slice(3);
      const got = o.deskDir && MEDIA_ID.test(id) ? new MediaStore(join(o.deskDir, "media")).get(id) : undefined;
      if (!got) return send(res, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
      const inline = /^(image\/(jpeg|png|gif|webp)|video\/|audio\/|application\/pdf)/.test(got.item.mime);
      res.writeHead(200, {
        "content-type": got.item.mime,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(got.item.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=86400",
        "x-robots-tag": "noindex",
      });
      res.end(readFileSync(got.path));
      return;
    }
    // A self-hosted Kloru's legal pages name its own site and contact address, not kloru.com's.
    const site = (html: string) => {
      const host = new URL(o.publicUrl).host;
      if (!o.operator?.contact || host === "kloru.com") return html;
      return html.replace(/(privacy|legal|support)@kloru\.com/g, esc(o.operator.contact)).replace(/kloru\.com/g, esc(host));
    };
    if (method === "GET" && path === "/privacy") return page(ctx, 200, "Privacy policy", site(privacyPage()));
    if (method === "GET" && path === "/terms") return page(ctx, 200, "Terms of service", site(termsPage()));
    if (method === "GET" && path === "/why") return page(ctx, 200, "Why Kloru", whyPage());
    if (method === "GET" && path === "/") return ctx.user ? redirect(res, 302, "/start") : page(ctx, 200, "An assistant for your people", homePage());
    if (method === "GET" && path === "/signin") {
      if (ctx.user) return redirect(res, 302, safeNext(url.searchParams.get("next")) === "/" ? "/start" : safeNext(url.searchParams.get("next")));
      const pre = preToken(req) ?? randomBytes(18).toString("base64url");
      return send(res, 200, layout({ title: "Sign in", body: signInPage(pre, safeNext(url.searchParams.get("next"))) }), { "set-cookie": preCookie(pre) });
    }
    if (method === "GET" && path === "/logout") return redirect(res, 302, "/", { "set-cookie": clearSessionCookie(secure) });
    if (method === "POST" && (path === "/signin/start" || path === "/signin/check")) return signIn(ctx, path);

    // A family member's link from the owner: no sign-in, the signed link is the permission.
    const connect = /^\/connect\/([A-Za-z0-9_.-]+?)(\/done)?$/.exec(path);
    if (connect) {
      const claim = readConnectToken(o.sessionSecret, connect[1]!);
      const owner = claim ? await o.store.user(claim.uid) : undefined;
      const client = owner ? o.clientFor(owner) : undefined;
      if (!claim || !client) return page(ctx, 404, "Link expired", messageBody("This link doesn't work", "It may have expired. Ask for a new one."));
      const here = `/connect/${connect[1]}`;
      if (connect[2]) return method === "GET" ? page(ctx, 200, "Connected", messageBody("You're connected", "Kloru can help with that account now. Connect another, or close this page.")) : send(res, 405, "method not allowed", { "content-type": "text/plain; charset=utf-8" });
      const texting = await client.call<TextingView>("texting.status", { person: claim.person }).catch(() => undefined);
      const form = () => connectPage(claim.name, here, texting);
      if (method === "GET") return page(ctx, 200, "Connect your accounts", form());
      if (method !== "POST") return send(res, 405, "method not allowed", { "content-type": "text/plain; charset=utf-8" });
      const toolkit = (await readForm(req).catch(() => new URLSearchParams())).get("toolkit") ?? "";
      if (!MEMBER_APPS.includes(toolkit)) return page(ctx, 400, "Connect your accounts", form(), { kind: "error", text: "Pick one of the apps below." });
      try {
        const r = await client.call<{ url?: string }>("apps.connect", { toolkit, person: claim.person, callbackUrl: `${o.publicUrl.replace(/\/+$/, "")}${here}/done` });
        return r.url ? redirect(res, 303, r.url) : page(ctx, 502, "Connect your accounts", form(), { kind: "error", text: "That didn't go through. Try again." });
      } catch (err) {
        return page(ctx, 502, "Connect your accounts", form(), agentBanner(err));
      }
    }

    if (!ctx.user) {
      if (method === "GET" && (path === "/connections/return" || /^\/b\/[A-Za-z0-9_-]{20,64}$/.test(path))) return redirect(res, 302, `/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
      return redirect(res, 302, "/signin");
    }

    // Get started: a new family's checklist, each step linking to the page that does it. Once the
    // required steps are done it gets out of the way and goes to Connections.
    if (method === "GET" && path === "/start" && (isAdmin(ctx.user) || memberOf(ctx.user))) {
      const client = o.clientFor(ctx.user);
      const status = client ? await client.call<SetupStatus>("setup.status", { phone: ctx.user.phone }).catch(() => undefined) : undefined;
      if (!status) return redirect(res, 302, "/connections");
      const owner = isAdmin(ctx.user);
      if (setupDone(status, owner) && url.searchParams.get("show") !== "1") return redirect(res, 302, "/connections");
      return page(ctx, 200, "Get started", startPage(status, owner, ctx.user.name ?? ""), undefined, "/start");
    }

    // A takeover link: the person who asked finishes one step in Kloru's browser by hand. Only they,
    // signed in, can open it; the agent checks the token and their phone on every frame and tap.
    const take = /^\/b\/([A-Za-z0-9_-]{20,64})(\/frame|\/input|\/done)?$/.exec(path);
    if (take) {
      const [, token, op] = take;
      if (!ctx.user) return op ? sendJson(res, 401, { error: "sign in" }) : redirect(res, 302, `/signin?next=${encodeURIComponent(path)}`);
      const client = o.clientFor(ctx.user);
      if (!client) return op ? sendJson(res, 503, { error: "Kloru isn't reachable" }) : page(ctx, 503, "Kloru's browser", messageBody("Kloru isn't reachable", "Try again in a minute."));
      const phone = ctx.user.phone;
      if (!op && method === "GET") return send(res, 200, takeoverPage(token!, ctx.csrf!), { "x-robots-tag": "noindex" });
      if (op === "/frame" && method === "GET") return client.call("takeover.frame", { token, phone }).then((f) => sendJson(res, 200, f), () => sendJson(res, 404, { error: "This link has ended." }));
      if (method === "POST" && (op === "/input" || op === "/done")) {
        if (!safeEqual(String(req.headers["x-csrf"] ?? ""), ctx.csrf!)) return sendJson(res, 403, { error: "this page expired; reload it" });
        const body = await readBytes(req, FORM_LIMIT).catch(() => undefined);
        const input = (() => { try { return JSON.parse(body?.toString("utf8") ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
        return client.call(op === "/done" ? "takeover.done" : "takeover.input", { token, phone, input }).then((r) => sendJson(res, 200, r), () => sendJson(res, 404, { error: "This link has ended." }));
      }
    }

    // Everyone in the family keeps their own vault: always the signed-in person's entries, never their values.
    if ((path === "/vault" || path === "/vault/add" || path === "/vault/remove" || path === "/vault/export") && (isAdmin(ctx.user) || memberOf(ctx.user))) {
      const client = o.clientFor(ctx.user);
      if (!client) return page(ctx, 503, "Your vault", messageBody("Kloru isn't reachable", "Try again in a minute."));
      const show = async (status: number, banner?: Banner) => {
        const entries = await client.call<VaultView[]>("vault.list", { phone: ctx.user!.phone }).catch(() => undefined);
        return entries ? page(ctx, status, "Your vault", vaultPage(entries, ctx.csrf!), banner) : page(ctx, 502, "Your vault", messageBody("Couldn't load your vault", "Try again in a minute."));
      };
      if (method === "GET" && path === "/vault") return show(200, url.searchParams.get("done") === "vault" ? { kind: "ok", text: "Saved." } : undefined);
      if (method === "POST") {
        const f = await readForm(req).catch(() => new URLSearchParams());
        if (f.get("csrf") !== ctx.csrf) return page(ctx, 403, "Expired", messageBody("This page expired", "Reload the page and try again."));
        if (path === "/vault/export") {
          // Every value, for the signed-in person only, straight to their download: never cached, never through a model.
          const all = await client.call<VaultExport[]>("vault.export", { phone: ctx.user.phone }).catch(() => undefined);
          if (!all) return show(502, { kind: "error", text: "Couldn't export your vault. Try again in a minute." });
          res.writeHead(200, {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="kloru-vault-${new Date().toISOString().slice(0, 10)}.csv"`,
            "cache-control": "no-store",
            ...SECURITY_HEADERS,
          });
          return void res.end(vaultCsv(all));
        }
        try {
          if (path === "/vault/remove") await client.call("vault.remove", { phone: ctx.user.phone, name: f.get("name") ?? "" });
          else {
            const kind = f.get("kind") ?? "";
            const num = (k: string) => (f.get(k)?.trim() ? Number(f.get(k)) : undefined);
            const limits = { ...(num("per_purchase") ? { perPurchaseUsd: num("per_purchase") } : {}), ...(num("per_day") ? { perDayUsd: num("per_day") } : {}) };
            const exp = f.get("exp") ?? "";
            const entry =
              kind === "card" ? { kind, meta: { ...(f.get("brand") ? { brand: f.get("brand") } : {}), ...(/\d{2}\D?(\d{2})$/.test(exp) ? { expYear: `20${/(\d{2})$/.exec(exp)![1]}` } : {}), ...(Object.keys(limits).length ? { limits } : {}) }, secret: { number: (f.get("number") ?? "").replace(/\s/g, ""), exp, cvc: f.get("cvc") ?? "", name: f.get("cardname") ?? "", zip: f.get("zip") ?? "" } }
              : kind === "login" ? { kind, meta: { site: f.get("site") ?? "", username: f.get("username") ?? "" }, secret: { password: f.get("password") ?? "" } }
              : kind === "api_key" ? { kind, meta: { service: f.get("service") ?? "" }, secret: { key: f.get("key") ?? "" } }
              : undefined;
            if (!entry) return show(400, { kind: "error", text: "Pick a card, a login or an API key." });
            await client.call("vault.add", { phone: ctx.user.phone, entry: { name: f.get("name") ?? "", ...entry } });
          }
          return redirect(res, 303, "/vault?done=vault");
        } catch (err) {
          return show(400, agentBanner(err));
        }
      }
    }

    // Everyone in the family keeps their own policy.md here: always the signed-in person's, never anyone else's.
    if (path === "/policy" && (isAdmin(ctx.user) || memberOf(ctx.user))) {
      const client = o.clientFor(ctx.user);
      if (!client) return page(ctx, 503, "Your policy", messageBody("Kloru isn't reachable", "Try again in a minute."));
      if (method === "POST") {
        const f = await readForm(req).catch(() => new URLSearchParams());
        if (f.get("csrf") !== ctx.csrf) return page(ctx, 403, "Expired", messageBody("This page expired", "Reload the page and try again."));
        try {
          await client.call("mypolicy.set", { phone: ctx.user.phone, text: f.get("text") ?? "" });
          return redirect(res, 303, "/policy?done=policy");
        } catch (err) {
          return page(ctx, 502, "Your policy", policyPage(f.get("text") ?? "", ctx.csrf!), agentBanner(err));
        }
      }
      if (method === "GET") {
        const got = await client.call<{ text: string }>("mypolicy.get", { phone: ctx.user.phone }).catch(() => undefined);
        if (!got) return page(ctx, 502, "Your policy", messageBody("Couldn't load your policy", "Try again in a minute."));
        return page(ctx, 200, "Your policy", policyPage(got.text, ctx.csrf!), url.searchParams.get("done") === "policy" ? { kind: "ok", text: "Saved. Kloru follows it from your next request." } : undefined);
      }
    }

    // A family member (not an owner) has their own corner: their connections. The rest is the owners'.
    const member = memberOf(ctx.user);
    if (member) {
      const client = o.clientFor(ctx.user);
      if (!client) return page(ctx, 503, "Kloru", messageBody("Kloru isn't reachable", "Try again in a minute."));
      const texting = await client.call<TextingView>("texting.status", { ...(member.person ? { person: member.person } : {}), phone: ctx.user.phone }).catch(() => undefined);
      const form = () => connectPage(member.name, "/connections", texting, ctx.csrf);
      if (method === "GET" && (path === "/connections" || path === "/settings")) return page(ctx, 200, "Your accounts", form(), undefined, "/connections");
      if (method === "GET" && path === "/connections/return") return page(ctx, 200, "Connected", messageBody("You're connected", "Kloru can help with that account now."));
      if (method === "POST" && path === "/connections") {
        const f = await readForm(req).catch(() => new URLSearchParams());
        if (f.get("csrf") !== ctx.csrf) return page(ctx, 403, "Expired", messageBody("This page expired", "Reload the page and try again."));
        const toolkit = f.get("toolkit") ?? "";
        if (!MEMBER_APPS.includes(toolkit) || !member.person) return page(ctx, 400, "Your accounts", form(), { kind: "error", text: "Pick one of the apps below." });
        try {
          const r = await client.call<{ url?: string }>("apps.connect", { toolkit, person: member.person, callbackUrl: `${o.publicUrl.replace(/\/+$/, "")}/connections/return` });
          return r.url ? redirect(res, 303, r.url) : page(ctx, 502, "Your accounts", form(), { kind: "error", text: "That didn't go through. Try again." });
        } catch (err) {
          return page(ctx, 502, "Your accounts", form(), agentBanner(err));
        }
      }
      return page(ctx, 403, "Owners only", messageBody("Owners only", "This part of Kloru is for the family's owners. Your accounts are under Connections."));
    }
    // Everything below runs on the owner-level API: on the family's Kloru it's the owners' alone (a member
    // whose lookup failed, or who left the family, gets nothing of it). Someone with their own agent owns it.
    const onFamilyAgent = !!o.devAgent && JSON.stringify(ctx.user.agent ?? null) === JSON.stringify(o.devAgent);
    if (onFamilyAgent && !isAdmin(ctx.user)) return page(ctx, 403, "Not yet", messageBody("Not set up for you yet", "Kloru can't confirm you're one of the family's owners right now. Try again in a minute, or ask an owner."));

    if (method === "GET") {
      const done = url.searchParams.get("done");
      const banner: Banner | undefined = done && DONE[done] ? { kind: "ok", text: DONE[done]! } : undefined;
      if (path === "/connections" || path === "/connections/return") return renderSection(ctx, "connections", banner);
      if (path === "/settings" && o.prefsPath) return page(ctx, 200, "Settings", settingsPage(improveKloru(o.prefsPath, ctx.user.phone), ctx.csrf!), banner, "/settings");
      if (path === "/permissions") return renderSection(ctx, "permissions", banner);
      if (path === "/approvals") return renderSection(ctx, "approvals", banner);
      if (path === "/automations") return renderSection(ctx, "automations", banner);
      if (path === "/contacts") return renderSection(ctx, "contacts", banner);
      if (path.startsWith("/admin/calls/")) {
        if (!isAdmin(ctx.user)) return page(ctx, 403, "Admin", messageBody("Admins only", "This page is for Kloru admins."));
        const sid = path.slice("/admin/calls/".length);
        const events = o.transcriptsDir ? readTranscript(o.transcriptsDir, sid) : undefined;
        if (!events) return page(ctx, 404, "Not found", messageBody("No transcript", "There's no transcript for that call."));
        return page(ctx, 200, "Call", transcriptPage(sid, events), undefined, "/admin");
      }
      if (path === "/admin/desk" || path.startsWith("/admin/desk/")) {
        if (!isAdmin(ctx.user)) return page(ctx, 403, "Admin", messageBody("Admins only", "This page is for Kloru admins."));
        if (!o.deskDir) return page(ctx, 404, "Not found", messageBody("No desk", "This console isn't connected to a desk."));
        const notFound = () => page(ctx, 404, "Not found", messageBody("Not found", "There's nothing here."));
        const rest = path.slice("/admin/desk".length);
        const repo = openRepo(o.deskDir);
        if (rest === "") return page(ctx, 200, "Desk", deskPage(repo, readAlerts(o.alertsPath), automationsSection(o.deskDir) + storeSection(o.deskDir) + artifactsSection(repo.artifacts(), revokedArtifacts(o.revokedArtifactsPath), ctx.csrf!)), undefined, "/admin");
        if (rest === "/ledger") return page(ctx, 200, "Ledger", ledgerPage(repo), undefined, "/admin");
        const issue = /^\/issues\/(\d+)$/.exec(rest);
        if (issue) {
          const found = repo.issue(Number(issue[1]));
          return found ? page(ctx, 200, `Issue #${found.id}`, issuePage(repo, found), undefined, "/admin") : notFound();
        }
        const call = /^\/calls\/([^/]+)$/.exec(rest);
        if (call) {
          const found = repo.call(decodeURIComponent(call[1]!));
          return found ? page(ctx, 200, "Call", deskCallPage(repo, found), undefined, "/admin") : notFound();
        }
        const memory = openMemory(o.deskDir);
        if (rest === "/memory" && memory) {
          const file = url.searchParams.get("file");
          const shown = memoryFile(memory, file);
          if (file && !shown) return notFound();
          return page(ctx, 200, "Memory", memoryPage(memory, shown), undefined, "/admin");
        }
        const commit = /^\/memory\/commits\/([0-9a-f]{7,40})$/.exec(rest);
        const shown = commit && memory ? ((d) => (d === undefined ? undefined : publicDiff(d)))(memory.show(commit[1]!)) : undefined;
        return commit && shown ? page(ctx, 200, "Memory commit", memoryCommitPage(commit[1]!, shown), undefined, "/admin") : notFound();
      }
      if (path === "/admin/metrics") {
        if (!isAdmin(ctx.user)) return page(ctx, 403, "Admin", messageBody("Admins only", "This page is for Kloru admins."));
        const client = o.clientFor(ctx.user);
        const report = client ? await client.call<MetricsView>("metrics.get", { days: 30 }).catch(() => undefined) : undefined;
        return report ? page(ctx, 200, "Metrics", metricsPage(report), undefined, "/admin") : page(ctx, 502, "Metrics", messageBody("Metrics aren't available", "Kloru isn't reachable right now. Try again in a minute."), undefined, "/admin");
      }
      if (path === "/admin") {
        if (!isAdmin(ctx.user)) return page(ctx, 403, "Admin", messageBody("Admins only", "This page is for Kloru admins."));
        return page(ctx, 200, "Admin", adminPage(await o.store.users(), await o.store.invites(), ctx.csrf!, o.callLogPath ? readCalls(o.callLogPath) : undefined, !!o.transcriptsDir, !!o.deskDir, o.version), banner, "/admin");
      }
      return page(ctx, 404, "Not found", messageBody("Not found", "There's nothing here."));
    }

    if (method !== "POST") return send(res, 405, "method not allowed", { "content-type": "text/plain; charset=utf-8" });
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return send(res, 413, "form too large", { "content-type": "text/plain; charset=utf-8" });
    }
    if (form.get("csrf") !== ctx.csrf) return page(ctx, 403, "Expired", messageBody("This page expired", "Reload the page and try again."));

    switch (path) {
      case "/settings": {
        if (!o.prefsPath) break;
        const on = form.get("improve") === "on";
        try {
          setImproveKloru(o.prefsPath, ctx.user.phone, on);
        } catch (err) {
          log(`settings: could not save for ${ctx.user.id}: ${(err as Error).message}`);
          return page(ctx, 500, "Settings", settingsPage(!on, ctx.csrf!), { kind: "error", text: "That didn't save. Try again in a minute." }, "/settings");
        }
        return redirect(res, 303, "/settings?done=saved");
      }
      case "/connections/connect": {
        const toolkit = form.get("toolkit") ?? "";
        const callbackUrl = `${o.publicUrl.replace(/\/+$/, "")}/connections/return?toolkit=${encodeURIComponent(toolkit)}`;
        return act(ctx, "connections", "apps.connect", { toolkit, callbackUrl }, "saved", (r) => (r as { url?: string }).url);
      }
      case "/contacts/connect-link": {
        const person = form.get("contactId") ?? "";
        if (!person) break;
        const url = `${o.publicUrl.replace(/\/+$/, "")}/connect/${makeConnectToken(o.sessionSecret, { person, name: (form.get("name") ?? person).split(" ")[0]!, uid: ctx.user.id })}`;
        return renderSection(ctx, "contacts", { kind: "ok", text: `Send ${form.get("name") ?? "them"} this link to connect their own Gmail and Calendar (it works for 7 days): ${url}` });
      }
      case "/automations/pause":
        return act(ctx, "automations", "automations.pause", { id: form.get("id") ?? "", enabled: form.get("enabled") === "true" }, "saved");
      case "/automations/delete":
        return act(ctx, "automations", "automations.delete", { id: form.get("id") ?? "" }, "deleted");
      case "/connections/payments":
        return act(ctx, "connections", "payments.connect", {}, "saved", (r) => (r as { url?: string }).url);
      case "/connections/disconnect":
        return act(ctx, "connections", "apps.disconnect", { toolkit: form.get("toolkit") ?? "", ...(form.get("account") ? { account: form.get("account") } : {}) }, "disconnected");
      case "/permissions":
        return act(ctx, "permissions", "policy.setPermission", { tier: "owner", capability: form.get("capability") ?? "", permission: form.get("permission") ?? "" }, "saved");
      case "/approvals/settle": {
        const approved = form.get("decision") === "approve";
        const token = form.get("token") ?? "";
        const client = o.clientFor(ctx.user);
        if (!client) return renderSection(ctx, "approvals", NO_AGENT);
        try {
          await client.call("approvals.settle", { token, approved, confirm: approved && form.get("confirm") === "1" });
          return redirect(res, 303, `/approvals?done=${approved ? "approved" : "denied"}`);
        } catch (err) {
          // Money and phone calls: the agent refuses until the owner confirms on a second, server-rendered step.
          if (err instanceof AgentError && err.status === 400 && /needs confirmation/.test(err.message)) {
            const pending = await client.call<ApprovalView[]>("approvals.list").catch(() => [] as ApprovalView[]);
            const item = pending.find((p) => p.token === token.toUpperCase());
            if (item) return page(ctx, 200, "Confirm", confirmApprovalPage(item, ctx.csrf!), undefined, "/approvals");
          }
          return renderSection(ctx, "approvals", agentBanner(err));
        }
      }
      case "/contacts": {
        const id = form.get("id");
        const args: Record<string, unknown> = { ...(id ? { id } : {}), name: form.get("name") ?? "", phones: list(form.get("phones")), emails: list(form.get("emails")), tier: form.get("tier") ?? "contact" };
        return act(ctx, "contacts", "contacts.upsert", args, "added");
      }
      case "/contacts/grant": {
        const maxUsd = (form.get("maxUsd") ?? "").trim();
        // An unreadable cap must never turn into "no cap".
        if (maxUsd && !/^\d+(\.\d{1,2})?$/.test(maxUsd)) return renderSection(ctx, "contacts", { kind: "error", text: "The dollar cap must be a plain number, like 50." });
        const args: Record<string, unknown> = {
          to: `contact:${form.get("contactId") ?? ""}`,
          capabilities: form.getAll("capabilities"),
          ...(form.get("windowFrom") ? { windowFrom: form.get("windowFrom") } : {}),
          ...(form.get("windowTo") ? { windowTo: form.get("windowTo") } : {}),
          ...(maxUsd ? { maxUsd: Number(maxUsd) } : {}),
          ...(form.get("note")?.trim() ? { note: form.get("note")!.trim() } : {}),
        };
        return act(ctx, "contacts", "grants.add", args, "granted");
      }
      case "/contacts/revoke":
        return act(ctx, "contacts", "grants.revoke", { id: form.get("id") ?? "" }, "revoked");
      case "/admin/desk/artifacts/revoke": {
        if (!isAdmin(ctx.user)) return page(ctx, 403, "Admin", messageBody("Admins only", "This page is for Kloru admins."));
        const id = form.get("id") ?? "";
        if (!o.revokedArtifactsPath || !ARTIFACT_ID.test(id)) return page(ctx, 400, "Desk", messageBody("Can't take that down", "That isn't a page."));
        revokeArtifact(o.revokedArtifactsPath, id);
        return redirect(res, 303, "/admin/desk");
      }
      case "/admin/invite":
      case "/admin/uninvite": {
        if (!isAdmin(ctx.user)) return page(ctx, 403, "Admin", messageBody("Admins only", "This page is for Kloru admins."));
        const phone = form.get("phone") ?? "";
        if (!isPhone(phone)) return page(ctx, 200, "Admin", adminPage(await o.store.users(), await o.store.invites(), ctx.csrf!, o.callLogPath ? readCalls(o.callLogPath) : undefined, !!o.transcriptsDir, !!o.deskDir, o.version), { kind: "error", text: "That doesn't look like a phone number. Include the area code." }, "/admin");
        if (path === "/admin/invite") await o.store.invite(phone, ctx.user.phone);
        else await o.store.removeInvite(phone);
        return redirect(res, 303, `/admin?done=${path === "/admin/invite" ? "invited" : "uninvited"}`);
      }
    }
    return page(ctx, 404, "Not found", messageBody("Not found", "There's nothing here."));
  }

  function preToken(req: http.IncomingMessage): string | undefined {
    const v = cookieValue(req.headers.cookie, PRE_COOKIE);
    return v && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : undefined;
  }

  function preCookie(token: string): string {
    return `${PRE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? "; Secure" : ""}`;
  }

  /** POST /signin/start (text a code) and /signin/check (verify it). */
  async function signIn(ctx: Ctx, path: string): Promise<void> {
    const { req, res } = ctx;
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return send(res, 413, "form too large", { "content-type": "text/plain; charset=utf-8" });
    }
    const pre = preToken(req);
    const next = safeNext(form.get("next"));
    const rerender = (status: number, banner: Banner, body?: string) =>
      send(res, status, layout({ title: "Sign in", body: body ?? signInPage(pre ?? "", next, form.get("phone") ?? ""), banner }));
    if (!pre || form.get("pre") !== pre) return send(res, 403, layout({ title: "Sign in", body: messageBody("This page expired", "Go back and try again.") }));

    const raw = form.get("phone") ?? "";
    if (!isPhone(raw)) return rerender(400, { kind: "error", text: "Enter your full phone number, with the area code." });
    // The sign-in code is the one text they asked for; texts about tasks are their separate, optional choice.
    const optIn = form.get("consent") === "yes";
    const phone = normPhone(raw);

    if (path === "/signin/start") {
      // Rate-limited before anyone is looked up, so a stranger can't probe the family.
      if (!sendsPerAddress.take(addressOf(req)) || !sendsPerPhone.take(phone)) return rerender(429, { kind: "error", text: "Too many codes requested. Wait a few minutes and try again." });
      if (!await allowed(phone)) {
        if (families.get(phone) === undefined && (await familyOf(phone)).failed) return rerender(503, { kind: "error", text: "Kloru can't check that number right now. Try again in a minute." });
        log("sign-in code refused for a number that isn't invited");
        return rerender(403, { kind: "error", text: "That number isn't invited yet. Ask whoever invited you to add it." });
      }
      try {
        await o.verifier.start(phone);
      } catch (err) {
        log(`sign-in code send failed: ${(err as Error).message}`);
        const text = err instanceof VerifyError ? "We couldn't send a code to that number. Try again in a minute." : "Something went wrong. Try again.";
        return rerender(502, { kind: "error", text });
      }
      return send(res, 200, layout({ title: "Enter your code", body: codePage(phone, pre, next, optIn) }));
    }

    // /signin/check
    const code = (form.get("code") ?? "").replace(/\s/g, "");
    const codeBody = codePage(phone, pre, next, optIn);
    if (!checksPerPhone.take(phone)) return rerender(429, { kind: "error", text: "Too many tries. Request a new code in a few minutes." }, codeBody);
    if (!/^\d{4,10}$/.test(code) || !await allowed(phone) || !(await o.verifier.check(phone, code).catch(() => false))) {
      return rerender(200, { kind: "error", text: "That code didn't match. Check the text and try again." }, codeBody);
    }
    const existing = await o.store.userByPhone(phone);
    const user = await o.store.upsertUser({
      ...(existing ? { id: existing.id } : {}),
      phone,
      // The family (admins, owners, members) is linked to the family's Kloru.
      ...((admins.has(phone) || (await familyOf(phone)).who) && !existing?.agent && o.devAgent ? { agent: o.devAgent } : {}),
      // A tick is a yes, kept with when they gave it; no tick leaves an earlier yes (STOP is how they opt out).
      ...(optIn ? { textsOptIn: { yes: true, at: new Date().toISOString() } } : existing?.textsOptIn ? {} : { textsOptIn: { yes: false, at: new Date().toISOString() } }),
    });
    const session = newSession(user.id, user.phone);
    return redirect(res, 303, next, { "set-cookie": [sessionCookie(signSession(o.sessionSecret, session), secure, SESSION_TTL_MS / 1000), `${PRE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`] });
  }

  return http.createServer((req, res) => {
    const ctx: Ctx = { req, res, url: new URL(req.url ?? "/", "http://console.local") };
    route(ctx).catch((err: unknown) => {
      log(`unhandled: ${(err as Error).message}`);
      if (!res.headersSent) send(res, 500, layout({ title: "Error", body: messageBody("Something went wrong", "Try again in a moment.") }));
      else res.end();
    });
  });
}

/** One vault entry with its values, as the owner API exports it for the signed-in person. */
interface VaultExport {
  name: string;
  kind: string;
  meta: { site?: string; username?: string; service?: string; note?: string; brand?: string };
  secret: Record<string, string>;
  createdBy?: string;
}

/** Chrome, 1Password and Bitwarden import name,url,username,password,note; the rest keeps cards and keys whole. */
export function vaultCsv(entries: VaultExport[]): string {
  const cell = (v: string | undefined) => (v === undefined ? "" : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const url = (site: string | undefined) => (!site ? "" : /^https?:\/\//.test(site) ? site : `https://${site}`);
  const head = ["name", "url", "username", "password", "note", "kind", "card_number", "card_exp", "card_cvc", "card_name", "card_zip", "api_key", "made_by"];
  const rows = entries.map((e) => {
    const s = e.secret;
    const note = [e.meta.brand, e.meta.service, e.meta.note, s.text, s.totp ? `TOTP: ${s.totp}` : undefined].filter(Boolean).join("; ");
    return [e.name, url(e.meta.site), e.meta.username, s.password, note, e.kind, s.number, s.exp, s.cvc, s.name, s.zip, s.key, e.createdBy === "kloru" ? "Kloru" : "you"].map(cell).join(",");
  });
  return [head.join(","), ...rows].join("\r\n") + "\r\n";
}
