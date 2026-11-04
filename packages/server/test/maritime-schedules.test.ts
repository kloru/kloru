import { afterEach, describe, expect, it, vi } from "vitest";
import { createScheduleSync, schedulesEndpoint } from "../src/maritime-schedules.js";

interface Call { url: string; init: RequestInit }

function fakeFetch(status = 200): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response("{}", { status });
  }) as typeof fetch;
  return { calls, fetch: f };
}

describe("schedulesEndpoint", () => {
  it("joins without double slashes", () => {
    expect(schedulesEndpoint("https://api.maritime.sh/")).toBe("https://api.maritime.sh/api/agents/internal/schedules");
    expect(schedulesEndpoint("https://api.maritime.sh")).toBe("https://api.maritime.sh/api/agents/internal/schedules");
  });
});

describe("createScheduleSync", () => {
  afterEach(() => vi.useRealTimers());

  it("posts the list with Maritime headers", async () => {
    const { calls, fetch } = fakeFetch();
    const list = [{ id: "a", cron: "0 8 * * *", tz: "UTC", prompt: "brief", enabled: true }];
    const sync = createScheduleSync({ backendUrl: "https://backend/", agentId: "agent_1", token: "tok", read: () => list, fetchImpl: fetch });
    expect(await sync.push(true)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://backend/api/agents/internal/schedules");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["X-Maritime-Agent-Id"]).toBe("agent_1");
    expect(headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ schedules: list });
  });

  it("skips unchanged lists and pushes when they change", async () => {
    const { calls, fetch } = fakeFetch();
    let list: unknown[] = [];
    const sync = createScheduleSync({ backendUrl: "https://backend", agentId: "a", token: "t", read: () => list, fetchImpl: fetch });
    expect(await sync.push(true)).toBe(true);
    expect(await sync.push()).toBe(false);
    list = [{ id: "x", prompt: "p", enabled: true }];
    expect(await sync.push()).toBe(true);
    expect(await sync.push()).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("does not remember a failed push, so it retries next time", async () => {
    const bad = fakeFetch(500);
    const logs: string[] = [];
    const sync = createScheduleSync({ backendUrl: "https://b", agentId: "a", token: "t", read: () => [1], fetchImpl: bad.fetch, logger: (m) => logs.push(m) });
    expect(await sync.push()).toBe(false);
    expect(await sync.push()).toBe(false);
    expect(bad.calls).toHaveLength(2);
    expect(logs.some((l) => l.includes("500"))).toBe(true);
  });

  it("swallows network errors", async () => {
    const throwing = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const sync = createScheduleSync({ backendUrl: "https://b", agentId: "a", token: "t", read: () => [], fetchImpl: throwing });
    await expect(sync.push(true)).resolves.toBe(false);
  });

  it("polls on an interval and stops", async () => {
    vi.useFakeTimers();
    const { calls, fetch } = fakeFetch();
    let list: unknown[] = [];
    const sync = createScheduleSync({ backendUrl: "https://b", agentId: "a", token: "t", read: () => list, fetchImpl: fetch, intervalMs: 1000 });
    const stop = sync.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    list = [{ id: "n" }];
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    stop();
    list = [{ id: "m" }];
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
  });
});
