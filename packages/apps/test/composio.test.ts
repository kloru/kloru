import { describe, expect, it, vi } from "vitest";
import type { StateDir } from "@kloru/core";
import { ALL_TOOLKITS, APPS_STATE_FILE, ComposioApps, OPENAI_COMPLETIONS_TOOL_LIMIT, composioModeFor, normalizeToolkits, toolkitsWithoutAuthConfig, wantsAllToolkits, type ComposioClientLike, type ComposioSessionLike, type SessionCreateConfig } from "../src/composio.js";
import type { McpToolSource } from "../src/wrap.js";

function fakeState(initial: Record<string, unknown> = {}): StateDir & { files: Record<string, unknown> } {
  const files: Record<string, unknown> = { ...initial };
  return {
    files,
    readJson: <T>(name: string, fallback: T): T => (name in files ? (files[name] as T) : fallback),
    writeJson: (name: string, value: unknown) => {
      files[name] = JSON.parse(JSON.stringify(value));
    },
  } as unknown as StateDir & { files: Record<string, unknown> };
}

function fakeSession(id: string, overrides: Partial<ComposioSessionLike> = {}): ComposioSessionLike {
  return {
    sessionId: id,
    mcp: { url: `https://backend.composio.dev/mcp/${id}`, headers: { "x-session": id } },
    authorize: async (toolkit) => ({ redirectUrl: `https://connect.example/${toolkit}` }),
    toolkits: async () => ({ items: [] }),
    ...overrides,
  };
}

function fakeComposio(opts: { useFails?: boolean; sessions?: Record<string, ComposioSessionLike> } = {}) {
  const created: Array<{ userId: string; config: SessionCreateConfig }> = [];
  const used: string[] = [];
  let n = 0;
  const client: ComposioClientLike = {
    sessions: {
      create: async (userId, config) => {
        created.push({ userId, config });
        n += 1;
        return fakeSession(`sess_new_${n}`);
      },
      use: async (id) => {
        used.push(id);
        if (opts.useFails) throw new Error("404 session not found");
        return opts.sessions?.[id] ?? fakeSession(id);
      },
    },
  };
  return { client, created, used };
}

function fakeMcp(tools: Array<{ name: string }> = [{ name: "GMAIL_SEND_EMAIL" }, { name: "COMPOSIO_MANAGE_CONNECTIONS" }]) {
  const endpoints: Array<{ url: string; headers?: Record<string, string> }> = [];
  const close = vi.fn(async () => undefined);
  const connectMcp = async (mcp: { url: string; headers?: Record<string, string> }): Promise<McpToolSource> => {
    endpoints.push(mcp);
    return {
      listTools: async () => tools.map((t) => ({ ...t, inputSchema: {} })),
      callTool: async () => ({ content: [] }),
      close,
    };
  };
  return { connectMcp, endpoints, close };
}

const base = { apiKey: "ak_test", userId: "maria", toolkits: ["gmail", "googlecalendar"] };

describe("ComposioApps.connect", () => {
  it("creates a direct_tools session with manage connections and saves it", async () => {
    const state = fakeState();
    const composio = fakeComposio();
    const mcp = fakeMcp();
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: mcp.connectMcp } });
    await apps.connect();
    expect(composio.created).toEqual([
      { userId: "maria", config: { toolkits: ["gmail", "googlecalendar"], manageConnections: { enable: true }, mcp: true, multiAccount: { enable: true, maxAccountsPerToolkit: 5 }, sessionPreset: "direct_tools" } },
    ]);
    expect(state.files[APPS_STATE_FILE]).toMatchObject({ sessionId: "sess_new_1", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "direct" });
    expect(mcp.endpoints).toEqual([{ url: "https://backend.composio.dev/mcp/sess_new_1", headers: { "x-session": "sess_new_1" } }]);
    expect(apps.sessionId).toBe("sess_new_1");
  });

  it("omits the preset in router mode", async () => {
    const composio = fakeComposio();
    const apps = new ComposioApps({ ...base, mode: "router", state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.created[0]?.config.sessionPreset).toBeUndefined();
  });

  it("reuses a saved session when user, toolkits and mode match", async () => {
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_old", userId: "maria", toolkits: ["googlecalendar", "gmail"], mode: "direct", multiAccount: true, createdAt: "2026-01-01T00:00:00Z" } });
    const composio = fakeComposio();
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.used).toEqual(["sess_old"]);
    expect(composio.created).toEqual([]);
    expect(apps.sessionId).toBe("sess_old");
  });

  it("creates a new session when the saved toolkits differ", async () => {
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_old", userId: "maria", toolkits: ["gmail"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const composio = fakeComposio();
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.used).toEqual([]);
    expect(composio.created).toHaveLength(1);
    expect((state.files[APPS_STATE_FILE] as { sessionId: string }).sessionId).toBe("sess_new_1");
  });

  it("creates a new session when the saved one belongs to another user", async () => {
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_old", userId: "someone-else", toolkits: ["gmail", "googlecalendar"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const composio = fakeComposio();
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.used).toEqual([]);
    expect(composio.created).toHaveLength(1);
  });

  it("falls back to a new session when the saved one cannot be used", async () => {
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_gone", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const composio = fakeComposio({ useFails: true });
    const logs: string[] = [];
    const apps = new ComposioApps({ ...base, state, logger: (m) => logs.push(m), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.used).toEqual(["sess_gone"]);
    expect(composio.created).toHaveLength(1);
    expect((state.files[APPS_STATE_FILE] as { sessionId: string }).sessionId).toBe("sess_new_1");
    expect(logs.some((l) => l.includes("unusable"))).toBe(true);
    expect(logs.join("\n")).not.toContain("x-session");
  });

  it("connects once even when called concurrently", async () => {
    const composio = fakeComposio();
    const mcp = fakeMcp();
    const apps = new ComposioApps({ ...base, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: mcp.connectMcp } });
    await Promise.all([apps.connect(), apps.connect(), apps.tools()]);
    expect(composio.created).toHaveLength(1);
    expect(mcp.endpoints).toHaveLength(1);
  });

  it("rejects missing credentials up front", () => {
    expect(() => new ComposioApps({ ...base, apiKey: "", state: fakeState() })).toThrow(/apiKey/);
    expect(() => new ComposioApps({ ...base, userId: "", state: fakeState() })).toThrow(/userId/);
  });
});

/** An error shaped like the Composio SDK's APIError: `status`, a "<status> <body>" message and the parsed body. */
function apiError(status: number, body: unknown): Error {
  const msg = typeof (body as { message?: unknown })?.message === "string" ? (body as { message: string }).message : JSON.stringify(body);
  return Object.assign(new Error(`${status} ${msg}`), { status, error: body });
}

/** A client whose first N creates fail with the given errors, then succeed. */
function failingComposio(errors: Error[]) {
  const created: Array<{ userId: string; config: SessionCreateConfig }> = [];
  const client: ComposioClientLike = {
    sessions: {
      create: async (userId, config) => {
        created.push({ userId, config });
        const err = errors.shift();
        if (err) throw err;
        return fakeSession(`sess_new_${created.length}`);
      },
      use: async (id) => fakeSession(id),
    },
  };
  return { client, created };
}

const noContactsConfig = () =>
  apiError(400, { error: { message: "Toolkits googlecontacts require auth configs but none exist. Create an auth config for them first.", code: 4302 } });

describe("ComposioApps when the project lacks an auth config", () => {
  const three = { ...base, toolkits: ["gmail", "googlecalendar", "googlecontacts"] };

  it("drops the toolkits Composio refused, retries once, and keeps the rest of the apps", async () => {
    const state = fakeState();
    const composio = failingComposio([noContactsConfig()]);
    const logs: string[] = [];
    const apps = new ComposioApps({ ...three, state, logger: (m) => logs.push(m), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.created.map((c) => c.config.toolkits)).toEqual([
      ["gmail", "googlecalendar", "googlecontacts"],
      ["gmail", "googlecalendar"],
    ]);
    // The retry keeps the rest of the config: direct preset, connections, MCP.
    expect(composio.created[1]?.config).toMatchObject({ sessionPreset: "direct_tools", manageConnections: { enable: true }, mcp: true });
    expect(apps.sessionId).toBe("sess_new_2");
    expect(apps.unavailableToolkits).toEqual(["googlecontacts"]);
    expect(apps.toolkitSlugs).toEqual(["gmail", "googlecalendar"]);
    expect(state.files[APPS_STATE_FILE]).toMatchObject({ sessionId: "sess_new_2", toolkits: ["gmail", "googlecalendar"] });
    expect(logs.join("\n")).toMatch(/no auth config for googlecontacts.*gmail, googlecalendar only/);
  });

  it("reports connection state only for the toolkits that made it into the session", async () => {
    const toolkits = vi.fn(async () => ({ items: [{ slug: "gmail", connection: { isActive: true } }] }));
    const composio = failingComposio([noContactsConfig()]);
    composio.client.sessions.create = (async (userId: string, config: SessionCreateConfig) => {
      composio.created.push({ userId, config });
      if (composio.created.length === 1) throw noContactsConfig();
      return fakeSession("s", { toolkits });
    }) as ComposioClientLike["sessions"]["create"];
    const apps = new ComposioApps({ ...three, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    const status = await apps.connectedToolkits();
    expect(status.map((s) => s.slug)).toEqual(["gmail", "googlecalendar"]);
    expect(toolkits).toHaveBeenCalledWith(expect.objectContaining({ toolkits: ["gmail", "googlecalendar"] }));
  });

  it("does not retry other errors", async () => {
    const unauthorized = apiError(401, { error: { message: "Invalid API key" } });
    const composio = failingComposio([unauthorized]);
    const apps = new ComposioApps({ ...three, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await expect(apps.connect()).rejects.toBe(unauthorized);
    expect(composio.created).toHaveLength(1);
    expect(apps.unavailableToolkits).toEqual([]);
  });

  it("gives up when every toolkit lacks an auth config, and retries only once", async () => {
    const all = apiError(400, { message: "Toolkits gmail, googlecalendar, googlecontacts require auth configs but none exist" });
    const composio = failingComposio([all]);
    const apps = new ComposioApps({ ...three, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await expect(apps.connect()).rejects.toBe(all);
    expect(composio.created).toHaveLength(1);

    const twice = failingComposio([noContactsConfig(), apiError(400, { message: "Toolkits googlecalendar require auth configs but none exist" })]);
    const again = new ComposioApps({ ...three, state: fakeState(), adapters: { createComposio: () => twice.client, connectMcp: fakeMcp().connectMcp } });
    await expect(again.connect()).rejects.toThrow(/googlecalendar/);
    expect(twice.created).toHaveLength(2);
  });
});

describe("ComposioApps when Composio refuses a toolkit name", () => {
  const invalidStrava = () => apiError(400, { error: { message: "Invalid toolkit slugs: strava. Please provide valid toolkit slugs.", code: 4305, slug: "ToolRouterV2_InvalidToolkitSlugs" } });
  const four = { ...base, toolkits: ["gmail", "googlecalendar", "strava", "googlecontacts"] };

  it("drops the refused name and keeps every other app", async () => {
    const composio = failingComposio([invalidStrava()]);
    const logs: string[] = [];
    const apps = new ComposioApps({ ...four, state: fakeState(), logger: (m) => logs.push(m), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.created.at(-1)?.config.toolkits).toEqual(["gmail", "googlecalendar", "googlecontacts"]);
    expect(apps.unavailableToolkits).toEqual(["strava"]);
    expect(logs.join("\n")).toMatch(/strava/);
  });

  it("then still drops a toolkit without an auth config", async () => {
    const composio = failingComposio([invalidStrava(), noContactsConfig()]);
    const apps = new ComposioApps({ ...four, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(composio.created.map((c) => c.config.toolkits)).toEqual([
      ["gmail", "googlecalendar", "googlecontacts", "strava"],
      ["gmail", "googlecalendar", "googlecontacts"],
      ["gmail", "googlecalendar"],
    ]);
    expect(apps.unavailableToolkits).toEqual(["googlecontacts", "strava"]);
  });
});

describe("toolkitsWithoutAuthConfig", () => {
  const requested = ["gmail", "googlecalendar", "googlecontacts"];

  it("returns the requested toolkits the error names, as whole words", () => {
    expect(toolkitsWithoutAuthConfig(noContactsConfig(), requested)).toEqual(["googlecontacts"]);
    // The exact text a live Composio project returned.
    const live = Object.assign(new Error("400 The following toolkits require auth configs but none exist and cannot be auto-created: googlecontacts."), { status: 400 });
    expect(toolkitsWithoutAuthConfig(live, requested)).toEqual(["googlecontacts"]);
    // The SDK may put the server text in the message or only in the attached body.
    const bodyOnly = Object.assign(new Error("400 status code (no body)"), { status: 400, error: { detail: "auth configs missing for toolkits: [googlecontacts, gmail]" } });
    expect(toolkitsWithoutAuthConfig(bodyOnly, requested)).toEqual(["gmail", "googlecontacts"]);
    // "gmail_extra" is not "gmail"; names nobody asked for are ignored.
    expect(toolkitsWithoutAuthConfig(apiError(400, { message: "gmail_extra and notion require auth configs but none exist" }), requested)).toEqual([]);
  });

  it("ignores errors that are not about auth configs", () => {
    expect(toolkitsWithoutAuthConfig(apiError(400, { message: "googlecontacts is not a valid toolkit" }), requested)).toEqual([]);
    expect(toolkitsWithoutAuthConfig(apiError(500, { message: "googlecontacts require auth configs but none exist" }), requested)).toEqual([]);
    expect(toolkitsWithoutAuthConfig(new Error("fetch failed"), requested)).toEqual([]);
    expect(toolkitsWithoutAuthConfig(undefined, requested)).toEqual([]);
  });
});

describe("composioModeFor", () => {
  it("uses router for an OpenAI-style chat completions model, which caps tools at 128", () => {
    expect(OPENAI_COMPLETIONS_TOOL_LIMIT).toBe(128);
    expect(composioModeFor({}, "openai-completions")).toEqual({ mode: "router", reason: expect.stringContaining("128") });
    expect(composioModeFor({}, "anthropic-messages")).toEqual({ mode: "direct", reason: "default" });
    expect(composioModeFor({}, undefined).mode).toBe("direct");
  });

  it("lets COMPOSIO_MODE override in either direction and ignores anything else", () => {
    expect(composioModeFor({ COMPOSIO_MODE: "direct" }, "openai-completions")).toEqual({ mode: "direct", reason: "COMPOSIO_MODE" });
    expect(composioModeFor({ COMPOSIO_MODE: " Router " }, "anthropic-messages")).toEqual({ mode: "router", reason: "COMPOSIO_MODE" });
    const bad = composioModeFor({ COMPOSIO_MODE: "fast" }, "openai-completions");
    expect(bad.mode).toBe("router");
    expect(bad.reason).toMatch(/COMPOSIO_MODE=fast is not direct or router/);
  });
});

describe("ComposioApps in all-toolkits mode", () => {
  it.each([["all"], ["*"], ["ALL"], [" All "], ["gmail", "all"]])("%j creates a session with no toolkit allowlist and no preset", async (...toolkits) => {
    const state = fakeState();
    const composio = fakeComposio();
    const logs: string[] = [];
    const apps = new ComposioApps({ ...base, toolkits, state, logger: (m) => logs.push(m), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(apps.allToolkits).toBe(true);
    expect(apps.mode).toBe("router");
    expect(apps.toolkitSlugs).toEqual([ALL_TOOLKITS]);
    expect(composio.created).toHaveLength(1);
    const config = composio.created[0]!.config;
    expect(config).toEqual({ manageConnections: { enable: true }, mcp: true, multiAccount: { enable: true, maxAccountsPerToolkit: 5 } });
    expect("toolkits" in config).toBe(false);
    expect("sessionPreset" in config).toBe(false);
    expect(state.files[APPS_STATE_FILE]).toMatchObject({ sessionId: "sess_new_1", userId: "maria", toolkits: [ALL_TOOLKITS], mode: "router" });
    expect(logs.some((l) => l.includes("all toolkits"))).toBe(true);
  });

  it("ignores an explicit direct mode and says so", async () => {
    const composio = fakeComposio();
    const logs: string[] = [];
    const apps = new ComposioApps({ ...base, toolkits: ["all"], mode: "direct", state: fakeState(), logger: (m) => logs.push(m), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await apps.connect();
    expect(apps.mode).toBe("router");
    expect(composio.created[0]?.config.sessionPreset).toBeUndefined();
    expect(logs.some((l) => l.includes("using router mode"))).toBe(true);
  });

  it("reuses a saved all-mode session and makes a new one when switching to a list", async () => {
    const saved = { sessionId: "sess_all", userId: "maria", toolkits: ["*"], mode: "router", multiAccount: true, createdAt: "x" };
    const composio = fakeComposio();
    const again = new ComposioApps({ ...base, toolkits: ["*"], state: fakeState({ [APPS_STATE_FILE]: saved }), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await again.connect();
    expect(composio.used).toEqual(["sess_all"]);
    expect(composio.created).toEqual([]);

    const narrowed = new ComposioApps({ ...base, toolkits: ["gmail"], state: fakeState({ [APPS_STATE_FILE]: saved }), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    await narrowed.connect();
    expect(composio.created).toHaveLength(1);
    expect(composio.created[0]?.config.toolkits).toEqual(["gmail"]);
  });

  it("reports the active connections, paging through the list, and never a no-auth toolkit", async () => {
    const calls: unknown[] = [];
    const toolkits = vi.fn(async (opts?: { cursor?: string }) => {
      calls.push(opts);
      if (!opts?.cursor) {
        return { items: [{ slug: "GMAIL", connection: { isActive: true } }, { slug: "notion", connection: { isActive: false } }, { slug: "hackernews", isNoAuth: true }], nextCursor: "p2" };
      }
      return { items: [{ slug: "slack", connection: { isActive: true } }, { slug: "gmail", connection: { isActive: true } }], nextCursor: null };
    });
    const composio = fakeComposio({ sessions: { s: fakeSession("s", { toolkits }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "s", userId: "maria", toolkits: ["*"], mode: "router", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, toolkits: ["all"], state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectedToolkits()).toEqual([
      { slug: "gmail", connected: true },
      { slug: "slack", connected: true },
    ]);
    expect(calls).toEqual([
      { isConnected: true, limit: 50 },
      { isConnected: true, limit: 50, cursor: "p2" },
    ]);
  });

  it("stops paging after a bounded number of pages", async () => {
    const toolkits = vi.fn(async () => ({ items: [{ slug: "gmail", connection: { isActive: true } }], nextCursor: "again" }));
    const composio = fakeComposio({ sessions: { s: fakeSession("s", { toolkits }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "s", userId: "maria", toolkits: ["*"], mode: "router", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, toolkits: ["all"], state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectedToolkits()).toEqual([{ slug: "gmail", connected: true }]);
    expect(toolkits).toHaveBeenCalledTimes(20);
  });

  it("still hands out connect links for any toolkit", async () => {
    const composio = fakeComposio();
    const apps = new ComposioApps({ ...base, toolkits: ["all"], state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectLink(" Notion ")).toBe("https://connect.example/notion");
  });
});

describe("ComposioApps.tools", () => {
  it("wraps the MCP tools with app_ names and capabilities, and caches", async () => {
    const composio = fakeComposio();
    const mcp = fakeMcp([{ name: "GMAIL_FETCH_EMAILS" }, { name: "GOOGLECALENDAR_CREATE_EVENT" }, { name: "COMPOSIO_MANAGE_CONNECTIONS" }]);
    const apps = new ComposioApps({ ...base, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: mcp.connectMcp } });
    const tools = await apps.tools();
    expect(tools.map((t) => [t.spec.name, t.spec.meta.capabilities])).toEqual([
      ["app_gmail_fetch_emails", ["email.read"]],
      ["app_googlecalendar_create_event", ["calendar.write"]],
      ["app_composio_manage_connections", ["apps.use", "trust.manage"]],
    ]);
    expect(tools.every((t) => t.spec.meta.group === "apps")).toBe(true);
    expect(await apps.tools()).toBe(tools);
    expect(await apps.tools({ refresh: true })).not.toBe(tools);
  });
});

describe("ComposioApps.connectLink and connectedToolkits", () => {
  it("returns the authorize redirect url, lowercasing the toolkit", async () => {
    const authorize = vi.fn(async (toolkit: string) => ({ redirectUrl: `https://connect.example/${toolkit}` }));
    const composio = fakeComposio({ sessions: { sess_old: fakeSession("sess_old", { authorize }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_old", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectLink("Gmail")).toBe("https://connect.example/gmail");
    expect(authorize).toHaveBeenCalledWith("gmail");
  });

  it("passes a callback URL to authorize when given one", async () => {
    const authorize = vi.fn(async (toolkit: string) => ({ redirectUrl: `https://connect.example/${toolkit}` }));
    const composio = fakeComposio({ sessions: { sess_old: fakeSession("sess_old", { authorize }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_old", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectLink("GoogleCalendar", "https://app.kloru.com/connections/return")).toBe("https://connect.example/googlecalendar");
    expect(authorize).toHaveBeenCalledWith("googlecalendar", { callbackUrl: "https://app.kloru.com/connections/return" });
  });

  it("disconnect deletes this user's accounts for the toolkit", async () => {
    const composio = fakeComposio();
    const deleted: string[] = [];
    const list = vi.fn(async () => ({ items: [{ id: "ca_1" }, { id: "ca_2" }] }));
    composio.client.connectedAccounts = { list, delete: async (id: string) => { deleted.push(id); } };
    const apps = new ComposioApps({ ...base, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.disconnect(" Gmail ")).toBe(2);
    expect(list).toHaveBeenCalledWith({ userIds: ["maria"], toolkitSlugs: ["gmail"] });
    expect(deleted).toEqual(["ca_1", "ca_2"]);
  });

  it("disconnect fails clearly when the client cannot list accounts", async () => {
    const apps = new ComposioApps({ ...base, state: fakeState(), adapters: { createComposio: () => fakeComposio().client, connectMcp: fakeMcp().connectMcp } });
    await expect(apps.disconnect("gmail")).rejects.toThrow(/connected accounts/);
  });

  it("returns undefined when there is no redirect", async () => {
    const composio = fakeComposio({ sessions: { s: fakeSession("s", { authorize: async () => ({ redirectUrl: null }) }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "s", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectLink("gmail")).toBeUndefined();
  });

  it("reports every configured toolkit, treating missing ones as not connected", async () => {
    const toolkits = vi.fn(async () => ({
      items: [
        { slug: "gmail", connection: { isActive: true } },
        { slug: "GOOGLECALENDAR", connection: { isActive: false } },
        { slug: "hackernews", isNoAuth: true },
      ],
    }));
    const composio = fakeComposio({ sessions: { s: fakeSession("s", { toolkits }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "s", userId: "maria", toolkits: ["gmail", "googlecalendar", "googlecontacts", "hackernews"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, toolkits: ["gmail", "googlecalendar", "googlecontacts", "hackernews"], state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectedToolkits()).toEqual([
      { slug: "gmail", connected: true },
      { slug: "googlecalendar", connected: false },
      { slug: "googlecontacts", connected: false },
      { slug: "hackernews", connected: true },
    ]);
    expect(toolkits).toHaveBeenCalledWith({ toolkits: ["gmail", "googlecalendar", "googlecontacts", "hackernews"], limit: 4 });
  });
});

describe("ComposioApps.close", () => {
  it("closes the MCP client and reconnects on the next use", async () => {
    const composio = fakeComposio();
    const mcp = fakeMcp();
    const apps = new ComposioApps({ ...base, state: fakeState(), adapters: { createComposio: () => composio.client, connectMcp: mcp.connectMcp } });
    await apps.tools();
    await apps.close();
    expect(mcp.close).toHaveBeenCalledTimes(1);
    await apps.close();
    expect(mcp.close).toHaveBeenCalledTimes(1);
    await apps.tools();
    expect(mcp.endpoints).toHaveLength(2);
    expect(composio.used).toEqual(["sess_new_1"]);
  });
});

describe("normalizeToolkits", () => {
  it("lowercases, trims, dedupes and sorts", () => {
    expect(normalizeToolkits([" Gmail", "gmail", "GOOGLECALENDAR", "", "  "])).toEqual(["gmail", "googlecalendar"]);
  });

  it("collapses to the all marker when any entry is all or *", () => {
    expect(normalizeToolkits(["all"])).toEqual(["*"]);
    expect(normalizeToolkits(["gmail", " ALL "])).toEqual(["*"]);
    expect(normalizeToolkits(["*", "slack"])).toEqual(["*"]);
    expect(normalizeToolkits([])).toEqual([]);
  });
});

describe("wantsAllToolkits", () => {
  it("accepts all and * in any case, nothing else", () => {
    expect(wantsAllToolkits(["all"])).toBe(true);
    expect(wantsAllToolkits(["*"])).toBe(true);
    expect(wantsAllToolkits(["gmail", "All"])).toBe(true);
    expect(wantsAllToolkits(["gmail", "allthings"])).toBe(false);
    expect(wantsAllToolkits([])).toBe(false);
  });
});

describe("ComposioApps.execute: one action by name, from code (no model)", () => {
  function recording(result: unknown) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connectMcp = async (): Promise<McpToolSource> => ({
      listTools: async () => [],
      callTool: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      },
      close: async () => undefined,
    });
    return { calls, connectMcp };
  }

  it("in router mode it goes through multi-execute and reads the one result", async () => {
    const mcp = recording({ successful: true, data: { results: [{ response: { successful: true, data: { id: "msg_1" } } }] } });
    const apps = new ComposioApps({ ...base, mode: "router", state: fakeState(), adapters: { createComposio: () => fakeComposio().client, connectMcp: mcp.connectMcp } });
    const out = await apps.execute("GMAIL_SEND_EMAIL", { recipient_email: "me@example.com", subject: "s", body: "b" });
    // sync_response_to_workbench is required by Composio (calls without it are refused), and false keeps
    // the full result inline instead of a truncated data_preview.
    expect(mcp.calls).toEqual([{ name: "COMPOSIO_MULTI_EXECUTE_TOOL", args: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "me@example.com", subject: "s", body: "b" } }], sync_response_to_workbench: false, thought: "Kloru runs GMAIL_SEND_EMAIL" } }]);
    expect(out).toEqual({ ok: true, data: { id: "msg_1" } });
  });

  it("a refused action comes back as not ok, with why", async () => {
    const mcp = recording({ successful: true, data: { results: [{ response: { successful: false, error: "Gmail is not connected" } }] } });
    const apps = new ComposioApps({ ...base, mode: "router", state: fakeState(), adapters: { createComposio: () => fakeComposio().client, connectMcp: mcp.connectMcp } });
    const out = await apps.execute("GMAIL_SEND_EMAIL", {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("not connected");
  });
});

describe("ComposioApps.execute through the SDK", () => {
  it("runs the action directly for this user when the SDK can, so results aren't cut to a preview", async () => {
    const calls: unknown[] = [];
    const composio = fakeComposio();
    const client = {
      ...composio.client,
      tools: {
        execute: async (slug: string, body: unknown) => {
          calls.push({ slug, body });
          return { successful: true, data: { messages: Array.from({ length: 100 }, (_, i) => ({ messageId: `m${i}` })) } };
        },
      },
    };
    const apps = new ComposioApps({ ...base, mode: "router", state: fakeState(), adapters: { createComposio: () => client as never, connectMcp: fakeMcp().connectMcp } });
    const out = await apps.execute("GMAIL_FETCH_EMAILS", { query: "newer_than:1d", max_results: 100 });
    expect(calls).toEqual([{ slug: "GMAIL_FETCH_EMAILS", body: { userId: "maria", arguments: { query: "newer_than:1d", max_results: 100 }, dangerouslySkipVersionCheck: true } }]);
    expect(out.ok).toBe(true);
    expect((out.data as { messages: unknown[] }).messages).toHaveLength(100);
  });

  it("a refusal from the SDK comes back as not ok, with why", async () => {
    const client = { ...fakeComposio().client, tools: { execute: async () => ({ successful: false, error: "Gmail is not connected", data: {} }) } };
    const apps = new ComposioApps({ ...base, mode: "router", state: fakeState(), adapters: { createComposio: () => client as never, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.execute("GMAIL_SEND_EMAIL", {})).toEqual({ ok: false, error: "Gmail is not connected" });
  });
});

describe("several accounts per app", () => {
  const ACCOUNTS_FILE = "app-accounts.json";
  type Row = { id: string; status: string; toolkit: { slug: string }; createdAt: string };
  const rows: Row[] = [
    { id: "ca_work_cal", status: "ACTIVE", toolkit: { slug: "googlecalendar" }, createdAt: "2026-10-29T10:00:00Z" },
    { id: "ca_home_mail", status: "ACTIVE", toolkit: { slug: "gmail" }, createdAt: "2026-10-27T10:00:00Z" },
    { id: "ca_work_mail", status: "ACTIVE", toolkit: { slug: "gmail" }, createdAt: "2026-10-29T10:00:00Z" },
    { id: "ca_old_mail", status: "EXPIRED", toolkit: { slug: "gmail" }, createdAt: "2026-10-20T10:00:00Z" },
    { id: "ca_gone_mail", status: "EXPIRED", toolkit: { slug: "gmail" }, createdAt: "2026-10-21T10:00:00Z" },
    { id: "ca_half", status: "INITIATED", toolkit: { slug: "gmail" }, createdAt: "2026-10-29T11:00:00Z" },
    { id: "ca_home_cal", status: "ACTIVE", toolkit: { slug: "googlecalendar" }, createdAt: "2026-10-27T10:00:00Z" },
  ];
  const who: Record<string, string> = { ca_home_mail: "ezra@gmail.example", ca_work_mail: "ezra@work.example.com", ca_home_cal: "ezra@gmail.example", ca_work_cal: "ezra@work.example.com" };

  function setup(o: { state?: ReturnType<typeof fakeState> } = {}) {
    const composio = fakeComposio();
    const executed: Array<{ slug: string; body: Record<string, unknown> }> = [];
    const deleted: string[] = [];
    const list = vi.fn(async (_q: unknown) => ({ items: rows }));
    const client = {
      ...composio.client,
      connectedAccounts: { list, delete: async (id: string) => void deleted.push(id) },
      tools: {
        execute: async (slug: string, body: Record<string, unknown>) => {
          executed.push({ slug, body });
          const email = who[String(body.connectedAccountId)];
          if (slug === "GMAIL_GET_PROFILE") return { successful: true, data: { emailAddress: email } };
          if (slug === "GOOGLECALENDAR_GET_CALENDAR") return { successful: true, data: { calendar_data: { id: email } } };
          return { successful: true, data: {} };
        },
      },
    };
    const state = o.state ?? fakeState({ [ACCOUNTS_FILE]: { ca_old_mail: "ezra@gmail.example" } });
    const apps = new ComposioApps({ ...base, mode: "router", state, adapters: { createComposio: () => client as never, connectMcp: fakeMcp().connectMcp } });
    return { apps, executed, deleted, list, state, composio };
  }

  it("the session allows several accounts per app; an older single-account session is replaced", async () => {
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "sess_old", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "router", createdAt: "x" } });
    const { apps, composio } = setup({ state });
    await apps.connect();
    expect(composio.created[0]?.config.multiAccount).toEqual({ enable: true, maxAccountsPerToolkit: 5 });
    expect(state.files[APPS_STATE_FILE]).toMatchObject({ multiAccount: true });
  });

  it("lists every account by its email, oldest first; an expired one shows unless the same address is connected again; half-finished sign-ins don't show", async () => {
    const { apps, state } = setup();
    expect(await apps.accounts()).toEqual([
      { id: "ca_home_mail", toolkit: "gmail", email: "ezra@gmail.example", status: "connected" },
      { id: "ca_work_mail", toolkit: "gmail", email: "ezra@work.example.com", status: "connected" },
      { id: "ca_gone_mail", toolkit: "gmail", status: "expired" },
      { id: "ca_home_cal", toolkit: "googlecalendar", email: "ezra@gmail.example", status: "connected" },
      { id: "ca_work_cal", toolkit: "googlecalendar", email: "ezra@work.example.com", status: "connected" },
    ]);
    expect(state.files[ACCOUNTS_FILE]).toMatchObject({ ca_home_mail: "ezra@gmail.example", ca_work_cal: "ezra@work.example.com" });
  });

  it("an account connected from a member's link is hers; the rest are the owner's", async () => {
    const authorize = vi.fn(async () => ({ id: "ca_work_mail", redirectUrl: "https://connect.example/gmail" }));
    const { apps, state, composio } = setup();
    (apps as unknown as { session: unknown }).session = { authorize };
    (apps as unknown as { connect: () => Promise<void> }).connect = async () => {};
    expect(await apps.connectLink("gmail", undefined, { person: "cleo" })).toBe("https://connect.example/gmail");
    const accounts = await apps.accounts();
    expect(accounts.find((a) => a.id === "ca_work_mail")).toMatchObject({ email: "ezra@work.example.com", person: "cleo" });
    expect(accounts.find((a) => a.id === "ca_home_mail")!.person).toBeUndefined();
    expect(state.files["app-account-people.json"]).toEqual({ ca_work_mail: "cleo" });
    expect(apps.connected().map((a) => a.id)).toContain("ca_work_mail");
  });

  it("looks each address up once", async () => {
    const { apps, executed } = setup();
    await apps.accounts();
    const n = executed.length;
    await apps.accounts();
    expect(executed.length).toBe(n);
  });

  it("disconnects one account, and only one of this family's", async () => {
    const { apps, deleted } = setup();
    await apps.disconnectAccount("ca_work_mail");
    expect(deleted).toEqual(["ca_work_mail"]);
    await expect(apps.disconnectAccount("ca_someone_else")).rejects.toThrow(/not one of/);
  });

  it("runs an action as the account it's given, and as the first connected one otherwise", async () => {
    const { apps, executed } = setup();
    await apps.accounts();
    executed.length = 0;
    await apps.execute("GMAIL_SEND_EMAIL", { to: "x" }, { account: "ca_work_mail" });
    await apps.execute("GMAIL_SEND_EMAIL", { to: "x" });
    expect(executed.map((e) => e.body.connectedAccountId)).toEqual(["ca_work_mail", "ca_home_mail"]);
  });

  it("an account can be named by its email address (the store files items under it)", async () => {
    const { apps, executed } = setup();
    await apps.accounts();
    executed.length = 0;
    await apps.execute("GMAIL_MOVE_TO_TRASH", { message_id: "m1" }, { account: "Ezra@work.example.com" });
    await apps.execute("GOOGLECALENDAR_PATCH_EVENT", { event_id: "e1" }, { account: "ezra@gmail.example" });
    expect(executed.map((e) => e.body.connectedAccountId)).toEqual(["ca_work_mail", "ca_home_cal"]);
    expect(await apps.execute("GMAIL_MOVE_TO_TRASH", { message_id: "m1" }, { account: "stranger@x.example" })).toEqual({ ok: false, error: "no connected Gmail account for stranger@x.example" });
  });

  it("an add link starts a new sign-in alongside the existing ones", async () => {
    const authorize = vi.fn(async (toolkit: string) => ({ redirectUrl: `https://connect.example/${toolkit}` }));
    const composio = fakeComposio({ sessions: { s: fakeSession("s", { authorize }) } });
    const state = fakeState({ [APPS_STATE_FILE]: { sessionId: "s", userId: "maria", toolkits: ["gmail", "googlecalendar"], mode: "direct", multiAccount: true, createdAt: "x" } });
    const apps = new ComposioApps({ ...base, state, adapters: { createComposio: () => composio.client, connectMcp: fakeMcp().connectMcp } });
    expect(await apps.connectLink("gmail", "https://kloru.com/connections/return")).toBe("https://connect.example/gmail");
    expect(composio.used).toEqual(["s"]);
  });

  it("tells agents which accounts there are and how to pick one", async () => {
    const { apps } = setup();
    expect(apps.accountsLine()).toBe("");
    await apps.accounts();
    const line = apps.accountsLine();
    expect(line).toContain("Gmail: ezra@gmail.example (account ca_home_mail), ezra@work.example.com (account ca_work_mail)");
    expect(line).toContain("Calendar: ezra@gmail.example (account ca_home_cal), ezra@work.example.com (account ca_work_cal)");
    expect(line).toMatch(/account/);
  });

  it("one account per app needs no line", async () => {
    const one = rows.filter((r) => r.id === "ca_home_mail" || r.id === "ca_home_cal");
    const { apps, list } = setup();
    list.mockResolvedValue({ items: one });
    await apps.accounts();
    expect(apps.accountsLine()).toBe("");
  });
});

describe("apps beyond Google", () => {
  const rows = [
    { id: "ca_outlook", status: "ACTIVE", toolkit: { slug: "outlook" }, createdAt: "2026-10-29T10:00:00Z" },
    { id: "ca_notion", status: "ACTIVE", toolkit: { slug: "notion" }, createdAt: "2026-10-29T10:00:00Z" },
    { id: "ca_drive", status: "ACTIVE", toolkit: { slug: "one_drive" }, createdAt: "2026-10-29T10:00:00Z" },
  ];
  function setup() {
    const executed: Array<{ slug: string; body: Record<string, unknown> }> = [];
    const client = {
      ...fakeComposio().client,
      connectedAccounts: { list: async () => ({ items: rows }), delete: async () => undefined },
      tools: {
        execute: async (slug: string, body: Record<string, unknown>) => {
          executed.push({ slug, body });
          if (slug === "OUTLOOK_OUTLOOK_GET_PROFILE") return { successful: true, data: { response_data: { mail: "Ezra@Outlook.example" } } };
          return { successful: true, data: {} };
        },
      },
    };
    const apps = new ComposioApps({ ...base, toolkits: ["gmail", "outlook", "notion", "one_drive"], mode: "router", state: fakeState(), adapters: { createComposio: () => client as never, connectMcp: fakeMcp().connectMcp } });
    return { apps, executed };
  }

  it("an Outlook account is named by its address", async () => {
    const { apps } = setup();
    expect((await apps.accounts()).find((a) => a.id === "ca_outlook")).toMatchObject({ toolkit: "outlook", email: "ezra@outlook.example" });
  });

  it("an action that names no account runs as that app's account", async () => {
    const { apps, executed } = setup();
    await apps.accounts();
    await apps.execute("NOTION_SEARCH_NOTION_PAGE", {});
    await apps.execute("ONE_DRIVE_LIST_ITEMS", {});
    expect(executed.filter((e) => !e.slug.includes("PROFILE")).map((e) => e.body.connectedAccountId)).toEqual(["ca_notion", "ca_drive"]);
  });
});
