/**
 * Convert desktopd and MCP results into the content blocks the model reads.
 *
 * desktopd returns one JSON object per action with the screenshot inline as `image_b64`.
 * The model wants the image as an image block and the rest as text, so the picture is
 * lifted out and the remaining fields are serialized with sorted keys (stable for tests
 * and for the audit log).
 */
import { toLlmContent, type CallToolResult } from "@earendil-works/pi-mcp";
import type { ToolResultLike } from "@kloru/core";

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type DesktopdResult = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON with keys sorted at every level. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
  return out;
}

function mimeOf(result: DesktopdResult): string {
  const mime = result.mime;
  if (typeof mime === "string" && mime.startsWith("image/")) return mime;
  return result.format === "jpeg" ? "image/jpeg" : "image/png";
}

/** desktopd marks failures with `error` (a string) and usually `is_error: true`. */
export function isDesktopdError(result: DesktopdResult): boolean {
  return result.is_error === true || (typeof result.error === "string" && result.error.length > 0);
}

/** Split one desktopd result into image blocks plus one text block with everything else. */
export function desktopdResultToContent(result: DesktopdResult, prefix = ""): ContentBlock[] {
  const rest: DesktopdResult = { ...result };
  const blocks: ContentBlock[] = [];
  const image = rest.image_b64;
  delete rest.image_b64;
  delete rest.mime;
  if (typeof image === "string" && image.length > 0) {
    blocks.push({ type: "image", data: image, mimeType: mimeOf(result) });
  }
  // Takeover completion nests a fresh screenshot under `screenshot`.
  const shot = rest.screenshot;
  if (isRecord(shot) && typeof shot.image_b64 === "string" && shot.image_b64.length > 0) {
    blocks.push({ type: "image", data: shot.image_b64, mimeType: mimeOf(shot) });
    const shotRest = { ...shot };
    delete shotRest.image_b64;
    delete shotRest.mime;
    rest.screenshot = shotRest;
  }
  blocks.push({ type: "text", text: prefix + stableJson(rest) });
  return blocks;
}

export function desktopdToolResult(result: DesktopdResult, extraText?: string): ToolResultLike {
  const content = desktopdResultToContent(result);
  if (extraText) content.push({ type: "text", text: extraText });
  return { content, isError: isDesktopdError(result) };
}

/** `/batch` answers `{results:[...]}`; each entry's text is prefixed `[i]` like Maritime's MCP server. */
export function desktopdBatchToolResult(response: DesktopdResult): ToolResultLike {
  const results = response.results;
  if (!Array.isArray(results)) return { content: desktopdResultToContent(response), isError: true };
  const content: ContentBlock[] = [];
  let anyError = false;
  results.forEach((item, index) => {
    const entry = isRecord(item) ? item : { value: item };
    anyError = anyError || isDesktopdError(entry);
    content.push(...desktopdResultToContent(entry, `[${index}] `));
  });
  return { content, isError: anyError };
}

/** An MCP CallToolResult as the core ToolResultLike, optionally with a trailing hint for the model. */
export function mcpResultToToolResult(result: CallToolResult, extraText?: string): ToolResultLike {
  const content: ContentBlock[] = toLlmContent(result);
  if (extraText) content.push({ type: "text", text: extraText });
  return { content, isError: result.isError === true };
}

export function errorResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }], isError: true };
}

/** Find a string field in a tool result: text blocks that parse as JSON, then structuredContent. */
export function findStringField(result: CallToolResult, field: string): string | undefined {
  const fromStructured = result.structuredContent?.[field];
  if (typeof fromStructured === "string") return fromStructured;
  for (const block of result.content) {
    if (block.type !== "text") continue;
    const parsed = tryParseJson(block.text);
    if (isRecord(parsed) && typeof parsed[field] === "string") return parsed[field];
  }
  return undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
