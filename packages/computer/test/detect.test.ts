import { describe, expect, it } from "vitest";
import { DEFAULT_MARITIME_MCP_URL, DESKTOPD_BACKOFF_MS, DesktopdClient, MaritimeMcpBackend, detectComputer, waitForDesktopd } from "../src/index.js";
import { fakeFetch, jsonResponse, unreachableFetch } from "./fake-fetch.js";

const healthy = () => fakeFetch({ "GET /health": () => jsonResponse({ ok: true, mode: "agent" }) });

/** A fetch that refuses the first `refusals` /health calls like a port nobody listens on, then answers ok. */
function lateFetch(refusals: number): { fetchImpl: typeof fetch; healthCalls: () => number } {
  let calls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/health")) {
      calls += 1;
      if (calls <= refusals) throw new TypeError("fetch failed: ECONNREFUSED");
      return jsonResponse({ ok: true, mode: "agent" });
    }
    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, healthCalls: () => calls };
}

/** A sleep that records waits and returns at once. */
function instantSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

describe("detectComputer", () => {
  it("auto picks desktopd when /health answers ok", async () => {
    const { fetchImpl, calls } = healthy();
    const logs: string[] = [];
    const backend = await detectComputer({ mode: "auto", fetchImpl, logger: (m) => logs.push(m), maritimeApiKey: "mk_x" });
    expect(backend?.kind).toBe("desktopd");
    expect(calls[0]?.path).toBe("/health");
    expect(logs.join("\n")).toContain("desktopd");
  });

  it("auto honours a custom desktopd url", async () => {
    const { fetchImpl } = healthy();
    const backend = await detectComputer({ mode: "auto", fetchImpl, desktopdUrl: "http://10.0.0.2:5911" });
    expect(backend?.describe()).toContain("http://10.0.0.2:5911");
  });

  it("auto falls back to the hosted MCP when desktopd is down and a key exists", async () => {
    const backend = await detectComputer({
      mode: "auto",
      fetchImpl: unreachableFetch(),
      maritimeMcpUrl: "https://mcp.example.test",
      maritimeApiKey: "mk_test",
      externalUserId: "user-1",
    });
    expect(backend).toBeInstanceOf(MaritimeMcpBackend);
    expect((backend as MaritimeMcpBackend).endpoint).toBe("https://mcp.example.test/mcp/u/user-1");
    expect(backend?.describe()).not.toContain("mk_test");
  });

  it("auto defaults the hosted url when only the key is given", async () => {
    const backend = await detectComputer({ mode: "auto", fetchImpl: unreachableFetch(), maritimeApiKey: "mk_test" });
    expect((backend as MaritimeMcpBackend).endpoint).toBe(`${DEFAULT_MARITIME_MCP_URL}/mcp/u/owner`);
  });

  it("auto returns undefined with no desktopd and no key", async () => {
    const logs: string[] = [];
    const backend = await detectComputer({ mode: "auto", fetchImpl: unreachableFetch(), logger: (m) => logs.push(m) });
    expect(backend).toBeUndefined();
    expect(logs.join("\n")).toContain("none");
  });

  it("auto without the platform flag keeps the single fast probe", async () => {
    const late = lateFetch(1);
    const { sleep, waits } = instantSleep();
    const backend = await detectComputer({ mode: "auto", fetchImpl: late.fetchImpl, sleep, maritimeApiKey: "mk_x" });
    expect(late.healthCalls()).toBe(1);
    expect(waits).toEqual([]);
    expect(backend).toBeInstanceOf(MaritimeMcpBackend);
  });

  it("auto with expectDesktopd polls through a slow desktopd start and picks desktopd", async () => {
    const late = lateFetch(3);
    const { sleep, waits } = instantSleep();
    const logs: string[] = [];
    const backend = await detectComputer({
      mode: "auto",
      expectDesktopd: true,
      fetchImpl: late.fetchImpl,
      sleep,
      logger: (m) => logs.push(m),
      // A hosted key must not win over the VM's own desktop while it is starting.
      maritimeApiKey: "mk_x",
    });
    expect(backend?.kind).toBe("desktopd");
    expect(late.healthCalls()).toBe(4);
    expect(waits).toEqual([DESKTOPD_BACKOFF_MS[0], DESKTOPD_BACKOFF_MS[1], DESKTOPD_BACKOFF_MS[2]]);
    expect(logs.join("\n")).toContain("waiting");
    expect(logs.join("\n")).toContain("desktopd at");
  });

  it("auto with expectDesktopd keeps desktopd even when the budget runs out", async () => {
    let clock = 0;
    const waits: number[] = [];
    const logs: string[] = [];
    const backend = await detectComputer({
      mode: "auto",
      expectDesktopd: true,
      fetchImpl: unreachableFetch(),
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
      desktopdWaitMs: 3_000,
      logger: (m) => logs.push(m),
      maritimeApiKey: "mk_x",
    });
    expect(backend?.kind).toBe("desktopd");
    expect(waits).toEqual([1_000, 2_000]);
    expect(logs.join("\n")).toContain("still starting");
  });

  it("desktopd mode waits for a late start instead of warning", async () => {
    const late = lateFetch(2);
    const { sleep } = instantSleep();
    const logs: string[] = [];
    const backend = await detectComputer({ mode: "desktopd", fetchImpl: late.fetchImpl, sleep, logger: (m) => logs.push(m) });
    expect(backend?.kind).toBe("desktopd");
    expect(late.healthCalls()).toBe(3);
    expect(logs.join("\n")).not.toContain("not reachable");
  });

  it("none returns undefined without touching the network", async () => {
    const { fetchImpl, calls } = healthy();
    expect(await detectComputer({ mode: "none", fetchImpl, maritimeApiKey: "mk_x" })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("desktopd keeps the backend even when health fails, and says so", async () => {
    const logs: string[] = [];
    const backend = await detectComputer({ mode: "desktopd", fetchImpl: unreachableFetch(), desktopdWaitMs: 0, logger: (m) => logs.push(m) });
    expect(backend?.kind).toBe("desktopd");
    expect(logs.join("\n")).toContain("not reachable");
  });

  it("maritime requires both url and key", async () => {
    await expect(detectComputer({ mode: "maritime", maritimeMcpUrl: "https://mcp.example.test" })).rejects.toThrow(/MARITIME_API_KEY/);
    const backend = await detectComputer({ mode: "maritime", maritimeApiKey: "mk_test" });
    expect(backend?.kind).toBe("maritime");
  });

  it("rejects unknown modes", async () => {
    await expect(detectComputer({ mode: "cloud" as never })).rejects.toThrow(/unknown computer mode/);
  });
});

describe("waitForDesktopd", () => {
  it("returns the first ok health without sleeping", async () => {
    const { fetchImpl } = healthy();
    const { sleep, waits } = instantSleep();
    const health = await waitForDesktopd({ client: new DesktopdClient({ fetchImpl }), waitMs: 60_000, sleep });
    expect(health?.ok).toBe(true);
    expect(waits).toEqual([]);
  });

  it("backs off 1 s, 2 s, 4 s, then 5 s and never sleeps past the deadline", async () => {
    const late = lateFetch(6);
    const { sleep, waits } = instantSleep();
    let clock = 0;
    const health = await waitForDesktopd({
      client: new DesktopdClient({ fetchImpl: late.fetchImpl }),
      waitMs: 14_000,
      sleep: async (ms) => {
        clock += ms;
        await sleep(ms);
      },
      now: () => clock,
    });
    expect(health).toBeUndefined();
    // 1 + 2 + 4 + 5 = 12 s, then only 2 s of budget remain.
    expect(waits).toEqual([1_000, 2_000, 4_000, 5_000, 2_000]);
    expect(late.healthCalls()).toBe(6);
  });

  it("a zero budget is exactly one probe", async () => {
    const late = lateFetch(1);
    const { sleep, waits } = instantSleep();
    const health = await waitForDesktopd({ client: new DesktopdClient({ fetchImpl: late.fetchImpl }), waitMs: 0, sleep });
    expect(health).toBeUndefined();
    expect(late.healthCalls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it("treats ok:false as not ready", async () => {
    let n = 0;
    const { fetchImpl } = fakeFetch({ "GET /health": () => jsonResponse({ ok: ++n > 1 }) });
    const { sleep } = instantSleep();
    const health = await waitForDesktopd({ client: new DesktopdClient({ fetchImpl }), waitMs: 10_000, sleep });
    expect(health?.ok).toBe(true);
    expect(n).toBe(2);
  });
});
