import { defineTool, wrapUntrusted } from "@kloru/core";
import type { RegisteredTool, ToolMeta, ToolResultLike } from "@kloru/core";
import { McpHttpError, toLlmContent } from "@earendil-works/pi-mcp";
import type { CallToolResult, Tool as McpTool } from "@earendil-works/pi-mcp";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { READ_TOOLS, capabilitiesFor, isSupportedTool } from "./capabilities.js";

/** The slice of an MCP client this package needs. Narrow so tests can stub it. */
export interface McpToolSource {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
}

export const TOOL_NAME_PREFIX = "atomicmail_";
/** Label inside the `<untrusted>` wrapper around mail the model reads. */
export const INBOX_LABEL = "Atomic Mail inbox";

/** `read_inbox` becomes `atomicmail_read_inbox`. The prefix keeps it clear of the Inkbox and app tools. */
export function toolNameFor(tool: string): string {
  return (TOOL_NAME_PREFIX + tool.toLowerCase().replace(/[^a-z0-9_-]/g, "_")).slice(0, 64);
}

/**
 * The model never picks an inbox. The API key is bound to one inbox, and letting the model
 * pass `agent_id` would let a prompt injection aim a send at another inbox on the account.
 */
const HIDDEN_ARGS = ["agent_id"] as const;

/** JSON Schema from MCP as a TypeBox schema, without the arguments the model may not set. */
export function parametersFor(inputSchema: Record<string, unknown>): TSchema {
  const properties = { ...((inputSchema.properties as Record<string, unknown> | undefined) ?? {}) };
  for (const key of HIDDEN_ARGS) delete properties[key];
  const required = Array.isArray(inputSchema.required)
    ? (inputSchema.required as unknown[]).filter((k) => typeof k === "string" && !(HIDDEN_ARGS as readonly string[]).includes(k))
    : undefined;
  return Type.Unsafe({ ...inputSchema, type: "object", properties, ...(required ? { required } : {}) });
}

function withoutHiddenArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(args) ? { ...args } : {};
  for (const key of HIDDEN_ARGS) delete out[key];
  return out;
}

/** Short description of a call for the audit log. It never carries a message body. */
export function describeCall(tool: string, args: unknown): string {
  const a = isRecord(args) ? args : {};
  switch (tool) {
    case "send_email":
      return `send_email to ${clip(recipients(a.to), 80)}: ${clip(a.subject, 60)}`;
    case "reply_to_message":
    case "read_message":
      return `${tool} ${clip(a.message_id, 40)}`;
    case "search_messages":
      return `search_messages ${clip(a.query, 60)}`;
    case "read_inbox":
      return typeof a.limit === "number" ? `read_inbox limit ${a.limit}` : "read_inbox";
    default:
      return tool;
  }
}

export function metaFor(tool: string): ToolMeta {
  return {
    capabilities: capabilitiesFor(tool),
    group: "apps",
    describe: (args) => describeCall(tool, args),
  };
}

/** Plain sentences for the failures a deployer can fix. Never includes the key. */
export function explainError(tool: string, err: unknown): string {
  if (err instanceof McpHttpError) {
    if (err.status === 401) {
      return "Atomic Mail rejected the API key. It is wrong, revoked, or its inbox is not active. The person running this agent must check ATOMIC_MAIL_API_KEY.";
    }
    if (err.status === 403) {
      return `Atomic Mail refused ${tool}: the key lacks the permission it needs. Sending needs the mail.send scope.`;
    }
    return `Atomic Mail answered HTTP ${err.status} to ${tool}.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Atomic Mail call ${tool} failed: ${message}`;
}

function errorResult(message: string): ToolResultLike {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Mail the model reads was written by other people, so it goes in the untrusted wrapper. */
function toToolResult(tool: string, result: CallToolResult): ToolResultLike {
  const content = toLlmContent(result);
  if (result.isError === true || !READ_TOOLS.has(tool)) {
    return { content, details: result.structuredContent, isError: result.isError === true };
  }
  const text = content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return {
    content: [{ type: "text", text: wrapUntrusted(text || "(nothing found)", INBOX_LABEL) }],
    details: result.structuredContent,
    isError: false,
  };
}

/** Wrap one hosted tool as an Kloru tool. The tool must be in the capability table. */
export function wrapMcpTool(source: McpToolSource, tool: McpTool): RegisteredTool {
  return defineTool({
    name: toolNameFor(tool.name),
    label: tool.title ?? tool.name,
    description: tool.description ?? tool.name,
    parameters: parametersFor(tool.inputSchema),
    meta: metaFor(tool.name),
    execute: async (args, _ctx, signal): Promise<ToolResultLike> => {
      try {
        const result = await source.callTool(tool.name, withoutHiddenArgs(args), { signal });
        return toToolResult(tool.name, result);
      } catch (err) {
        return errorResult(explainError(tool.name, err));
      }
    },
  });
}

/** Wrap every listed tool that has a capability tag. The rest are reported, not registered. */
export async function wrapMcpTools(source: McpToolSource): Promise<{ tools: RegisteredTool[]; skipped: string[] }> {
  const listed = await source.listTools();
  const tools: RegisteredTool[] = [];
  const skipped: string[] = [];
  for (const tool of listed) {
    if (!isSupportedTool(tool.name)) {
      skipped.push(tool.name);
      continue;
    }
    tools.push(wrapMcpTool(source, tool));
  }
  return { tools, skipped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recipients(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string").join(", ");
  return "";
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
