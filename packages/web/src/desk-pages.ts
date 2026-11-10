/**
 * The Desk, read-only, for admins: the repository the agent keeps on disk (calls, issues, the
 * ledger of real-world changes, memory), read through @kloru/desk itself so the chain checks and
 * the Merkle root are the agent's own. Opened fresh per request and never written.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLOSED, Memory, Repo, describeWhen, type Artifact, type CallRecord, type Issue, type LedgerEntry } from "@kloru/desk";
import { Store } from "@kloru/store";
import { esc } from "./html.js";
import { renderMarkdown } from "./markdown.js";

const when = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", second: "2-digit" });
const at = (iso: string | undefined, f = when) => (iso && !Number.isNaN(Date.parse(iso)) ? f.format(new Date(iso)) : esc(iso ?? ""));
const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const short = (hash: string) => hash.slice(0, 12);

export interface Alert {
  call_sid: string;
  failures: Array<{ name: string; detail: string }>;
}

export function openRepo(dir: string): Repo {
  return new Repo(dir, undefined, { readOnly: true });
}

export function openMemory(dir: string): Memory | undefined {
  const root = join(dir, "memory");
  return existsSync(join(root, ".git")) ? new Memory(root, { owner: { name: "", phones: [] } }) : undefined;
}

/** The after-call checks that failed (voice/checks.py), newest first. */
export function readAlerts(path: string | undefined, limit = 15): Alert[] {
  if (!path || !existsSync(path)) return [];
  const out: Alert[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const a = JSON.parse(line) as Alert;
      if (a.call_sid && Array.isArray(a.failures)) out.push(a);
    } catch {
      continue;
    }
  }
  return out.reverse().slice(0, limit);
}

const nav = `<ul class="go"><li><a href="/admin/desk">Desk</a></li><li><a href="/admin/desk/ledger">Ledger</a></li><li><a href="/admin/desk/memory">Memory</a></li><li><a href="/admin">Admin</a></li></ul>`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const status = (i: Issue) => `<span class="state${CLOSED.has(i.status) ? "" : " ok"}">${esc(i.status.replace(/_/g, " "))}</span>`;
const issueLink = (i: Issue) => `<a href="/admin/desk/issues/${i.id}">#${i.id}</a>`;
const callLink = (c: CallRecord) => `<a href="/admin/desk/calls/${encodeURIComponent(c.id)}">${at(c.startedAt)}</a>`;

function issueRow(i: Issue): string {
  const kind = i.purpose ? `${i.kind}, ${i.purpose}` : i.kind;
  return `<li>${issueLink(i)} ${status(i)} <span class="muted small">${esc(kind)} · ${at(i.updatedAt)}</span><br>${esc(clip(i.request))}</li>`;
}

function chain(r: { ok: true; value: number } | { ok: false; error: { at: number; reason: string } }, unit: string): string {
  return r.ok ? `${plural(r.value, unit)}, chain verifies` : `chain broken at ${unit} ${r.error.at} (${esc(r.error.reason)})`;
}

export function deskPage(repo: Repo, alerts: Alert[], pages = ""): string {
  const issues = repo.issues().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const open = issues.filter((i) => !CLOSED.has(i.status) && !i.purpose);
  const closed = issues.filter((i) => CLOSED.has(i.status) && !i.purpose).slice(0, 20);
  const memoryRuns = issues.filter((i) => i.purpose === "memory");
  const calls = repo.allCalls().reverse().slice(0, 15);
  const broken = repo.allCalls().filter((c) => !repo.verifyCall(c.id).ok).length;
  const alertRows = alerts
    .map((a) => `<li class="call warn"><span class="name">${esc(a.call_sid)}</span> ${a.failures.map((f) => `<span class="state">${esc(f.name)}</span> ${esc(f.detail)}`).join("; ")}</li>`)
    .join("");
  const callRows = calls
    .map((c) => {
      const filed = repo.issues((i) => i.filedBy.call === c.id && !i.purpose).length;
      return `<li>${callLink(c)} <span class="muted small">${esc(c.phone)} · ${plural(repo.turns(c.id).length, "turn")} · ${plural(filed, "issue")}${c.endedAt ? "" : " · live"}</span></li>`;
    })
    .join("");
  const ledger = repo.ledger();
  return (
    `<h1>Desk</h1><p class="muted small">Root ${short(repo.root().hash)} · Ledger: ${chain(repo.verifyLedger(), "change")} · ${broken ? `${plural(broken, "call")} with a broken chain` : "every call's chain verifies"}</p>` +
    `<section><h2>Failed call checks</h2>${alertRows ? `<ul class="rows">${alertRows}</ul>` : "<p>None.</p>"}</section>` +
    `<section><h2>Open issues</h2>${open.length ? `<ul class="rows">${open.map(issueRow).join("")}</ul>` : "<p>None.</p>"}</section>` +
    `<section><h2>Calls</h2>${callRows ? `<ul class="rows">${callRows}</ul>` : "<p>None yet.</p>"}</section>` +
    pages +
    `<section><h2>Recently closed</h2>${closed.length ? `<ul class="rows">${closed.map(issueRow).join("")}</ul>` : "<p>None.</p>"}</section>` +
    `<p class="muted small">${plural(memoryRuns.length, "memory update")} · ${plural(ledger.length, "ledger entry", "ledger entries")}</p>` +
    nav
  );
}

function ledgerRow(e: LedgerEntry): string {
  return (
    `<li><span class="muted small">${at(e.at)}</span> ${e.issue ? `<a href="/admin/desk/issues/${e.issue}">#${e.issue}</a> ` : ""}<span class="name">${esc(e.slug)}</span> <span class="state${e.ok ? " ok" : ""}">${e.ok ? "ok" : "failed"}</span><br>${esc(clip(e.result, 300))}` +
    `<details><summary>arguments</summary><pre class="code">${esc(JSON.stringify(e.args, null, 2))}</pre></details></li>`
  );
}

export function issuePage(repo: Repo, issue: Issue): string {
  const call = repo.call(issue.filedBy.call);
  const thread = issue.thread.map((t) => `<li><span class="muted small">${at(t.at, clock)}</span> <span class="name">${esc(t.by)}</span> ${esc(t.text)}</li>`).join("");
  const prs = issue.prs.map((p) => `<li><span class="muted small">${at(p.at, clock)}</span> <span class="state">${esc(p.status)}</span><pre class="code">${esc(p.body)}</pre></li>`).join("");
  const ledger = repo.ledger(issue.id).map(ledgerRow).join("");
  const links = Object.entries(issue.links).map(([k, n]) => `${esc(k)} <a href="/admin/desk/issues/${n}">#${n}</a>`).join(" · ");
  return (
    `<h1>Issue #${issue.id}</h1><p>${status(issue)} <span class="muted small">${esc(issue.kind)}${issue.purpose ? `, ${esc(issue.purpose)}` : ""} · opened ${at(issue.createdAt)} · updated ${at(issue.updatedAt)}${call ? ` · from ${callLink(call)}` : ""}</span></p>` +
    `<section><h2>Request</h2><p>${esc(issue.request)}</p>${issue.target ? `<h2>Done when</h2><p>${esc(issue.target.doneWhen)}</p><p class="muted">Goal: ${esc(issue.target.goal)} · ${esc(issue.target.deliverable)}</p>` : ""}${issue.spec ? `<h2>Spec</h2><p>${esc(issue.spec)}</p>` : ""}` +
    `${issue.resources.length ? `<p class="muted small">Resources: ${esc(issue.resources.join(", "))}</p>` : ""}${links ? `<p class="muted small">${links}</p>` : ""}` +
    `${issue.confirmation ? `<p class="muted small">Needs a yes on draft ${esc(issue.confirmation.id)}${issue.confirmation.confirmedAt ? `, confirmed ${at(issue.confirmation.confirmedAt)}` : ""}</p><pre class="code">${esc(issue.confirmation.draft)}</pre>` : ""}</section>` +
    `<section><h2>Thread</h2>${thread ? `<ul class="rows">${thread}</ul>` : "<p>Nothing yet.</p>"}</section>` +
    `<section><h2>Results</h2>${prs ? `<ul class="rows">${prs}</ul>` : "<p>None.</p>"}</section>` +
    `<section><h2>Changes in the world</h2>${ledger ? `<ul class="rows">${ledger}</ul>` : "<p>None.</p>"}</section>` +
    nav
  );
}

export function deskCallPage(repo: Repo, call: CallRecord): string {
  type Row = { at: string; html: string };
  const rows: Row[] = [
    ...repo.turns(call.id).map((t) => ({ at: t.at, html: `<li class="say ${t.role}"><span class="muted small">${at(t.at, clock)}</span> <span class="name">${t.role === "caller" ? "Caller" : "Kloru"}</span> ${esc(t.text)}${t.interrupted ? ` <span class="state">(cut off)</span>` : ""}</li>` })),
    ...repo.issues((i) => i.filedBy.call === call.id).map((i) => ({ at: i.createdAt, html: `<li class="task"><span class="muted small">${at(i.createdAt, clock)}</span> <span class="state">Filed ${issueLink(i)} (now ${esc(i.status.replace(/_/g, " "))}):</span> ${esc(clip(i.request, 200))}</li>` })),
    ...repo.inbox(call.id, 0).map((m) => ({ at: m.at, html: `<li class="task"><span class="muted small">${at(m.at, clock)}</span> <span class="state">${esc(m.kind)}${m.issue ? ` for #${m.issue}` : ""}:</span> ${esc(m.text)}</li>` })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const notes = (call.notes ?? []).map((n) => `<li>${esc(n)}</li>`).join("");
  return (
    `<h1>Call on ${at(call.startedAt)}</h1><p class="muted small">${esc(call.phone)} · ${esc(call.channel)} · ${esc(call.callSid)} · ${chain(repo.verifyCall(call.id), "turn")} · head ${short(repo.head(call.id))}</p>` +
    `<ul class="rows transcript">${rows.map((r) => r.html).join("")}</ul>` +
    `${notes ? `<section><h2>Notes for memory</h2><ul class="rows">${notes}</ul></section>` : ""}` +
    `<ul class="go"><li><a href="/admin/calls/${encodeURIComponent(call.callSid)}">Voice transcript</a></li></ul>` +
    nav
  );
}

export function ledgerPage(repo: Repo): string {
  const entries = repo.ledger().reverse();
  return `<h1>Ledger</h1><p class="muted small">Every real-world change, append-only and hash-chained: ${chain(repo.verifyLedger(), "change")}.</p>` + `${entries.length ? `<ul class="rows">${entries.map(ledgerRow).join("")}</ul>` : "<p>No changes yet.</p>"}` + nav;
}

/** Private files (<person>/private/) never appear on the website, for anyone: they're only ever their owner's. */
const shownOnline = (path: string) => !Memory.privateOwner(path);

/** A memory commit's diff without any private file in it. */
export function publicDiff(diff: string): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((part) => !/^diff --git a\/(\S+)/.exec(part) || shownOnline(/^diff --git a\/(\S+)/.exec(part)![1]!))
    .join("");
}

export function memoryPage(memory: Memory, file?: string): string {
  const files = memory.list().filter((f) => shownOnline(f.path));
  const shown = file ? memory.open(file) : undefined;
  const tree = files.map((f) => `<li><a href="/admin/desk/memory?file=${encodeURIComponent(f.path)}"${f.path === file ? ' aria-current="page"' : ""}>${esc(f.path)}</a></li>`).join("");
  const commits = memory.log().map((c) => `<li><a href="/admin/desk/memory/commits/${c.commit}">${c.commit.slice(0, 8)}</a> ${esc(c.message)}</li>`).join("");
  const body = shown && file ? `<section><h2>${esc(file)}</h2><pre class="code">${esc(readFileSync(join(memory.root, file), "utf8"))}</pre></section>` : "";
  return `<h1>Memory</h1><p class="muted small">${plural(files.length, "file")}, ${plural(memory.log().length, "commit")}: one per call the memory worker read.</p>` + body + `<section><h2>Files</h2><ul class="rows">${tree}</ul></section><section><h2>History</h2><ul class="rows">${commits}</ul></section>` + nav;
}

export function memoryCommitPage(commit: string, shown: string): string {
  return `<h1>Memory commit ${esc(commit.slice(0, 8))}</h1><pre class="code">${esc(shown)}</pre>` + nav;
}

/** A memory file path the page may show: one of memory's own files, never anything else. */
export function memoryFile(memory: Memory, path: string | null): string | undefined {
  return path && shownOnline(path) && memory.list().some((f) => f.path === path) ? path : undefined;
}

// ---------------------------------------------------------------------------
// Artifacts: public pages by unguessable link; revoked ids live in the website's own data
// ---------------------------------------------------------------------------

export function revokedArtifacts(path: string | undefined): Set<string> {
  if (!path || !existsSync(path)) return new Set();
  try {
    const ids = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function revokeArtifact(path: string, id: string): void {
  const ids = revokedArtifacts(path);
  ids.add(id);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify([...ids].sort()));
  renameSync(tmp, path);
}

/** The page itself: no console chrome, no scripts, the markdown rendered safely. */
/**
 * A page: the editor (BlockNote) renders its Markdown as blocks, editable when a family member is
 * signed in. The server-rendered page stays underneath until the editor loads, so it reads without
 * scripts too. The page data is JSON in a script tag, with "<" escaped so nothing can close it.
 */
export function artifactPage(a: Artifact, o: { editable?: boolean; csrf?: string; assets?: string } = {}): string {
  const v = o.assets ? `?v=${o.assets}` : "";
  const data = JSON.stringify({ id: a.id, title: a.title, markdown: a.markdown, editable: !!o.editable, ...(o.editable && o.csrf ? { csrf: o.csrf } : {}) }).replace(/</g, "\\u003c");
  const when = at(a.updatedAt ?? a.createdAt);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><title>${esc(a.title)}</title><link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/static/editor.css${v}"></head>` +
    `<body class="artifact"><main>${/^\s*#\s/.test(a.markdown) ? "" : `<h1>${esc(a.title)}</h1>`}<div id="kloru-editor"></div><article id="kloru-fallback">${renderMarkdown(a.markdown)}</article>` +
    `<p class="muted small">Made by Kloru · ${a.version && a.version > 1 ? `updated ${when} (version ${a.version})` : when}</p></main>` +
    `<script type="application/json" id="kloru-page-data">${data}</script><script type="module" src="/static/editor.js${v}"></script></body></html>`
  );
}

export function artifactGonePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Taken down</title><link rel="stylesheet" href="/static/app.css"></head><body class="artifact"><main><h1>This page was taken down</h1></main></body></html>`;
}

export function artifactsSection(list: Artifact[], revoked: Set<string>, csrf: string): string {
  const rows = list
    .slice()
    .reverse()
    .map((a) => {
      const gone = revoked.has(a.id);
      const action = gone
        ? `<span class="state">taken down</span>`
        : `<form method="post" action="/admin/desk/artifacts/revoke" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="id" value="${esc(a.id)}"><button class="link">take down</button></form>`;
      return `<li>${gone ? esc(a.title) : `<a href="/a/${esc(a.id)}">${esc(a.title)}</a>`} <span class="muted small">${a.kind === "app" ? "app · " : ""}${at(a.createdAt)} · <a href="/admin/desk/issues/${a.issue}">#${a.issue}</a>${a.emailedAt ? " · emailed" : ""}</span> · ${action}</li>`;
    })
    .join("");
  return `<section><h2>Pages and apps</h2>${rows ? `<ul class="rows">${rows}</ul>` : "<p>None yet.</p>"}<p class="muted small">Anyone with a page's link can open it; an app is the family's unless it was made for guests. Taking one down is permanent.</p></section>`;
}


// ---------------------------------------------------------------------------
// The store's sync status and automations, read from the agent's data directory
// ---------------------------------------------------------------------------

/** Sync status per source and item counts; read-only, from <agent dir>/store/store.db. */
export function storeSection(deskDir: string): string {
  const path = join(dirname(deskDir), "store", "store.db");
  if (!existsSync(path)) return `<section><h2>Store</h2><p>Not syncing yet.</p></section>`;
  let store: Store | undefined;
  try {
    store = new Store(path, undefined, { readOnly: true });
    const counts = Object.entries(store.counts()).map(([k, n]) => `${esc(k)}: ${n}`).join(" · ");
    const rows = store
      .syncStates()
      .map((st) => `<li><span class="name">${esc(st.source)}</span> <span class="muted small">${esc(st.account)}</span> · ${st.lastOkAt ? `synced ${at(st.lastOkAt)}` : "never synced"}${st.lastError ? ` · <span class="state">${esc(st.lastError)}${st.lastErrorAt ? ` (${at(st.lastErrorAt)})` : ""}</span>` : ""}</li>`)
      .join("");
    return `<section><h2>Store</h2><p class="small">${counts || "Empty."}</p><ul class="rows">${rows}</ul></section>`;
  } catch (error) {
    return `<section><h2>Store</h2><p class="small">Couldn't read it: ${esc(error instanceof Error ? error.message : String(error))}</p></section>`;
  } finally {
    store?.close();
  }
}

interface ScheduleRow {
  id: string;
  name?: string;
  enabled: boolean;
  cron?: string;
  tz?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  prompt: string;
  target?: string;
  phone?: string;
}

/** Automations made on calls (and any other schedules), from <agent dir>/schedules.json. */
export function automationsSection(deskDir: string): string {
  const path = join(dirname(deskDir), "schedules.json");
  let list: ScheduleRow[] = [];
  try {
    list = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ScheduleRow[]) : [];
  } catch {
    list = [];
  }
  const rows = list
    .map((e) => `<li><span class="name">${esc(e.name ?? "untitled")}</span> <span class="muted small">${esc(describeWhen(e.cron, e.cron ? undefined : e.nextRunAt, e.tz))}${e.enabled ? "" : " · paused"}${e.nextRunAt ? ` · next ${at(e.nextRunAt)}` : ""}${e.lastRunAt ? ` · last ${at(e.lastRunAt)}` : ""}${e.phone ? ` · for ${esc(e.phone)}` : ""}</span><br>${esc(clip(e.prompt, 200))}</li>`)
    .join("");
  return `<section><h2>Automations</h2>${rows ? `<ul class="rows">${rows}</ul>` : "<p>None yet. Ask Kloru on a call: “every weekday at 7, email me my day.”</p>"}</section>`;
}
