/**
 * An app (one HTML file a worker wrote) runs in two layers:
 *
 * - The shell, at /a/<id>: Kloru's own page. It knows who is using the app and talks to the
 *   app's data routes for them.
 * - The frame, at /a/<id>/app: the app's HTML, sandboxed. It has no kloru.com cookies or storage
 *   and can make no network request; all it can do is ask the shell for its own data.
 *
 * So an app can't reach anything on this site but its own records, and can't send them anywhere.
 */
import type { Artifact } from "@kloru/desk";
import { esc } from "./html.js";

/** The frame's whole world: its own inline script and style, nothing loaded, nothing sent. */
export const FRAME_CSP =
  "sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export type AppAccess = "family" | "visitor" | "sign-in";

/** Who is this to the app: the family (signed in), a guest the app lets in, or someone to send to sign in. */
export function appAccess(app: Pick<Artifact, "visitors">, signedIn: boolean): AppAccess {
  if (signedIn) return "family";
  return app.visitors === "add" || app.visitors === "all" ? "visitor" : "sign-in";
}

/** The shell: a full-window frame, and what its script needs, as attributes (the page's policy allows no inline script). */
export function appShellPage(a: Artifact, o: { key: string; frameKey: string; me?: { name: string }; test?: boolean; assets?: string }): string {
  const v = o.assets ? `?v=${o.assets}` : "";
  const version = a.version ?? 1;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow"><title>${esc(a.title)}</title><link rel="stylesheet" href="/static/app.css"></head>` +
    `<body class="app-shell"><iframe id="kloru-app" title="${esc(a.title)}" sandbox="allow-scripts allow-forms" src="/a/${esc(a.id)}/app?k=${esc(o.frameKey)}&amp;v=${version}"` +
    ` name="${esc(JSON.stringify({ me: o.me ?? null }))}" data-app="${esc(a.id)}" data-key="${esc(o.key)}" data-version="${version}"${o.me ? "" : ` data-visitor="1"`}${o.test ? ` data-test="1"` : ""}></iframe>` +
    `<script src="/static/app-shell.js${v}"></script></body></html>`
  );
}

/** The frame: Kloru's client script first (it defines `kloru`), then the app's file as written. */
export function appFramePage(a: Artifact, client: string): string {
  const html = (a.html ?? "").replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><script>${client.replace(/<\/script/gi, "<\\/script")}</script>${html}`;
}

const day = (iso: string) => iso.slice(0, 10);

/** Your pages and the family's apps, newest first. */
export function pagesPage(list: Artifact[]): string {
  const rows = list
    .slice()
    .sort((x, y) => (y.updatedAt ?? y.createdAt).localeCompare(x.updatedAt ?? x.createdAt))
    .map((a) => `<li><a href="/a/${esc(a.id)}">${esc(a.title)}</a> <span class="muted small">${a.kind === "app" ? "app" : "page"} · ${day(a.updatedAt ?? a.createdAt)}</span></li>`)
    .join("");
  return `<h1>Pages</h1><section>${rows ? `<ul class="rows">${rows}</ul>` : "<p>None yet. Ask Kloru for a shared grocery list, or a summary of your week.</p>"}<p class="muted small">Apps are the whole family's. Pages are yours.</p></section>`;
}
