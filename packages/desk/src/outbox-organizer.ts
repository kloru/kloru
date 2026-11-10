/**
 * The outbox organizer: one agent run per person whenever their outbox needs looking at. It sees
 * everything waiting for them, what they already got today, and how they like to be reached, and
 * decides what they get, when, and in what shape. Stateless between runs; what it learns goes in
 * its notes.
 */
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { createInitialSystemMessage, toToolDeclaration, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { clip } from "./memory.js";
import { localTime, whenIn, type Organizer, type OrganizerActions, type OrganizerView } from "./outbox.js";
import type { OutboxItem } from "./outbox-store.js";

export const ORGANIZER_RULES = `You organize everything Kloru has waiting to send one person.
Your goal: they're glad to get each message, and nothing they need is late or missing.
Read their guidelines, your notes and what they already got today before you act.
For each item: send it as written, write one message that covers several, schedule it, or drop it.
Long content goes on a page; send one line with its link.
A question that blocks work goes on its own, soon.
Keep the drafts' facts and never add any.
Note what you learn about how they like to be reached.
End with one line on what you did.`;

const str = (description: string) => Type.String({ description });
const WHEN = {
  at: Type.Optional(str('their local time, like "2026-11-11T07:05"')),
  in_minutes: Type.Optional(Type.Number({ description: "or minutes from now" })),
};

const age = (item: OutboxItem, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - Date.parse(item.at)) / 60_000));
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
};

export function itemLine(item: OutboxItem, now: Date, timezone: string, request?: string, changed: string[] = []): string {
  const from = `${item.from.agent}${item.from.issue ? ` #${item.from.issue}` : ""}`;
  const parts = [item.why, `from ${from}`, item.state === "scheduled" && item.sendAt ? `goes ${localTime(new Date(item.sendAt), timezone)}` : `waited ${age(item, now)}`];
  if (item.channel) parts.push(`suggested ${item.channel}`);
  if (item.media?.length) parts.push(`${item.media.length} attached`);
  const lines = [`- ${item.id} [${parts.join(", ")}] ${clip(item.text, 1200)}`];
  if (request) lines.push(`    asked: ${clip(request, 200)}`);
  if (changed.length) lines.push(`    its page changed since they got the link: ${changed.join(", ")}`);
  if (item.note) lines.push(`    note: ${item.note}`);
  if (item.covers?.length) lines.push(`    carries: ${item.covers.join(", ")}`);
  return lines.join("\n");
}

/** What the organizer reads at the start of a run. */
export function organizerView(view: OrganizerView, timezone: string): string {
  const p = view.person;
  const list = (title: string, lines: string[]) => (lines.length ? `${title}:\n${lines.join("\n")}` : "");
  return [
    `${p.name}'s outbox. Their time now: ${p.localTime}.`,
    p.inConversation ? `They are in a conversation with Kloru right now (${p.inConversation}).` : "They are not in a conversation with Kloru right now.",
    `They can be reached by: ${p.channels.join(", ") || "nothing set up"}.`,
    p.guidelines ? `Their guidelines:\n${p.guidelines}` : "",
    p.preferences ? `How they like messages:\n${p.preferences}` : "",
    p.notes ? `Your notes:\n${p.notes}` : "",
    list("The last turns of their latest conversation", p.turns.map((t) => `  ${t}`)),
    list("Still being worked on for them", p.running.map((r) => `  - ${r}`)),
    list("Sent to them or dropped in the last day, oldest first", view.recent.map((r) => `  - ${r}`)),
    list("Scheduled", view.scheduled.map((i) => itemLine(i, view.now, timezone))),
    list("Queued, oldest first", view.queued.map((i) => itemLine(i, view.now, timezone, view.requests[i.id], view.changed[i.id]))),
  ].filter(Boolean).join("\n\n");
}

export function organizerTools(view: OrganizerView, act: OrganizerActions, timezone: string, done?: () => void): AgentTool<any>[] {
  const when = (a: { at?: string; in_minutes?: number }): Date | string => {
    if (typeof a.in_minutes === "number" && a.in_minutes > 0) return new Date(view.now.getTime() + a.in_minutes * 60_000);
    const d = a.at ? whenIn(a.at, timezone) : undefined;
    return d ?? 'Say when: at (their local time, like "2026-11-11T07:05") or in_minutes.';
  };
  const t = (name: string, description: string, parameters: any, run: (a: any) => string | Promise<string>): AgentTool<any> => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id: string, a: any) => {
      const text = await run(a);
      done?.();
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  });
  const items = Type.Array(Type.String(), { description: "item ids (o_…)" });
  const channel = Type.Optional(Type.Union([Type.Literal("imessage"), Type.Literal("email")], { description: "unset: where it would go by default" }));
  return [
    t("send", "Send now. One item and no text: it goes as written. With text: your message goes and carries those items.", Type.Object({ items, text: Type.Optional(str("the message you wrote, first person as Kloru")), channel, subject: Type.Optional(str("a few words, for an email")) }), (a) => act.send({ items: a.items, ...(a.text ? { text: a.text } : {}), ...(a.channel ? { channel: a.channel } : {}), ...(a.subject ? { subject: a.subject } : {}) })),
    t("page", "Put long content on a page and get its link. Pass page to update one that exists.", Type.Object({ title: str("the page's title"), markdown: str("the whole page"), page: Type.Optional(str("an existing page's id")) }), (a) => act.page({ title: a.title, markdown: a.markdown, ...(a.page ? { page: a.page } : {}) })),
    t("schedule", "Hold items until a time; each is weighed again then.", Type.Object({ items, ...WHEN }), (a) => {
      const at = when(a);
      return typeof at === "string" ? at : act.schedule({ items: a.items, at });
    }),
    t("drop", "Drop items they don't need.", Type.Object({ items, reason: str("why, in a few words") }), (a) => act.drop({ items: a.items, reason: a.reason })),
    t("wake", "Look at this outbox again at a time.", Type.Object(WHEN), (a) => {
      const at = when(a);
      return typeof at === "string" ? at : act.wake({ at });
    }),
    t("note", "Save one line about how this person likes to be reached, for your later runs.", Type.Object({ line: str("one plain line") }), (a) => act.note({ line: a.line })),
    t("ask", "Rarely: ask them one short question about how they want messages; the answer becomes a guideline.", Type.Object({ question: str("one short question") }), (a) => act.ask({ question: a.question })),
  ];
}

export interface OutboxOrganizerOptions {
  model: Model<any>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  timezone?: string;
  log?: (m: string) => void;
  onReply?: (reply: { model: string; usage: unknown; timestamp: number }) => void;
}

export class OutboxOrganizer implements Organizer {
  constructor(private readonly o: OutboxOrganizerOptions) {}

  async organize(view: OrganizerView, act: OrganizerActions): Promise<void> {
    const timezone = this.o.timezone ?? "America/Los_Angeles";
    let actions = 0;
    const tools = organizerTools(view, act, timezone, () => actions++);
    const system = createInitialSystemMessage(ORGANIZER_RULES, tools.map(toToolDeclaration));
    const agent = new Agent({
      initialState: { systemPrompt: "", model: this.o.model, thinkingLevel: this.o.thinking ?? "low", tools, messages: system ? [system] : [] },
      streamFn: this.o.streamFn,
      ...(this.o.getApiKey ? { getApiKey: this.o.getApiKey } : {}),
      toolExecution: "sequential",
    });
    agent.subscribe((e) => {
      if (e.type !== "tool_execution_end") return;
      const out = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" ").slice(0, 200);
      this.o.log?.(`organizer: ${e.toolName}${e.isError ? " (error)" : ""} → ${out}`);
    });
    const before = agent.state.messages.length;
    await agent.prompt(organizerView(view, timezone));
    await agent.waitForIdle();
    const fresh = agent.state.messages.slice(before) as AgentMessage[];
    for (const m of fresh) if (m.role === "assistant" && m.usage) this.o.onReply?.({ model: m.model, usage: m.usage, timestamp: m.timestamp });
    const last = [...fresh].reverse().find((m) => m.role === "assistant");
    if (last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      const why = last.errorMessage || `organizer run ${last.stopReason}`;
      // A run that already acted isn't replayed; what it left queued is looked at again later.
      if (actions > 0) {
        this.o.log?.(`organizer: run failed after ${actions} action(s): ${why}`);
        return;
      }
      throw new Error(why);
    }
    if (last && last.role === "assistant") {
      const text = last.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(" ").trim();
      if (text) this.o.log?.(`organizer: ${text}`);
    }
  }
}
