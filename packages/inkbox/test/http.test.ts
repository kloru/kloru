import { describe, expect, it } from "vitest";
import { InkboxHttpError, createRest, isHttpStatus, parseRetryAfter, retryDelayMs, shouldRetry } from "../src/http.js";
import { fakeFetch } from "./fake-fetch.js";

const BASE = "https://inkbox.test";

function rest(fake: ReturnType<typeof fakeFetch>, sleeps: number[] = []) {
  return createRest({
    apiKey: "ik_test",
    baseUrl: BASE,
    fetchImpl: fake.fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

describe("parseRetryAfter", () => {
  it("reads delta seconds and HTTP dates, and ignores junk", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter(" 1 ")).toBe(1);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(parseRetryAfter("Sat, 03 Oct 2026 12:00:03 GMT", () => now)).toBe(3);
    expect(parseRetryAfter("Sat, 03 Oct 2026 11:00:00 GMT", () => now)).toBe(0);
  });
});

describe("retry policy", () => {
  it("retries short waits on 429/502/503/504 at most twice", () => {
    expect(shouldRetry(429, 1, 0)).toBe(true);
    expect(shouldRetry(429, 5, 1)).toBe(true);
    expect(shouldRetry(429, 1, 2)).toBe(false);
    expect(shouldRetry(429, 6, 0)).toBe(false);
    expect(shouldRetry(503, null, 0)).toBe(true);
    expect(shouldRetry(502, null, 1)).toBe(true);
    expect(shouldRetry(504, 2, 0)).toBe(true);
    expect(shouldRetry(500, null, 0)).toBe(false);
    expect(shouldRetry(404, 1, 0)).toBe(false);
  });

  it("treats a 429 without Retry-After as a quota and does not retry it", () => {
    expect(shouldRetry(429, null, 0)).toBe(false);
  });

  it("waits at least the backoff floor and at most the server's hint", () => {
    expect(retryDelayMs(1, 0)).toBe(1000);
    expect(retryDelayMs(null, 0)).toBe(250);
    expect(retryDelayMs(null, 1)).toBe(500);
    expect(retryDelayMs(0, 1)).toBe(500);
  });
});

describe("createRest", () => {
  it("retries a 429 with Retry-After: 1 once and returns the eventual body", async () => {
    let n = 0;
    const fake = fakeFetch({
      "GET /api/v1/identities/maria-instinct/a2a/tasks/t1": () => (++n === 1 ? { status: 429, body: { detail: "slow down" }, headers: { "Retry-After": "1" } } : { body: { id: "t1", state: "completed" } }),
    });
    const sleeps: number[] = [];
    const out = await rest(fake, sleeps).request<{ state: string }>("GET", "/identities/maria-instinct/a2a/tasks/t1");
    expect(out.state).toBe("completed");
    expect(fake.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it.each([429, 502, 503, 504])("does not replay an unkeyed mutation after HTTP %s", async (status) => {
    const fake = fakeFetch({ "POST /api/v1/identities/x/a2a/tasks/t/reply": { status, headers: { "Retry-After": "1" } } });
    await expect(rest(fake).request("POST", "/identities/x/a2a/tasks/t/reply", { intent: "progress", parts: [{ text: "working" }] })).rejects.toMatchObject({ status });
    expect(fake.calls).toHaveLength(1);
  });

  it("retries an explicitly replay-safe request with the same message ID", async () => {
    let calls = 0;
    const fake = fakeFetch({ "POST /a2a/peer": () => ++calls === 1 ? { status: 503 } : { body: { result: {} } } });
    const body = { params: { message: { messageId: "stable-message" } } };
    await rest(fake).requestUrl("POST", `${BASE}/a2a/peer`, body, {}, { replaySafe: true });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.map((c) => c.body)).toEqual([body, body]);
  });

  it("gives up on a long Retry-After and exposes it on the error", async () => {
    const fake = fakeFetch({ "GET /api/v1/identities/x": { status: 429, body: { detail: "rate limited" }, headers: { "Retry-After": "30" } } });
    const sleeps: number[] = [];
    const err = await rest(fake, sleeps).request("GET", "/identities/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InkboxHttpError);
    expect((err as InkboxHttpError).status).toBe(429);
    expect((err as InkboxHttpError).retryAfterSeconds).toBe(30);
    expect((err as InkboxHttpError).message).toContain("retry after 30s");
    expect(isHttpStatus(err, 429)).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("stops after three attempts on a persistent 503 and reports null retryAfterSeconds without a header", async () => {
    const fake = fakeFetch({ "GET /api/v1/identities/x": { status: 503, body: "down" } });
    const sleeps: number[] = [];
    const err = await rest(fake, sleeps).request("GET", "/identities/x").catch((e: unknown) => e);
    expect(fake.calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
    expect((err as InkboxHttpError).retryAfterSeconds).toBeNull();
    expect((err as InkboxHttpError).status).toBe(503);
  });

  it("does not retry a quota 429 that has no Retry-After, so callers can fall back at once", async () => {
    const fake = fakeFetch({ "POST /api/v1/identities/": { status: 429, body: { detail: "phone inventory" } } });
    await expect(rest(fake).request("POST", "/identities/", { phone_number: {} })).rejects.toMatchObject({ status: 429, retryAfterSeconds: null });
    expect(fake.calls).toHaveLength(1);
  });

  it("never retries a 4xx other than 429", async () => {
    const fake = fakeFetch({ "GET /api/v1/identities/x": { status: 404, body: { detail: "nope" } } });
    await expect(rest(fake).request("GET", "/identities/x")).rejects.toMatchObject({ status: 404 });
    expect(fake.calls).toHaveLength(1);
  });
});
