/**
 * A link the owner sends a family member so she connects her own Gmail and Calendar: no sign-in,
 * the link is the permission. It's signed (so nobody can make one for another family or person)
 * and lasts 7 days. Accounts connected through it are tagged as hers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ConnectClaim {
  /** The member's contact id. */
  person: string;
  name: string;
  /** The console user (family owner) whose agent the accounts join. */
  uid: string;
}

const DAYS = 7;
const sign = (secret: string, body: string) => createHmac("sha256", `connect:${secret}`).update(body).digest("base64url");

export function makeConnectToken(secret: string, claim: ConnectClaim, now = new Date()): string {
  const body = Buffer.from(JSON.stringify({ ...claim, exp: now.getTime() + DAYS * 86_400_000 })).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function readConnectToken(secret: string, token: string, now = new Date()): ConnectClaim | undefined {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return undefined;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<ConnectClaim> & { exp?: number };
    if (typeof c.person !== "string" || typeof c.uid !== "string" || typeof c.exp !== "number" || c.exp < now.getTime()) return undefined;
    return { person: c.person, name: typeof c.name === "string" ? c.name : c.person, uid: c.uid };
  } catch {
    return undefined;
  }
}
