import { describe, expect, it } from "vitest";
import type { CallToolResult, JsonRpcMessage, Tool } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { AtomicMailBackend, DEFAULT_ATOMIC_MAIL_MCP_URL } from "../src/backend.js";

const KEY = "am_test_key_0123456789";

const LIST_AGENTS: Tool = { name: "list_agents", description: "List inboxes.", inputSchema: { type: "object", properties: {} } };
const READ_INBOX: Tool = { name: "read_inbox", description: "List recent messages.", inputSchema: { type: "object", properties: { agent_id: { type: "string" } } } };
const SEND_EMAIL: Tool = { name: "send_email", description: "Send.", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } };
const JMAP_REQUEST: Tool = { name: "jmap_request", description: "Raw JMAP.", inputSchema: { type: "object", properties: { ops: { type: "string" } } } };
const HOSTED = [LIST_AGENTS, READ_INBOX, SEND_EMAIL, JMAP_REQUEST];

interface FakeServer {
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  initializes: number;
}

/** A minimal MCP server on the server half of an in-memory pair. */
async function startFakeServer(
  tools: Tool[],
  onCall: (name: string, args: Record<string, unknown>) => CallToolResult,
): Promise<{ server: FakeServer; clientTransport: InMemoryTransport }> {
  const pair = createInMemoryTransportPair();
  const server: FakeServer = { calls: [], initializes: 0 };
  pair.server.onMessage((message: JsonRpcMessage) => {
    if (!("method" in message) || !("id" in message)) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const reply = (result: unknown) => void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        server.initializes += 1;
        reply({ protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-atomicmail", version: "0" } });
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
        server.calls.push({ name, args });
        reply(onCall(name, args));
        break;
      }
      default:
        void pair.server.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${message.method}` } });
    }
  });
  await pair.server.start();
  return { server, clientTransport: pair.client };
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function handler(agents: unknown[]) {
  return (name: string): CallToolResult => {
    if (name === "list_agents") return json({ agents });
    return { content: [{ type: "text", text: `called ${name}` }] };
  };
}

async function backendWith(onCall: (name: string, args: Record<string, unknown>) => CallToolResult, logs: string[] = []) {
  const { server, clientTransport } = await startFakeServer(HOSTED, onCall);
  const backend = new AtomicMailBackend({ apiKey: KEY, transportFactory: () => clientTransport, logger: (m) => logs.push(m) });
  return { backend, server };
}

describe("AtomicMailBackend", () => {
  it("needs an API key", () => {
    expect(() => new AtomicMailBackend({ apiKey: "   " })).toThrow(/API key/);
  });

  it("defaults to the hosted server and trims a trailing slash from an override", () => {
    expect(new AtomicMailBackend({ apiKey: KEY }).endpoint).toBe(DEFAULT_ATOMIC_MAIL_MCP_URL);
    expect(new AtomicMailBackend({ apiKey: KEY, url: "https://staging.example.test/mcp/" }).endpoint).toBe("https://staging.example.test/mcp");
  });

  it("describes itself without the key", () => {
    expect(new AtomicMailBackend({ apiKey: KEY }).describe()).not.toContain(KEY);
  });

  it("shares one handshake between concurrent callers", async () => {
    const { backend, server } = await backendWith(handler([]));
    await Promise.all([backend.connect(), backend.connect(), backend.listTools()]);
    expect(server.initializes).toBe(1);
    await backend.close();
  });

  it("registers only the tagged tools and logs what it left out", async () => {
    const logs: string[] = [];
    const { backend } = await backendWith(handler([]), logs);
    const tools = await backend.tools();
    expect(tools.map((t) => t.spec.name).sort()).toEqual(["atomicmail_read_inbox", "atomicmail_send_email"]);
    expect(logs.some((l) => l.includes("left out") && l.includes("jmap_request") && l.includes("list_agents"))).toBe(true);
    await backend.close();
  });

  it("calls through to the server with the arguments given", async () => {
    const { backend, server } = await backendWith(handler([]));
    const tools = await backend.tools();
    const send = tools.find((t) => t.spec.name === "atomicmail_send_email");
    await send?.spec.execute({ to: "a@x.io" }, { principal: { kind: "owner", id: "o", tier: "owner", displayName: "M" }, conversationKey: "c", channel: "chat", now: () => new Date() });
    expect(server.calls).toEqual([{ name: "send_email", args: { to: "a@x.io" } }]);
    await backend.close();
  });

  it("never writes the key to a log line", async () => {
    const logs: string[] = [];
    const { backend } = await backendWith(handler([{ email: "me@atomicmail.ai" }]), logs);
    await backend.tools();
    await backend.address();
    await backend.close();
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(KEY);
  });
});

describe("AtomicMailBackend.address", () => {
  it("returns the address when the server lists exactly one inbox", async () => {
    const { backend } = await backendWith(handler([{ accountId: "a1", inboxId: "me", email: "me@atomicmail.ai" }]));
    expect(await backend.address()).toBe("me@atomicmail.ai");
    await backend.close();
  });

  it("returns nothing when there are several inboxes, rather than guess", async () => {
    const { backend } = await backendWith(handler([{ email: "a@atomicmail.ai" }, { email: "b@atomicmail.ai" }]));
    expect(await backend.address()).toBeUndefined();
    await backend.close();
  });

  it("returns nothing when there is no inbox or the email is not an address", async () => {
    expect(await (await backendWith(handler([]))).backend.address()).toBeUndefined();
    expect(await (await backendWith(handler([{ email: "not-an-address" }]))).backend.address()).toBeUndefined();
  });

  it("returns nothing when the server answers with an error", async () => {
    const { backend } = await backendWith(() => ({ content: [{ type: "text", text: "boom" }], isError: true }));
    expect(await backend.address()).toBeUndefined();
    await backend.close();
  });

  it("returns nothing when the answer is not JSON, and logs without the key", async () => {
    const logs: string[] = [];
    const { backend } = await backendWith(() => ({ content: [{ type: "text", text: "plain words" }] }), logs);
    expect(await backend.address()).toBeUndefined();
    expect(logs.some((l) => l.includes("could not read the inbox address"))).toBe(true);
    await backend.close();
  });
});

describe("AtomicMailBackend over HTTP", () => {
  it("sends the API key as a Bearer header on every request", async () => {
    const auth: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      auth.push(new Headers(init?.headers).get("authorization") ?? "");
      const body = JSON.parse(String(init?.body)) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.method === "initialize"
          ? { protocolVersion: body.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } }
          : { tools: [READ_INBOX] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const backend = new AtomicMailBackend({ apiKey: KEY, fetchImpl });
    const tools = await backend.tools();
    expect(tools.map((t) => t.spec.name)).toEqual(["atomicmail_read_inbox"]);
    expect(auth.length).toBeGreaterThan(1);
    for (const header of auth) expect(header).toBe(`Bearer ${KEY}`);
    await backend.close();
  });
});
