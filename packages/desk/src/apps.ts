/**
 * Apps are artifacts people use, not just read: a shared list, a sign-up form, a tracker. A worker
 * writes one HTML file (markup, style and script) with a tool call; the website serves it in a
 * sandboxed frame and keeps its data (`kloru.list/put/remove/onChange`). Same link, versions and
 * follow-ups as a page. No build, no deploy, no shell, so anyone's request can make one.
 */
import { Script } from "node:vm";
import { defineTool, textResult, type RegisteredTool } from "@kloru/core";
import { Type } from "typebox";
import type { Desk } from "./desk.js";
import { err, ok, type Result } from "./result.js";

export const APP_MAX = 512_000;
/** How much of a collection one app_data list shows. */
const DATA_OUT = 24_000;
/** A record a worker put there, as the app shows who added it. */
const KLORU = { by: "Kloru", owner: "kloru" };

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const issueOf = (ctx: { conversationKey?: string } | undefined) => Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
const isQa = (ctx: { conversationKey?: string } | undefined) => /^desk:issue:\d+:qa$/.test(ctx?.conversationKey ?? "");
const CLASSIC = /^(|text\/javascript|application\/javascript)$/i;

/**
 * What can be checked without running an app: it has something in it, it fits, and every inline
 * script compiles. What it loads from other addresses is its own business (the frame keeps it off Kloru).
 */
export function checkApp(html: string): Result<true> {
  if (!html.trim()) return err("the app is empty");
  if (html.length > APP_MAX) return err(`the app is too long (${html.length} characters; at most ${APP_MAX})`);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue; // a library, loaded from its own address
    const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] ?? "";
    if (!CLASSIC.test(type)) continue;
    const line = html.slice(0, (m.index ?? 0) + m[0].indexOf(">") + 1).split("\n").length;
    try {
      // Compiles without running.
      new Script(m[2] ?? "", { filename: "app.html", lineOffset: line - 1 });
    } catch (error) {
      const at = /app\.html:(\d+)/.exec(String((error as Error).stack ?? ""))?.[1];
      return err(`the script doesn't parse${at ? ` (line ${at})` : ""}: ${(error as Error).message}`);
    }
  }
  return ok(true);
}

const VISITORS = Type.Optional(
  Type.Union([Type.Literal("none"), Type.Literal("add"), Type.Literal("all")], {
    description: "who may use it without signing in. none (default): the family only. add: guests with the link add entries and see only their own (an RSVP form). all: guests see and change everything (a potluck sign-up)",
  }),
);

export function appTools(desk: Desk): RegisteredTool[] {
  const caller = (ctx: { conversationKey?: string } | undefined) => {
    const issue = desk.repo.issue(issueOf(ctx));
    return issue ? { issue: issue.id, phone: issue.filedBy.phone } : undefined;
  };
  const reported = (errors: string[]) => (errors.length ? `\n\nErrors people's browsers reported in this version:\n${errors.map((e) => `- ${e}`).join("\n")}` : "");
  return [
    defineTool({
      name: "app_create",
      label: "Make an app",
      description:
        "Make a small web app for this task: something people fill in or tick off themselves (a shared list, a sign-up, a tracker). One HTML file, which may load libraries, map tiles and public APIs over https; its data is kept for you: await kloru.list(collection), kloru.put(collection, record), kloru.remove(collection, id), kloru.onChange(fn), kloru.me. Follow-ups change it with app_update. Returns the link.",
      parameters: Type.Object({
        title: Type.String({ description: "short, plain title, e.g. Grocery list" }),
        html: Type.String({ description: "the whole app: one HTML file, phone-first; libraries load by https URL with a pinned version" }),
        visitors: VISITORS,
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ title, html, visitors }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can make apps.");
        const made = desk.publishApp(who.issue, title, html, visitors);
        return made.ok ? textResult(`Made: ${made.value.url}\nTry it with app_test if you have it, then put this link in your result.`) : failed(made.error);
      },
    }),
    defineTool({
      name: "app_update",
      label: "Change an app",
      description:
        "Change an existing app in place, at the same link (a follow-up like 'add a quantity field'): give replace (one exact piece of the file and what it becomes) for a small change, or html for a whole new file. Keep collection names, so what people entered stays. Returns the link.",
      parameters: Type.Object({
        id: Type.String({ description: "the app id (from the issue, the brief or artifact_find)" }),
        html: Type.Optional(Type.String({ description: "the whole new file" })),
        replace: Type.Optional(Type.Object({ old: Type.String({ description: "text that appears exactly once in the file" }), new: Type.String() })),
        title: Type.Optional(Type.String({ description: "a new title, if it should change" })),
        visitors: VISITORS,
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id, html, replace, title, visitors }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can change apps.");
        if (html === undefined && replace === undefined && title === undefined && visitors === undefined) return failed("Say what to change: replace, html, title or visitors.");
        const r = desk.updateApp(id, { ...(html !== undefined ? { html } : {}), ...(replace !== undefined ? { replace } : {}), ...(title !== undefined ? { title } : {}), ...(visitors !== undefined ? { visitors } : {}) }, who);
        return r.ok ? textResult(`Updated (version ${r.value.version}): ${r.value.url}\nTry the change with app_test if you have it, then say it was updated, with the link.`) : failed(r.error);
      },
    }),
    defineTool({
      name: "app_read",
      label: "Read an app",
      description: "Read an app's file before changing it, by id, with any errors people's browsers reported.",
      parameters: Type.Object({ id: Type.String() }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can read apps.");
        const r = desk.readApp(id, who.phone);
        if (!r.ok) return failed(r.error);
        const a = r.value.app;
        return textResult(`${a.title} (app, version ${a.version ?? 1}, visitors: ${a.visitors ?? "none"}, ${desk.artifactUrl(id)})${reported(r.value.errors)}\n\n${a.html ?? ""}`);
      },
    }),
    defineTool({
      name: "app_data",
      label: "An app's data",
      description:
        "Read or change what an app holds: the same records its page reads with kloru.list. list: with no collection, the collections and how many records each has; with one, its records. " +
        "put: add records, or replace the ones whose id you give (to put a list someone sent you into the app, or fix an entry). remove: by id. " +
        "This is what the family entered unless scratch is true: then it is the copy app_test runs on, and clear empties it for a fresh try.",
      parameters: Type.Object({
        id: Type.String({ description: "the app id" }),
        action: Type.Union([Type.Literal("list"), Type.Literal("put"), Type.Literal("remove"), Type.Literal("clear")]),
        collection: Type.Optional(Type.String({ description: "the collection, as the app's script names it, e.g. items" })),
        records: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { description: "for put: the records, with the fields the app's script uses" })),
        ids: Type.Optional(Type.Array(Type.String(), { description: "for remove: the ids of the records to remove" })),
        scratch: Type.Optional(Type.Boolean({ description: "true: the scratch copy app_test uses, not what the family entered" })),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ id, action, collection, records, ids, scratch }, ctx) => {
        const who = caller(ctx);
        if (!who) return failed("Only desk workers can reach an app's data.");
        const got = desk.appData(id, who.phone, scratch === true);
        if (!got.ok) return failed(got.error);
        const { store, space } = got.value;
        const where = scratch ? "the scratch copy" : "the app";
        try {
          if (action === "list") {
            if (!collection) {
              const all = store.collections(space);
              return textResult(all.length ? all.map((c) => `${c.collection}: ${c.records}`).join("\n") : `Nothing is in ${where} yet.`);
            }
            const rows = store.list(space, collection);
            const body = JSON.stringify(rows);
            return textResult(`${rows.length} in ${collection}${body.length > DATA_OUT ? ` (showing the first ${DATA_OUT} characters)` : ""}:\n${body.slice(0, DATA_OUT)}`);
          }
          // QA looks at what the family entered but changes only the scratch copy.
          if (isQa(ctx) && !scratch) return failed("QA changes only the scratch copy: pass scratch: true.");
          if (action === "clear") {
            if (!scratch) return failed("clear is for the scratch copy (scratch: true). What the family entered is removed one record at a time, by id.");
            return textResult(`Emptied the scratch copy (${store.clear(space)} records).`);
          }
          if (!collection) return failed("Name the collection.");
          if (action === "put") {
            if (!records?.length) return failed("Give the records to put.");
            const saved: string[] = [];
            for (const r of records) {
              const put = store.put(space, collection, r, KLORU);
              if (!put.ok) return failed(`${saved.length} saved, then one was refused: ${put.error}`);
              saved.push(put.record.id);
            }
            if (!scratch) desk.appDataChanged(who.issue, id, `put ${saved.length} in ${collection}`);
            return textResult(`Saved ${saved.length} in ${collection} (${where}); open pages show them within seconds. Ids: ${saved.join(", ")}`);
          }
          if (!ids?.length) return failed("Give the ids to remove.");
          const gone = ids.filter((i) => store.remove(space, collection, i));
          if (!scratch && gone.length) desk.appDataChanged(who.issue, id, `removed ${gone.length} from ${collection}`);
          const missing = ids.length - gone.length;
          return textResult(`Removed ${gone.length} from ${collection} (${where})${missing ? `; ${missing} weren't there` : ""}.`);
        } catch (error) {
          return failed(`The app's data couldn't be reached: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    }),
    defineTool({
      name: "app_verdict",
      label: "QA's verdict",
      description: "QA only: say what you found after using the app. usable false sends bugs back to the engineer to fix, and you try it again after.",
      parameters: Type.Object({
        usable: Type.Boolean({ description: "true when people can do what the request asked for, even if it isn't perfect" }),
        bugs: Type.Optional(Type.String({ description: "what stops people using it: for each, the steps you took, what happened and what should have" })),
      }),
      meta: { capabilities: [], group: "files" as const },
      execute: async ({ usable, bugs }, ctx) => {
        if (!isQa(ctx)) return failed("Only QA gives a verdict.");
        if (!usable && !bugs?.trim()) return failed("Say what stops people using it: the steps, what happened and what should have.");
        const said = desk.qaVerdict(issueOf(ctx), usable, bugs ?? "");
        return said.ok ? textResult(usable ? "Noted: usable. End with one line on what you tried." : "Noted: the engineer gets these. End with one line on what you tried.") : failed(said.error);
      },
    }),
  ];
}
