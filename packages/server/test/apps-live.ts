/**
 * What the live app suites share: a real desk whose workers run on real models, the real website
 * over the same desk and app store, and a real phone-sized Chromium for app_test. A request is
 * assigned as the PM would, and the desk's own loop (engineer, then QA when it's on) carries it to review.
 */
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createInitialSystemMessage, toToolDeclaration, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { defineTool, resolveModel, textResult, type RegisteredTool, type WorkerRole } from "@kloru/core";
import { AppStore, Desk, appTools, artifactTools, type Deliverable, type Planner, type WorkerHost } from "@kloru/desk";
import { createConsole } from "../../web/src/server.js";
import { SESSION_COOKIE, newSession, signSession } from "../../web/src/session.js";
import { FileStore } from "../../web/src/store.js";
import { appErrorsReader } from "../src/app-errors.js";
import { browserTools, findChromium } from "../src/browser-tools.js";
import { createSkillCatalog, formatSkillsIndex, loadSkillTool } from "../src/skills.js";

export const key = process.env.OPENROUTER_API_KEY;
export const chrome = findChromium(process.env);
export const EZRA = "+14155550190";

export interface LiveOptions {
  /** The engineer's model (provider/id). */
  engineer: string;
  /** QA's model; unset: no QA, the engineer's result goes straight to review. */
  qa?: string;
  /** An engineer played by the test instead of a model: it calls the tools and returns its result. `round` counts its runs on the issue. */
  script?: (tool: (name: string, args: Record<string, unknown>) => Promise<string>, round: number) => Promise<string>;
}

export async function setup(o: LiveOptions) {
  const root = mkdtempSync(join(tmpdir(), "apps-live-"));
  const appsDbPath = join(root, "apps.db");
  const store = new AppStore(appsDbPath);
  const calls: string[] = [];
  const spent = { engineer: 0, qa: 0 };
  let registered: RegisteredTool[] = [];
  let index = "";
  const agents = new Map<string, Agent>();
  const rounds = new Map<number, number>();
  const model = (role: WorkerRole): Model<any> => role.model ?? resolveModel(o.engineer, process.env);

  /** Workers as the runtime would run them: one conversation per issue and role, the role's prompt, model and tools. */
  const host: WorkerHost = {
    async run(issue, role, prompt, _phone, session) {
      const conversationKey = `desk:issue:${session ?? issue}:${role.name}`;
      if (o.script && role.name === "engineer") {
        const round = rounds.get(issue) ?? 0;
        rounds.set(issue, round + 1);
        if (process.env.SHOW) console.log("engineer (played), round", round, prompt.slice(0, 600));
        return o.script(async (name, args) => {
          const r = (await registered.find((t) => t.spec.name === name)!.spec.execute(args as never, { conversationKey } as never)) as { content: { text: string }[] };
          return r.content.map((c) => c.text).join(" ");
        }, round);
      }
      let agent = agents.get(conversationKey);
      if (!agent) {
        const ctx = { conversationKey } as never;
        const tools: AgentTool<any>[] = registered
          .filter((t) => role.visible?.(t) ?? true)
          .map((t) => ({
            name: t.spec.name,
            label: t.spec.label,
            description: t.spec.description,
            parameters: t.spec.parameters,
            execute: async (_id, params, signal) => {
              const r = (await t.spec.execute(params as never, ctx, signal)) as { content: { type: "text"; text: string }[]; isError?: boolean };
              calls.push(`${role.name}:${t.spec.name}${r.isError ? " (error)" : ""}`);
              if (process.env.SHOW) console.log(role.name, t.spec.name, JSON.stringify(params).slice(0, 600), "→", r.content.map((c) => c.text).join(" ").slice(0, 400));
              return { content: r.content, details: undefined, ...(r.isError ? { isError: true } : {}) } as never;
            },
          }));
        const system = createInitialSystemMessage(`${role.prompt}\n\n${index}`, tools.map(toToolDeclaration));
        agent = new Agent({
          initialState: { systemPrompt: "", model: model(role), thinkingLevel: "medium", tools, messages: system ? [system] : [] },
          streamFn: streamSimple as unknown as StreamFn,
          getApiKey: () => key,
          toolExecution: "sequential",
        });
        agents.set(conversationKey, agent);
      }
      const from = agent.state.messages.length;
      await agent.prompt(role.name === "qa" ? prompt : `${desk.brief(EZRA)}\n\n${prompt}`);
      await agent.waitForIdle();
      const fresh = agent.state.messages.slice(from);
      for (const m of fresh) if (m.role === "assistant") spent[role.name === "qa" ? "qa" : "engineer"] += m.usage?.cost?.total ?? 0;
      const last = [...fresh].reverse().find((m) => m.role === "assistant");
      if (last && last.role === "assistant" && last.errorMessage) throw new Error(last.errorMessage);
      return last && last.role === "assistant" ? last.content.map((c) => (c.type === "text" ? c.text : "")).join("") : "";
    },
    steer: () => false,
    stop: () => {},
  };

  const desk = new Desk({
    root: join(root, "repo"),
    host,
    planner: { handle: async () => {} } as Planner,
    ownerPhone: EZRA,
    appErrors: appErrorsReader(appsDbPath),
    appStore: () => store,
    artifactBaseUrl: "http://127.0.0.1:0/a/",
    engineerModel: resolveModel(o.engineer, process.env),
    ...(o.qa ? { qa: true, qaModel: resolveModel(o.qa, process.env) } : {}),
  });
  const users = new FileStore(join(root, "console"));
  const site = createConsole({
    store: users,
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
  const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  (desk as unknown as { artifactBaseUrl: string }).artifactBaseUrl = `${base}/a/`;
  const { tools: browser, pool } = browserTools({ desk, profilesDir: join(root, "browser"), executablePath: chrome!, log: () => {} });
  const skills = createSkillCatalog({ builtinDirs: fileURLToPath(new URL("../../../skills", import.meta.url)) });
  index = formatSkillsIndex(skills.list()) ?? "";
  // The week, as the store would give it.
  const calendar = defineTool({
    name: "store_calendar",
    label: "Calendar",
    description: "Events on the person's calendars between two dates.",
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    meta: { capabilities: [], group: "files" as const },
    execute: async () => textResult("Mon 9:00 Dentist (Nora)\nTue 18:30 Dinner with the Parks\nThu 10:00 Docker onboarding\nSat 9:00 Soccer (Nora)"),
  });
  registered = [...artifactTools(desk), ...appTools(desk), ...browser.filter((t) => t.spec.name === "app_test"), loadSkillTool(() => skills.list()), calendar];

  /** File a request and assign it to an engineer, as the PM would; resolves when its result is up for review (or it failed). */
  const request = async (text: string, deliverable: Deliverable, continues?: number) => {
    const { call } = desk.startCall({ callSid: `imessage:${Math.random()}`, phone: EZRA, channel: "imessage" });
    const issue = desk.fileIssue(call.id, text);
    const from = calls.length;
    const began = Date.now();
    const assigned = desk.assign(issue.id, "work", text, [], { goal: text, doneWhen: "it works on a phone and they have the link", deliverable }, continues !== undefined ? { continues } : {});
    if (!assigned.ok) throw new Error(assigned.error);
    for (;;) {
      const now = desk.repo.issue(issue.id)!;
      if (now.status === "in_review" || now.status === "failed") {
        return { issue: now, text: now.prs.at(-1)?.body ?? "", calls: calls.slice(from), seconds: Math.round((Date.now() - began) / 1000) };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  /** An app that is already there, as an earlier request left it: its issue (for a follow-up to continue) and its id. */
  const plant = async (title: string, html: string) => {
    const { call } = desk.startCall({ callSid: `imessage:${Math.random()}`, phone: EZRA, channel: "imessage" });
    const issue = desk.fileIssue(call.id, `Make us an app: ${title}`);
    const made = desk.publishApp(issue.id, title, html);
    if (!made.ok) throw new Error(made.error);
    return { issue: issue.id, id: desk.repo.issue(issue.id)!.artifact! };
  };
  /** The owner's browser, signed in: what the family sees at the app's link, on its real data. */
  const signedIn = async () => {
    const user = await users.upsertUser({ phone: EZRA, name: "Ezra" });
    return { name: SESSION_COOKIE, value: signSession("session-secret", newSession(user.id, user.phone)), url: base };
  };
  const close = async () => {
    await pool.closeAll();
    await new Promise((r) => site.close(() => r(undefined)));
    store.close();
  };
  return { desk, base, store, request, plant, spent, signedIn, close };
}
