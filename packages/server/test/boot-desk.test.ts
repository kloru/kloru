import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { boot, type BootResult } from "../src/boot.js";

describe("boot: desk", () => {
  let dataDir: string;
  let app: BootResult | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "instinct-boot-desk-"));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const logs: string[] = [];
  async function bootWith(extra: NodeJS.ProcessEnv = {}) {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }, { id: "faux-pm" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
    const env = { INSTINCT_DATA_DIR: dataDir, INSTINCT_OWNER_NAME: "Ezra", INSTINCT_OWNER_PHONE: "+14155550190", INSTINCT_AGENT_NAME: "Kloru", INSTINCT_MODEL: "faux/faux-1", INSTINCT_COMPUTER: "none", INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"), ...extra };
    app = await boot(env, { model: faux.getModel("faux-1"), streamFn, logger: (m) => logs.push(m) });
    return app;
  }

  it("without an agent handle, apps stay off rather than share the default Composio user", async () => {
    logs.length = 0;
    await bootWith({ COMPOSIO_API_KEY: "ck_test" });
    expect(logs.some((m) => /apps: off.*no agent handle/.test(m))).toBe(true);
  });

  it("builds a desk whose repository lives in the agent's data dir", async () => {
    const a = await bootWith();
    expect(a.desk).toBeDefined();
    expect(a.desk!.repo.dir).toBe(join(dataDir, "repo"));
    const { call } = a.desk!.startCall({ callSid: "CA1", phone: "+14155550190", channel: "voice" });
    expect(a.desk!.repo.call(call.id)).toBeDefined();
  });

  it("KLORU_DESK=off leaves it out", async () => {
    expect((await bootWith({ KLORU_DESK: "off" })).desk).toBeUndefined();
  });

  it("KLORU_ENGINEER_MODEL puts engineers on their own model", async () => {
    await bootWith({ KLORU_ENGINEER_MODEL: "openrouter/openai/gpt-6.1-terra" });
    expect(logs.some((l) => l.includes("engineers on openrouter/openai/gpt-6.1-terra"))).toBe(true);
  });

  it("KLORU_APP_ENGINEER_MODEL puts app work on its own model; QA needs a browser, and KLORU_QA=off leaves it out", async () => {
    logs.length = 0;
    await bootWith({ KLORU_ENGINEER_MODEL: "openrouter/openai/gpt-6-luna", KLORU_APP_ENGINEER_MODEL: "openrouter/openai/gpt-6.1-terra", KLORU_QA_MODEL: "openrouter/openai/gpt-6-luna", STEEL_API_KEY: "steel_test" });
    expect(logs.some((l) => l.includes("engineers on openrouter/openai/gpt-6-luna, apps on openrouter/openai/gpt-6.1-terra, QA tries apps on openrouter/openai/gpt-6-luna"))).toBe(true);
    await app?.close();
    logs.length = 0;
    await bootWith({ KLORU_APP_ENGINEER_MODEL: "openrouter/openai/gpt-6.1-terra", STEEL_API_KEY: "steel_test", KLORU_QA: "off" });
    expect(logs.some((l) => l.includes("apps on openrouter/openai/gpt-6.1-terra"))).toBe(true);
    expect(logs.some((l) => l.includes("QA tries apps"))).toBe(false);
    await app?.close();
    logs.length = 0;
    await bootWith({ KLORU_BROWSER: "off", STEEL_API_KEY: "steel_test" });
    expect(logs.some((l) => l.includes("QA tries apps"))).toBe(false);
  });
});

