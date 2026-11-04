/**
 * /admin/metrics: what Kloru costs a day, what it did, the time it saved, and who uses it. Charts are
 * SVG drawn here (the page allows no scripts or inline styles); colors come from app.css.
 */
import { esc } from "./html.js";

export interface MetricsView {
  generatedAt: string;
  days: Array<{
    date: string;
    cost: { models: number; phone: number | null; browser: number | null; speech: number; hosting: number };
    modelSource: "openrouter" | "sessions";
    desk: Record<string, number>;
    requests: { filed: number; finished: number; failed: number };
    actions: Record<string, number>;
    minutesSaved: number;
  }>;
  totals: { today: number; week: number; month: number; requestsFinished: number; minutesSaved: number; activePeople: number };
  people: Array<{ name: string; phone: string; conversations: number; requests: number; minutesSaved: number; costUsd: number }>;
  recent: Array<{ id: number; at: string; who: string; request: string; outcome: string; costUsd: number; minutes: number | null }>;
  sources: string[];
}

const SOURCES = [
  ["models", "Models"],
  ["phone", "Phone"],
  ["browser", "Browser"],
  ["speech", "Speech"],
  ["hosting", "Hosting"],
] as const;

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const hours = (m: number) => (m >= 60 ? `${(m / 60).toFixed(m >= 600 ? 0 : 1)} h` : `${Math.round(m)} min`);
const short = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Stacked daily bars, one scale for every bar; the top tick names a value the chart reaches. */
function costChart(days: MetricsView["days"]): string {
  const W = 680, H = 200, left = 44, bottom = 22, top = 10;
  const totals = days.map((d) => SOURCES.reduce((n, [k]) => n + (d.cost[k] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const step = max > 20 ? 10 : max > 8 ? 5 : max > 4 ? 2 : 1;
  const ceil = Math.ceil(max / step) * step;
  const y = (v: number) => H - bottom - (v / ceil) * (H - bottom - top);
  const bw = (W - left - 8) / days.length;
  const ticks = Array.from({ length: ceil / step + 1 }, (_, i) => i * step);
  const bars = days
    .map((d, i) => {
      let base = 0;
      const x = left + i * bw + 2;
      const parts = SOURCES.map(([k]) => {
        const v = d.cost[k] ?? 0;
        if (v <= 0) return "";
        const r = `<rect class="m-${k}" x="${x.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}"><title>${esc(short(d.date))} ${k}: ${usd(v)}</title></rect>`;
        base += v;
        return r;
      }).join("");
      const label = i % 5 === 0 || i === days.length - 1 ? `<text class="m-axis" x="${(x + (bw - 4) / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(short(d.date))}</text>` : "";
      return parts + label;
    })
    .join("");
  const grid = ticks.map((t) => `<line class="m-grid" x1="${left}" x2="${W}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text class="m-axis" x="${left - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">$${t}</text>`).join("");
  return `<svg class="m-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cost per day for the last ${days.length} days, by source">${grid}${bars}</svg>`;
}

function legend(): string {
  return `<p class="m-legend">${SOURCES.map(([k, label]) => `<span><svg viewBox="0 0 10 10" aria-hidden="true"><rect class="m-${k}" width="10" height="10"/></svg>${label}</span>`).join("")}</p>`;
}

export function metricsPage(m: MetricsView): string {
  const today = m.days.at(-1)!;
  const week = m.days.slice(-7);
  const sum = (rows: MetricsView["days"], f: (d: MetricsView["days"][number]) => number) => rows.reduce((n, d) => n + f(d), 0);
  const actionTotals: Record<string, number> = {};
  for (const d of week) for (const [k, v] of Object.entries(d.actions)) actionTotals[k] = (actionTotals[k] ?? 0) + v;
  const deskWeek: Record<string, number> = {};
  for (const d of week) for (const [k, v] of Object.entries(d.desk)) deskWeek[k] = (deskWeek[k] ?? 0) + v;
  const unavailable = (k: "phone" | "browser") => m.days.every((d) => d.cost[k] === null);

  const stat = (value: string, label: string) => `<div class="m-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const table = (head: string[], rows: string[][]) =>
    `<div class="m-table"><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${head.length}">Nothing yet.</td></tr>`}</table></div>`;

  return (
    `<section class="prose"><p class="lead">Metrics</p><p class="m-note">Updated ${esc(new Date(m.generatedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" }))}. Estimates are marked; the sources are at the bottom.</p></section>` +
    `<div class="m-stats">${stat(usd(m.totals.today), "cost today")}${stat(usd(m.totals.week), "last 7 days")}${stat(usd(m.totals.month), `last ${m.days.length} days`)}${stat(String(m.totals.requestsFinished), "requests done")}${stat(hours(m.totals.minutesSaved), "time saved (estimate)")}${stat(String(m.totals.activePeople), "people this week")}</div>` +
    `<h2>Cost per day</h2>${costChart(m.days)}${legend()}` +
    `<p class="m-note">Today: models ${usd(today.cost.models)}${today.modelSource === "sessions" ? " (desk only)" : ""}, phone ${today.cost.phone === null ? "not available" : usd(today.cost.phone)}, browser ${today.cost.browser === null ? "not available" : usd(today.cost.browser)}, speech ${usd(today.cost.speech)} (estimate), hosting ${usd(today.cost.hosting)} (estimate).${unavailable("phone") ? " Phone usage isn't available." : ""}${unavailable("browser") ? " Browser usage isn't available." : ""}</p>` +
    `<h2>Desk models, last 7 days</h2>` +
    table(["Role", "Cost"], Object.entries(deskWeek).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(k), usd(v)])) +
    `<h2>What it did, last 7 days</h2>` +
    `<div class="m-stats">${stat(String(sum(week, (d) => d.requests.filed)), "requests")}${stat(String(sum(week, (d) => d.requests.finished)), "done")}${stat(String(sum(week, (d) => d.requests.failed)), "failed")}${stat(hours(sum(week, (d) => d.minutesSaved)), "saved (estimate)")}</div>` +
    table(["Action", "Count"], Object.entries(actionTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => [esc(k), String(v)])) +
    `<h2>People, last ${m.days.length} days</h2>` +
    table(["Person", "Conversations", "Requests", "Time saved", "Model cost"], m.people.map((p) => [`${esc(p.name)} <span class="m-soft">${esc(p.phone)}</span>`, String(p.conversations), String(p.requests), hours(p.minutesSaved), usd(p.costUsd)])) +
    `<h2>Recent requests</h2>` +
    table(["When", "Who", "Request", "Outcome", "Cost", "Saved"], m.recent.map((r) => [esc(new Date(r.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })), esc(r.who), `<a href="/admin/desk/issues/${r.id}">${esc(r.request)}</a>`, esc(r.outcome), usd(r.costUsd), r.minutes === null ? `<span class="m-soft">pending</span>` : hours(r.minutes)])) +
    `<h2>Where the numbers come from</h2><ul class="m-sources">${m.sources.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`
  );
}
