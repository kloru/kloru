/** Page chrome and escaping. Every dynamic value on a page goes through `esc`. */

export type Banner = { kind: "ok" | "error"; text: string };

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

/** Three hand-drawn figures, arm in arm: Kloru is for groups. */
export const LOGO_SVG =
  `<svg class="mark" viewBox="0 0 64 44" width="88" height="60" role="img" aria-label="Kloru" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="14" cy="7" r="4.2"/><path d="M14 11.5c-.4 5 .3 10.2 0 15.4M14 26.9l-4.6 13.4M14 26.9l4.3 13.2M14 15.6c-3.6 2.4-6.2 5.6-7.6 9.4M14 15.6c4.4 1.2 8.8 2.6 13.6 2.2"/>` +
  `<circle cx="32" cy="6" r="4.4"/><path d="M32.2 10.6c.3 5.4-.4 10.8.1 16.2M32.3 26.8l-4.9 13.7M32.3 26.8l4.6 13.9M27.6 18c1.6-.7 3.1-1.3 4.6-1.6M32.2 16.4c4.8.7 9.3 1.4 13.8 1.4"/>` +
  `<circle cx="50" cy="7.4" r="4"/><path d="M49.9 11.6c.4 5-.2 10 .2 15M50.1 26.6l-4.3 13.6M50.1 26.6l4.8 13.1M50 15.8c3.4 2.3 5.9 5.3 7.4 9"/>` +
  `</svg>`;

const NAV: ReadonlyArray<readonly [string, string]> = [
  ["/connections", "Connections"],
  ["/permissions", "Permissions"],
  ["/approvals", "Approvals"],
  ["/automations", "Automations"],
  ["/contacts", "People"],
  ["/pages", "Pages"],
  ["/outbox", "Messages"],
  ["/policy", "My policy"],
  ["/vault", "Vault"],
  ["/settings", "Settings"],
];

export interface LayoutOptions {
  title: string;
  body: string;
  user?: { label: string; admin: boolean };
  active?: string;
  banner?: Banner;
}

export function layout(o: LayoutOptions): string {
  const links = o.user ? [...NAV, ...(o.user.admin ? [["/admin", "Admin"] as const] : [])] : [];
  const nav = o.user
    ? `<nav>${links.map(([href, label]) => `<a href="${href}"${o.active === href ? ' aria-current="page"' : ""}>${label}</a>`).join("")}` +
      `<span class="who">${esc(o.user.label)} · <a href="/logout">Sign out</a></span></nav>`
    : "";
  const banner = o.banner ? `<p class="banner ${o.banner.kind}" role="status">${esc(o.banner.text)}</p>` : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(o.title)} · Kloru</title><link rel="stylesheet" href="/static/app.css"><script src="/static/app.js" defer></script></head>` +
    `<body><header><a class="brand" href="/" aria-label="Kloru home">${LOGO_SVG}</a>${nav}</header>` +
    `<main>${banner}${o.body}</main>` +
    `<footer><span>© 2026 Kloru</span><a href="/why">Why</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a></footer></body></html>`
  );
}
