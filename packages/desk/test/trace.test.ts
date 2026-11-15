import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Desk, type Planner, type Trigger, type WorkerHost } from "../src/desk.js";
import { Traces, readTrace, traceAgent, type Timed } from "../src/trace.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

describe("Traces", () => {
  it("keeps one line per step, read back in the order the steps started", () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    const traces = new Traces(dir);
    const at = (s: number) => new Date(Date.UTC(2026, 10, 15, 9, 0, s));
    traces.append(7, { step: "engineer", kind: "agent", start: at(3), end: at(50), outcome: "done" });
    traces.append(7, { step: "pm", kind: "agent", start: at(0), end: at(3), outcome: "filed: ok" });
    const spans = readTrace(dir, 7);
    expect(spans.map((s) => [s.step, s.ms])).toEqual([["pm", 3000], ["engineer", 47000]]);
    expect(readTrace(dir, 8)).toEqual([]);
  });

  it("a line cut short by a crash doesn't lose the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    const traces = new Traces(dir);
    traces.append(1, { step: "pm", kind: "agent", start: new Date(0), end: new Date(10) });
    appendFileSync(join(dir, "1.jsonl"), '{"step":"engin');
    expect(traces.read(1).map((s) => s.step)).toEqual(["pm"]);
  });

  it("keeps times and outcomes, clipped, never a long text", () => {
    const dir = mkdtempSync(join(tmpdir(), "traces-"));
    const span = new Traces(dir).append(1, { step: "x".repeat(300), kind: "tool", start: new Date(0), end: new Date(5), outcome: "y".repeat(300), error: "z".repeat(900) });
    expect(span.step.length).toBe(80);
    expect(span.outcome!.length).toBe(80);
    expect(span.error!.length).toBe(200);
  });
});

describe("traceAgent", () => {
  it("times each model turn and tool call of a run, and stops when told", () => {
    let listener: (e: any) => void = () => {};
    let stopped = false;
    const agent = { subscribe: (l: (e: any) => void) => ((listener = l), () => (stopped = true)) };
    const got: Timed[] = [];
    const stop = traceAgent(agent, "engineer", (t) => got.push(t));
    listener({ type: "turn_start" });
    listener({ type: "message_end", message: { role: "user" } });
    listener({ type: "message_end", message: { role: "assistant", model: "terra", stopReason: "toolUse", usage: { input: 900, output: 40 } } });
    listener({ type: "tool_execution_start", toolCallId: "a", toolName: "browser_run" });
    listener({ type: "tool_execution_end", toolCallId: "a", toolName: "browser_run", isError: true });
    listener({ type: "tool_execution_end", toolCallId: "never-started", toolName: "x" });
    expect(got.map((t) => [t.step, t.kind, t.within, t.outcome])).toEqual([
      ["model", "model", "engineer", "toolUse"],
      ["browser_run", "tool", "engineer", "error"],
    ]);
    expect(got[0]).toMatchObject({ model: "terra", tokens: { in: 900, out: 40 } });
    stop();
    expect(stopped).toBe(true);
  });
});

describe("Desk: a request's trace", () => {
  it("has the talker, the PM and the worker, with how each ended", async () => {
    const runs: Array<(t: string) => void> = [];
    const host: WorkerHost = { run: () => new Promise((resolve) => runs.push(resolve)), steer: () => false, stop: () => {} };
    const pm: Planner = {
      handle: async (ts: Trigger[], d: Desk) => {
        for (const t of ts) if (t.kind === "filed") d.assign(t.issue, "work", "Find the cards", []);
      },
    };
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host, planner: pm, retryMs: 5 });
    const { call } = desk.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    desk.addTurn(call.id, { role: "caller", text: "Find Halloween diamond-art cards" });
    const issue = desk.fileIssue(call.id, "Find Halloween diamond-art cards");
    await settle();
    runs[0]!("Two packs found.");
    await settle();
    const trace = desk.trace(issue.id);
    expect(trace.map((s) => [s.step, s.kind])).toEqual(expect.arrayContaining([["talker", "agent"], ["pm", "agent"], ["engineer", "agent"]]));
    expect(trace.find((s) => s.step === "engineer")!.outcome).toBe("done");
    expect(trace.find((s) => s.step === "pm")!.outcome).toContain("filed");
    // Times and outcomes only: what was asked stays on the issue.
    expect(JSON.stringify(trace)).not.toContain("diamond");
  });

  it("a step for a request that isn't there is dropped, not thrown", () => {
    const desk = new Desk({ root: mkdtempSync(join(tmpdir(), "desk-")), host: { run: async () => "", steer: () => false, stop: () => {} }, planner: { handle: async () => {} } });
    expect(() => desk.span(99, { step: "pm", kind: "agent", start: new Date() })).not.toThrow();
    expect(desk.trace(99)).toEqual([]);
  });
});
