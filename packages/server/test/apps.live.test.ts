/**
 * The engineer on the real model, making an app end to end (#43): the real tools, the real
 * website over the same desk, and a real phone-sized Chromium for app_test. Needs
 * OPENROUTER_API_KEY and a browser:
 *   set -a && . ./.instinct.env && set +a && cd packages/server && npx vitest run test/apps.live.test.ts
 * ENGINEER_MODEL tries another model; unset, INSTINCT_MODEL. APPS_OUT keeps the app and a screenshot.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createInitialSystemMessage, toToolDeclaration } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { defineTool, resolveModel, textResult, type RegisteredTool, type WorkerRole } from "@kloru/core";
import { Desk, appTools, artifactTools, type Planner, type WorkerHost } from "@kloru/desk";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { createConsole } from "../../web/src/server.js";
import { FileStore } from "../../web/src/store.js";
import { appErrorsReader } from "../src/app-errors.js";
import { browserTools, findChromium } from "../src/browser-tools.js";
import { createSkillCatalog, formatSkillsIndex, loadSkillTool } from "../src/skills.js";

const key = process.env.OPENROUTER_API_KEY;
const chrome = findChromium(process.env);
const spec = process.env.ENGINEER_MODEL ?? process.env.INSTINCT_MODEL ?? "";
const EZRA = "+14155550190";

class Host implements WorkerHost {
  run(): Promise<string> {
    return new Promise(() => {});
  }
  steer(): boolean {
    return false;
  }
  stop(): void {}
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "apps-live-"));
  const appsDbPath = join(root, "apps.db");
  let base = "";
  const desk = new Desk({ root: join(root, "repo"), host: new Host(), planner: { handle: async () => {} } as Planner, ownerPhone: EZRA, appErrors: appErrorsReader(appsDbPath), artifactBaseUrl: "http://127.0.0.1:0/a/" });
  const site = createConsole({
    store: new FileStore(join(root, "console")),
    sessionSecret: "session-secret",
    publicUrl: "http://localhost:8790",
    adminPhones: [EZRA],
    verifier: { start: async () => {}, check: async () => true },
    clientFor: () => ({ call: async () => null as never }),
    pageClient: () => ({ call: async () => null as never }),
    staticDir: fileURLToPath(new URL("../../web/static", import.meta.url)),
    deskDir: join(root, "repo"),
    appsDbPath,
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  (desk as unknown as { artifactBaseUrl: string }).artifactBaseUrl = `${base}/a/`;
  const { tools: browser, pool } = browserTools({ desk, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
  const skills = createSkillCatalog({ builtinDirs: fileURLToPath(new URL("../../../skills", import.meta.url)) });
  // The week, as the store would give it.
  const store = defineTool({
    name: "store_calendar",
    label: "Calendar",
    description: "Events on the person's calendars between two dates.",
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    meta: { capabilities: [], group: "files" as const },
    execute: async () => textResult("Mon 9:00 Dentist (Nora)\nTue 18:30 Dinner with the Parks\nThu 10:00 Docker onboarding\nSat 9:00 Soccer (Nora)"),
  });
  const registered: RegisteredTool[] = [...artifactTools(desk), ...appTools(desk), ...browser.filter((t) => t.spec.name === "app_test"), loadSkillTool(() => skills.list()), store];
  const calls: string[] = [];
  /** One engineer on one issue, as the worker host would run it. */
  const engineer = (request: string) => {
    const { call } = desk.startCall({ callSid: `imessage:${Math.random()}`, phone: EZRA, channel: "imessage" });
    const issue = desk.fileIssue(call.id, request);
    const ctx = { conversationKey: `desk:issue:${issue.id}:engineer` } as never;
    const tools: AgentTool<any>[] = registered.map((t) => ({
      name: t.spec.name,
      label: t.spec.label,
      description: t.spec.description,
      parameters: t.spec.parameters,
      execute: async (_id, params, signal) => {
        const r = (await t.spec.execute(params as never, ctx, signal)) as { content: { type: "text"; text: string }[]; isError?: boolean };
        calls.push(`${t.spec.name}${r.isError ? " (error)" : ""}`);
        if (process.env.SHOW) console.log(t.spec.name, t.spec.name === "app_test" ? (params as { code: string }).code : "", "→", r.content.map((c) => c.text).join(" ").slice(0, 400));
        return { content: r.content, details: undefined, ...(r.isError ? { isError: true } : {}) } as never;
      },
    }));
    const role = (desk as unknown as { engineerRole(id: number): WorkerRole }).engineerRole(issue.id);
    const system = createInitialSystemMessage(`${role.prompt}\n\n${formatSkillsIndex(skills.list()) ?? ""}`, tools.map(toToolDeclaration));
    const agent = new Agent({
      initialState: { systemPrompt: "", model: resolveModel(spec, process.env), thinkingLevel: "low", tools, messages: system ? [system] : [] },
      streamFn: streamSimple as unknown as StreamFn,
      getApiKey: () => key,
      toolExecution: "sequential",
    });
    return async () => {
      const from = calls.length;
      await agent.prompt(`${desk.brief(EZRA)}\n\nRequest: ${request}`);
      await agent.waitForIdle();
      const last = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
      const text = last && last.role === "assistant" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
      if (last && last.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
      return { text, calls: calls.slice(from) };
    };
  };
  const close = async () => {
    await pool.closeAll();
    await new Promise((r) => site.close(() => r(undefined)));
  };
  return { desk, base, engineer, close };
}

describe.skipIf(!key || !chrome || !spec)("an engineer makes an app, live", () => {
  it("a shared grocery list is an app, tried on a phone before the link is sent; a follow-up changes the same app; a summary is still a page", async () => {
    const { desk, engineer, close } = await setup();
    try {
      const made = await engineer("Make us a shared grocery list")();
      console.log(made);
      const apps = () => desk.repo.artifacts().filter((a) => a.kind === "app");
      expect(apps()).toHaveLength(1);
      const app = apps()[0]!;
      expect(made.calls).toContain("app_test");
      expect(made.text).toContain(desk.artifactUrl(app.id));
      expect(made.text.length).toBeLessThan(400);
      expect(app.html).toMatch(/kloru\.(list|put)/);

      const changed = await engineer("Add a quantity field to the grocery list")();
      console.log(changed);
      expect(apps()).toHaveLength(1);
      expect(apps()[0]!.id).toBe(app.id);
      expect(apps()[0]!.version ?? 1).toBeGreaterThan(app.version ?? 1);
      expect(apps()[0]!.html).toMatch(/quantity|qty/i);
      expect(changed.text).toContain(desk.artifactUrl(app.id));

      const week = await engineer("Summarize my week")();
      console.log(week);
      expect(week.calls).not.toContain("app_create");
      expect(apps()).toHaveLength(1);

      // What the family would see, on a phone, with something on the list.
      const out = process.env.APPS_OUT;
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, "grocery-list.html"), apps()[0]!.html ?? "");
        const link = desk.appTestUrl(app.id, EZRA);
        if (!link.ok) throw new Error(link.error);
        const browser = await chromium.launch({ executablePath: chrome!, headless: true });
        const page = await browser.newPage({ viewport: { width: 430, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        await page.goto(link.value);
        await page.frameLocator("#kloru-app").locator("body").waitFor();
        await page.waitForTimeout(3000);
        await page.screenshot({ path: join(out, "grocery-list.png") });
        await browser.close();
      }
    } finally {
      await close();
    }
  }, 600_000);
});
