/** HTTP calls to a running Kloru server (local or tunneled). */
import { CliError } from "./io.js";

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:8080";

/** The server's INSTINCT_CHAT_TOKEN as a Bearer header, or nothing when no token is set. */
export function authHeaders(token: string | undefined): Record<string, string> {
  const t = token?.trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export interface LocalChatBody {
  message: string;
  source: string;
  conversation_id?: string;
}

export async function localChat(
  f: typeof fetch,
  baseUrl: string,
  body: LocalChatBody,
  token?: string,
): Promise<{ response: string | null; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/chat`;
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify(body) });
  } catch (err) {
    throw new CliError(`Could not reach ${url}. Is \`instinct dev\` running? (${err instanceof Error ? err.message : String(err)})`);
  }
  if (res.status === 401) throw new CliError(`${url} wants a chat token. Set INSTINCT_CHAT_TOKEN to the server's value.`);
  if (!res.ok) throw new CliError(`${url} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as { response: string | null; error?: string };
}

export async function localStatus(f: typeof fetch, baseUrl: string, token?: string): Promise<Record<string, unknown>> {
  const root = baseUrl.replace(/\/+$/, "");
  for (const p of ["/", "/health"]) {
    let res: Response;
    try {
      res = await f(`${root}${p}`, { headers: { Accept: "application/json", ...authHeaders(token) } });
    } catch (err) {
      throw new CliError(`Could not reach ${root}. Is \`instinct dev\` running? (${err instanceof Error ? err.message : String(err)})`);
    }
    if (res.status === 401) throw new CliError(`${root} wants a chat token. Set INSTINCT_CHAT_TOKEN to the server's value.`);
    if (!res.ok) continue;
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      return { response: parsed };
    } catch {
      return { body: text.slice(0, 200) };
    }
  }
  throw new CliError(`${root} answered neither / nor /health with 200.`);
}
