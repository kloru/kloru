/**
 * /admin/models: which model does each job, and picking another. The choices come from OpenRouter's
 * list as the agent read it just now; the agent checks a pick against the same list before keeping it.
 */
import { esc } from "./html.js";

type Kind = "decision" | "tools" | "json" | "text" | "image";

export interface ModelsView {
  roles: Array<{ id: string; label: string; what: string; group: string; kind: Kind; model: string; default: string; by?: string; at?: string }>;
  catalog: { ok: true; value: Array<{ id: string; name: string; in: number; out: number; since: string; kinds: Kind[] }> } | { ok: false; error: string };
}

const KINDS: Kind[] = ["decision", "tools", "json", "text", "image"];
const usd = (n: number) => (n === 0 ? "$0" : `$${n.toFixed(n < 0.1 ? 3 : 2)}`);

export function modelsPage(v: ModelsView, csrf: string): string {
  const listed = v.catalog.ok ? v.catalog.value : [];
  const byId = new Map(listed.map((m) => [m.id, m]));
  const about = (id: string) => {
    const m = byId.get(id);
    if (m) return `Listed ${esc(m.since)} · ${usd(m.in)} in, ${usd(m.out)} out per million tokens.`;
    return v.catalog.ok ? "OpenRouter doesn't list this one through a provider that keeps no data." : "";
  };
  const role = (r: ModelsView["roles"][number]) =>
    `<form method="post" action="/admin/models" class="model"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="role" value="${esc(r.id)}">` +
    `<label><span><span class="name">${esc(r.label)}</span> <span class="muted small">${esc(r.what)}</span></span>` +
    `<input name="model" list="models-${r.kind}" value="${esc(r.model)}" required autocomplete="off" autocapitalize="off" spellcheck="false"></label>` +
    `<p class="muted small">${about(r.model)}${r.by ? ` Picked by ${esc(r.by)}${r.at ? ` on ${esc(r.at.slice(0, 10))}` : ""}.` : " The default."}</p>` +
    `<p><button class="go">Save</button>${r.by ? ` <button class="link" name="reset" value="1" formnovalidate>Back to the default (${esc(r.default)})</button>` : ""}</p></form>`;
  const groups = [...new Set(v.roles.map((r) => r.group))];
  const lists = KINDS.map(
    (k) => `<datalist id="models-${k}">${listed.filter((m) => m.kinds.includes(k)).map((m) => `<option value="${esc(m.id)}" label="${esc(`${m.name} · ${usd(m.in)} in, ${usd(m.out)} out · ${m.since}`)}">`).join("")}</datalist>`,
  ).join("");
  return (
    `<h1>Models</h1><p>Which model does each job. A change takes effect on the next request or call, with no deploy. ` +
    `Every choice is a model OpenRouter offers now through a provider that keeps no data, and one that can do the job.</p>` +
    (v.catalog.ok ? "" : `<p class="muted">${esc(v.catalog.error)}. Nothing can be changed until it can.</p>`) +
    groups.map((g) => `<section class="models"><h2>${esc(g)}</h2>${v.roles.filter((r) => r.group === g).map(role).join("")}</section>`).join("") +
    lists
  );
}
