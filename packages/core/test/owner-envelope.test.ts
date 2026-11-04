import { describe, expect, it } from "vitest";
import { canonicalJson, isOwnerEnvelope, signOwnerEnvelope, verifyOwnerEnvelope } from "../src/owner-envelope.js";

const T = new Date("2026-10-27T12:00:00Z");

describe("owner envelope", () => {
  it("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null, u: undefined } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  });

  it("round-trips a signed envelope", () => {
    const env = signOwnerEnvelope("s3cret", "policy.get", {}, T);
    expect(isOwnerEnvelope(env)).toBe(true);
    expect(verifyOwnerEnvelope("s3cret", env, T)).toEqual({ ok: true, env });
  });

  it("survives a JSON round trip with reordered keys", () => {
    const env = signOwnerEnvelope("s3cret", "grants.add", { to: "contact:sam", capabilities: ["calendar.write"], maxUsd: 20 }, T);
    const reordered = JSON.parse(JSON.stringify({ ...env, args: { maxUsd: 20, capabilities: ["calendar.write"], to: "contact:sam" } }));
    expect(verifyOwnerEnvelope("s3cret", reordered, T).ok).toBe(true);
  });

  it("rejects a wrong secret, tampered args, a missing secret, skew and a bad sig", () => {
    const env = signOwnerEnvelope("s3cret", "grants.revoke", { id: "g_1" }, T);
    expect(verifyOwnerEnvelope("other", env, T).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", { ...env, args: { id: "g_2" } }, T).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", { ...env, op: "policy.get" }, T).ok).toBe(false);
    expect(verifyOwnerEnvelope(undefined, env, T).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", env, new Date(T.getTime() + 301_000)).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", env, new Date(T.getTime() - 301_000)).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", { ...env, sig: "zz" }, T).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", { ...env, args: [] }, T).ok).toBe(false);
    expect(verifyOwnerEnvelope("s3cret", "nope", T).ok).toBe(false);
  });
});
