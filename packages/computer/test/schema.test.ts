import { describe, expect, it } from "vitest";
import {
  ACTION_ENUM,
  ComputerActionSchema,
  computerGuidance,
  desktopdResultToContent,
  findStringField,
  isDesktopdError,
  mcpSchemaToTypeBox,
  sanitizeToolName,
  schemaHasProperty,
  stableJson,
} from "../src/index.js";
import { PNG_B64 } from "./fake-fetch.js";

describe("schemas", () => {
  it("mirrors Maritime's computer tool: action enum and plain JSON Schema coordinates", () => {
    const schema = ComputerActionSchema as unknown as { type: string; required: string[]; properties: Record<string, Record<string, unknown>> };
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action?.enum).toEqual([...ACTION_ENUM]);
    expect(ACTION_ENUM).toContain("left_click_drag");
    expect(ACTION_ENUM).toContain("zoom");
    expect(ACTION_ENUM).toHaveLength(17);
    expect(schema.properties.coordinate).toMatchObject({ type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 });
    expect(schema.properties.region).toMatchObject({ type: "array", minItems: 4, maxItems: 4 });
    expect(schema.properties.scroll_direction?.enum).toEqual(["up", "down", "left", "right"]);
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["action", "coordinate", "duration", "key", "modifier", "no_screenshot", "region", "repeat", "scroll_amount", "scroll_direction", "start_coordinate", "text"].sort(),
    );
  });

  it("converts MCP input schemas into provider-safe object schemas", () => {
    const converted = mcpSchemaToTypeBox({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }) as Record<string, unknown>;
    expect(converted).toMatchObject({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });

    const bare = mcpSchemaToTypeBox({ type: "object" }) as Record<string, unknown>;
    expect(bare.properties).toEqual({});

    const missing = mcpSchemaToTypeBox(undefined) as Record<string, unknown>;
    expect(missing).toMatchObject({ type: "object", properties: {} });

    const wrongType = mcpSchemaToTypeBox({ type: "string", properties: "nope" }) as Record<string, unknown>;
    expect(wrongType.type).toBe("object");
    expect(wrongType.properties).toEqual({});
  });

  it("detects properties and sanitizes tool names", () => {
    expect(schemaHasProperty({ properties: { computer_id: {} } }, "computer_id")).toBe(true);
    expect(schemaHasProperty({ properties: {} }, "computer_id")).toBe(false);
    expect(schemaHasProperty(undefined, "computer_id")).toBe(false);
    expect(sanitizeToolName("get_computer")).toBe("get_computer");
    expect(sanitizeToolName("weird/tool name")).toBe("weird_tool_name");
    expect(sanitizeToolName("x".repeat(80))).toHaveLength(64);
    expect(sanitizeToolName("")).toBe("tool");
  });
});

describe("result helpers", () => {
  it("lifts images out of desktopd results and sorts the remaining keys", () => {
    const blocks = desktopdResultToContent({ width: 1200, image_b64: PNG_B64, action: "zoom", mime: "image/png", height: 750 });
    expect(blocks).toEqual([
      { type: "image", data: PNG_B64, mimeType: "image/png" },
      { type: "text", text: '{"action":"zoom","height":750,"width":1200}' },
    ]);
    expect(desktopdResultToContent({ blocked: true, mode: "human" })).toEqual([{ type: "text", text: '{"blocked":true,"mode":"human"}' }]);
  });

  it("recognizes desktopd errors in both spellings", () => {
    expect(isDesktopdError({ error: "x" })).toBe(true);
    expect(isDesktopdError({ is_error: true })).toBe(true);
    expect(isDesktopdError({ error: "" })).toBe(false);
    expect(isDesktopdError({ ok: true })).toBe(false);
  });

  it("finds string fields in text blocks and structured content", () => {
    expect(findStringField({ content: [{ type: "text", text: "not json" }, { type: "text", text: '{"computer_id":"cmp_1"}' }] }, "computer_id")).toBe("cmp_1");
    expect(findStringField({ content: [], structuredContent: { computer_id: "cmp_2" } }, "computer_id")).toBe("cmp_2");
    expect(findStringField({ content: [{ type: "text", text: '{"computer_id":7}' }] }, "computer_id")).toBeUndefined();
    expect(stableJson({ b: [{ z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
  });
});

describe("computerGuidance", () => {
  it("names the loop, the frame width and the takeover triggers", () => {
    const text = computerGuidance();
    expect(text).toContain("1200");
    expect(text).toMatch(/screenshot/i);
    expect(text).toContain("request_takeover");
    expect(text).toMatch(/CAPTCHA/);
    expect(text).toMatch(/2FA/);
    expect(text).not.toContain("—");
  });
});
