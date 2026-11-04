/**
 * Plain REST helpers for the Maritime control plane. The maritime-sdk create
 * type lacks `desktop`, `framework`, `exposedPort` and `healthCheckPath`, so
 * the CLI posts the camelCase JSON body itself.
 */
import { CliError } from "./io.js";

export const MARITIME_API_URL = "https://api.maritime.sh";
export const MARITIME_APP_URL = "https://maritime.sh";
/**
 * The port Maritime injects as $PORT for framework "custom" (8080 is taken inside
 * the VM). The create body sends it as `exposedPort` and as an explicit PORT env
 * var so the two can never disagree. the old gateway provisioner had the
 * same constant for multi-user signups.
 */
export const MARITIME_AGENT_PORT = 18789;
/** A model id Maritime's metered OpenAI-compatible proxy serves. Override with --model or INSTINCT_MARITIME_MODEL. */
export const DEFAULT_MARITIME_LLM_MODEL = "gpt-5.4";

export interface MaritimeEnvVar {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface CreateAgentBody {
  name: string;
  framework: "custom";
  imageName: string;
  exposedPort: number;
  healthCheckPath: string;
  desktop: boolean;
  externalId: string;
  initialEnvVars: MaritimeEnvVar[];
  idleTtlSeconds: number;
  instructions: string;
  /** Ask Maritime to inject OPENAI_API_KEY and OPENAI_BASE_URL for its metered LLM proxy. */
  useMaritimeLlm?: boolean;
}

export interface CreatedAgent {
  id: string;
  name: string;
  status?: string;
  externalId?: string | null;
  [k: string]: unknown;
}

export interface MaritimeClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function maritimeBaseUrl(env: NodeJS.ProcessEnv): string {
  return (env.MARITIME_API_URL ?? MARITIME_API_URL).replace(/\/+$/, "");
}

export function maritimeAppUrl(env: NodeJS.ProcessEnv): string {
  return (env.MARITIME_APP_URL ?? MARITIME_APP_URL).replace(/\/+$/, "");
}

export function dashboardUrl(env: NodeJS.ProcessEnv, agentId: string): string {
  return `${maritimeAppUrl(env)}/dashboard/agents/${encodeURIComponent(agentId)}`;
}

async function request<T>(opts: MaritimeClientOptions, method: string, path: string, body?: unknown): Promise<T> {
  const f = opts.fetchImpl ?? globalThis.fetch;
  const url = `${(opts.baseUrl ?? MARITIME_API_URL).replace(/\/+$/, "")}${path}`;
  let res: Response;
  try {
    res = await f(url, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new CliError(`Could not reach Maritime at ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    throw new CliError(describeFailure(res.status, parsed, text));
  }
  return parsed as T;
}

function describeFailure(status: number, parsed: unknown, text: string): string {
  const detail =
    parsed && typeof parsed === "object" && "detail" in parsed
      ? String((parsed as { detail: unknown }).detail)
      : text.slice(0, 300);
  if (status === 401 || status === 403) return `Maritime rejected the API key (${status}). ${detail}`.trim();
  if (status === 402) return `Maritime needs a plan change before this agent can be created (402). ${detail}`.trim();
  return `Maritime returned ${status}. ${detail}`.trim();
}

export async function createAgent(opts: MaritimeClientOptions, body: CreateAgentBody): Promise<CreatedAgent> {
  return request<CreatedAgent>(opts, "POST", "/api/agents", body);
}

export async function chatWithAgent(
  opts: MaritimeClientOptions,
  agentId: string,
  message: string,
  conversationId?: string,
): Promise<{ response: string | null; error?: string }> {
  return request(opts, "POST", `/api/agents/${encodeURIComponent(agentId)}/chat`, {
    message,
    conversation_id: conversationId,
  });
}

export async function listAgents(opts: MaritimeClientOptions, externalId?: string): Promise<CreatedAgent[]> {
  const q = externalId ? `?externalId=${encodeURIComponent(externalId)}` : "";
  return request<CreatedAgent[]>(opts, "GET", `/api/agents${q}`);
}
