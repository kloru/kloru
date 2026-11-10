/**
 * Artifacts are a task's living document (a comparison, a plan, a report): a worker creates one,
 * follow-ups edit it in place (every version kept), and anyone with the link can open it. The issue
 * comes from the worker's own conversation, never from the model's arguments, so a page always
 * belongs to the issue and caller that made or edited it.
 */
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import { clip } from "./memory.js";
import type { Desk } from "./desk.js";

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const issueOf = (ctx: { conversationKey?: string } | undefined) => Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);

export function artifactTools(desk: Desk): RegisteredTool[] {
  const caller = (ctx: { conversationKey?: string } | undefined) => {
    const issue = desk.repo.issue(issueOf(ctx));
    return issue ? { issue: issue.id, phone: issue.filedBy.phone } : undefined;
  };
  return [
    defineTool({
      name: "artifact_create",
      label: "Make a page",
      description:
        "Make the page for this task (markdown: headings, lists, tables, links, images as ![name](/m/<id>)): a comparison, a plan, a report, options. One page per task; follow-ups edit it with artifact_update. Returns the link.",
      parameters: Type.Object({
        title: Type.String({ description: "short, plain title, e.g. Tucson flights, Nov 3–5" }),
        markdown: Type.String({ description: "the page, in markdown, with a heading per part so parts can be edited later" }),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ title, markdown }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can make pages.");
        const made = desk.publishArtifact(who.issue, title, markdown);
        return made.ok ? textResult(`Made: ${made.value.url}\nPut this link in your result.`) : failed(made.error);
      },
    }),
    defineTool({
      name: "artifact_update",
      label: "Edit a page",
      description:
        "Edit an existing page in place (a follow-up like 'I prefer United'): give section (a heading) with its new markdown, or append, or markdown alone to replace the whole page. Returns the link.",
      parameters: Type.Object({
        id: Type.String({ description: "the page id (from the issue, the brief or artifact_find)" }),
        section: Type.Optional(Type.String({ description: "the heading of the part to replace; added if it isn't there" })),
        markdown: Type.Optional(Type.String({ description: "the section's new markdown, or the whole page when no section is given" })),
        append: Type.Optional(Type.String({ description: "markdown to add at the end" })),
        title: Type.Optional(Type.String({ description: "a new title, if it should change" })),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id, section, markdown, append, title }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can edit pages.");
        if (section === undefined && markdown === undefined && append === undefined && title === undefined) return failed("Say what to change: section and markdown, markdown, or append.");
        const r = desk.updateArtifact(id, { ...(section !== undefined ? { section } : {}), ...(markdown !== undefined ? { markdown } : {}), ...(append !== undefined ? { append } : {}), ...(title !== undefined ? { title } : {}) }, who);
        return r.ok ? textResult(`Updated (version ${r.value.version}): ${r.value.url}\nSay it was updated, with the link.`) : failed(r.error);
      },
    }),
    defineTool({
      name: "artifact_find",
      label: "Find pages",
      description: "Find the caller's earlier pages by words in their title or body (flights, Northwind brief…), before searching again.",
      parameters: Type.Object({ query: Type.String() }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ query }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can find pages.");
        const found = desk.findArtifacts(who.phone, query);
        return textResult(found.length ? found.map((a) => a.kind === "app" ? `${a.id} "${a.title}" (app, updated ${(a.updatedAt ?? a.createdAt).slice(0, 16)}): read it with app_read` : `${a.id} "${a.title}" (updated ${(a.updatedAt ?? a.createdAt).slice(0, 16)}): ${clip(a.markdown.replace(/\s+/g, " "), 160)}`).join("\n") : "No pages match.");
      },
    }),
    defineTool({
      name: "artifact_read",
      label: "Read a page",
      description: "Read one of the caller's pages, by id.",
      parameters: Type.Object({ id: Type.String() }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can read pages.");
        const r = desk.readArtifact(id, who.phone);
        if (r.ok && r.value.kind === "app") return textResult(`${r.value.title} is an app (${desk.artifactUrl(id)}); read it with app_read and change it with app_update.`);
        return r.ok ? textResult(`# ${r.value.title} (version ${r.value.version ?? 1}, ${desk.artifactUrl(id)})\n\n${r.value.markdown}`) : failed(r.error);
      },
    }),
  ];
}
