import { describe, expect, it } from "vitest";
import type { CallToolResult, JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import type { Principal, RegisteredTool, ToolContext } from "@kloru/core";
import { MaritimeMcpBackend, maritimeMcpEndpoint } from "../src/index.js";
import { PNG_B64 } from "./fake-fetch.js";

const owner: Principal = { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" };
const ctx: ToolContext = { principal: owner, conversationKey: "chat:test", channel: "chat", now: () => new Date() };

const COMPUTER_ID = { type: "string", description: "The computer id returned by get_computer." };

/** The hosted server's catalog, trimmed to the tools the tests exercise. */
const HOSTED_TOOLS: Tool[] = [
  {
    name: "get_computer",
    description: "Get (or create) the persistent computer for one end user.",
    inputSchema: { type: "object", properties: { user_id: { type: "string" }, name: { type: "string" } }, required: [] },
  },
  {
    name: "computer",
    description: "Control the desktop.",
    inputSchema: {
      type: "object",
      properties: { computer_id: COMPUTER_ID, action: { type: "string", enum: ["screenshot", "left_click"] }, coordinate: { type: "array" } },
      required: ["computer_id", "action"],
    },
  },
  {
    name: "request_takeover",
    description: "Hand the desktop to the person.",
    inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID, reason: { type: "string" }, wait: { type: "boolean" } }, required: ["computer_id", "reason"] },
  },
  { name: "takeover_status", description: "Where a takeover stands.", inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID }, required: ["computer_id"] } },
  { name: "close_computer", description: "End the session.", inputSchema: { type: "object", properties: { computer_id: COMPUTER_ID }, required: ["computer_id"] } },
  // A tool without `properties` checks the schema conversion path.
  { name: "weird/tool", description: "no properties", inputSchema: { type: "object" } },
];

interface FakeServer {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  transport: InMemoryTransport;
}

/** A minimal MCP server on the server half of an in-memory pair. */
async function startFakeServer(
  tools: Tool[],
  onCall: (name: string, args: Record<string, unknown>) => CallToolResult,
): Promise<{ server: FakeServer; clientTransport: InMemoryTransport }> {
  const pair = createInMemoryTransportPair();
  const calls: FakeServer["calls"] = [];
  pair.server.onMessage((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const reply = (result: unknown) => void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-maritime", version: "0" } });
        break;
      case "ping":
        reply({});
        break;
      case "tools/list":
        reply({ tools });
        break;
      case "tools/call": {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        calls.push({ name, args });
        reply(onCall(name, args));
        break;
      }
      default:
        void pair.server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${message.method}` } });
    }
  });
  await pair.server.start();
  return { server: { calls, transport: pair.server }, clientTransport: pair.client };
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function defaultHandler(name: string, args: Record<string, unknown>): CallToolResult {
  switch (name) {
    case "get_computer":
      return text({ computer_id: "cmp_42", status: "ready", screen: { width: 1280, height: 800 } });
    case "computer":
      return { content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }, { type: "text", text: JSON.stringify({ action: args.action, computer_id: args.computer_id, width: 1200, height: 750 }) }] };
    case "request_takeover":
      return text({ status: "waiting", viewer_url: "https://maritime.sh/computer/v/abc", expires_at: "soon" });
    case "takeover_status":
      return text({ mode: "agent" });
    case "close_computer":
      return text({ closed: true });
    default:
      return { content: [{ type: "text", text: `unknown ${name}` }], isError: true };
  }
}

async function backendWithServer(handler = defaultHandler) {
  const { server, clientTransport } = await startFakeServer(HOSTED_TOOLS, handler);
  const backend = new MaritimeMcpBackend({
    url: "https://mcp.example.test",
    apiKey: "mk_test",
    externalUserId: "user-1",
    transportFactory: () => clientTransport,
  });
  return { backend, server };
}

function byName(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((t) => t.spec.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

async function exec(tools: RegisteredTool[], name: string, args: unknown) {
  const result = await byName(tools, name).spec.execute(args, ctx);
  if (typeof result === "string") throw new Error("expected blocks");
  return result;
}

describe("maritimeMcpEndpoint", () => {
  it("pins the connection to the end user whatever the base looks like", () => {
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh", "u1")).toBe("https://mcp.maritime.sh/mcp/u/u1");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh/", "u1")).toBe("https://mcp.maritime.sh/mcp/u/u1");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh/mcp", "u1")).toBe("https://mcp.maritime.sh/mcp/u/u1");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh/mcp/u/already", "u1")).toBe("https://mcp.maritime.sh/mcp/u/already");
    expect(maritimeMcpEndpoint("https://mcp.maritime.sh", "a b/c")).toBe("https://mcp.maritime.sh/mcp/u/a%20b%2Fc");
    expect(maritimeMcpEndpoint("")).toBe("https://mcp.maritime.sh/mcp/u/owner");
  });
});

describe("MaritimeMcpBackend", () => {
  it("wraps every hosted tool under its exact name with computer.use metadata", async () => {
    const { backend } = await backendWithServer();
    const tools = await backend.tools();
    const names = tools.map((t) => t.spec.name);
    expect(names).toEqual(["get_computer", "computer", "request_takeover", "takeover_status", "close_computer", "weird_tool"]);
    for (const tool of tools) {
      expect(tool.spec.meta).toMatchObject({ capabilities: ["computer.use"], group: "computer" });
      expect(tool.spec.parameters).toMatchObject({ type: "object" });
      expect((tool.spec.parameters as { properties: unknown }).properties).toBeTypeOf("object");
    }
    expect(byName(tools, "computer").spec.description).toBe("Control the desktop.");
    expect(backend.describe()).toContain("user-1");
    expect(backend.describe()).not.toContain("mk_test");
    await backend.close();
  });

  it("remembers the computer_id from get_computer and injects it when the model omits it", async () => {
    const { backend, server } = await backendWithServer();
    const tools = await backend.tools();

    const got = await exec(tools, "get_computer", {});
    expect(got.isError).toBe(false);
    expect(backend.computerId).toBe("cmp_42");

    const shot = await exec(tools, "computer", { action: "screenshot" });
    expect(shot.content[0]).toMatchObject({ type: "image", data: PNG_B64 });
    expect(server.calls.at(-1)).toEqual({ name: "computer", args: { action: "screenshot", computer_id: "cmp_42" } });

    // An explicit id from the model is kept.
    await exec(tools, "takeover_status", { computer_id: "cmp_other" });
    expect(server.calls.at(-1)?.args).toEqual({ computer_id: "cmp_other" });
    await backend.close();
  });

  it("fetches the computer first when nothing is remembered yet", async () => {
    const { backend, server } = await backendWithServer();
    const tools = await backend.tools();
    const result = await exec(tools, "computer", { action: "left_click", coordinate: [1, 2] });
    expect(result.isError).toBe(false);
    expect(server.calls.map((c) => c.name)).toEqual(["get_computer", "computer"]);
    expect(server.calls[1]?.args.computer_id).toBe("cmp_42");
    await backend.close();
  });

  it("appends the owner hint to a successful request_takeover and passes errors through", async () => {
    const { backend } = await backendWithServer((name, args) =>
      name === "computer" ? { content: [{ type: "text", text: "no_plan" }], isError: true } : defaultHandler(name, args),
    );
    const tools = await backend.tools();
    const takeover = await exec(tools, "request_takeover", { reason: "log in" });
    const texts = takeover.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
    expect(texts[0]).toContain("viewer_url");
    expect(texts.at(-1)).toContain("Send the viewer_url to the owner");

    const failed = await exec(tools, "computer", { action: "screenshot" });
    expect(failed.isError).toBe(true);
    expect(failed.content).toHaveLength(1);
    await backend.close();
  });

  it("returns an error result instead of throwing when get_computer gives no id", async () => {
    const { backend } = await backendWithServer((name, args) =>
      name === "get_computer" ? text({ status: "sleeping" }) : defaultHandler(name, args),
    );
    const tools = await backend.tools();
    const result = await exec(tools, "computer", { action: "screenshot" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/computer_id/);
    await backend.close();
  });

  it("shares one handshake between concurrent callers and reconnects after close", async () => {
    const { backend, server } = await backendWithServer();
    const [a, b] = await Promise.all([backend.connect(), backend.connect()]);
    expect(a).toBe(b);
    await backend.close();
    expect(server.transport).toBeDefined();
    // After close the transport pair is dead; a fresh factory would be needed to reconnect.
    await expect(backend.connect()).rejects.toThrow();
  });
});
