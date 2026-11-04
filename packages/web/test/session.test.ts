import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, clearSessionCookie, newSession, readBlob, readSession, sessionCookie, signBlob, signSession } from "../src/session.js";

const S = "secret-a";

describe("session", () => {
  it("round-trips through a cookie header with other cookies", () => {
    const s = newSession("u1", "+14155550190", 1_000);
    const header = `other=1; ${SESSION_COOKIE}=${signSession(S, s)}; x=y`;
    expect(readSession(S, header, 2_000)).toEqual(s);
    expect(s.csrf.length).toBeGreaterThan(20);
    expect(s.exp).toBe(1_000 + 7 * 24 * 3600 * 1000);
  });

  it("treats tampering, another secret, expiry and garbage as signed out", () => {
    const s = newSession("u1", "+14155550100", 0);
    const v = signSession(S, s);
    expect(readSession("secret-b", `${SESSION_COOKIE}=${v}`, 1)).toBeUndefined();
    expect(readSession(S, `${SESSION_COOKIE}=${v.replace(/^./, (c) => (c === "x" ? "y" : "x"))}`, 1)).toBeUndefined();
    expect(readSession(S, `${SESSION_COOKIE}=${v}`, s.exp + 1)).toBeUndefined();
    expect(readSession(S, `${SESSION_COOKIE}=%%%`, 1)).toBeUndefined();
    expect(readSession(S, `${SESSION_COOKIE}=a.b`, 1)).toBeUndefined();
    expect(readSession(S, undefined, 1)).toBeUndefined();
    const forged = `${Buffer.from(JSON.stringify({ uid: "u1" })).toString("base64url")}`;
    expect(readSession(S, `${SESSION_COOKIE}=${forged}.${"A".repeat(43)}`, 1)).toBeUndefined();
  });

  it("signs arbitrary blobs", () => {
    expect(readBlob<{ a: number }>(S, signBlob(S, { a: 1 }))).toEqual({ a: 1 });
    expect(readBlob(S, signBlob("other", { a: 1 }))).toBeUndefined();
    expect(readBlob(S, undefined)).toBeUndefined();
  });

  it("cookie flags", () => {
    expect(sessionCookie("v", true, 60)).toBe(`${SESSION_COOKIE}=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`);
    expect(sessionCookie("v", false, 60)).not.toContain("Secure");
    expect(clearSessionCookie(true)).toContain("Max-Age=0");
  });
});
