import { describe, expect, it, vi } from "vitest";
import type { CallToolResult, Tool } from "@earendil-works/pi-mcp";
import { describeCall, parametersFor, toolNameFor, wrapMcpTool, wrapMcpTools, type McpToolSource } from "../src/wrap.js";

const ctx = { principal: { kind: "owner", id: "owner", tier: "owner", displayName: "Maria" }, conversationKey: "chat:1", channel: "chat", now: () => new Date() } as const;

function stubSource(tools: Tool[], result: CallToolResult = { content: [{ type: "text", text: "ok" }] }): McpToolSource & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    listTools: async () => tools,
    callTool: async (name, args) => {
      calls.push([name, args]);
      return result;
    },
    close: async () => undefined,
  };
}

const gmailSend: Tool = {
  name: "GMAIL_SEND_EMAIL",
  description: "Send an email",
  inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to"] },
};

describe("toolNameFor", () => {
  it("prefixes, lowercases and sanitizes", () => {
    expect(toolNameFor("GMAIL_SEND_EMAIL")).toBe("app_gmail_send_email");
    expect(toolNameFor("Weird.Tool/Name")).toBe("app_weird_tool_name");
  });
  it("clips to 64 characters", () => {
    const long = "A".repeat(100);
    const name = toolNameFor(long);
    expect(name).toHaveLength(64);
    expect(name.startsWith("app_")).toBe(true);
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

describe("parametersFor", () => {
  it("forces an object schema with properties", () => {
    const schema = parametersFor({}) as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({});
  });
  it("keeps the original properties and required list", () => {
    const schema = parametersFor(gmailSend.inputSchema) as Record<string, unknown>;
    expect(schema.required).toEqual(["to"]);
    expect(Object.keys(schema.properties as object)).toEqual(["to", "body"]);
  });
});

describe("describeCall", () => {
  it("includes slug and args, clipped", () => {
    expect(describeCall("GMAIL_SEND_EMAIL", { to: "a@b.c" })).toBe('GMAIL_SEND_EMAIL {"to":"a@b.c"}');
    const long = describeCall("X", { body: "y".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(165);
    expect(long.endsWith("...")).toBe(true);
  });
  it("survives unserializable args", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeCall("X", circular)).toBe("X [unserializable]");
  });
});

describe("wrapMcpTool", () => {
  it("builds a RegisteredTool with capability meta and group apps", () => {
    const tool = wrapMcpTool(stubSource([gmailSend]), gmailSend);
    expect(tool.spec.name).toBe("app_gmail_send_email");
    expect(tool.spec.label).toBe("GMAIL_SEND_EMAIL");
    expect(tool.spec.description).toBe("Send an email");
    expect(tool.spec.meta.group).toBe("apps");
    expect(tool.spec.meta.capabilities).toEqual(["email.send"]);
    expect(tool.spec.meta.describe?.({ to: "x" })).toBe('GMAIL_SEND_EMAIL {"to":"x"}');
  });

  it("prefers the MCP title as label and falls back to the slug for description", () => {
    const t: Tool = { name: "GOOGLECALENDAR_FIND_FREE_SLOTS", title: "Find free slots", inputSchema: {} };
    const tool = wrapMcpTool(stubSource([t]), t);
    expect(tool.spec.label).toBe("Find free slots");
    expect(tool.spec.description).toBe("GOOGLECALENDAR_FIND_FREE_SLOTS");
    expect(tool.spec.meta.capabilities).toEqual(["calendar.freebusy"]);
  });

  it("warns about COMPOSIO_MULTI_EXECUTE_TOOL in its description", () => {
    const t: Tool = { name: "COMPOSIO_MULTI_EXECUTE_TOOL", description: "Run tools", inputSchema: {} };
    const tool = wrapMcpTool(stubSource([t]), t);
    expect(tool.spec.description).toContain("Run tools");
    expect(tool.spec.description).toContain("cannot check them one by one");
    expect(tool.spec.meta.capabilities).toEqual(["apps.use", "trust.manage"]);
  });

  it("calls the MCP tool by its original slug and converts the result", async () => {
    const source = stubSource([gmailSend], {
      content: [{ type: "text", text: "sent" }, { type: "image", data: "AAA=", mimeType: "image/png" }],
      structuredContent: { id: "m1" },
    });
    const tool = wrapMcpTool(source, gmailSend);
    const signal = new AbortController().signal;
    const result = await tool.spec.execute({ to: "a@b.c" }, ctx as never, signal);
    expect(source.calls).toEqual([["GMAIL_SEND_EMAIL", { to: "a@b.c" }]]);
    expect(result).toEqual({
      content: [{ type: "text", text: "sent" }, { type: "image", data: "AAA=", mimeType: "image/png" }],
      details: { id: "m1" },
      isError: false,
    });
  });

  it("passes the abort signal through", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const source: McpToolSource = { listTools: async () => [], callTool, close: async () => undefined };
    const tool = wrapMcpTool(source, gmailSend);
    const signal = new AbortController().signal;
    await tool.spec.execute({}, ctx as never, signal);
    expect(callTool).toHaveBeenCalledWith("GMAIL_SEND_EMAIL", {}, { signal });
  });

  it("marks MCP tool failures as isError without throwing", async () => {
    const source = stubSource([gmailSend], { content: [{ type: "text", text: "boom" }], isError: true });
    const tool = wrapMcpTool(source, gmailSend);
    const result = await tool.spec.execute({ to: "x" }, ctx as never);
    expect(typeof result).toBe("object");
    if (typeof result === "string") throw new Error("unexpected string");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "boom" }]);
  });

  it("renders structuredContent as text when the server sends no content blocks", async () => {
    const source = stubSource([gmailSend], { content: [], structuredContent: { ok: true } });
    const tool = wrapMcpTool(source, gmailSend);
    const result = await tool.spec.execute({}, ctx as never);
    if (typeof result === "string") throw new Error("unexpected string");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toContain('"ok"');
  });

  it("propagates transport errors as rejections", async () => {
    const source: McpToolSource = {
      listTools: async () => [],
      callTool: async () => {
        throw new Error("connection closed");
      },
      close: async () => undefined,
    };
    const tool = wrapMcpTool(source, gmailSend);
    await expect(tool.spec.execute({}, ctx as never)).rejects.toThrow("connection closed");
  });
});

describe("wrapMcpTools", () => {
  it("wraps every listed tool and drops names that collide after clipping", async () => {
    const a: Tool = { name: "X".repeat(70) + "A", inputSchema: {} };
    const b: Tool = { name: "X".repeat(70) + "B", inputSchema: {} };
    const tools = await wrapMcpTools(stubSource([gmailSend, a, b]));
    expect(tools.map((t) => t.spec.name)).toEqual(["app_gmail_send_email", toolNameFor(a.name)]);
  });
});
