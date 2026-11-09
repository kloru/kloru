/**
 * Page bodies. Pure functions of data the agent returned; every dynamic value is escaped.
 * Forms post back to the console with the session's CSRF token.
 */
import { OUTCOMES, type CallSummary, type Outcome } from "./calls.js";
import type { TranscriptEvent } from "./transcripts.js";
import { esc } from "./html.js";
import type { ConsoleUser, Invite } from "./store.js";

/** The apps Kloru offers, in the order the Connections page lists them. Each has Composio's own sign-in. */
export const APP_CATALOG: ReadonlyArray<{ slug: string; name: string; blurb: string }> = [
  { slug: "gmail", name: "Gmail", blurb: "Read and send email" },
  { slug: "googlecalendar", name: "Google Calendar", blurb: "Your days, plans and free time" },
  { slug: "outlook", name: "Outlook", blurb: "Microsoft email and calendar" },
  { slug: "googledrive", name: "Google Drive", blurb: "Find and share files" },
  { slug: "googledocs", name: "Google Docs", blurb: "Read and write documents" },
  { slug: "googlesheets", name: "Google Sheets", blurb: "Lists, budgets and trackers" },
  { slug: "googlephotos", name: "Google Photos", blurb: "Find photos and albums" },
  { slug: "googletasks", name: "Google Tasks", blurb: "To-do lists" },
  { slug: "todoist", name: "Todoist", blurb: "To-do lists and reminders" },
  { slug: "ticktick", name: "TickTick", blurb: "To-do lists and habits" },
  { slug: "notion", name: "Notion", blurb: "Notes, plans and family wikis" },
  { slug: "one_drive", name: "OneDrive", blurb: "Microsoft files" },
  { slug: "dropbox", name: "Dropbox", blurb: "Files and shared folders" },
  { slug: "box", name: "Box", blurb: "Files and shared folders" },
  { slug: "splitwise", name: "Splitwise", blurb: "Shared expenses" },
  { slug: "calendly", name: "Calendly", blurb: "Booking links" },
  { slug: "zoom", name: "Zoom", blurb: "Video meetings" },
  { slug: "slack", name: "Slack", blurb: "Messages in your workspaces" },
  { slug: "discord", name: "Discord", blurb: "Servers and messages" },
  { slug: "youtube", name: "YouTube", blurb: "Videos and playlists" },
  { slug: "linkedin", name: "LinkedIn", blurb: "Your professional profile" },
  { slug: "asana", name: "Asana", blurb: "Projects and tasks" },
  { slug: "trello", name: "Trello", blurb: "Boards and cards" },
  { slug: "airtable", name: "Airtable", blurb: "Shared tables and lists" },
];

/** The apps a family member can connect from her own link: mail and calendar, which her words can share. */
export const MEMBER_APPS: readonly string[] = ["gmail", "googlecalendar", "outlook"];

export const TOOLKIT_NAMES: Record<string, string> = { ...Object.fromEntries(APP_CATALOG.map((a) => [a.slug, a.name])), googlecontacts: "Google Contacts" };

export const toolkitName = (slug: string): string => TOOLKIT_NAMES[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1).replace(/_/g, " ");

/** "+16504849720" as "(650) 484-9720"; other numbers as given. */
export const formatPhone = (phone: string): string => {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
};

const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
};

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

/** Last four digits only, for "we texted •••• 0190". */
export const maskPhone = (phone: string): string => `•••• ${phone.slice(-4)}`;

const preFields = (pre: string, next: string) => `<input type="hidden" name="pre" value="${esc(pre)}"><input type="hidden" name="next" value="${esc(next)}">`;

/** The public front page: what Kloru is, in three short paragraphs. */
export function homePage(): string {
  return `<section class="prose">` +
    `<p class="lead">Kloru is an assistant for your people: your family, your friends, the group chat that never decides anything.</p>` +
    `<p>Everyone texts or calls the same number. Kloru knows who's asking, keeps track of what the group wants, and does the work.</p>` +
    `<p>It can <span class="u">order groceries</span> for the family, <span class="u">plan the vacation</span>, find a night that works for everyone, or <span class="u">get your friends out the door</span> on Saturday.</p>` +
    `</section><ul class="go"><li><a href="/signin">Start a group</a></li><li><a href="/signin">Log in</a></li><li><a href="/signin?next=%2Fadmin">Invite someone</a></li></ul>`;
}

export function signInPage(pre: string, next: string, phone = ""): string {
  // A2P 10DLC: the code is a one-time text they ask for. Texts about tasks are a separate box that's
  // optional and never pre-checked; Kloru works without it (Twilio rejected bundled consent, 2026-11-02).
  return `<section class="prose"><p class="lead">Sign in with your phone number.</p><p>We'll text you a one-time sign-in code. Kloru is invite only for now.</p></section>` +
    `<form method="post" action="/signin/start" class="signin">${preFields(pre, next)}` +
    `<label><span>Phone number</span><input type="tel" name="phone" autocomplete="tel" inputmode="tel" required placeholder="(415) 555-0190" value="${esc(phone)}"></label>` +
    `<label class="check consent"><input type="checkbox" name="consent" value="yes"> <span class="small">Optional: also text me about the tasks I or my group ask Kloru to do. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt out, HELP for help. You can use Kloru without this, and it's not a condition of purchase. See the <a href="/terms">Terms of service</a> and <a href="/privacy">Privacy policy</a>.</span></label>` +
    `<button class="go">Text me a sign-in code</button>` +
    `<p class="small">Msg &amp; data rates may apply to the sign-in code.</p></form>`;
}

export function codePage(phone: string, pre: string, next: string, optIn = false): string {
  // Their texting choice rides along to the check (where it's saved) and to a resend.
  const choice = optIn ? `<input type="hidden" name="consent" value="yes">` : "";
  return `<section class="prose"><p class="lead">Enter your code.</p><p>We texted a 6-digit code to ${esc(maskPhone(phone))}.</p></section>` +
    `<form method="post" action="/signin/check" class="signin">${preFields(pre, next)}<input type="hidden" name="phone" value="${esc(phone)}">${choice}` +
    `<label><span>Code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,10}" maxlength="10" required autofocus></label>` +
    `<button class="go">Sign in</button></form>` +
    `<div class="small"><form method="post" action="/signin/start" class="inline">${preFields(pre, next)}<input type="hidden" name="phone" value="${esc(phone)}">${choice}<button class="link">Text me a new code</button></form> · <a href="/signin">Use a different number</a></div>`;
}

export function messageBody(title: string, text: string): string {
  return `<section class="prose"><p class="lead">${esc(title)}</p><p>${esc(text)}</p><ul class="go"><li><a href="/">Back</a></li></ul></section>`;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface AppAccountView {
  id: string;
  email?: string;
  status: "connected" | "expired";
}

export interface AppStatus {
  slug: string;
  connected: boolean;
  /** Every account connected to this app. Missing from an older agent: one row per app, as before. */
  accounts?: AppAccountView[];
}

/** Whether texting works for a person yet (the agent's texting.status). */
export interface TextingView {
  number?: string;
  handle?: string;
  texted?: string;
  sent?: string;
}

/** The family's payment wallet (the agent's payments.status). */
export interface PaymentsView {
  configured: boolean;
  connected: boolean;
  test?: boolean;
}

/** Kloru's texting number, and whether texts work for this person yet. Empty when the agent doesn't text. */
export function textingPanel(t: TextingView | undefined, who = "you"): string {
  if (!t?.number) return "";
  const number = `<a href="sms:${esc(t.number)}">${esc(formatPhone(t.number))}</a>`;
  const optIn = t.handle ? `connect @${t.handle}` : "";
  const since = t.texted ? `${who === "you" ? "You" : who} last texted Kloru ${esc(shortDate(t.texted))}.` : t.sent ? `Kloru last texted ${esc(who)} ${esc(shortDate(t.sent))}.` : "";
  const state = t.texted || t.sent
    ? `<p><span class="state ok">Texts work</span> · ${since}</p>`
    : `<p><span class="state warn">Not yet</span> · No texts with ${esc(who)} yet.${optIn ? ` To turn texts on, text <a href="sms:${esc(t.number)}&amp;body=${encodeURIComponent(optIn)}"><b>${esc(optIn)}</b></a> to ${esc(formatPhone(t.number))} from ${who === "you" ? "your" : "their"} phone.` : ""}</p>`;
  return `<section class="app"><h2>Texting</h2><p>Text Kloru at ${number}.</p>${state}</section>`;
}

function paymentsPanel(p: PaymentsView | undefined, csrf: string): string {
  if (!p) return "";
  const test = p.test ? ` <span class="state">Test mode</span>` : "";
  if (!p.configured) return `<section class="app"><h2>Payments</h2><p class="muted">Not set up yet. Once it is, you connect Stripe Link here and approve each purchase in Link.</p></section>`;
  if (p.connected) return `<section class="app"><h2>Payments</h2><p><span class="state ok">Stripe Link connected</span>${test} · Kloru asks Link for a one-time card for each purchase, and you approve every one in Link.</p></section>`;
  return `<section class="app"><h2>Payments</h2><p class="muted">Kloru pays with a one-time card from your Stripe Link wallet. You approve every purchase in Link.${test}</p>` +
    `<form method="post" action="/connections/payments">${csrfField(csrf)}<button class="go">Connect Stripe Link</button></form></section>`;
}

/** Texting and payments, then each connected app with its accounts, then every other app to add. */
/** An app the search found, from the agent's catalog (apps.catalog). */
export interface CatalogHit {
  slug: string;
  name: string;
  description: string;
  category?: string;
}

/** The Connections page's search: what was typed, what matched (best first), how many in all. */
export interface AppSearch {
  q: string;
  apps: CatalogHit[];
  total: number;
  /** Set when the catalog couldn't be read. */
  error?: string;
}

const firstSentence = (text: string, max = 110) => {
  const s = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return s.length > max ? `${s.slice(0, s.lastIndexOf(" ", max)).replace(/[,;:]$/, "")}…` : s;
};

export function connectionsPage(apps: AppStatus[], csrf: string, extra: { texting?: TextingView; payments?: PaymentsView; search?: AppSearch } = {}): string {
  const accountsOf = (a: AppStatus) => a.accounts ?? (a.connected ? [{ id: "", status: "connected" as const }] : []);
  const order = (slug: string) => {
    const i = APP_CATALOG.findIndex((c) => c.slug === slug);
    return i === -1 ? APP_CATALOG.length : i;
  };
  const sorted = [...apps].sort((a, b) => order(a.slug) - order(b.slug) || a.slug.localeCompare(b.slug));
  const mine = sorted.filter((a) => accountsOf(a).length > 0);
  const others = sorted.filter((a) => accountsOf(a).length === 0);
  const sections = mine
    .map((a) => {
      const name = toolkitName(a.slug);
      const slug = esc(a.slug);
      const toolkit = `${csrfField(csrf)}<input type="hidden" name="toolkit" value="${slug}">`;
      const rows = accountsOf(a)
        .map((acc) => {
          const who = acc.email ?? `${name} account`;
          const remove = `<form method="post" action="/connections/disconnect" class="inline" data-confirm="${esc(`Disconnect ${who} from ${name}? Kloru will lose access to it.`)}">${toolkit}${acc.id ? `<input type="hidden" name="account" value="${esc(acc.id)}">` : ""}<button class="link">${acc.status === "expired" ? "remove" : "disconnect"}</button></form>`;
          const reconnect = acc.status === "expired" ? `<form method="post" action="/connections/connect" class="inline">${toolkit}<button class="link">reconnect</button></form> · ` : "";
          const state = acc.status === "expired" ? `<span class="state warn">Needs reconnecting</span>` : `<span class="state ok">Connected</span>`;
          return `<li><span class="name">${esc(who)}</span> ${state} · ${reconnect}${remove}</li>`;
        })
        .join("");
      const add = `<form method="post" action="/connections/connect">${toolkit}<button class="go">${esc(`Add another ${name} account`)}</button></form>`;
      return `<section class="app"><h2>${esc(name)}</h2><ul class="rows">${rows}</ul>${add}</section>`;
    })
    .join("");
  const connect = (slug: string, name: string, about?: string) =>
    `<li><form method="post" action="/connections/connect" class="inline">${csrfField(csrf)}<input type="hidden" name="toolkit" value="${esc(slug)}"><button class="link">${esc(`Connect ${name}`)}</button></form>${about ? ` <span class="muted">${esc(about)}</span>` : ""}</li>`;
  const have = new Set(mine.map((a) => a.slug));
  const search = extra.search;
  const q = search?.q ?? "";
  const form =
    `<form method="get" action="/connections" class="search" role="search"><label><span>Find an app</span>` +
    `<input type="search" id="app-search" name="q" value="${esc(q)}" placeholder="GitHub, Slack, invoices…" autocomplete="off" maxlength="100"></label><button class="go">Search</button></form>`;
  let found: string;
  if (search?.error) {
    found = `<p class="muted">${esc(`Searching apps didn't work just now (${search.error}). Try again in a moment.`)}</p>`;
  } else if (q && search) {
    found = search.apps.length
      ? `<ul class="apps">${search.apps.map((a) => connect(a.slug, a.name, firstSentence(a.description) || a.category)).join("")}</ul>` +
        (search.total > search.apps.length ? `<p class="muted">${esc(`Showing ${search.apps.length} of ${search.total}. Add a word to narrow it.`)}</p>` : "") +
        `<p class="muted"><a href="/connections">Clear the search</a></p>`
      : `<p class="muted">${esc(`No app matches “${q}”. Try another name, or what it's for, like “invoices” or “photos”.`)}</p>`;
  } else {
    // Nothing typed yet: the apps families use most, then the rest of the catalog is a search away.
    const popular = [...APP_CATALOG.filter((c) => !have.has(c.slug)).map((c) => ({ slug: c.slug, name: c.name, about: c.blurb })), ...others.filter((a) => !APP_CATALOG.some((c) => c.slug === a.slug)).map((a) => ({ slug: a.slug, name: toolkitName(a.slug), about: undefined }))];
    found = popular.length ? `<h3>Popular</h3><ul class="apps">${popular.map((a) => connect(a.slug, a.name, a.about)).join("")}</ul>` : "";
  }
  const more = `<section class="more"><h2>Add an app</h2><p class="muted">Kloru can connect to more than a thousand apps. Search by name or by what it's for.</p>${form}${found}</section>`;
  return `<h1>Connections</h1><p class="muted">The accounts Kloru can use for you. Add each one you want it to see, like a personal and a work Gmail; it uses the one a request is about.</p>` +
    textingPanel(extra.texting) + paymentsPanel(extra.payments, csrf) +
    sections + more;
}

// ---------------------------------------------------------------------------
// Permissions (the agent's own tier: what it may do for you without asking)
// ---------------------------------------------------------------------------

export interface PolicyView {
  capabilities: string[];
  tiers: Record<string, Record<string, string>>;
  grants: GrantView[];
}

export interface GrantView {
  id: string;
  to: string;
  capabilities: string[];
  scope?: { window?: { from: string; to: string }; maxUsd?: number };
  expiresAt?: string;
  note?: string;
}

export const PERMISSION_GROUPS: ReadonlyArray<{ title: string; items: ReadonlyArray<{ cap: string; label: string }> }> = [
  { title: "Calendar", items: [{ cap: "calendar.freebusy", label: "See when you're free" }, { cap: "calendar.read", label: "Read events" }, { cap: "calendar.write", label: "Create and change events" }] },
  { title: "Email", items: [{ cap: "email.read", label: "Read email" }, { cap: "email.send", label: "Send email" }] },
  { title: "Contacts", items: [{ cap: "contacts.read", label: "Read contacts" }] },
  { title: "Money", items: [{ cap: "purchase", label: "Buy things" }, { cap: "travel.book", label: "Book travel" }] },
  { title: "Phone", items: [{ cap: "phone.call", label: "Place calls" }] },
  { title: "Computer and web", items: [{ cap: "computer.use", label: "Use its computer and browser" }, { cap: "web.read", label: "Search and read the web" }] },
  { title: "Memory", items: [{ cap: "memory.write", label: "Remember things about you" }] },
];

const CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "yes", label: "Allowed" },
  { value: "ask", label: "Ask me first" },
  { value: "no", label: "Never" },
];
const SPEND = new Set(["purchase", "travel.book"]);

export function permissionsPage(policy: PolicyView, csrf: string): string {
  const owner = policy.tiers.owner ?? {};
  const groups = PERMISSION_GROUPS.map((g) => {
    const rows = g.items
      .map(({ cap, label }) => {
        const current = owner[cap] ?? "no";
        const choices = [...(SPEND.has(cap) ? [{ value: "limit", label: "Within spend limits" }] : []), ...CHOICES];
        const radios = choices
          .map((c) => `<label class="choice"><input type="radio" name="permission" value="${c.value}"${current === c.value ? " checked" : ""}><span>${esc(c.label)}</span></label>`)
          .join("");
        return `<form method="post" action="/permissions" class="perm" data-autosubmit>${csrfField(csrf)}<input type="hidden" name="capability" value="${esc(cap)}">` +
          `<span class="name">${esc(label)}</span><span class="choices">${radios}</span><noscript><button class="link">save</button></noscript></form>`;
      })
      .join("");
    return `<section><h2>${esc(g.title)}</h2>${rows}</section>`;
  }).join("");
  return `<h1>Permissions</h1><p class="muted">What Kloru may do for you on its own. "Ask me first" sends it to Approvals and texts you.</p>${groups}`;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalView {
  token: string;
  summary: string;
  capability: string;
  amountUsd?: number;
  createdAt: string;
}

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}`;
const sensitive = (a: ApprovalView) => SPEND.has(a.capability) || a.amountUsd !== undefined || a.capability === "phone.call";

export function approvalsPage(list: ApprovalView[], csrf: string): string {
  if (list.length === 0) return `<h1>Approvals</h1><p>Nothing is waiting for you.</p>`;
  const items = list
    .map((a) => {
      const amount = a.amountUsd !== undefined ? ` <span class="state">${esc(fmtUsd(a.amountUsd))}</span>` : "";
      const approve = `<form method="post" action="/approvals/settle" class="inline">${csrfField(csrf)}<input type="hidden" name="token" value="${esc(a.token)}"><button class="link" name="decision" value="approve">${sensitive(a) ? "review and approve" : "approve"}</button></form>`;
      const deny = `<form method="post" action="/approvals/settle" class="inline">${csrfField(csrf)}<input type="hidden" name="token" value="${esc(a.token)}"><button class="link" name="decision" value="deny">deny</button></form>`;
      return `<li><span class="name">${esc(a.summary)}</span>${amount}<br><span class="muted small">asked ${esc(new Date(a.createdAt).toLocaleString("en-US"))}</span><br>${approve} · ${deny}</li>`;
    })
    .join("");
  return `<h1>Approvals</h1><ul class="rows">${items}</ul>`;
}

// ---------------------------------------------------------------------------
// Automations: recurring jobs made on a call, to see, pause or delete
// ---------------------------------------------------------------------------

export interface AutomationView {
  id: string;
  name: string;
  when: string;
  request: string;
  enabled: boolean;
  nextRunAt?: string;
  lastRunAt?: string;
  for?: string;
}

export function automationsPage(list: AutomationView[], csrf: string): string {
  const intro = `<p class="muted">Things Kloru does on its own, on a schedule. To add one, call or text Kloru: “every weekday at 7, text me my day.”</p>`;
  if (list.length === 0) return `<h1>Automations</h1>${intro}<p>None yet.</p>`;
  const when = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const items = list
    .map((a) => {
      const id = `<input type="hidden" name="id" value="${esc(a.id)}">`;
      const toggle = `<form method="post" action="/automations/pause" class="inline">${csrfField(csrf)}${id}<button class="link" name="enabled" value="${a.enabled ? "false" : "true"}">${a.enabled ? "pause" : "resume"}</button></form>`;
      const remove = `<form method="post" action="/automations/delete" class="inline">${csrfField(csrf)}${id}<button class="link">delete</button></form>`;
      const meta = [a.when, a.for ? `for ${a.for}` : "", !a.enabled ? "paused" : a.nextRunAt ? `next ${when(a.nextRunAt)}` : "", a.lastRunAt ? `last ran ${when(a.lastRunAt)}` : ""].filter(Boolean).map(esc).join(" · ");
      return `<li><span class="name">${esc(a.name)}</span>${a.enabled ? "" : ' <span class="state">paused</span>'}<br><span class="muted small">${meta}</span><br>${esc(a.request)}<br>${toggle} · ${remove}</li>`;
    })
    .join("");
  return `<h1>Automations</h1>${intro}<ul class="rows">${items}</ul>`;
}

/** The second step for money and phone calls. Only this form carries confirm=1. */
export function confirmApprovalPage(a: ApprovalView, csrf: string): string {
  const amount = a.amountUsd !== undefined ? ` for ${esc(fmtUsd(a.amountUsd))}` : "";
  const what = a.capability === "phone.call" ? "This places a phone call." : "This spends money.";
  return `<section class="prose"><p class="lead">${esc(a.summary)}${amount}</p><p>${what} Kloru will go ahead as soon as you confirm.</p></section>` +
    `<ul class="go"><li><form method="post" action="/approvals/settle" class="inline">${csrfField(csrf)}<input type="hidden" name="token" value="${esc(a.token)}"><input type="hidden" name="confirm" value="1"><button class="link" name="decision" value="approve">Yes, approve</button></form></li>` +
    `<li><a href="/approvals">Not now</a></li></ul>`;
}

// ---------------------------------------------------------------------------
// Contacts: who can reach the agent, their tier, and per-contact grants
// ---------------------------------------------------------------------------

export interface ContactView {
  id: string;
  name: string;
  tier: string;
  phones: string[];
  emails: string[];
}

export const TIER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "partner", label: "Partner" },
  { value: "family", label: "Family" },
  { value: "friend", label: "Friend" },
  { value: "contact", label: "Contact" },
  { value: "staff", label: "Staff (another agent)" },
];

export const GRANTABLE: ReadonlyArray<{ cap: string; label: string }> = [
  { cap: "calendar.freebusy", label: "See when you're free" },
  { cap: "calendar.read", label: "Read your events" },
  { cap: "calendar.write", label: "Book on your calendar" },
  { cap: "email.send", label: "Have the agent email for them" },
  { cap: "plans.commit", label: "Commit you to plans" },
  { cap: "purchase", label: "Spend money" },
  { cap: "phone.call", label: "Have the agent place calls" },
  { cap: "owner.location.approx", label: "Know roughly where you are" },
];

const capLabel = (cap: string) => GRANTABLE.find((g) => g.cap === cap)?.label ?? cap;

function tierSelect(current: string): string {
  return `<select name="tier">${TIER_OPTIONS.map((t) => `<option value="${t.value}"${t.value === current ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select>`;
}

function grantText(g: GrantView): string {
  const parts = [g.capabilities.map(capLabel).join(", ")];
  if (g.scope?.window) parts.push(`${g.scope.window.from} to ${g.scope.window.to}`);
  if (g.scope?.maxUsd !== undefined) parts.push(`up to ${fmtUsd(g.scope.maxUsd)}`);
  if (g.note) parts.push(g.note);
  return parts.map(esc).join(" · ");
}

export function contactsPage(contacts: ContactView[], grants: GrantView[], csrf: string): string {
  const rows = contacts
    .map((c) => {
      const mine = grants.filter((g) => g.to === `contact:${c.id}`);
      const grantList = mine
        .map((g) => `<li>${grantText(g)} · <form method="post" action="/contacts/revoke" class="inline">${csrfField(csrf)}<input type="hidden" name="id" value="${esc(g.id)}"><button class="link">remove</button></form></li>`)
        .join("");
      const checks = GRANTABLE.map((g) => `<label><input type="checkbox" name="capabilities" value="${g.cap}"> ${esc(g.label)}</label>`).join("");
      const member = c.tier === "partner" || c.tier === "family";
      const link = member ? `<form method="post" action="/contacts/connect-link" class="inline">${csrfField(csrf)}<input type="hidden" name="contactId" value="${esc(c.id)}"><input type="hidden" name="name" value="${esc(c.name)}"><button class="link">link to connect their accounts</button></form>` : "";
      return `<li><span class="name">${esc(c.name)}</span> <span class="muted small">${[...c.phones, ...c.emails].map(esc).join(" · ") || "no phone or email"}</span> ${link}` +
        `<form method="post" action="/contacts" class="inline tier">${csrfField(csrf)}<input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="name" value="${esc(c.name)}">${tierSelect(c.tier)}<button class="link">save</button></form>` +
        (mine.length ? `<ul class="grants">${grantList}</ul>` : "") +
        `<details><summary>allow more</summary><form method="post" action="/contacts/grant" class="stack">${csrfField(csrf)}<input type="hidden" name="contactId" value="${esc(c.id)}">` +
        `<div class="checks">${checks}</div><div class="fields"><label>From <input type="date" name="windowFrom"></label><label>To <input type="date" name="windowTo"></label>` +
        `<label>Up to $ <input type="number" name="maxUsd" min="0" step="1"></label><label>Note <input name="note"></label></div><button class="link">allow</button></form></details></li>`;
    })
    .join("");
  const add = `<section><h2>Add someone</h2><form method="post" action="/contacts" class="stack">${csrfField(csrf)}` +
    `<label><span>Name</span><input name="name" required></label><label><span>Phones</span><input name="phones" placeholder="+1 415 555 0190, …"></label>` +
    `<label><span>Emails</span><input name="emails" placeholder="sam@example.com"></label><label><span>They are</span>${tierSelect("friend")}</label><button class="go">Add</button></form></section>`;
  return `<h1>People</h1><p class="muted">Who can reach Kloru, and what each person may ask it to do. "Allow more" gives one person something extra.</p>` +
    (contacts.length ? `<ul class="rows">${rows}</ul>` : `<p>No one yet.</p>`) + add;
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  connected: "connected",
  hung_up_attestation: "hung up: carrier didn't vouch for caller ID",
  refused_unknown: "refused: unknown number",
  bad_signature: "forged request (not from Twilio)",
};

const callTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function callsSection(calls: CallSummary | undefined, transcripts: boolean): string {
  if (!calls || calls.recent.length === 0) return `<section><h2>Calls</h2><p>No calls logged yet.</p></section>`;
  const week = OUTCOMES.map((o) => `${calls.week[o]} ${OUTCOME_LABEL[o]}`).join(" · ");
  const rows = calls.recent
    .map((c) => {
      const when = Number.isNaN(Date.parse(c.at)) ? c.at : callTime.format(new Date(c.at));
      const detail = [c.verstat || "no rating", c.ip ? `from ${c.ip}` : "", c.callSid].filter(Boolean).map(esc).join(" · ");
      const link = transcripts && c.outcome === "connected" && /^CA[0-9a-f]{32}$/.test(c.callSid) ? ` · <a href="/admin/calls/${esc(c.callSid)}">transcript</a>` : "";
      return `<li class="call${c.outcome === "hung_up_attestation" ? " warn" : ""}"><span class="name">${esc(when)}</span> ${esc(c.from || "unknown")}, <span class="state">${esc(OUTCOME_LABEL[c.outcome])}</span>${link}<br><span class="muted small">${detail}</span></li>`;
    })
    .join("");
  return `<section><h2>Calls</h2><p class="small">Last 7 days: ${esc(week)}</p>` +
    `<p class="muted small">A hang-up on your number that you didn't make means someone faked it. One you did make means a good call was turned away.</p>` +
    `<ul class="rows">${rows}</ul></section>`;
}

const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", second: "2-digit" });

/** One call: what was said, and each background task's request and result, in order. */
export function transcriptPage(callSid: string, events: TranscriptEvent[]): string {
  const start = events[0] ? Date.parse(events[0].at) : NaN;
  const title = Number.isNaN(start) ? "Call" : `Call on ${callTime.format(new Date(start))}`;
  const rows = events
    .map((e) => {
      const t = Number.isNaN(Date.parse(e.at)) ? esc(e.at) : esc(clock.format(new Date(e.at)));
      switch (e.kind) {
        case "caller":
          return `<li class="say caller"><span class="muted small">${t}</span> <span class="name">Caller</span> ${esc(e.text ?? "")}</li>`;
        case "kloru":
          return `<li class="say kloru"><span class="muted small">${t}</span> <span class="name">Kloru</span> ${esc(e.text ?? "")}${e.interrupted ? ` <span class="state">(cut off)</span>` : ""}</li>`;
        case "task_started":
          return `<li class="task"><span class="muted small">${t}</span> <span class="state">Task ${esc(String(e.task ?? ""))} started (${esc(e.size ?? "")}):</span> ${esc(e.request ?? "")}</li>`;
        case "task_finished":
          return `<li class="task"><span class="muted small">${t}</span> <span class="state">Task ${esc(String(e.task ?? ""))} ${esc(e.status ?? "")}${e.after_call ? ", after the call ended" : ""}:</span> ${esc(e.result ?? "")}</li>`;
        case "call_started":
          return `<li class="muted small">${t} Call connected from ${esc(e.from ?? "")}</li>`;
        default:
          return `<li class="muted small">${t} Call ended</li>`;
      }
    })
    .join("");
  return `<h1>${esc(title)}</h1><p class="muted small">${esc(callSid)}</p><ul class="rows transcript">${rows}</ul><ul class="go"><li><a href="/admin">Back to Admin</a></li></ul>`;
}

export function settingsPage(improve: boolean, csrf: string): string {
  return `<h1>Settings</h1><form method="post" action="/settings" class="stack">${csrfField(csrf)}<input type="hidden" name="sent" value="1">` +
    `<label class="check"><input type="checkbox" name="improve"${improve ? " checked" : ""}> <span class="name">Help improve Kloru for everyone</span></label>` +
    `<p class="muted small">Kloru keeps the text of your calls for 90 days so we can see where it got things wrong and fix them. Calls are never recorded, and your conversations are never used to train AI models. When this is off, we keep only who called and when, to protect your account.</p>` +
    `<button class="go">Save</button></form>`;
}

export function adminPage(users: ConsoleUser[], invites: Invite[], csrf: string, calls?: CallSummary, transcripts = false, desk = false, version?: string): string {
  const userRows = users.map((u) => `<li><span class="name">${esc(u.phone)}</span>${u.name ? ` ${esc(u.name)}` : ""} <span class="muted small">${u.agent ? esc(u.agent.kind === "direct" ? `agent at ${u.agent.url}` : `Maritime ${u.agent.agentId}`) : "no agent yet"}</span></li>`).join("");
  const inviteRows = invites
    .map((i) => `<li><span class="name">${esc(i.phone)}</span> <span class="muted small">invited by ${esc(i.invitedBy)}</span> · <form method="post" action="/admin/uninvite" class="inline">${csrfField(csrf)}<input type="hidden" name="phone" value="${esc(i.phone)}"><button class="link">remove</button></form></li>`)
    .join("");
  return `<h1>Admin</h1><ul class="go"><li><a href="/admin/metrics">Metrics: cost, what got done, time saved, who uses it</a></li>${desk ? `<li><a href="/admin/desk">Desk: issues, calls, ledger and memory</a></li>` : ""}</ul><section><h2>Invite someone</h2><form method="post" action="/admin/invite" class="signin">${csrfField(csrf)}<label><span>Their phone number</span><input type="tel" name="phone" required placeholder="+1 415 555 0100"></label><button class="go">Invite</button></form>` +
    `<p class="muted small">They sign in with a code texted to that number.</p></section>` +
    `<section><h2>Invites</h2>${inviteRows ? `<ul class="rows">${inviteRows}</ul>` : "<p>None.</p>"}</section>` +
    `<section><h2>People</h2>${userRows ? `<ul class="rows">${userRows}</ul>` : "<p>None yet.</p>"}</section>` +
    callsSection(calls, transcripts) +
    (version ? `<p class="muted small">Running ${esc(version)}. Update with <code>python3 deploy/selfhost/setup.py --update</code>.</p>` : "");
}

// ---------------------------------------------------------------------------
// Why
// ---------------------------------------------------------------------------

const WHY: readonly string[] = [
  "I'm Evan. I'm a real person.",
  "I created Kloru because I'm overwhelmed as an adult. There's so much to do and not really enough time to do it. I don't want to use a new portal or a new website. I want to make calls and send texts to get done what I need, so I can spend time doing what I really care about.",
  "I want to spend time with my wife, making her laugh at my dumb jokes. I want to make silly faces and be absurd to make my daughter smile. I want my friends and parents to know I care about them.",
  "Being an adult feels like living in a giant hole of responsibilities. I created Kloru as a stepstool to help see the light. It's not a perfect solution, but it's my solution to spending time on what I actually care about, which has nothing to do with the internet.",
];

export function whyPage(): string {
  return `<section class="prose">${WHY.map((p, i) => `<p${i === 0 ? ' class="lead"' : ""}>${esc(p)}</p>`).join("")}<p class="muted">Evan</p></section>` +
    `<ul class="go"><li><a href="/">Back to Kloru</a></li></ul>`;
}

/** What a family member sees when she opens the owner's link: one button per app, as herself. */
export interface VaultView {
  name: string;
  kind: string;
  meta: { brand?: string; last4?: string; expYear?: string; limits?: { perPurchaseUsd?: number; perDayUsd?: number }; site?: string; username?: string; service?: string; note?: string };
  createdAt: string;
  usedAt?: string;
  /** "kloru" for a login Kloru made when it signed up for you. */
  createdBy?: string;
}

/** Your vault: cards, logins and API keys Kloru uses by name. Values are never shown again once saved. */
export function vaultPage(entries: VaultView[], csrf: string): string {
  const describe = (e: VaultView) =>
    e.kind === "card" ? `${esc(e.meta.brand ?? "Card")} ending ${esc(e.meta.last4 ?? "?")}${e.meta.limits?.perPurchaseUsd ? ` · up to $${e.meta.limits.perPurchaseUsd} a purchase` : ""}${e.meta.limits?.perDayUsd ? ` · $${e.meta.limits.perDayUsd} a day` : ""}`
    : e.kind === "login" ? `${esc(e.meta.site ?? "")} as ${esc(e.meta.username ?? "")}`
    : e.kind === "api_key" ? `API key for ${esc(e.meta.service ?? "")}`
    : esc(e.meta.note ?? "Note");
  const rows = entries.length
    ? `<ul class="rows">${entries.map((e) => `<li><b>${esc(e.name)}</b> · ${describe(e)}${e.createdBy === "kloru" ? " · made by Kloru" : ""}${e.usedAt ? ` · last used ${esc(e.usedAt.slice(0, 10))}` : ""} <form method="post" action="/vault/remove" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="name" value="${esc(e.name)}"><button class="link">remove</button></form></li>`).join("")}</ul>`
    : "<p>Nothing saved yet.</p>";
  const exporter = entries.length
    ? `<form method="post" action="/vault/export" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="link">Export my vault</button></form> <small>A CSV with every value, including logins Kloru made, for Chrome, 1Password or Bitwarden. Keep the file safe and delete it after importing.</small>`
    : "";
  const field = (name: string, label: string, extra = "") => `<label><span>${label}</span><input name="${name}" ${extra}></label>`;
  const form = (kind: string, title: string, fields: string) => `<details><summary>${title}</summary><form method="post" action="/vault/add" class="signin"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="kind" value="${kind}">${field("name", "Name Kloru uses", 'required pattern="[a-z0-9][a-z0-9-]{1,62}" placeholder="e.g. evan-credit-card"')}${fields}<button class="go">Save</button></form></details>`;
  return `<section class="prose"><p class="lead">Your vault</p><p>Cards, logins and API keys Kloru uses for you by name. Kloru's models never see the values: they're filled in at the last moment and removed from anything Kloru reads back. Use a card with limits you control at your bank; Kloru also keeps to the limits you set here. Never send these by text.</p></section>` +
    rows +
    exporter +
    form("card", "Add a card", field("number", "Card number", 'required inputmode="numeric" autocomplete="off"') + field("exp", "Expires (MM/YY)", 'required autocomplete="off"') + field("cvc", "Security code", 'required inputmode="numeric" autocomplete="off"') + field("cardname", "Name on card", 'autocomplete="off"') + field("zip", "Billing ZIP", 'autocomplete="off"') + field("brand", "Brand", 'placeholder="Visa"') + field("per_purchase", "Most per purchase ($)", 'inputmode="decimal"') + field("per_day", "Most per day ($)", 'inputmode="decimal"')) +
    form("login", "Add a login", field("site", "Site", 'required placeholder="pge.com"') + field("username", "Username or email", "required") + field("password", "Password", 'required type="password" autocomplete="off"')) +
    form("api_key", "Add an API key", field("service", "Service", "required") + field("key", "Key", 'required type="password" autocomplete="off"'));
}

/** Kloru's browser tab, live, for the person to finish one step (a check, a code) by hand. */
export function takeoverPage(token: string, csrf: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">` +
    `<title>Finish this step · Kloru</title><link rel="stylesheet" href="/static/takeover.css"><script src="/static/takeover.js" defer></script></head>` +
    `<body data-token="${esc(token)}" data-csrf="${esc(csrf)}"><header><p id="reason">Loading Kloru's browser…</p><button id="done" type="button">Done</button></header>` +
    `<main><img id="screen" alt="Kloru's browser"></main>` +
    `<footer><form id="typing"><input id="text" autocomplete="off" autocapitalize="off" placeholder="Type here, then Send"><button>Send</button></form>` +
    `<div class="keys"><button data-key="Backspace" type="button">⌫</button><button data-key="Tab" type="button">Tab</button><button data-key="Enter" type="button">Enter</button><button data-scroll="-500" type="button">▲</button><button data-scroll="500" type="button">▼</button></div>` +
    `<p id="status">Tap the page as you would on the site. Kloru carries on when you're done.</p></footer></body></html>`;
}

/** Your own policy.md: what others in the family may and may not do with your things. Only you change it. */
export function policyPage(text: string, csrf: string): string {
  return `<section class="prose"><p class="lead">Your policy</p><p>What others in your family may and may not do with your connected accounts (email, calendar) through Kloru. Anything it doesn't mention is open to the family. What Kloru keeps in your private folder is only ever yours. Only you can change this; you can also just tell Kloru ("don't let Cara read my work email").</p></section>` +
    `<form method="post" action="/policy" class="signin"><input type="hidden" name="csrf" value="${esc(csrf)}">` +
    `<label><span>One line each</span><textarea name="text" rows="10" maxlength="20000" placeholder="- Cara can see and do everything, except my work email.">${esc(text)}</textarea></label>` +
    `<button class="go">Save my policy</button></form>`;
}

export function connectPage(name: string, path: string, texting?: TextingView, csrf?: string): string {
  const button = (slug: string) => `<form method="post" action="${esc(path)}">${csrf ? `<input type="hidden" name="csrf" value="${esc(csrf)}">` : ""}<input type="hidden" name="toolkit" value="${esc(slug)}"><button class="go">Connect ${esc(toolkitName(slug))}</button></form>`;
  return `<section class="prose"><p class="lead">Hi ${esc(name)}</p><p>Connect your own email and calendar so Kloru can help you. Each account stays yours: your email is private to you unless you say otherwise.</p>${MEMBER_APPS.map(button).join("")}${csrf ? `<p><a href="/policy">Your policy</a>: what others in the family may do with your things.</p>` : ""}</section>` +
    textingPanel(texting);
}
