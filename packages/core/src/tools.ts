/**
 * Tool registry. Every tool the agent can call is a ToolSpec: a TypeBox schema, an
 * execute function and a ToolMeta tag with the capabilities it needs. The registry
 * turns specs into Pi AgentTools bound to one conversation's ToolContext.
 */
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { Channel, Principal, ToolMeta } from "./types.js";

export interface ToolContext {
  principal: Principal;
  conversationKey: string;
  /** Channel address, distinct from a per-principal or per-task runtime key. */
  deliveryKey?: string;
  replyRef?: Record<string, string | undefined>;
  /** Bound by the runtime; worker tools never accept a model-selected task. */
  assertA2AActive?: () => Promise<void>;
  markA2AState?: (state: string) => void;
  channel: Channel;
  /**
   * True only while the current run was started by the owner's own direct message on a
   * carrier-bound or local channel (iMessage, SMS, chat). False for email, group threads,
   * delegated A2A results, scheduled jobs and resumed conversations, whose text the owner
   * did not write.
   */
  ownerTurn?: boolean;
  now(): Date;
}

export type ToolResultLike =
  | string
  | {
      content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
      details?: unknown;
      isError?: boolean;
    };

export interface ToolSpec<T extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  meta: ToolMeta;
  execute: (args: Static<T>, ctx: ToolContext, signal?: AbortSignal) => Promise<ToolResultLike>;
}

export interface RegisteredTool {
  spec: ToolSpec<any>;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Wrap a spec so the generic parameter is inferred once and the schema stays typed. */
export function defineTool<T extends TSchema>(spec: ToolSpec<T>): RegisteredTool {
  if (!TOOL_NAME.test(spec.name)) {
    throw new Error(`Invalid tool name "${spec.name}": use [A-Za-z0-9_-], at most 64 characters`);
  }
  return { spec };
}

export function textResult(text: string): ToolResultLike {
  return { content: [{ type: "text", text }] };
}

/** Pi wants content blocks. Strings become one text block; empty strings still produce a block. */
export function toAgentToolResult(result: ToolResultLike): AgentToolResult<unknown> {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }], details: undefined };
  }
  return {
    content: result.content.length > 0 ? result.content : [{ type: "text", text: "" }],
    details: result.details,
    ...(result.isError ? { isError: true } : {}),
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    // Later registrations win so a package can override a core tool on purpose.
    this.tools.set(tool.spec.name, tool);
  }

  registerMany(tools: RegisteredTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  meta(name: string): ToolMeta | undefined {
    return this.tools.get(name)?.spec.meta;
  }

  /**
   * Build Pi AgentTools for one conversation. The filter decides visibility (what the model
   * can see); the policy guard in the runtime decides execution.
   */
  bind(ctx: ToolContext, filter?: (t: RegisteredTool) => boolean): AgentTool<any>[] {
    const out: AgentTool<any>[] = [];
    for (const tool of this.tools.values()) {
      if (filter && !filter(tool)) continue;
      out.push(bindOne(tool, ctx));
    }
    return out;
  }
}

function bindOne(tool: RegisteredTool, ctx: ToolContext): AgentTool<any> {
  const spec = tool.spec;
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (_toolCallId, params, signal) => {
      const result = await spec.execute(params, ctx, signal);
      return toAgentToolResult(result);
    },
  };
}
