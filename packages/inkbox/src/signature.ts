/**
 * Webhook signature check. Mirrors @inkbox/sdk's verifyWebhook (HMAC-SHA256 over
 * `${request_id}.${timestamp}.${raw_body}`, key with or without `whsec_`) and adds
 * a timestamp window so a captured request cannot be replayed later.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyOptions {
  /** Seconds the timestamp may differ from now. Default 300. Pass Infinity to skip. */
  toleranceSeconds?: number;
  /** Current time in epoch milliseconds (Date.now-compatible). */
  now?: () => number;
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== want) continue;
    const first = Array.isArray(v) ? v[0] : v;
    return first ?? "";
  }
  return "";
}

/** Inkbox sends unix seconds; accept ISO 8601 and unix milliseconds as well. */
export function parseWebhookTimestamp(value: string): number | undefined {
  const t = value.trim();
  if (!t) return undefined;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    // Anything past the year 2286 in seconds is really milliseconds.
    return n > 1e11 ? n : n * 1000;
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? undefined : ms;
}

export function computeInkboxSignature(rawBody: Buffer | string, requestId: string, timestamp: string, signingKey: string): string {
  const key = signingKey.startsWith("whsec_") ? signingKey.slice("whsec_".length) : signingKey;
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const message = Buffer.concat([Buffer.from(`${requestId}.${timestamp}.`), body]);
  return `sha256=${createHmac("sha256", key).update(message).digest("hex")}`;
}

export function verifyInkboxSignature(
  rawBody: Buffer | string,
  headers: Headers,
  signingKey: string,
  opts: VerifyOptions = {},
): boolean {
  if (!signingKey) return false;
  const signature = header(headers, "x-inkbox-signature");
  const requestId = header(headers, "x-inkbox-request-id");
  const timestamp = header(headers, "x-inkbox-timestamp");
  if (!signature.startsWith("sha256=")) return false;

  const tolerance = opts.toleranceSeconds ?? 300;
  if (Number.isFinite(tolerance)) {
    const ts = parseWebhookTimestamp(timestamp);
    if (ts === undefined) return false;
    const now = (opts.now ?? Date.now)();
    if (Math.abs(now - ts) > tolerance * 1000) return false;
  }

  const expected = Buffer.from(computeInkboxSignature(rawBody, requestId, timestamp, signingKey));
  const received = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch; a mismatch is simply a bad signature.
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
