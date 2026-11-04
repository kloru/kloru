import { innerCalls } from "./writes.js";
import type { Capability, RegisteredTool, ToolContext, ToolMeta, ToolResultLike, ToolSpec } from "@kloru/core";
import { toLlmContent, type CallToolResult, type Tool as McpTool } from "@earendil-works/pi-mcp";
import { Type, type TSchema } from "typebox";
import { capabilitiesForSlug } from "./capabilities.js";

/** The slice of pi-mcp's McpClient this package needs. Narrow so tests can stub it. */
export interface McpToolSource {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args?: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export const TOOL_NAME_PREFIX = "app_";
const MAX_TOOL_NAME = 64;

/** Providers accept `[A-Za-z0-9_-]{1,64}`. Composio slugs are upper snake case; we lower them. */
export function toolNameFor(slug: string): string {
  const base = slug.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return (TOOL_NAME_PREFIX + base).slice(0, MAX_TOOL_NAME);
}

/** Short description of a call for the audit log. Never includes bodies longer than a line. */
export function describeCall(slug: string, args: unknown): string {
  const text = safeJson(args);
  return text.length > 160 ? `${slug} ${text.slice(0, 157)}...` : `${slug} ${text}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

/** JSON Schema from MCP as a TypeBox schema. Providers want an object with `properties`. */
export function parametersFor(inputSchema: Record<string, unknown>): TSchema {
  const properties = (inputSchema.properties as Record<string, unknown> | undefined) ?? {};
  return Type.Unsafe({ ...inputSchema, type: "object", properties });
}

export function metaFor(slug: string, capabilities: Capability[] = capabilitiesForSlug(slug)): ToolMeta {
  return {
    capabilities,
    group: "apps",
    describe: (args) => describeCall(slug, args),
    // A batch needs what each call in it needs; one it can't read stays owner-only.
    ...(slug.toUpperCase() === "COMPOSIO_MULTI_EXECUTE_TOOL"
      ? {
          capabilitiesFor: (args: unknown) => {
            const calls = innerCalls(`app_${slug.toLowerCase()}`, args);
            return calls?.length ? [...new Set<Capability>(["apps.use", ...calls.flatMap((c) => capabilitiesForSlug(c.slug))])] : undefined;
          },
        }
      : {}),
  };
}

const MULTI_EXECUTE_NOTE =
  " Runs several Composio tools in one call, so the policy guard cannot check them one by one. Prefer the direct app_ tools.";

/** Wrap one MCP tool as an Kloru RegisteredTool. */
export function wrapMcpTool(source: McpToolSource, tool: McpTool): RegisteredTool {
  const slug = tool.name;
  const upper = slug.toUpperCase();
  const description = (tool.description ?? slug) + (upper === "COMPOSIO_MULTI_EXECUTE_TOOL" ? MULTI_EXECUTE_NOTE : "");

  const spec: ToolSpec<TSchema> = {
    name: toolNameFor(slug),
    label: tool.title ?? slug,
    description,
    parameters: parametersFor(tool.inputSchema),
    meta: metaFor(upper),
    execute: async (args, _ctx: ToolContext, signal?: AbortSignal): Promise<ToolResultLike> => {
      const result = await source.callTool(slug, (args ?? {}) as Record<string, unknown>, { signal });
      // MCP reports tool failures inside the result rather than as protocol errors.
      return { content: toLlmContent(result), details: result.structuredContent, isError: result.isError === true };
    },
  };
  // RegisteredTool is `{ spec }`; building it directly keeps this package free of
  // runtime imports from core, so it loads before core is built.
  return { spec };
}

/** Wrap every tool the MCP server lists. Names that collide after clipping keep the first one. */
export async function wrapMcpTools(source: McpToolSource): Promise<RegisteredTool[]> {
  const tools = await source.listTools();
  const seen = new Set<string>();
  const out: RegisteredTool[] = [];
  for (const tool of tools) {
    const wrapped = wrapMcpTool(source, tool);
    if (seen.has(wrapped.spec.name)) continue;
    seen.add(wrapped.spec.name);
    out.push(wrapped);
  }
  return out;
}
