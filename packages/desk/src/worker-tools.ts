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
      parameters: Type.Object({ draft: Type.String({ description: "exactly what you'll do, in words the caller can say yes to, e.g. 'Email Cara: running 10 minutes late'" }) }),
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
      parameters: Type.Object({ words: Type.String({ description: "the owner's words, e.g. 'Add my wife Cara, 415 555 0191, she should be able to do and see everything'" }) }),
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
        "Send the person who asked a message: when they asked you to text or email them (\"text me the link\", \"email me when you're done\"). Leave channel out unless they named one. Every message is checked first; if it's held or dropped, you're told why. Links are fine here.",
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
        return r.ok ? textResult(`Sent${r.value === "default" ? "" : ` by ${r.value}`}.`) : { content: [{ type: "text" as const, text: r.error }], isError: true };
      },
    }),
    defineTool({
      name: "comment_on_issue",
      label: "Leave the PM a note on your issue",
      description:
        "A note for the PM, who coordinates: a message that was held (paste exactly what you'd send), or something another issue or person has to know. Then carry on or finish.",
      parameters: Type.Object({ text: Type.String({ description: "the note, with any held message word for word" }) }),
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
        ask: Type.String({ description: "what Kloru would do, in their terms, e.g. 'Book your flight to Atlanta for the evening of Nov 3'" }),
        goal: Type.String({ description: "the goal it serves, e.g. 'Get to the Atlanta board visit Nov 4 to 5'" }),
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
