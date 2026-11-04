/**
 * Signed cookies. A value is base64url(JSON) + "." + HMAC-SHA256(secret, that base64url).
 * A cookie that fails to verify, or has expired, reads as "signed out", never as an error.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "kloru_session";
/** Anonymous visitors get this before signing in; the sign-in forms carry its value. */
export const PRE_COOKIE = "kloru_pre";
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export interface Session {
  uid: string;
  phone: string;
  exp: number;
  /** Every POST form carries this; a mismatch is refused. */
  csrf: string;
}

const mac = (secret: string, body: string): string => createHmac("sha256", secret).update(body).digest("base64url");

export function signBlob(secret: string, value: unknown): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${body}.${mac(secret, body)}`;
}

export function readBlob<T>(secret: string, value: string | undefined): T | undefined {
  if (!value) return undefined;
  const [body, sig, extra] = value.split(".");
  if (!body || !sig || extra !== undefined) return undefined;
  const want = Buffer.from(mac(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return undefined;
  }
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function newSession(uid: string, phone: string, now: number = Date.now()): Session {
  return { uid, phone, exp: now + SESSION_TTL_MS, csrf: randomBytes(18).toString("base64url") };
}

export function signSession(secret: string, s: Session): string {
  return signBlob(secret, s);
}

export function readSession(secret: string, cookieHeader: string | undefined, now: number = Date.now()): Session | undefined {
  const s = readBlob<Partial<Session>>(secret, cookieValue(cookieHeader, SESSION_COOKIE));
  if (!s || typeof s.uid !== "string" || typeof s.phone !== "string" || typeof s.csrf !== "string" || typeof s.exp !== "number") return undefined;
  if (s.exp < now) return undefined;
  return { uid: s.uid, phone: s.phone, exp: s.exp, csrf: s.csrf };
}

export function sessionCookie(value: string, secure: boolean, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", secure, 0);
}
