import { describe, expect, it } from "vitest";
import { computeInkboxSignature, parseWebhookTimestamp, verifyInkboxSignature } from "../src/signature.js";

const KEY = "whsec_0123456789abcdef";
const BODY = JSON.stringify({ id: "evt_1", event_type: "imessage.received", data: {} });
const NOW = 1_760_000_000_000; // fixed epoch ms

function signedHeaders(opts: { key?: string; body?: string; ts?: string; requestId?: string } = {}) {
  const ts = opts.ts ?? String(Math.floor(NOW / 1000));
  const requestId = opts.requestId ?? "req_abc";
  return {
    "x-inkbox-request-id": requestId,
    "x-inkbox-timestamp": ts,
    "x-inkbox-signature": computeInkboxSignature(opts.body ?? BODY, requestId, ts, opts.key ?? KEY),
  };
}

describe("verifyInkboxSignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verifyInkboxSignature(BODY, signedHeaders(), KEY, { now: () => NOW })).toBe(true);
  });

  it("accepts the key with or without the whsec_ prefix, like the SDK", () => {
    const bare = KEY.slice("whsec_".length);
    expect(verifyInkboxSignature(BODY, signedHeaders({ key: KEY }), bare, { now: () => NOW })).toBe(true);
    expect(verifyInkboxSignature(BODY, signedHeaders({ key: bare }), KEY, { now: () => NOW })).toBe(true);
  });

  it("accepts a Buffer body and mixed-case or array headers", () => {
    const h = signedHeaders();
    const headers = {
      "X-Inkbox-Request-ID": [h["x-inkbox-request-id"]],
      "X-Inkbox-Timestamp": h["x-inkbox-timestamp"],
      "X-Inkbox-Signature": h["x-inkbox-signature"],
    };
    expect(verifyInkboxSignature(Buffer.from(BODY), headers, KEY, { now: () => NOW })).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifyInkboxSignature(BODY + " ", signedHeaders(), KEY, { now: () => NOW })).toBe(false);
  });

  it("rejects a wrong key, a wrong request id and a malformed signature", () => {
    expect(verifyInkboxSignature(BODY, signedHeaders(), "whsec_other", { now: () => NOW })).toBe(false);
    const h = signedHeaders();
    expect(verifyInkboxSignature(BODY, { ...h, "x-inkbox-request-id": "req_zzz" }, KEY, { now: () => NOW })).toBe(false);
    expect(verifyInkboxSignature(BODY, { ...h, "x-inkbox-signature": "md5=abc" }, KEY, { now: () => NOW })).toBe(false);
    expect(verifyInkboxSignature(BODY, { ...h, "x-inkbox-signature": "sha256=" }, KEY, { now: () => NOW })).toBe(false);
    expect(verifyInkboxSignature(BODY, h, "", { now: () => NOW })).toBe(false);
  });

  it("rejects an expired timestamp and accepts one inside the window", () => {
    const old = String(Math.floor(NOW / 1000) - 301);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: old }), KEY, { now: () => NOW })).toBe(false);
    const fresh = String(Math.floor(NOW / 1000) - 299);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: fresh }), KEY, { now: () => NOW })).toBe(true);
    const future = String(Math.floor(NOW / 1000) + 400);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: future }), KEY, { now: () => NOW })).toBe(false);
  });

  it("honours a custom tolerance and can skip the window check", () => {
    const old = String(Math.floor(NOW / 1000) - 3600);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: old }), KEY, { now: () => NOW, toleranceSeconds: 60 })).toBe(false);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: old }), KEY, { now: () => NOW, toleranceSeconds: 7200 })).toBe(true);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: old }), KEY, { now: () => NOW, toleranceSeconds: Infinity })).toBe(true);
  });

  it("rejects a missing or unparseable timestamp when the window is enforced", () => {
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: "yesterday" }), KEY, { now: () => NOW })).toBe(false);
    const h = signedHeaders();
    const { "x-inkbox-timestamp": _drop, ...noTs } = h;
    expect(verifyInkboxSignature(BODY, noTs, KEY, { now: () => NOW })).toBe(false);
  });

  it("accepts ISO 8601 and millisecond timestamps", () => {
    const iso = new Date(NOW).toISOString();
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: iso }), KEY, { now: () => NOW })).toBe(true);
    expect(verifyInkboxSignature(BODY, signedHeaders({ ts: String(NOW) }), KEY, { now: () => NOW })).toBe(true);
  });
});

describe("parseWebhookTimestamp", () => {
  it("handles seconds, milliseconds and ISO strings", () => {
    expect(parseWebhookTimestamp("1760000000")).toBe(1_760_000_000_000);
    expect(parseWebhookTimestamp("1760000000000")).toBe(1_760_000_000_000);
    expect(parseWebhookTimestamp("2025-10-09T08:53:20.000Z")).toBe(Date.parse("2025-10-09T08:53:20.000Z"));
    expect(parseWebhookTimestamp("")).toBeUndefined();
    expect(parseWebhookTimestamp("soon")).toBeUndefined();
  });
});
