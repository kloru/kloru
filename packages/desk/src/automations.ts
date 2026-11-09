/**
 * Automations made on a call: "every weekday at 7, email me a debrief of my day", or "when I get an
 * email I need to answer, draft a reply". Ops saves one (after the caller's yes, enforced by the
 * desk's ops guard) in the agent's scheduler; when it fires (its time, an app event or its webhook),
 * Desk.runAutomation files it as a desk issue and the result reaches the caller.
 */
import { randomBytes } from "node:crypto";
import { defineTool, textResult, type RegisteredTool, type ScheduleEntry, type ScheduleEvent } from "@kloru/core";
import { Type } from "typebox";
import { AUTOMATION_CREATE, AUTOMATION_DELETE, AUTOMATION_EVENTS, AUTOMATION_LIST, describeEvent, describeWhen, type Desk } from "./desk.js";

export { AUTOMATION_CREATE, AUTOMATION_DELETE, AUTOMATION_EVENTS, AUTOMATION_LIST };

/** App events and webhooks, when the server has them: without, automations run on a schedule only. */
export interface AutomationEvents {
  /** What an app can start an automation on: its events, one per line (slug, name, use, settings). */
  types(app: string): Promise<string>;
  /** Watch an event of a connected account for this caller; throws when the account isn't theirs to watch. Returns Composio's trigger id. */
  watch(o: { trigger: string; account: string; config?: Record<string, unknown>; phone: string; issue: number }): Promise<{ instance: string; label?: string }>;
  unwatch(instance: string): Promise<void>;
  /** The public URL of a webhook automation; undefined when this Kloru has no public address. */
  hookUrl(token: string): string | undefined;
}

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const issueOf = (ctx: { conversationKey?: string } | undefined) => Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);

/** An automation's "when", for people. */
export function describeAutomation(e: ScheduleEntry, tz?: string): string {
  return e.on ? `${describeEvent(e.on)}${e.when ? `, if ${e.when}` : ""}` : describeWhen(e.cron, e.cron ? undefined : e.nextRunAt, tz);
}

/** Delete an automation; an app event nothing else watches stops being watched. */
export async function deleteAutomation(scheduler: NonNullable<Desk["scheduler"]>, id: string, events?: Pick<AutomationEvents, "unwatch">): Promise<boolean> {
  const entry = scheduler.list().find((e) => e.id === id);
  if (!entry || !scheduler.delete(id)) return false;
  const on = entry.on;
  if (on?.kind === "app" && events && !scheduler.list().some((e) => e.on?.kind === "app" && e.on.instance === on.instance)) await events.unwatch(on.instance);
  return true;
}

export function automationTools(desk: Desk, events?: AutomationEvents): RegisteredTool[] {
  const record = (issueId: number, slug: string, args: unknown, ok: boolean, result: string) => {
    const issue = desk.repo.issue(issueId);
    if (issue) desk.repo.appendLedger({ issue: issueId, call: issue.filedBy.call, phone: issue.filedBy.phone, tool: slug.toLowerCase(), slug, args, ok, result });
  };
  const tools: RegisteredTool[] = [
    defineTool({
      name: AUTOMATION_CREATE,
      label: "Create an automation",
      description:
        "Save something to do on its own: on a schedule (cron, 5 fields in the owner's timezone, for repeating; at, an ISO time, for once), " +
        (events ? "when an app event happens (on_event: an event from automation_events, for one of the caller's connected accounts), or when its own webhook URL is called (on_webhook). " : "") +
        "The request is what the desk does each time; its result reaches the caller. Needs the caller's yes first.",
      parameters: Type.Object({
        name: Type.String({ description: 'short, e.g. "Morning debrief"' }),
        request: Type.String({ description: "what to do each time, in one clear sentence, as if the caller just asked" }),
        cron: Type.Optional(Type.String({ description: 'minute hour day-of-month month day-of-week, e.g. "0 7 * * 1-5"' })),
        at: Type.Optional(Type.String({ description: "ISO time for a one-time run" })),
        ...(events
          ? {
              on_event: Type.Optional(
                Type.Object({
                  trigger: Type.String({ description: "the event's slug, e.g. GMAIL_NEW_GMAIL_MESSAGE" }),
                  account: Type.String({ description: "the connected account to watch, by address" }),
                  config: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "the event's settings, if it has any" })),
                }),
              ),
              on_webhook: Type.Optional(Type.Boolean({ description: "true: run whenever its own URL is called (from Zapier, a script, a device). The URL comes back here; give it to the caller." })),
              when: Type.Optional(Type.String({ description: 'for an event: which ones are worth a run, in the caller\'s words, e.g. "an email I need to answer"; leave out to run on every one' })),
            }
          : {}),
      }),
      meta: { capabilities: ["schedule.manage"], group: "schedule" as const },
      execute: async (args, ctx) => {
        const { name, request, cron, at } = args;
        const a = args as { on_event?: { trigger: string; account: string; config?: Record<string, unknown> }; on_webhook?: boolean; when?: string };
        const issueId = issueOf(ctx);
        const issue = desk.repo.issue(issueId);
        if (!issue || !desk.scheduler) return failed("Automations aren't available here.");
        const kinds = [cron, at, a.on_event, a.on_webhook].filter(Boolean).length;
        if (kinds !== 1) return failed("Give exactly one of cron, at, on_event or on_webhook.");
        const logged = { name, request, cron, at, on_event: a.on_event, on_webhook: a.on_webhook, when: a.when };
        let on: ScheduleEvent | undefined;
        try {
          if (a.on_event && events) {
            const trigger = a.on_event.trigger.trim().toUpperCase();
            const w = await events.watch({ ...a.on_event, trigger, phone: issue.filedBy.phone, issue: issueId });
            on = { kind: "app", trigger, ...(w.label ? { label: w.label } : {}), account: a.on_event.account.trim().toLowerCase(), ...(a.on_event.config ? { config: a.on_event.config } : {}), instance: w.instance };
          } else if (a.on_webhook && events) {
            on = { kind: "hook", token: randomBytes(24).toString("base64url") };
          }
          const entry = desk.scheduler.create({ name, prompt: request, ...(cron ? { cron } : {}), ...(at ? { nextRunAt: at } : {}), ...(on ? { on } : {}), ...(on && a.when?.trim() ? { when: a.when.trim() } : {}), tz: desk.timezone, enabled: true, target: "desk", phone: issue.filedBy.phone });
          const when = describeAutomation(entry, desk.timezone);
          const url = on?.kind === "hook" ? events?.hookUrl(on.token) : undefined;
          record(issueId, "AUTOMATION_CREATE", logged, true, `${entry.id}: ${when}`);
          if (on?.kind === "hook") return textResult(url ? `Saved "${name}" (${entry.id}), ${when}. Its URL: ${url} . Anything that POSTs to it starts a run; give it to the caller and say to keep it private.` : `Saved "${name}" (${entry.id}), but this Kloru has no public address, so nothing can call its webhook yet.`);
          return textResult(`Saved "${name}" (${entry.id}), ${when}.${entry.nextRunAt ? ` Next run ${entry.nextRunAt}.` : ""}`);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          // A trigger made for an automation that wasn't saved isn't left watching.
          const made = on?.kind === "app" ? on.instance : undefined;
          if (made && events && !desk.scheduler.list().some((e) => e.on?.kind === "app" && e.on.instance === made)) await events.unwatch(made).catch(() => undefined);
          record(issueId, "AUTOMATION_CREATE", logged, false, why);
          return failed(why);
        }
      },
    }),
    defineTool({
      name: AUTOMATION_LIST,
      label: "List automations",
      description: "List the caller's automations: id, name, when, what it does, next run.",
      parameters: Type.Object({}),
      meta: { capabilities: [], group: "schedule" as const },
      execute: async (_args, ctx) => {
        const issue = desk.repo.issue(issueOf(ctx));
        if (!issue || !desk.scheduler) return failed("Automations aren't available here.");
        const mine = desk.scheduler.list().filter((e) => e.target === "desk" && e.phone === issue.filedBy.phone);
        return textResult(mine.length ? mine.map((e) => `${e.id}: ${e.name ?? "untitled"}, ${describeAutomation(e, desk.timezone)}${e.enabled ? "" : " (paused)"}: ${e.prompt}${e.on ? "" : ` | next ${e.nextRunAt ?? "-"}`}`).join("\n") : "No automations yet.");
      },
    }),
    defineTool({
      name: AUTOMATION_DELETE,
      label: "Delete an automation",
      description: "Stop and delete one of the caller's automations, by id (from automation_list).",
      parameters: Type.Object({ id: Type.String() }),
      meta: { capabilities: ["schedule.manage"], group: "schedule" as const },
      execute: async ({ id }, ctx) => {
        const issueId = issueOf(ctx);
        const issue = desk.repo.issue(issueId);
        if (!issue || !desk.scheduler) return failed("Automations aren't available here.");
        const entry = desk.scheduler.list().find((e) => e.id === id && e.target === "desk" && e.phone === issue.filedBy.phone);
        if (!entry) return failed(`No automation ${id} for this caller.`);
        // The automation is gone either way; a trigger left behind only posts events nothing listens for.
        const left = await deleteAutomation(desk.scheduler, id, events).then(() => "", (error: unknown) => ` (its app event is still watched: ${error instanceof Error ? error.message : String(error)})`);
        record(issueId, "AUTOMATION_DELETE", { id }, true, `deleted ${entry.name ?? id}${left}`);
        return textResult(`Deleted "${entry.name ?? id}".`);
      },
    }),
  ];
  if (events) {
    tools.push(
      defineTool({
        name: AUTOMATION_EVENTS,
        label: "List an app's events",
        description: "What an app (gmail, googlecalendar, slack, github, ...) can start an automation on: each event's slug, name, what it's for and its settings.",
        parameters: Type.Object({ app: Type.String({ description: "the app's toolkit name, e.g. gmail" }) }),
        meta: { capabilities: [], group: "schedule" as const },
        execute: async ({ app }) => {
          try {
            return textResult((await events.types(app)) || `No events for ${app}.`);
          } catch (error) {
            return failed(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }
  return tools;
}
