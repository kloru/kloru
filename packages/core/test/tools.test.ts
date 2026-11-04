import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ToolRegistry, defineTool, textResult, toAgentToolResult, type ToolContext } from "../src/tools.js";
import { principalOf } from "./helpers.js";

const ctx: ToolContext = { principal: principalOf("owner"), conversationKey: "chat:t", channel: "chat", now: () => new Date("2026-10-03T12:00:00Z") };

describe("defineTool", () => {
  it("rejects names Pi would refuse", () => {
    expect(() =>
      defineTool({ name: "bad name!", label: "x", description: "x", parameters: Type.Object({}), meta: { capabilities: [], group: "system" }, execute: async () => "" }),
    ).toThrow(/Invalid tool name/);
    expect(() =>
      defineTool({ name: "a".repeat(65), label: "x", description: "x", parameters: Type.Object({}), meta: { capabilities: [], group: "system" }, execute: async () => "" }),
    ).toThrow(/Invalid tool name/);
  });
});

describe("toAgentToolResult", () => {
  it("turns a string into exactly one text block", () => {
    expect(toAgentToolResult("hello")).toEqual({ content: [{ type: "text", text: "hello" }], details: undefined });
    expect(toAgentToolResult("").content).toHaveLength(1);
  });

  it("passes blocks, details and isError through", () => {
    const r = toAgentToolResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], details: { n: 1 }, isError: true });
    expect(r.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(r.details).toEqual({ n: 1 });
    expect(r.isError).toBe(true);
  });

  it("never returns an empty content array", () => {
    expect(toAgentToolResult({ content: [] }).content).toEqual([{ type: "text", text: "" }]);
  });
});

describe("ToolRegistry", () => {
  const echo = defineTool({
    name: "echo",
    label: "Echo",
    description: "echo",
    parameters: Type.Object({ text: Type.String() }),
    meta: { capabilities: ["converse"], group: "system" },
    execute: async ({ text }, c) => textResult(`${c.principal.displayName}:${text}`),
  });
  const secret = defineTool({
    name: "secret",
    label: "Secret",
    description: "owner only",
    parameters: Type.Object({}),
    meta: { capabilities: ["computer.use"], group: "computer" },
    execute: async () => ({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], details: { ok: true } }),
  });

  it("registers, lists, looks up and exposes meta", () => {
    const reg = new ToolRegistry();
    reg.registerMany([echo, secret]);
    expect(reg.all().map((t) => t.spec.name).sort()).toEqual(["echo", "secret"]);
    expect(reg.get("echo")).toBe(echo);
    expect(reg.meta("secret")?.capabilities).toEqual(["computer.use"]);
    expect(reg.meta("nope")).toBeUndefined();
  });

  it("later registrations replace earlier ones with the same name", () => {
    const reg = new ToolRegistry();
    reg.register(echo);
    const echo2 = defineTool({ ...echo.spec, description: "replaced" });
    reg.register(echo2);
    expect(reg.all()).toHaveLength(1);
    expect(reg.get("echo")?.spec.description).toBe("replaced");
  });

  it("binds Pi AgentTools that call execute with the context and normalise results", async () => {
    const reg = new ToolRegistry();
    reg.registerMany([echo, secret]);
    const tools = reg.bind(ctx);
    expect(tools.map((t) => t.name).sort()).toEqual(["echo", "secret"]);
    const bound = tools.find((t) => t.name === "echo")!;
    expect(bound.label).toBe("Echo");
    expect(bound.parameters).toBe(echo.spec.parameters);
    const result = await bound.execute("call-1", { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "Maria:hi" }]);

    const multi = await tools.find((t) => t.name === "secret")!.execute("call-2", {});
    expect(multi.content).toHaveLength(2);
    expect(multi.details).toEqual({ ok: true });
  });

  it("applies the visibility filter", () => {
    const reg = new ToolRegistry();
    reg.registerMany([echo, secret]);
    const visible = reg.bind(ctx, (t) => !t.spec.meta.capabilities.includes("computer.use"));
    expect(visible.map((t) => t.name)).toEqual(["echo"]);
  });

  it("lets thrown errors propagate so Pi marks the result as an error", async () => {
    const reg = new ToolRegistry();
    reg.register(
      defineTool({ name: "boom", label: "Boom", description: "x", parameters: Type.Object({}), meta: { capabilities: [], group: "system" }, execute: async () => { throw new Error("kaboom"); } }),
    );
    await expect(reg.bind(ctx)[0]!.execute("c", {})).rejects.toThrow("kaboom");
  });
});
