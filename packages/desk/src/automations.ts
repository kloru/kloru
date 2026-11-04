/**
 * Automations made on a call: "every weekday at 7, email me a debrief of my day". Ops saves one
 * (after the caller's yes, enforced by the desk's ops guard) in the agent's scheduler; when it
 * fires, Desk.runAutomation files it as a desk issue and the result reaches the caller.
 */
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import { AUTOMATION_CREATE, AUTOMATION_DELETE, AUTOMATION_LIST, describeWhen, type Desk } from "./desk.js";

export { AUTOMATION_CREATE, AUTOMATION_DELETE, AUTOMATION_LIST };

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const issueOf = (ctx: { conversationKey?: string } | undefined) => Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);

export function automationTools(desk: Desk): RegisteredTool[] {
  const record = (issueId: number, slug: string, args: unknown, ok: boolean, result: string) => {
    const issue = desk.repo.issue(issueId);
    if (issue) desk.repo.appendLedger({ issue: issueId, call: issue.filedBy.call, phone: issue.filedBy.phone, tool: slug.toLowerCase(), slug, args, ok, result });
  };
  return [
    defineTool({
      name: AUTOMATION_CREATE,
      label: "Create an automation",
      description:
        "Save something to do on its own, on a schedule: give cron (5 fields, in the owner's timezone) for repeating, or at (ISO time) for once. The request is what the desk does each time; its result reaches the caller. Needs the caller's yes first.",
      parameters: Type.Object({
        name: Type.String({ description: 'short, e.g. "Morning debrief"' }),
        request: Type.String({ description: "what to do each time, in one clear sentence, as if the caller just asked" }),
        cron: Type.Optional(Type.String({ description: 'minute hour day-of-month month day-of-week, e.g. "0 7 * * 1-5"' })),
        at: Type.Optional(Type.String({ description: "ISO time for a one-time run" })),
      }),
      meta: { capabilities: ["schedule.manage"], group: "schedule" as const },
      execute: async ({ name, request, cron, at }, ctx) => {
        const issueId = issueOf(ctx);
        const issue = desk.repo.issue(issueId);
        if (!issue || !desk.scheduler) return failed("Automations aren't available here.");
        try {
          const entry = desk.scheduler.create({ name, prompt: request, ...(cron ? { cron } : {}), ...(at ? { nextRunAt: at } : {}), tz: desk.timezone, enabled: true, target: "desk", phone: issue.filedBy.phone });
          const when = describeWhen(cron, at, desk.timezone);
          record(issueId, "AUTOMATION_CREATE", { name, request, cron, at }, true, `${entry.id}: ${when}`);
          return textResult(`Saved "${name}" (${entry.id}), ${when}. Next run ${entry.nextRunAt ?? "?"}.`);
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          record(issueId, "AUTOMATION_CREATE", { name, request, cron, at }, false, why);
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
        return textResult(mine.length ? mine.map((e) => `${e.id}: ${e.name ?? "untitled"}, ${describeWhen(e.cron, e.cron ? undefined : e.nextRunAt, desk.timezone)}${e.enabled ? "" : " (paused)"}: ${e.prompt} | next ${e.nextRunAt ?? "-"}`).join("\n") : "No automations yet.");
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
        desk.scheduler.delete(id);
        record(issueId, "AUTOMATION_DELETE", { id }, true, `deleted ${entry.name ?? id}`);
        return textResult(`Deleted "${entry.name ?? id}".`);
      },
    }),
  ];
}
