/**
 * A fetch stand-in that records every call and answers from a routing table.
 * Routes match on "METHOD /path" (path without query string).
 */
export interface Recorded {
  method: string;
  url: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** Multipart parts when the body was a FormData: field, filename, type and size. */
  form?: Array<{ field: string; filename: string; type: string; size: number }>;
}

export interface Answer {
  status?: number;
  body?: unknown;
  /** Extra response headers, for example `{ "Retry-After": "1" }`. */
  headers?: Record<string, string>;
}

export type Responder = (req: Recorded) => Answer | undefined;

export function fakeFetch(routes: Record<string, Responder | Answer>, fallback?: Responder) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = v;
    const rec: Recorded = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams.entries()),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    if (init?.body instanceof FormData) {
      rec.form = [];
      for (const [field, value] of init.body.entries()) {
        if (value instanceof Blob) rec.form.push({ field, filename: value instanceof File ? value.name : "", type: value.type, size: value.size });
        else rec.form.push({ field, filename: "", type: "text", size: value.length });
      }
    }
    calls.push(rec);
    const key = `${rec.method} ${rec.path}`;
    const route = routes[key];
    const answer = typeof route === "function" ? route(rec) : route ?? fallback?.(rec);
    if (!answer) {
      return new Response(JSON.stringify({ detail: `no route for ${key}` }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const status = answer.status ?? 200;
    // Response() refuses a body on 204/205/304, like a real server would.
    const noBody = status === 204 || status === 205 || status === 304 || answer.body === undefined;
    const body = noBody ? null : JSON.stringify(answer.body);
    return new Response(body, { status, headers: { "content-type": "application/json", ...(answer.headers ?? {}) } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A raw identity as GET /api/v1/identities/{handle} returns it. */
export function rawIdentity(overrides: Record<string, unknown> = {}) {
  return {
    id: "ident_1",
    organization_id: "org_1",
    agent_handle: "maria-instinct",
    display_name: "Maria's Kloru",
    description: null,
    email_address: "maria-instinct@inkbox.ai",
    imessage_enabled: true,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    mailbox: {
      id: "mb_1",
      email_address: "maria-instinct@inkbox.ai",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    phone_number: {
      id: "pn_1",
      number: "+16505550123",
      type: "local",
      status: "active",
      incoming_call_action: "auto_reject",
      client_websocket_url: null,
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
    imessage_number: null,
    tunnel: { id: "tn_1", tunnel_name: "maria-instinct", tls_mode: "edge", status: "active", public_host: "maria-instinct.tunnels.inkbox.ai", zone: "tunnels.inkbox.ai", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" },
    ...overrides,
  };
}
