import type { TSchema } from "typebox";
import type { RegisteredTool, ToolResultLike, ToolSpec } from "@kloru/core";

/**
 * Same shapes as core's defineTool and textResult. Kept local so this package depends on core
 * for types only; its tests then run whether or not core is built.
 */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function defineTool<T extends TSchema>(spec: ToolSpec<T>): RegisteredTool {
  if (!TOOL_NAME.test(spec.name)) throw new Error(`Invalid tool name "${spec.name}"`);
  return { spec };
}

export function textResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}
