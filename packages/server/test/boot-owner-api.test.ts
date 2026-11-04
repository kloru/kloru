import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { signOwnerEnvelope } from "@kloru/core";
import { boot, type BootResult } from "../src/boot.js";

describe("boot: owner API", () => {
  let dataDir: string;
  let app: BootResult | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "instinct-boot-owner-"));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bootWith(extra: NodeJS.ProcessEnv = {}): Promise<BootResult> {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
    const env = { INSTINCT_DATA_DIR: dataDir, INSTINCT_OWNER_NAME: "Maria", INSTINCT_OWNER_PHONE: "+14155550000", INSTINCT_AGENT_NAME: "Smoke", INSTINCT_MODEL: "faux/faux-1", INSTINCT_COMPUTER: "none", INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"), ...extra };
    app = await boot(env, { model: faux.getModel("faux-1"), streamFn, logger: () => {} });
    return app;
  }

  it("has no owner API without OWNER_API_SECRET", async () => {
    expect((await bootWith()).ownerApi).toBeUndefined();
  });

  it("with a secret, a console permission change lands in policy.json", async () => {
    const result = await bootWith({ OWNER_API_SECRET: "s3cret" });
    const out = await result.ownerApi!.handle(signOwnerEnvelope("s3cret", "policy.setPermission", { tier: "owner", capability: "email.send", permission: "ask" }));
    expect(out.status).toBe(200);
    expect(JSON.parse(readFileSync(join(dataDir, "policy.json"), "utf8")).tiers.owner["email.send"]).toBe("ask");
    expect((await result.ownerApi!.handle(signOwnerEnvelope("s3cret", "status.get", {}))).result).toMatchObject({ agent: "Smoke", owner: "Maria" });
  });
});
