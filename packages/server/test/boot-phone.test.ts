import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { boot, callOriginationFrom, type BootResult } from "../src/boot.js";

/** Every request the SDK and the adapter make against the fake Inkbox, by "METHOD path". */
let requests: Array<{ method: string; path: string; body: unknown }>;

function fakeInkboxFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: url.pathname, body });
    const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/api/v1/identities/smoke-instinct") {
      return json(200, {
        id: "ident_1",
        organization_id: "org_1",
        agent_handle: "smoke-instinct",
        display_name: "Smoke",
        email_address: "smoke-instinct@inkbox.ai",
        imessage_enabled: true,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        mailbox: null,
        phone_number: null,
        imessage_number: null,
        tunnel: null,
      });
    }
    if (method === "PUT" && url.pathname === "/api/v1/phone/hosted-agent-config") {
      return json(200, { agent_identity_id: "ident_1", voice: body?.voice ?? null, effective_voice: body?.voice ?? "default", effective_model: "m", instructions: body?.instructions ?? null, authority_mode: "contact_scoped" });
    }
    if (method === "GET" && url.pathname === "/api/v1/phone/calls/call_1/transcripts") {
      return json(200, [{ id: "t1", call_id: "call_1", seq: 1, ts_ms: 0, party: "remote", text: "Hi, this is Maria, bye.", created_at: "2026-10-16T18:00:00Z" }]);
    }
    return json(404, { detail: `no route for ${method} ${url.pathname}` });
  }) as typeof fetch;
}

describe("boot: phone voice", () => {
  let dataDir: string;
  let app: BootResult | undefined;
  const logs: string[] = [];
  const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    INSTINCT_DATA_DIR: dataDir,
    INSTINCT_OWNER_NAME: "Maria",
    INSTINCT_OWNER_PHONE: "+14155550000",
    INSTINCT_AGENT_NAME: "Smoke",
    INSTINCT_MODEL: "faux/faux-1",
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
    INKBOX_API_KEY: "ik_identity",
    INKBOX_AGENT_HANDLE: "smoke-instinct",
    INKBOX_BASE_URL: "https://inkbox.test",
    ...extra,
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "instinct-boot-phone-"));
    requests = [];
    logs.length = 0;
    vi.stubGlobal("fetch", fakeInkboxFetch());
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllGlobals();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function bootWith(extra: NodeJS.ProcessEnv = {}): Promise<BootResult> {
    const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
    app = await boot(env(extra), { model: faux.getModel("faux-1"), streamFn, logger: (m) => logs.push(m), fetchImpl: fakeInkboxFetch() });
    return app;
  }

  it("sets the Voice AI voice and the assistant instructions when INKBOX_VOICE is set", async () => {
    const result = await bootWith({ INKBOX_VOICE: "ember" });
    const put = requests.find((r) => r.method === "PUT" && r.path === "/api/v1/phone/hosted-agent-config");
    expect(put?.body).toEqual({
      agent_identity_id: "ident_1",
      voice: "ember",
      instructions: "You are Maria's assistant calling on their behalf. Be brief and polite, confirm names and times before you end the call, and never share Maria's card details or personal data.",
    });
    expect(logs).toContain("phone voice: ember");
    // Inkbox call reports no longer text the owner on the side: every message goes through coms.
    expect(result.onCallEnded).toBeUndefined();
    expect(result.runtime).toBeDefined();
  });

  it("leaves the Inkbox voice config alone when no voice is chosen, and registers phone_call", async () => {
    await bootWith();
    expect(requests.some((r) => r.path === "/api/v1/phone/hosted-agent-config")).toBe(false);
    expect(logs.some((l) => l.startsWith("phone voice"))).toBe(false);
    expect(logs.some((l) => /tools/.test(l))).toBe(true);
  });

  it("boots anyway when Inkbox refuses the voice config", async () => {
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ detail: "nope" }), { status: 500, headers: { "content-type": "application/json" } })) as typeof fetch);
    const result = await bootWith({ INKBOX_VOICE: "ember" });
    expect(result.runtime).toBeDefined();
    expect(logs.some((l) => l.startsWith("phone voice unavailable:"))).toBe(true);
  });

  it("reads INKBOX_CALL_ORIGINATION and refuses a value Inkbox does not know", () => {
    expect(callOriginationFrom({})).toBeUndefined();
    expect(callOriginationFrom({ INKBOX_CALL_ORIGINATION: " Dedicated_Number " })).toBe("dedicated_number");
    expect(() => callOriginationFrom({ INKBOX_CALL_ORIGINATION: "pigeon" })).toThrow(/INKBOX_CALL_ORIGINATION must be one of dedicated_number, shared_imessage_number, dedicated_imessage_number, not "pigeon"/);
  });

});
