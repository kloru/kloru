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

const failed = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
const issueOf = (ctx: { conversationKey?: string } | undefined) => Number(/^desk:issue:(\d+):/.exec(ctx?.conversationKey ?? "")?.[1] ?? NaN);
const CLASSIC = /^(|text\/javascript|application\/javascript)$/i;
const ONE_FILE = "an app is one file: put the script and style inline (nothing can load from another address)";

/**
 * What can be checked without running an app: it has something in it, it fits, nothing loads from
 * elsewhere (the frame's policy would block it), and every inline script compiles.
 */
export function checkApp(html: string): Result<true> {
  if (!html.trim()) return err("the app is empty");
  if (html.length > APP_MAX) return err(`the app is too long (${html.length} characters; at most ${APP_MAX})`);
  if (/<link\b[^>]*\brel\s*=\s*["']?stylesheet/i.test(html)) return err(ONE_FILE);
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) return err(ONE_FILE);
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
        "Make a small web app for this task: something people fill in or tick off themselves (a shared list, a sign-up, a tracker). One HTML file with inline style and script; its data is kept for you: await kloru.list(collection), kloru.put(collection, record), kloru.remove(collection, id), kloru.onChange(fn), kloru.me. Follow-ups change it with app_update. Returns the link.",
      parameters: Type.Object({
        title: Type.String({ description: "short, plain title, e.g. Grocery list" }),
        html: Type.String({ description: "the whole app: one HTML file, phone-first, no outside scripts, styles, fonts or images" }),
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
  ];
}
