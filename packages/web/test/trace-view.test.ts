import { describe, expect, it } from "vitest";
import type { TraceSpan } from "@kloru/desk";
import { seconds, traceSection } from "../src/trace-view.js";

const span = (step: string, kind: TraceSpan["kind"], from: number, to: number, more: Partial<TraceSpan> = {}): TraceSpan => ({
  step,
  kind,
  start: new Date(Date.UTC(2026, 10, 15, 9, 0, 0) + from).toISOString(),
  end: new Date(Date.UTC(2026, 10, 15, 9, 0, 0) + to).toISOString(),
  ms: to - from,
  ...more,
});

describe("traceSection", () => {
  it("draws a row per step with its time, and says how long the request took", () => {
    const html = traceSection([
      span("pm", "agent", 0, 3_000, { outcome: "filed: ok" }),
      span("engineer", "agent", 3_000, 58_000, { outcome: "done" }),
      span("browser_run", "tool", 5_000, 29_000, { within: "engineer", outcome: "ok" }),
      span("send", "plumbing", 68_000, 69_100, { outcome: "imessage" }),
    ]);
    expect(html).toContain("1 min 9 s from the first step to the last, 4 steps");
    expect(html.match(/<rect class="t-(agent|tool|plumbing)" x=/g)).toHaveLength(4);
    expect(html).toContain("· browser_run → ok");
    expect(html).toContain("engineer: browser_run, 24.0 s, ok");
    // The site's CSP has no inline styles.
    expect(html).not.toContain("style=");
  });

  it("escapes what a step is called, and says so when there is no trace", () => {
    expect(traceSection([span("<b>x</b>", "tool", 0, 10)])).not.toContain("<b>x</b>");
    expect(traceSection([])).toContain("No trace");
  });

  it("writes times the way people read them", () => {
    expect([seconds(40), seconds(2_100), seconds(69_100)]).toEqual(["40 ms", "2.1 s", "1 min 9 s"]);
  });
});
