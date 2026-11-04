import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { CallToolResult, McpTransport, Tool } from "@earendil-works/pi-mcp";
import type { RegisteredTool } from "@kloru/core";
import { wrapMcpTools } from "./wrap.js";
import type { McpToolSource } from "./wrap.js";

export type Logger = (message: string) => void;

export const DEFAULT_ATOMIC_MAIL_MCP_URL = "https://mcp.atomicmail.ai/mcp";
export const ATOMIC_MAIL_REQUEST_TIMEOUT_MS = 60_000;

export interface AtomicMailBackendOptions {
  /** API key from the inbox's Connect dialog in the Atomic Mail dashboard. Sent as a Bearer header, never logged. */
  apiKey: string;
  /** Override for a self-hosted or staging server. */
  url?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Test seam: supply the client-side transport instead of Streamable HTTP. */
  transportFactory?: () => McpTransport;
}

/**
 * The agent's own inbox, through the Atomic Mail hosted MCP server. One connection, shared by
 * every call. A dropped connection is reopened on the next call.
 */
export class AtomicMailBackend implements McpToolSource {
  readonly endpoint: string;

  private readonly apiKey: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly log: Logger;
  private readonly transportFactory: (() => McpTransport) | undefined;
  private client: McpClient | undefined;
  private connecting: Promise<McpClient> | undefined;
  private toolList: Tool[] | undefined;

  constructor(opts: AtomicMailBackendOptions) {
    if (!opts.apiKey.trim()) throw new Error("AtomicMailBackend needs an API key");
    this.apiKey = opts.apiKey.trim();
    this.endpoint = (opts.url ?? DEFAULT_ATOMIC_MAIL_MCP_URL).replace(/\/+$/, "");
    this.requestTimeoutMs = opts.requestTimeoutMs ?? ATOMIC_MAIL_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl;
    this.log = opts.logger ?? (() => {});
    this.transportFactory = opts.transportFactory;
  }

  describe(): string {
    return `Atomic Mail inbox through ${this.endpoint}`;
  }

  /** Connect once. Concurrent callers share the same handshake. */
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
    const client = new McpClient({ name: "kloru", version: "0.1.0", requestTimeoutMs: this.requestTimeoutMs });
    client.onClose(() => {
      // Let the next call reconnect instead of failing on a dead session.
      if (this.client === client) {
        this.client = undefined;
        this.connecting = undefined;
        this.toolList = undefined;
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
    this.log(`atomicmail: connected (${client.serverInfo?.name ?? "server"})`);
    return client;
  }

  async listTools(): Promise<Tool[]> {
    if (this.toolList) return this.toolList;
    const client = await this.connect();
    this.toolList = await client.listTools({ timeoutMs: this.requestTimeoutMs });
    return this.toolList;
  }

  async callTool(name: string, args: Record<string, unknown> = {}, options: { signal?: AbortSignal } = {}): Promise<CallToolResult> {
    const client = await this.connect();
    return client.callTool(name, args, { signal: options.signal, timeoutMs: this.requestTimeoutMs });
  }

  /** The tools the model gets: only those with a capability tag. */
  async tools(): Promise<RegisteredTool[]> {
    const { tools, skipped } = await wrapMcpTools(this);
    if (skipped.length > 0) this.log(`atomicmail: left out ${skipped.join(", ")}`);
    return tools;
  }

  /**
   * The inbox address, for the prompt. Undefined when the server lists no inbox or more than
   * one, because then the model should not be told a guess.
   */
  async address(): Promise<string | undefined> {
    try {
      const result = await this.callTool("list_agents");
      if (result.isError === true) return undefined;
      for (const block of result.content) {
        if (block.type !== "text") continue;
        const parsed = JSON.parse(block.text) as { agents?: Array<{ email?: unknown }> };
        const agents = parsed.agents ?? [];
        const email = agents.length === 1 ? agents[0]?.email : undefined;
        return typeof email === "string" && email.includes("@") ? email : undefined;
      }
      return undefined;
    } catch (err) {
      this.log(`atomicmail: could not read the inbox address (${err instanceof Error ? err.name : "error"})`);
      return undefined;
    }
  }

  async close(): Promise<void> {
    const client = this.client ?? (this.connecting ? await this.connecting.catch(() => undefined) : undefined);
    this.client = undefined;
    this.connecting = undefined;
    this.toolList = undefined;
    await client?.close();
  }
}
