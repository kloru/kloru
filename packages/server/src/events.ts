/**
 * Event automations: an app event (a Composio trigger, signed with the project's secret) or a call
 * to an automation's own webhook URL starts a run. Each event is written to a durable inbox before
 * it's acknowledged; then the automations waiting for it get the quick check (event-gate) when they
 * have a condition, and the ones it passes are filed on the desk like a scheduled run.
 */
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { ScheduleEntry, StateDir } from "@kloru/core";
import { DurableInbox } from "@kloru/inkbox";
import type { AppEvent } from "@kloru/apps";
import type { GateDecision, GateInput } from "./event-gate.js";

type Headers = Record<string, string | string[] | undefined>;

export interface QueuedEvent {
  id: string;
  at: string;
  source: "app" | "hook";
  /** app: the Composio trigger it came from. */
  instance?: string;
  trigger?: string;
  /** hook: the automation whose URL was called. */
  automation?: string;
  body: string;
}

export interface EventsOptions {
  state: StateDir;
  automations: () => ScheduleEntry[];
  /** File a run on the desk (Desk.runAutomation). */
  run(entry: ScheduleEntry, event: string): void;
  gate?: (g: GateInput) => Promise<GateDecision>;
  guidelines?: (phone: string) => string;
  /** Check an app event's signature and read it; unset: app events are refused. */
  verify?: (body: string, headers: Headers) => Promise<AppEvent>;
  /** Every decision, for the audit log: which event, which automation, run or skip. */
  record?: (detail: Record<string, unknown>) => void;
  log: (m: string) => void;
  now?: () => number;
  /** Calls a webhook automation takes an hour before it answers 429. */
  hourlyLimit?: number;
}

/** The part of an event a run sees (an email's first part, a webhook's body). */
const EVENT_MAX = 8_000;
const HOUR = 3_600_000;

const header = (h: Headers, name: string) => ((v) => (Array.isArray(v) ? v[0] : v))(h[name])?.trim();
const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** JSON pretty-printed (one space: shorter), anything else as it came. */
function readable(body: string | Record<string, unknown>): string {
  if (typeof body !== "string") return JSON.stringify(body, null, 1);
  try {
    return JSON.stringify(JSON.parse(body), null, 1);
  } catch {
    return body;
  }
}

export class Events {
  private readonly inbox: DurableInbox<QueuedEvent>;
  private readonly calls = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(private readonly o: EventsOptions) {
    this.now = o.now ?? Date.now;
    this.inbox = new DurableInbox<QueuedEvent>({
      file: o.state.path("events-inbox.json"),
      handle: (e) => this.handle(e),
      onError: (id, status) => o.log(`events: ${id}: ${status}`),
    });
  }

  start(): void {
    this.inbox.start();
  }

  close(): Promise<void> {
    return this.inbox.close();
  }

  /** Run whatever has arrived (tests). */
  drain(): Promise<void> {
    return this.inbox.drain();
  }

  /** POST /webhooks/composio: the status to answer. */
  async fromApp(body: string, headers: Headers): Promise<number> {
    if (!this.o.verify) return 503;
    let e: AppEvent;
    try {
      e = await this.o.verify(body, headers);
    } catch (error) {
      this.o.log(`events: refused an app event: ${error instanceof Error ? error.message : String(error)}`);
      return 401;
    }
    if (!this.o.automations().some((a) => a.on?.kind === "app" && a.on.instance === e.instance)) {
      this.o.log(`events: ${e.trigger} (${e.instance}) has no automation; dropped`);
      return 204;
    }
    return this.enqueue({ id: `app:${e.id || randomUUID()}`, at: new Date(this.now()).toISOString(), source: "app", instance: e.instance, trigger: e.trigger, body: readable(e.data).slice(0, EVENT_MAX) });
  }

  /** POST /webhooks/hook/<token>: the status to answer. */
  fromHook(token: string, body: string, headers: Headers): number {
    const entry = this.o.automations().find((a) => a.on?.kind === "hook" && sameToken(a.on.token, token));
    if (!entry) return 404;
    if (!entry.enabled) {
      this.o.log(`events: ${entry.id} is paused; its webhook call is dropped`);
      return 204;
    }
    const t = this.now();
    const recent = (this.calls.get(entry.id) ?? []).filter((x) => t - x < HOUR);
    if (recent.length >= (this.o.hourlyLimit ?? 60)) return 429;
    this.calls.set(entry.id, [...recent, t]);
    // A sender's own id makes its retries count once.
    const key = header(headers, "idempotency-key") ?? header(headers, "x-request-id");
    return this.enqueue({ id: `hook:${entry.id}:${key ? key.slice(0, 200) : randomUUID()}`, at: new Date(t).toISOString(), source: "hook", automation: entry.id, body: readable(body).slice(0, EVENT_MAX) });
  }

  private enqueue(e: QueuedEvent): number {
    try {
      this.inbox.enqueue(e.id, e);
      return 204;
    } catch (error) {
      this.o.log(`events: can't keep ${e.id}: ${error instanceof Error ? error.message : String(error)}`);
      return 503;
    }
  }

  private async handle(e: QueuedEvent): Promise<void> {
    const waiting = this.o.automations().filter((a) => a.enabled && a.target === "desk" && (e.source === "hook" ? a.id === e.automation : a.on?.kind === "app" && a.on.instance === e.instance));
    for (const a of waiting) {
      const on = a.on!;
      const event = `${on.kind === "app" ? `${on.label ?? e.trigger ?? on.trigger} for ${on.account}` : "A call to its webhook"}, at ${e.at}:\n${e.body}`;
      let decision: GateDecision & { error?: string } = { run: true };
      if (a.when && this.o.gate) {
        decision = await this.o
          .gate({ automation: a.name ?? "Automation", request: a.prompt, condition: a.when, event, guidelines: (a.phone && this.o.guidelines?.(a.phone)) || "" })
          .catch((error: unknown) => ({ run: true, error: error instanceof Error ? error.message : String(error) }));
      }
      this.o.record?.({ event: e.id, automation: a.id, ...(e.trigger ? { trigger: e.trigger } : {}), run: decision.run, ...(decision.p !== undefined ? { p: decision.p } : {}), ...(decision.error ? { error: decision.error } : {}) });
      this.o.log(`events: ${e.id} → ${a.id} ${decision.run ? "runs" : "skipped"}${decision.p !== undefined ? ` (${decision.p.toFixed(2)})` : ""}${decision.error ? ` (check failed: ${decision.error})` : ""}`);
      if (decision.run) this.o.run(a, event);
    }
  }
}
