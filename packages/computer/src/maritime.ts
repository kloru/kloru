/**
 * Hosted desktop through the Maritime Computers MCP server.
 *
 * Used when the agent runs outside a Maritime desktop VM (self-hosted, local dev, or a VM
 * created without `desktop: true`). Maritime keeps one persistent Linux desktop per end user
 * behind `https://mcp.maritime.sh/mcp/u/{externalUserId}`; the connection is pinned to that
 * user so `get_computer` needs no `user_id`. Tools are registered under the exact names the
 * server uses, so a prompt written for the hosted product works unchanged.
 */
import {
  McpClient,
  StreamableHttpTransport,
  type CallToolResult,
  type McpTransport,
  type Tool,
} from "@earendil-works/pi-mcp";
import type { RegisteredTool, ToolMeta, ToolResultLike } from "@kloru/core";
import { errorResult, findStringField, isRecord, mcpResultToToolResult } from "./result.js";
import { mcpSchemaToTypeBox, sanitizeToolName, schemaHasProperty } from "./schema.js";
import { defineTool } from "@kloru/core";
import type { ComputerBackend, Logger } from "./types.js";

export const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";
/** `get_computer` can take 60 s on first use while the desktop is created; waking takes a few seconds. */
export const MARITIME_REQUEST_TIMEOUT_MS = 180_000;
/** Pinned connections default to this end user id when the deployment gives none. */
export const DEFAULT_EXTERNAL_USER_ID = "owner";

const META: ToolMeta = { capabilities: ["computer.use"], group: "computer" };

/**
 * Build the pinned endpoint from a base URL. Accepts a bare origin, a URL ending in `/mcp`,
 * or an already pinned URL (used as is).
 */
export function maritimeMcpEndpoint(base: string, externalUserId: string = DEFAULT_EXTERNAL_USER_ID): string {
  const trimmed = (base || DEFAULT_MARITIME_MCP_URL).replace(/\/+$/, "");
  if (/\/mcp\/u\/[^/]+$/.test(trimmed)) return trimmed;
  const root = trimmed.endsWith("/mcp") ? trimmed.slice(0, -"/mcp".length) : trimmed;
  return `${root}/mcp/u/${encodeURIComponent(externalUserId)}`;
}

export interface MaritimeMcpBackendOptions {
  /** Base URL (`https://mcp.maritime.sh`) or a full pinned endpoint. */
  url: string;
  /** Maritime API key with the `computers` scope. Sent as a Bearer header, never logged. */
  apiKey: string;
  externalUserId?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Test seam: supply the client-side transport instead of Streamable HTTP. */
  transportFactory?: () => McpTransport;
}

export class MaritimeMcpBackend implements ComputerBackend {
  readonly kind = "maritime" as const;
  readonly endpoint: string;
  readonly externalUserId: string;
  /** The computer id learned from `get_computer`, injected into later calls when the model omits it. */
  computerId: string | undefined;

  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly log: Logger;
  private readonly transportFactory: (() => McpTransport) | undefined;
  private client: McpClient | undefined;
  private connecting: Promise<McpClient> | undefined;
  private toolList: Tool[] | undefined;

  constructor(opts: MaritimeMcpBackendOptions) {
    this.externalUserId = opts.externalUserId ?? DEFAULT_EXTERNAL_USER_ID;
    this.endpoint = maritimeMcpEndpoint(opts.url, this.externalUserId);
    this.apiKey = opts.apiKey;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? MARITIME_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.logger ?? (() => {});
    this.transportFactory = opts.transportFactory;
  }

  describe(): string {
    return `Maritime hosted computer for end user "${this.externalUserId}" (${this.endpoint})`;
  }

  /** Connect once; concurrent callers share the same handshake. */
  connect(): Promise<McpClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.connecting) {
      this.connecting = this.openClient().then(
        (client) => {
          this.client = client;
          return client;
        },
        (err) => {
          this.connecting = undefined;
          throw err;
        },
      );
    }
    return this.connecting;
  }

  private async openClient(): Promise<McpClient> {
    const client = new McpClient({
      name: "kloru",
      version: "0.1.0",
      requestTimeoutMs: this.requestTimeoutMs,
    });
    client.onClose(() => {
      // Let the next call reconnect instead of failing on a dead session.
      if (this.client === client) {
        this.client = undefined;
        this.connecting = undefined;
      }
    });
    const transport =
      this.transportFactory?.() ??
      new StreamableHttpTransport({
        url: this.endpoint,
        headers: { Authorization: `Bearer ${this.apiKey}` },
        ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      });
    await client.connect(transport);
    this.log(`connected to Maritime Computers MCP (${client.serverInfo?.name ?? "server"})`);
    return client;
  }

  async listTools(): Promise<Tool[]> {
    if (this.toolList) return this.toolList;
    const client = await this.connect();
    this.toolList = await client.listTools({ timeoutMs: this.requestTimeoutMs });
    return this.toolList;
  }

  /**
   * Call a hosted tool. Fills in `computer_id` from memory (fetching it with `get_computer`
   * when nothing is remembered yet) and remembers the id `get_computer` returns.
   */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    const client = await this.connect();
    const tool = (await this.listTools()).find((t) => t.name === name);
    const params = { ...args };
    if (tool && schemaHasProperty(tool.inputSchema, "computer_id") && typeof params.computer_id !== "string") {
      params.computer_id = await this.ensureComputerId(signal);
    }
    const result = await client.callTool(name, params, { signal, timeoutMs: this.requestTimeoutMs });
    if (name === "get_computer" && result.isError !== true) {
      const id = findStringField(result, "computer_id");
      if (id) this.computerId = id;
    }
    return result;
  }

  private async ensureComputerId(signal?: AbortSignal): Promise<string> {
    if (this.computerId) return this.computerId;
    const result = await this.call("get_computer", {}, signal);
    if (!this.computerId) {
      throw new Error("get_computer did not return a computer_id; the Maritime key may lack the computers scope");
    }
    void result;
    return this.computerId;
  }

  async tools(): Promise<RegisteredTool[]> {
    const tools = await this.listTools();
    return tools.map((tool) => this.wrap(tool));
  }

  private wrap(tool: Tool): RegisteredTool {
    const name = sanitizeToolName(tool.name);
    const hint = TOOL_HINTS[tool.name];
    return defineTool({
      name,
      label: tool.title ?? tool.name,
      description: tool.description ?? tool.name,
      parameters: mcpSchemaToTypeBox(tool.inputSchema),
      meta: { ...META, describe: (args) => describeCall(tool.name, args) },
      execute: async (args, _ctx, signal): Promise<ToolResultLike> => {
        try {
          const result = await this.call(tool.name, isRecord(args) ? args : {}, signal);
          return mcpResultToToolResult(result, result.isError ? undefined : hint);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return errorResult(`Maritime computer call ${tool.name} failed: ${message}`);
        }
      },
    });
  }

  async close(): Promise<void> {
    const client = this.client ?? (this.connecting ? await this.connecting.catch(() => undefined) : undefined);
    this.client = undefined;
    this.connecting = undefined;
    this.toolList = undefined;
    await client?.close();
  }
}

/** Short reminders appended to successful results where the model tends to stall. */
const TOOL_HINTS: Record<string, string> = {
  request_takeover:
    "Send the viewer_url to the owner in one short message on their channel and say what to do there. " +
    "Then poll takeover_status or retry your next action. If success is false, stop and tell the owner.",
};

function describeCall(name: string, args: unknown): string {
  if (!isRecord(args)) return name;
  if (name === "computer" && typeof args.action === "string") {
    const at = Array.isArray(args.coordinate) ? ` at ${args.coordinate.join(",")}` : "";
    return `${args.action}${at}`;
  }
  if (name === "computer_batch" && Array.isArray(args.actions)) return `batch of ${args.actions.length}`;
  if (name === "run_shell" && typeof args.command === "string") return `shell: ${args.command.slice(0, 60)}`;
  if ((name === "read_file" || name === "write_file") && typeof args.path === "string") return `${name} ${args.path}`;
  if (name === "request_takeover" && typeof args.reason === "string") return `takeover: ${args.reason}`;
  return name;
}
