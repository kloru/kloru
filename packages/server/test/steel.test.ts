/**
 * Opening a Steel session, with Steel and its browser stood in for.
 *
 * 2026-11-12: a session with a profile is "live" a few seconds before its browser can be reached,
 * and the one attempt to connect failed every time ("Target browser not available"), so Kloru had
 * no browser at all; each failure also left a session running until its time limit.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { describe, expect, it } from "vitest";
import { openSteel } from "../src/steel.js";

function steel() {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: { body?: string }) => {
    const path = new URL(url).pathname.replace("/v1", "");
    calls.push({ path, body: JSON.parse(init.body ?? "{}") });
    return new Response(JSON.stringify(path === "/sessions" ? { id: "s1", profileId: "p1" } : {}), { status: path === "/sessions" ? 201 : 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const browser = { contexts: () => [{}], close: async () => {} } as unknown as Browser;
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "steel-"));
  writeFileSync(join(d, "steel.json"), JSON.stringify({ profileId: "p1" }));
  return d;
};

describe("opening a Steel session (2026-11-12)", () => {
  it("a browser that isn't there yet is asked again until it is", async () => {
    const s = steel();
    let tries = 0;
    const opened = await openSteel({ apiKey: "k", dir: dir(), log: () => {}, fetchImpl: s.fetchImpl, retryMs: 5, connect: async () => (++tries < 3 ? Promise.reject(new Error("Target browser not available.")) : browser) });
    expect(tries).toBe(3);
    expect(opened.sessionId).toBe("s1");
    expect(s.calls.map((c) => c.path)).toEqual(["/sessions"]);
    expect(s.calls[0]!.body).toMatchObject({ useProxy: true, profileId: "p1" });
    await opened.close();
  });

  it("a browser that never comes is given up on, and its session is released", async () => {
    const s = steel();
    let tries = 0;
    const lines: string[] = [];
    await expect(openSteel({ apiKey: "k", dir: dir(), log: (m) => lines.push(m), fetchImpl: s.fetchImpl, retryMs: 5, connect: async () => (tries++, Promise.reject(new Error("Target browser not available. wss://connect.steel.dev?apiKey=k"))) })).rejects.toThrow(/Steel's browser didn't come up/);
    expect(tries).toBeGreaterThan(3);
    expect(s.calls.map((c) => c.path)).toEqual(["/sessions", "/sessions/s1/release"]);
    expect(lines.join("\n")).not.toContain("apiKey=k");
  });
});
