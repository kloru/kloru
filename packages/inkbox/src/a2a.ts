/**
 * Agent-to-agent transport over Inkbox. As a worker we answer tasks Inkbox stores
 * for us (REST reply). As a caller we speak A2A 1.0 JSON-RPC straight to the peer's
 * endpoint on inkbox.ai with our identity key. Both use the injectable fetch.
 */
import { randomUUID } from "node:crypto";
import { createRest, isHttpStatus, type RestClient } from "./http.js";

export type A2AIntent = "progress" | "complete" | "ask_caller" | "fail";

export interface A2ASendResult {
  taskId?: string;
  contextId?: string;
  state?: string;
  raw: unknown;
}

type Dict = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function dict(v: unknown): Dict | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined;
}

export class A2ARpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(`A2A error ${code}: ${message}`);
    this.name = "A2ARpcError";
    this.code = code;
    this.data = data;
  }
}

/** Build the two-part message body OIP/1 expects: readable text plus typed data. */
export function a2aParts(text: string, data?: Record<string, unknown>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  if (text) parts.push({ text });
  if (data) parts.push({ data });
  if (parts.length === 0) parts.push({ text: "" });
  return parts;
}

/** Read task id, context id and state from a SendMessage result, whatever shape came back. */
export function summarizeSendResult(result: unknown): A2ASendResult {
  const r = dict(result) ?? {};
  const task = dict(r.task);
  if (task) {
    const status = dict(task.status);
    const out: A2ASendResult = { raw: result };
    const id = str(task.id);
    if (id) out.taskId = id;
    const ctx = str(task.contextId) ?? str(task.context_id);
    if (ctx) out.contextId = ctx;
    const state = str(status?.state) ?? str(task.state);
    if (state) out.state = state;
    return out;
  }
  const message = dict(r.message);
  if (message) {
    const out: A2ASendResult = { raw: result };
    const taskId = str(message.taskId) ?? str(message.task_id);
    if (taskId) out.taskId = taskId;
    const ctx = str(message.contextId) ?? str(message.context_id);
    if (ctx) out.contextId = ctx;
    return out;
  }
  // Older servers return the task object directly.
  if ("status" in r && "id" in r) return summarizeSendResult({ task: r });
  return { raw: result };
}

export class InkboxA2A {
  readonly handle: string;
  private readonly rest: RestClient;
  private nextRpcId = 0;

  constructor(opts: { apiKey: string; handle: string; baseUrl?: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }) {
    this.handle = opts.handle.replace(/^@+/, "");
    const restOpts: Parameters<typeof createRest>[0] = { apiKey: opts.apiKey };
    if (opts.baseUrl) restOpts.baseUrl = opts.baseUrl;
    if (opts.fetchImpl) restOpts.fetchImpl = opts.fetchImpl;
    if (opts.sleep) restOpts.sleep = opts.sleep;
    this.rest = createRest(restOpts);
  }

  private base(): string {
    return `/identities/${encodeURIComponent(this.handle)}/a2a`;
  }

  /** Worker side: answer a task in our inbox and move it to the next state. */
  async reply(taskId: string, intent: A2AIntent, text: string, data?: Record<string, unknown>): Promise<void> {
    await this.rest.request("POST", `${this.base()}/tasks/${encodeURIComponent(taskId)}/reply`, {
      intent,
      parts: a2aParts(text, data),
    });
  }

  /** Caller side: SendMessage to a peer. Reuse contextId to keep one topic together. */
  async send(
    peerHandle: string,
    text: string,
    data?: Record<string, unknown>,
    opts: { contextId?: string; taskId?: string; messageId?: string } = {},
  ): Promise<A2ASendResult> {
    const peer = peerHandle.replace(/^@+/, "");
    const message: Dict = {
      messageId: opts.messageId ?? randomUUID(),
      role: "ROLE_USER",
      parts: a2aParts(text, data),
    };
    if (opts.contextId) message.contextId = opts.contextId;
    if (opts.taskId) message.taskId = opts.taskId;
    const body = {
      jsonrpc: "2.0",
      id: ++this.nextRpcId,
      method: "SendMessage",
      params: { message, configuration: { returnImmediately: true } },
    };
    const payload = await this.rest.requestUrl<Dict>("POST", `${this.rest.baseUrl}/a2a/${encodeURIComponent(peer)}`, body, {
      "A2A-Version": "1.0",
    }, { replaySafe: true });
    const error = dict(payload?.error);
    if (error) {
      throw new A2ARpcError(typeof error.code === "number" ? error.code : -32603, str(error.message) ?? "Unknown A2A error", error.data);
    }
    return summarizeSendResult(payload?.result);
  }

  /** A task we received, or one we sent (checked in that order). */
  async getTask(taskId: string): Promise<unknown> {
    const id = encodeURIComponent(taskId);
    try {
      return await this.rest.request("GET", `${this.base()}/tasks/${id}`);
    } catch (err) {
      if (!isHttpStatus(err, 404)) throw err;
      return this.rest.request("GET", `${this.base()}/sent/tasks/${id}`);
    }
  }

  async listInbox(state?: string): Promise<unknown[]> {
    const query: Record<string, string | undefined> = {};
    if (state) query.state = state;
    const raw = await this.rest.request<unknown>("GET", `${this.base()}/tasks`, undefined, query);
    if (Array.isArray(raw)) return raw;
    const r = dict(raw);
    const items = r?.items ?? r?.tasks;
    return Array.isArray(items) ? items : [];
  }

  /** The peer's public Agent Card. */
  async fetchCard(peerHandle: string): Promise<Record<string, unknown>> {
    const peer = peerHandle.replace(/^@+/, "");
    const card = await this.rest.requestUrl<unknown>("GET", `${this.rest.baseUrl}/a2a/${encodeURIComponent(peer)}/card`);
    return dict(card) ?? {};
  }
}
