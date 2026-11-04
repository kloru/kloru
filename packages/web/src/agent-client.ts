/**
 * How the console reaches a person's agent: a signed owner.api envelope over /chat.
 * Direct talks to an agent's own HTTP port (local dev, self-host). Maritime (M4) will
 * post the same envelope through Maritime's /api/agents/:id/chat.
 */
import { encodeEvent, signOwnerEnvelope } from "@kloru/core";
import type { ConsoleUser } from "./store.js";

/** status 0: the agent could not be reached or did not answer in time. */
export class AgentError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface AgentClient {
  call<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
}

export interface DirectAgentOptions {
  url: string;
  /** INSTINCT_CHAT_TOKEN of that agent, when it has one. */
  token?: string;
  /** OWNER_API_SECRET shared with that agent. */
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const AGENT_TIMEOUT_MS = 20_000;

export class DirectAgentClient implements AgentClient {
  constructor(private readonly o: DirectAgentOptions) {}

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const f = this.o.fetchImpl ?? fetch;
    const envelope = signOwnerEnvelope(this.o.secret, op, args);
    let res: Response;
    try {
      res = await f(`${this.o.url.replace(/\/+$/, "")}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) },
        body: JSON.stringify({ message: encodeEvent(envelope), source: "console", conversation_id: "console" }),
        signal: AbortSignal.timeout(this.o.timeoutMs ?? AGENT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AgentError(0, (err as Error).message);
    }
    if (!res.ok) throw new AgentError(res.status, `the agent answered HTTP ${res.status}`);
    let result: unknown;
    let status = 200;
    try {
      const body = (await res.json()) as { response?: string; status?: number };
      status = body.status ?? 200;
      result = JSON.parse(body.response ?? "null");
    } catch {
      throw new AgentError(502, "the agent returned something that is not JSON");
    }
    if (status !== 200) throw new AgentError(status, (result as { error?: string } | null)?.error ?? `the agent answered status ${status}`);
    return result as T;
  }
}

/** The client for a user's agent, or undefined when none is assigned or its secret is missing. */
export function clientFor(user: ConsoleUser, env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): AgentClient | undefined {
  const agent = user.agent;
  if (!agent || agent.kind !== "direct") return undefined; // Maritime agents arrive with hosting (M4).
  const secret = env[agent.secretEnv];
  if (!secret) return undefined;
  const token = env[agent.tokenEnv];
  return new DirectAgentClient({ url: agent.url, secret, ...(token ? { token } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
}
