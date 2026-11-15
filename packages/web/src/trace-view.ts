/**
 * A request's timing trace as a picture: one row per step, drawn from traces/<issue>.jsonl
 * (packages/desk/src/trace.ts). SVG attributes only: the site's CSP allows no inline styles.
 */
import type { TraceKind, TraceSpan } from "@kloru/desk";
import { esc } from "./html.js";

const KINDS: Array<[TraceKind, string]> = [
  ["agent", "agent run"],
  ["model", "model turn"],
  ["tool", "tool call"],
  ["decision", "decision"],
  ["plumbing", "waiting and sending"],
];

export const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function traceSection(spans: TraceSpan[]): string {
  if (!spans.length) return `<section><h2>Timing</h2><p class="muted">No trace: this request ran before traces were kept.</p></section>`;
  const t0 = Math.min(...spans.map((s) => Date.parse(s.start)));
  const t1 = Math.max(...spans.map((s) => Date.parse(s.end)));
  const total = Math.max(1, t1 - t0);
  const W = 720, ROW = 18, TOP = 20, LEFT = 200, RIGHT = 640;
  const x = (t: number) => LEFT + ((t - t0) / total) * (RIGHT - LEFT);
  const H = TOP + spans.length * ROW + 6;
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const gx = (LEFT + f * (RIGHT - LEFT)).toFixed(1);
      return `<line class="m-grid" x1="${gx}" x2="${gx}" y1="${TOP - 4}" y2="${H - 4}"/><text class="m-axis" x="${gx}" y="10" text-anchor="middle">${esc(seconds(Math.round(f * total)))}</text>`;
    })
    .join("");
  const rows = spans
    .map((s, i) => {
      const y = TOP + i * ROW;
      const a = x(Date.parse(s.start));
      const w = Math.max(1.5, x(Date.parse(s.end)) - a);
      const label = `${s.within ? "· " : ""}${s.step}${s.outcome ? ` → ${s.outcome}` : ""}`;
      const tip = `${s.within ? `${s.within}: ` : ""}${s.step}, ${seconds(s.ms)}${s.outcome ? `, ${s.outcome}` : ""}${s.model ? `, ${s.model}` : ""}${s.tokens ? `, ${s.tokens.in} in / ${s.tokens.out} out` : ""}${s.error ? `, ${s.error}` : ""}`;
      return (
        `<text class="m-axis${s.error ? " t-failed" : ""}" x="${s.within ? 12 : 0}" y="${y + 12}">${esc(clip(label, s.within ? 30 : 32))}</text>` +
        `<rect class="t-${s.kind}" x="${a.toFixed(1)}" y="${y + 3}" width="${w.toFixed(1)}" height="${ROW - 6}"><title>${esc(tip)}</title></rect>` +
        `<text class="m-axis" x="${W}" y="${y + 12}" text-anchor="end">${esc(seconds(s.ms))}</text>`
      );
    })
    .join("");
  const legend = `<p class="m-legend">${KINDS.filter(([k]) => spans.some((s) => s.kind === k)).map(([k, label]) => `<span><svg viewBox="0 0 10 10" aria-hidden="true"><rect class="t-${k}" width="10" height="10"/></svg>${label}</span>`).join("")}</p>`;
  return (
    `<section><h2>Timing</h2><p class="muted small">${esc(seconds(total))} from the first step to the last, ${spans.length} steps.</p>${legend}` +
    `<svg class="m-chart t-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Each step of this request on a timeline, ${esc(seconds(total))} in all">${grid}${rows}</svg></section>`
  );
}
