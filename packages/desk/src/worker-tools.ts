/**
 * ask_for_yes: a worker decides, from the caller's guidelines, that something needs their yes first.
 * Not a rule in code (guidelines-not-rules skill): the worker judges, the caller hears the exact draft,
 * and their yes reaches the same worker.
 */
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import { ASK_FOR_YES, type Desk } from "./desk.js";

export function workerTools(desk: Desk): RegisteredTool[] {
  return [
    defineTool({
      name: ASK_FOR_YES,
      label: "Ask the caller for a yes",
      description:
        "When the caller's guidelines call for their yes before you act (by default: something reaching another person, spending money, or that can't be undone), give the exact draft of what you'll do. The caller hears it; their yes comes back to you. Then stop.",
      parameters: Type.Object({ draft: Type.String({ description: "exactly what you'll do, in words the caller can say yes to, e.g. 'Email Cleo: running 10 minutes late'" }) }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ draft }, ctx) => {
        const issue = Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
        const asked = desk.askForYes(issue, draft);
        return asked.ok ? textResult("Asked. Stop here; you'll be told when they say yes.") : { content: [{ type: "text" as const, text: asked.error }], isError: true };
      },
    }),
    defineTool({
      name: "set_member",
      label: "Say who may use Kloru and what they may do",
      description:
        "Owner only: when the owner adds someone to the family, changes what someone may see and do through Kloru, or opens or closes Kloru to anyone who calls (e.g. 'anyone can book a meeting with me'). Pass the owner's own words, verbatim. They hear it read back; their yes saves it. Then stop.",
      parameters: Type.Object({ words: Type.String({ description: "the owner's words, e.g. 'Add my wife Cleo, 415 555 0191, she should be able to do and see everything'" }) }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ words }, ctx) => {
        const issue = Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
        const r = await desk.setMember(issue, words);
        return r.ok ? textResult("Read back to them. Stop here; their yes saves it.") : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
    defineTool({
      name: "send_to_caller",
      label: "Text or email the person who asked",
      description:
        "Send the person who asked a message: when they asked you to text or email them (\"text me the link\", \"email me when you're done\"). Leave channel out unless they named one. It goes into their outbox, which sends it now, keeps it for a better time, or drops it; you're told which. Links are fine here.",
      parameters: Type.Object({
        text: Type.String({ description: "the message, short; for email it can be longer, with links" }),
        // "text" and "imessage" are the same channel: Kloru texts over iMessage.
        channel: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("imessage"), Type.Literal("email")])),
        subject: Type.Optional(Type.String({ description: "email only" })),
        media: Type.Optional(Type.Array(Type.String(), { description: "photos or files to attach, by id (m_…); keep a file or web image first with media_keep" })),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ text, channel, subject, media }, ctx) => {
        const issue = Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
        const r = await desk.messageCaller(issue, text, channel === "text" ? "imessage" : channel, subject, media ?? []);
        return r.ok ? textResult(r.value) : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
    defineTool({
      name: "remind",
      label: "Remind the person who asked, once, at a time",
      description:
        "A one-time reminder whose words you know now (\"remind me at 9 to call Dr. Lee\"): Kloru sends them exactly this text at that time. Something that needs looking up then, or repeats, is an automation instead.",
      parameters: Type.Object({
        text: Type.String({ description: "the reminder as they should read it, e.g. 'Reminder: call Dr. Lee about Friday.'" }),
        at: Type.String({ description: 'when, in their local time, like "2026-11-11T09:00"' }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ text, at }, ctx) => {
        const issue = Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
        const r = await desk.remindCaller(issue, text, at);
        return r.ok ? textResult(r.value) : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
    defineTool({
      name: "outbox_list",
      label: "See what's waiting to go to the person who asked",
      description: "The messages and reminders Kloru has waiting for them, each with its id. Use it when they ask what's coming or want one stopped.",
      parameters: Type.Object({}),
      meta: { capabilities: [], group: "files" as const },
      execute: async (_a, ctx) => {
        const issue = desk.repo.issue(Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN));
        if (!issue) return { content: [{ type: "text" as const, text: "no issue here" }], isError: true };
        const lines = desk.outboxList(issue.filedBy.phone);
        return textResult(lines.length ? lines.join("\n") : "Nothing is waiting to go to them.");
      },
    }),
    defineTool({
      name: "outbox_cancel",
      label: "Stop a waiting message or reminder",
      description: "Stop one message or reminder that hasn't gone yet, by its id from outbox_list. Only when they asked for it to stop.",
      parameters: Type.Object({ id: Type.String({ description: "the item's id, like o_…" }) }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id }, ctx) => {
        const issue = desk.repo.issue(Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN));
        if (!issue) return { content: [{ type: "text" as const, text: "no issue here" }], isError: true };
        const r = desk.outboxCancel(id, issue.filedBy.phone);
        return r.ok ? textResult(`Stopped: ${r.value.text.slice(0, 200)}`) : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
    defineTool({
      name: "comment_on_issue",
      label: "Leave the PM a note on your issue",
      description:
        "A note for the PM, who coordinates: something another issue or person has to know. Then carry on or finish.",
      parameters: Type.Object({ text: Type.String({ description: "the note" }) }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ text }, ctx) => {
        const issue = Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
        const r = desk.workerComment(issue, text);
        return r.ok ? textResult("The PM has it.") : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
    defineTool({
      name: "suggest",
      label: "Suggest something the caller will want",
      description: "Scouts only: something Kloru could do that the caller will likely want, offered on their next calls.",
      parameters: Type.Object({
        ask: Type.String({ description: "what Kloru would do, in their terms, e.g. 'Book your flight to Tucson for the evening of Nov 3'" }),
        goal: Type.String({ description: "the goal it serves, e.g. 'Get to the Tucson board visit Nov 4 to 5'" }),
        why: Type.String({ description: "why now: what you saw, e.g. 'the trip is on your calendar but no flight confirmation is in your email'" }),
        kind: Type.Union([Type.Literal("one_off"), Type.Literal("automation")], { description: "automation: something to run on a schedule" }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async (args, ctx) => {
        const issue = Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
        const r = desk.suggest(issue, args);
        return r.ok ? textResult("Saved; it's offered on their next calls.") : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
  ];
}
