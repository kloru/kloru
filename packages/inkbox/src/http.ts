/**
 * A tiny REST helper for the Inkbox endpoints the SDK does not wrap in a way we
 * can test. Every call goes through an injectable fetch so tests never touch
 * the network.
 */

export const INKBOX_BASE_URL = "https://inkbox.ai";

export interface RestOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Wait between retries. Tests inject a no-op; production uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class InkboxHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;
  /** Seconds from the `Retry-After` header, or null when the server gave none. */
  readonly retryAfterSeconds: number | null;

  constructor(status: number, url: string, body: unknown, retryAfterSeconds: number | null = null) {
    super(`Inkbox HTTP ${status} for ${url}: ${describeBody(body)}${retryAfterSeconds !== null ? ` (retry after ${retryAfterSeconds}s)` : ""}`);
    this.name = "InkboxHttpError";
    this.status = status;
    this.body = body;
    this.url = url;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** `Retry-After` is either delta-seconds or an HTTP-date. Returns whole seconds, never negative. */
export function parseRetryAfter(header: string | null | undefined, now: () => number = Date.now): number | null {
  if (header === null || header === undefined) return null;
  const h = header.trim();
  if (!h) return null;
  if (/^\d+$/.test(h)) return Number(h);
  const at = Date.parse(h);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now()) / 1000));
}

/**
 * Reads and explicitly replay-safe requests get a short bounded retry
 * on 429/502/503/504 honoring Retry-After up to 5 s. A 429 with no
 * Retry-After is a quota, not a hiccup, so it is thrown at once. The provisioner
 * relies on that for its phone-inventory fallback.
 */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_SECONDS = 5;

export function shouldRetry(status: number, retryAfterSeconds: number | null, attempt: number): boolean {
  if (attempt >= MAX_RETRIES || !RETRY_STATUSES.has(status)) return false;
  if (retryAfterSeconds !== null && retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) return false;
  if (status === 429 && retryAfterSeconds === null) return false;
  return true;
}

export function retryDelayMs(retryAfterSeconds: number | null, attempt: number): number {
  return Math.max((retryAfterSeconds ?? 0) * 1000, 250 * 2 ** attempt);
}

function describeBody(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    return typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 300);
  }
  try {
    return JSON.stringify(body).slice(0, 300);
  } catch {
    return String(body);
  }
}

/** Read the human-readable detail an Inkbox error body carries, if any. */
export function errorDetail(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" ? body : undefined;
  const detail = (body as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object") {
    const msg = (detail as { message?: unknown; detail?: unknown }).message ?? (detail as { detail?: unknown }).detail;
    if (typeof msg === "string") return msg;
  }
  return undefined;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface RestClient {
  readonly baseUrl: string;
  /** `path` is relative to `/api/v1`, for example `/identities/maria`. */
  request<T = unknown>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T>;
  /** Absolute URL, same auth headers. Used for the public A2A routes under `/a2a/`. */
  requestUrl<T = unknown>(method: string, url: string, body?: unknown, extraHeaders?: Record<string, string>, options?: { replaySafe?: boolean }): Promise<T>;
}

export function createRest(opts: RestOptions): RestClient {
  const baseUrl = trimSlash(opts.baseUrl ?? INKBOX_BASE_URL);
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function requestUrl<T>(method: string, url: string, body?: unknown, extraHeaders?: Record<string, string>, options: { replaySafe?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-API-Key": opts.apiKey,
      ...extraHeaders,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(url, init);
      const text = await res.text();
      const parsed = parseJson(text);
      if (res.ok) return parsed as T;
      const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
      if ((method === "GET" || method === "HEAD" || options.replaySafe === true) && shouldRetry(res.status, retryAfter, attempt)) {
        await sleep(retryDelayMs(retryAfter, attempt));
        continue;
      }
      throw new InkboxHttpError(res.status, url, parsed ?? text, retryAfter);
    }
  }

  return {
    baseUrl,
    request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
      const url = new URL(`${baseUrl}/api/v1${path.startsWith("/") ? path : `/${path}`}`);
      for (const [k, v] of Object.entries(query ?? {})) {
        if (v !== undefined && v !== "") url.searchParams.set(k, v);
      }
      return requestUrl<T>(method, url.toString(), body);
    },
    requestUrl,
  };
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isHttpStatus(err: unknown, status: number): boolean {
  return err instanceof InkboxHttpError && err.status === status;
}
