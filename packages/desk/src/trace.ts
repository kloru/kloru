/**
 * A request's timing trace: one line per step in `traces/<issue>.jsonl`, written as each step
 * ends. A step is an agent's run, one model turn or tool call inside it, a decision, or plumbing
 * (the talker filing, a message waiting in the outbox, the channel taking it).
 *
 * Times and outcomes only, never words: what was asked and answered is on the issue and in the
 * call's transcript. The same steps go to Langfuse when that is on (Desk.span).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TraceKind = "agent" | "decision" | "model" | "tool" | "plumbing";

export interface TraceSpan {
  /** What ran: "pm", "engineer", "fast path", "access review", "model", "browser_run", "send". */
  step: string;
  kind: TraceKind;
  start: string;
  end: string;
  ms: number;
  /** How it ended: a decision's answer, a model turn's stop reason, "ok", "failed". */
  outcome?: string;
  /** The agent run a model turn or tool call was part of. */
  within?: string;
  model?: string;
  tokens?: { in: number; out: number };
  error?: string;
}

/** A step as its caller times it. */
export interface Timed {
  step: string;
  kind: TraceKind;
  start: Date;
  /** Unset: now. */
  end?: Date;
  outcome?: string;
  within?: string;
  model?: string;
  tokens?: { in: number; out: number };
  error?: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toSpan(t: Timed): TraceSpan {
  const end = t.end ?? new Date();
  return {
    step: clip(t.step, 80),
    kind: t.kind,
    start: t.start.toISOString(),
    end: end.toISOString(),
    ms: Math.max(0, end.getTime() - t.start.getTime()),
    ...(t.outcome ? { outcome: clip(t.outcome, 80) } : {}),
    ...(t.within ? { within: t.within } : {}),
    ...(t.model ? { model: t.model } : {}),
    ...(t.tokens ? { tokens: t.tokens } : {}),
    ...(t.error ? { error: clip(t.error, 200) } : {}),
  };
}

export class Traces {
  constructor(private readonly dir: string, o: { readOnly?: boolean } = {}) {
    if (!o.readOnly) mkdirSync(dir, { recursive: true });
  }

  private file(issue: number): string {
    return join(this.dir, `${issue}.jsonl`);
  }

  append(issue: number, t: Timed): TraceSpan {
    const span = toSpan(t);
    appendFileSync(this.file(issue), JSON.stringify(span) + "\n");
    return span;
  }

  /** The issue's steps in the order they started. */
  read(issue: number): TraceSpan[] {
    return readTrace(this.dir, issue);
  }
}

/** Read a trace without a Traces (the website reads a live repository). */
export function readTrace(dir: string, issue: number): TraceSpan[] {
  const file = join(dir, `${issue}.jsonl`);
  if (!existsSync(file)) return [];
  const out: TraceSpan[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TraceSpan);
    } catch {
      // A line cut short by a crash; the rest still reads.
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** The part of an agent the tracer listens to (a Pi Agent). */
export interface TracedAgent {
  subscribe(listener: (e: any) => void): () => void;
}

/**
 * Time an agent's model turns and tool calls while it runs. A model turn runs from the turn's
 * start to the assistant's message; returns the function that stops it.
 */
export function traceAgent(agent: TracedAgent, within: string, record: (t: Timed) => void): () => void {
  let turn: Date | undefined;
  const tools = new Map<string, Date>();
  return agent.subscribe((e) => {
    try {
      if (e.type === "turn_start") turn = new Date();
      else if (e.type === "message_end" && e.message?.role === "assistant") {
        const m = e.message as { model?: string; stopReason?: string; usage?: { input?: number; output?: number } };
        record({
          step: "model",
          kind: "model",
          within,
          start: turn ?? new Date(),
          ...(m.stopReason ? { outcome: m.stopReason } : {}),
          ...(m.model ? { model: m.model } : {}),
          ...(m.usage ? { tokens: { in: m.usage.input ?? 0, out: m.usage.output ?? 0 } } : {}),
        });
        turn = undefined;
      } else if (e.type === "tool_execution_start") tools.set(e.toolCallId, new Date());
      else if (e.type === "tool_execution_end") {
        const start = tools.get(e.toolCallId);
        tools.delete(e.toolCallId);
        if (start) record({ step: String(e.toolName), kind: "tool", within, start, outcome: e.isError ? "error" : "ok" });
      }
    } catch {
      // Tracing never breaks a run.
    }
  });
}
