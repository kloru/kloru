import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { OutboundMessage, Outbox, Principal } from "@kloru/core";
import { boot } from "../src/boot.js";

const KEY = "am_test_key_0123456789";

class RecordingOutbox implements Outbox {
  sent: Array<{ msg: OutboundMessage; principal: Principal }> = [];
  async send(msg: OutboundMessage, ctx: { principal: Principal; conversationKey: string }): Promise<void> {
    this.sent.push({ msg, principal: ctx.principal });
  }
  async typing(): Promise<void> {}
}

const READ_INBOX = { name: "read_inbox", description: "List recent messages.", inputSchema: { type: "object", properties: { agent_id: { type: "string" } } } };
const SEND_EMAIL = { name: "send_email", description: "Send.", inputSchema: { type: "object", properties: { to: { type: "string" } } } };
const JMAP = { name: "jmap_request", description: "Raw.", inputSchema: { type: "object" } };
const LIST_AGENTS = { name: "list_agents", description: "List.", inputSchema: { type: "object" } };
const TOOLS = [READ_INBOX, SEND_EMAIL, JMAP, LIST_AGENTS];

interface Seen {
  urls: string[];
  auth: string[];
}

/** A stub `fetch` that speaks just enough MCP over Streamable HTTP. Anything else is a 404. */
function fakeAtomicMail(seen: Seen, opts: { reject?: boolean; url?: string } = {}): typeof fetch {
  const mcpUrl = opts.url ?? "https://mcp.atomicmail.ai/mcp";
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== mcpUrl) return new Response("not found", { status: 404 });
    seen.urls.push(url);
    seen.auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (opts.reject) {
      return new Response('{"error":"invalid_token"}', { status: 401, headers: { "www-authenticate": 'Bearer error="invalid_token"' } });
    }
    const body = JSON.parse(String(init?.body)) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (body.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (body.method === "initialize") {
      result = { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-atomicmail", version: "0" } };
    } else if (body.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (body.method === "tools/call" && body.params?.name === "list_agents") {
      result = { content: [{ type: "text", text: JSON.stringify({ agents: [{ inboxId: "me", email: "me@atomicmail.ai" }] }) }] };
    } else {
      result = { content: [{ type: "text", text: "ok" }] };
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function bootWith(extra: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
  const dataDir = mkdtempSync(join(tmpdir(), "instinct-boot-"));
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    INSTINCT_DATA_DIR: dataDir,
    INSTINCT_OWNER_NAME: "Test Owner",
    INSTINCT_OWNER_PHONE: "+15550001111",
    INSTINCT_OWNER_EMAIL: "owner@example.com",
    INSTINCT_OWNER_TIMEZONE: "America/New_York",
    INSTINCT_AGENT_NAME: "Test",
    INSTINCT_MODEL: "faux/faux-1",
    INSTINCT_COMPUTER: "none",
    INSTINCT_SKILLS_DIR: join(dataDir, "no-skills"),
    ...extra,
  };
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const streamFn = models.streamSimple.bind(models) as unknown as StreamFn;
  const logs: string[] = [];
  const app = await boot(env, { model: faux.getModel("faux-1"), streamFn, outbox: new RecordingOutbox(), logger: (m) => logs.push(m), fetchImpl });
  return { app, logs };
}

describe("Atomic Mail wiring in boot", () => {
  it("does nothing without a key", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const { app, logs } = await bootWith({}, fakeAtomicMail(seen));
    expect(logs.filter((l) => l.toLowerCase().includes("atomicmail"))).toEqual([]);
    expect(seen.urls).toEqual([]);
    await app.close();
  });

  it("registers the tagged tools and names the address when a key is set", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const { app, logs } = await bootWith({ ATOMIC_MAIL_API_KEY: KEY }, fakeAtomicMail(seen));
    expect(logs).toContain("atomicmail: 2 tools (me@atomicmail.ai)");
    expect(logs.some((l) => l.includes("left out") && l.includes("jmap_request"))).toBe(true);
    expect(seen.auth.length).toBeGreaterThan(0);
    for (const header of seen.auth) expect(header).toBe(`Bearer ${KEY}`);
    await app.close();
  });

  it("never writes the key to a log line", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const { app, logs } = await bootWith({ ATOMIC_MAIL_API_KEY: KEY }, fakeAtomicMail(seen));
    await app.close();
    for (const line of logs) expect(line).not.toContain(KEY);
  });

  it("uses ATOMIC_MAIL_MCP_URL when it is set", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const url = "https://staging.example.test/mcp";
    const { app, logs } = await bootWith({ ATOMIC_MAIL_API_KEY: KEY, ATOMIC_MAIL_MCP_URL: url }, fakeAtomicMail(seen, { url }));
    expect(logs).toContain("atomicmail: 2 tools (me@atomicmail.ai)");
    expect(new Set(seen.urls)).toEqual(new Set([url]));
    await app.close();
  });

  it("boots anyway when the server rejects the key, and says so without the key", async () => {
    const seen: Seen = { urls: [], auth: [] };
    const { app, logs } = await bootWith({ ATOMIC_MAIL_API_KEY: KEY }, fakeAtomicMail(seen, { reject: true }));
    expect(logs.some((l) => l.startsWith("atomicmail unavailable"))).toBe(true);
    expect(logs.some((l) => l.startsWith("atomicmail:"))).toBe(false);
    for (const line of logs) expect(line).not.toContain(KEY);
    await app.close();
  });
});
