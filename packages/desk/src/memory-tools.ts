/**
 * Memory tools for desk workers. Engineers get the reads; only the memory worker (an ops
 * issue filed after each call) gets the writes, and the desk commits what it wrote.
 */
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import { Memory } from "./memory.js";

export const MEMORY_READ_TOOLS: ReadonlySet<string> = new Set(["memory_search", "memory_open"]);
export const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set(["memory_save", "memory_move", "memory_remove"]);

const meta = { capabilities: ["memory.write" as const], group: "memory" as const };
const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/**
 * `who` names the person a worker's request is for (by its conversation key): another person's
 * private/ folder is never read or listed for it. Unset: nobody's private files are shown.
 */
export function memoryTools(memory: Memory, who?: (conversationKey: string) => string | undefined): RegisteredTool[] {
  const asker = (ctx?: { conversationKey?: string }) => (ctx?.conversationKey ? who?.(ctx.conversationKey) : undefined);
  // Another person's private files are never written, moved or removed for a request, any more than read.
  const notYours = (path: string, ctx?: { conversationKey?: string }) => {
    const owner = Memory.privateOwner(path);
    const phone = asker(ctx);
    return owner && owner !== (phone ? memory.operatorFor(phone) : undefined) ? `No file ${path}.` : undefined;
  };
  return [
    defineTool({
      name: "memory_search",
      label: "Search memory",
      description: "Find memory files (people, places, routines, preferences, projects) whose name, aliases or text mention every word of the query.",
      parameters: Type.Object({ query: Type.String({ description: "words to look for, e.g. a name" }) }),
      meta,
      execute: async ({ query }, ctx) => {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const hits = memory.visibleTo(memory.list(), asker(ctx)).filter((f) => words.every((w) => [f.id, f.name, ...f.aliases, f.body].join(" ").toLowerCase().includes(w)));
        return textResult(hits.length ? hits.map((f) => `${f.path} — ${f.name}${f.aliases.length ? ` (${f.aliases.join(", ")})` : ""}: ${f.body.split("\n")[0] ?? ""}`).join("\n") : "Nothing in memory matches.");
      },
    }),
    defineTool({
      name: "memory_open",
      label: "Open memory file",
      description: "Read one memory file, or list every file when path is omitted.",
      parameters: Type.Object({ path: Type.Optional(Type.String({ description: "e.g. household/people/maya.md" })) }),
      meta,
      execute: async ({ path }, ctx) => {
        const visible = memory.visibleTo(memory.list(), asker(ctx));
        if (!path) return textResult(visible.map((f) => f.path).join("\n") || "(memory is empty)");
        const f = memory.open(path);
        if (!f || !memory.visibleTo([f], asker(ctx)).length) return failed(`No file ${path}.`);
        const fm = Object.entries(f.meta).map(([k, v]) => `${k}: ${v}`).join("\n");
        return textResult(`---\n${fm}\n---\n${f.body}`);
      },
    }),
    defineTool({
      name: "memory_save",
      label: "Save memory file",
      description:
        "Write a whole memory file (create or replace). Path: household/<people|places|routines|projects>/<id>.md for shared things, " +
        "<operator>/<preferences|people|projects>/<id>.md for one person's own. Text starts with frontmatter " +
        "(---, id, type, aliases: [..], optional ends: YYYY-MM-DD for plans, ---), then one fact per line: " +
        '"- fact (who said it, YYYY-MM-DD)". Link other files as [[household/<id>]].',
      parameters: Type.Object({ path: Type.String(), text: Type.String() }),
      meta,
      execute: async ({ path, text }, ctx) => {
        const refused = notYours(path, ctx);
        if (refused) return failed(refused);
        const r = memory.save(path, text);
        return r.ok ? textResult(`Saved ${path}.`) : failed(r.error);
      },
    }),
    defineTool({
      name: "memory_move",
      label: "Move memory file",
      description: "Move or rename a memory file, e.g. a finished project to <operator>/projects/done/.",
      parameters: Type.Object({ from: Type.String(), to: Type.String() }),
      meta,
      execute: async ({ from, to }, ctx) => {
        const refused = notYours(from, ctx) ?? notYours(to, ctx);
        if (refused) return failed(refused);
        // A private file stays private: it moves only within its owner's private folder.
        if (Memory.privateOwner(from) && Memory.privateOwner(from) !== Memory.privateOwner(to)) return failed(`${from} is private: it can only move within ${Memory.privateOwner(from)}/private/.`);
        const r = memory.move(from, to);
        return r.ok ? textResult(`Moved to ${r.value}.`) : failed(r.error);
      },
    }),
    defineTool({
      name: "memory_remove",
      label: "Remove memory file",
      description: "Delete a memory file (a duplicate you merged, or something the caller asked to forget).",
      parameters: Type.Object({ path: Type.String() }),
      meta,
      execute: async ({ path }, ctx) => {
        const refused = notYours(path, ctx);
        if (refused) return failed(refused);
        const r = memory.remove(path);
        return r.ok ? textResult(`Removed ${path}.`) : failed(r.error);
      },
    }),
  ];
}
