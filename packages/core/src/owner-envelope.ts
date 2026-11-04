/**
 * Owner operations from a console (the Kloru website) travel to the agent over the
 * plain /chat route as signed envelopes, so a local agent and a Maritime VM share one
 * path. They are handled before the runtime and never reach the model. /chat is already
 * the owner's surface; the signature and time box are defense in depth.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const OWNER_API_EVENT = "owner.api";
/** How far an envelope's timestamp may drift from the agent's clock. */
export const OWNER_ENVELOPE_MAX_SKEW_MS = 300_000;

export interface OwnerEnvelope {
  type: typeof OWNER_API_EVENT;
  op: string;
  args: Record<string, unknown>;
  at: string;
  sig: string;
}

/** JSON with object keys sorted at every level and undefined values dropped. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function mac(secret: string, op: string, at: string, args: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(`${op}\n${at}\n${canonicalJson(args)}`).digest("hex");
}

export function signOwnerEnvelope(secret: string, op: string, args: Record<string, unknown>, at: Date = new Date()): OwnerEnvelope {
  const iso = at.toISOString();
  return { type: OWNER_API_EVENT, op, args, at: iso, sig: mac(secret, op, iso, args) };
}

export function isOwnerEnvelope(event: unknown): boolean {
  return !!event && typeof event === "object" && (event as { type?: unknown }).type === OWNER_API_EVENT;
}

export type OwnerEnvelopeCheck = { ok: true; env: OwnerEnvelope } | { ok: false; error: string };

/** Checks shape, clock skew and signature. Never throws. */
export function verifyOwnerEnvelope(secret: string | undefined, event: unknown, now: Date = new Date()): OwnerEnvelopeCheck {
  if (!secret) return { ok: false, error: "owner API is not configured on this agent" };
  if (!isOwnerEnvelope(event)) return { ok: false, error: "not an owner envelope" };
  const e = event as Record<string, unknown>;
  if (typeof e.op !== "string" || typeof e.at !== "string" || typeof e.sig !== "string") return { ok: false, error: "malformed envelope" };
  if (!e.args || typeof e.args !== "object" || Array.isArray(e.args)) return { ok: false, error: "malformed envelope" };
  const at = Date.parse(e.at);
  if (!Number.isFinite(at) || Math.abs(now.getTime() - at) > OWNER_ENVELOPE_MAX_SKEW_MS) return { ok: false, error: "envelope expired or clocks disagree" };
  const want = Buffer.from(mac(secret, e.op, e.at, e.args as Record<string, unknown>), "utf8");
  const got = Buffer.from(e.sig, "utf8");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, error: "bad signature" };
  return { ok: true, env: { type: OWNER_API_EVENT, op: e.op, args: e.args as Record<string, unknown>, at: e.at, sig: e.sig } };
}
