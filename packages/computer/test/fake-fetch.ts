/** A scripted fetch for the desktopd client: routes by `METHOD path` and records every call. */
export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export type Route = (call: RecordedCall) => Response | Promise<Response>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function bytesResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(Buffer.from(bytes), { status, headers: { "content-type": "application/octet-stream" } });
}

export function fakeFetch(routes: Record<string, Route>): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: RecordedCall = { method, path: url.pathname + url.search, body };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return jsonResponse({ error: "not found" }, 404);
    return route(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch whose every call fails like a closed port. */
export function unreachableFetch(): typeof fetch {
  return (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  }) as unknown as typeof fetch;
}

export const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
