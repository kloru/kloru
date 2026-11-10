import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, LedgerEntry } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { Metrics } from "../src/metrics.js";

const EZRA = "+14155550190";
const NOW = new Date("2026-11-03T20:00:00Z");
const issue = (id: number, o: Partial<Issue>): Issue => ({ id, kind: "work", status: "done", request: `request ${id}`, filedBy: { phone: EZRA, call: "c1" }, baseTurn: 0, baseHash: "", resources: [], thread: [], prs: [], links: {}, createdAt: "2026-11-03T18:00:00Z", updatedAt: "2026-11-03T18:30:00Z", ...o }) as Issue;

function setup(fetchImpl: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "metrics-"));
  mkdirSync(join(dir, "sessions"));
  writeFileSync(join(dir, "sessions", `${encodeURIComponent("desk:issue:1:engineer")}.jsonl`), [JSON.stringify({ role: "assistant", usage: { cost: { total: 0.4 } }, timestamp: Date.parse("2026-11-03T18:10:00Z") }), JSON.stringify({ role: "assistant", usage: { cost: { total: 0.1 } }, timestamp: Date.parse("2026-11-03T18:20:00Z") })].join("\n") + "\n");
  mkdirSync(join(dir, "repo", "calls", "c1"), { recursive: true });
  writeFileSync(join(dir, "repo", "calls", "c1", "call.json"), JSON.stringify({ id: "c1", callSid: "CA1", phone: EZRA, channel: "voice", startedAt: "2026-11-03T18:00:00Z", endedAt: "2026-11-03T18:10:00Z" }));
  const ledger: LedgerEntry[] = [{ at: "2026-11-03T18:15:00Z", issue: 1, call: "c1", phone: EZRA, tool: "app", slug: "GOOGLECALENDAR_CREATE_EVENT", args: {}, ok: true, result: "ok", parent: "", hash: "" }];
  const m = new Metrics({ dataDir: dir, issues: () => [issue(1, {}), issue(2, { status: "failed" }), issue(3, { purpose: "memory" } as Partial<Issue>)], ledger: () => ledger, nameOf: (p) => (p.endsWith("4155550190") ? "Ezra" : undefined), timezone: "America/Los_Angeles", openrouterKeys: { main: "k", voice: "k" }, decisionKey: "d", twilio: { sid: "AC1", token: "t" }, steelKey: "s", fetchImpl, now: () => NOW });
  return { m, dir };
}

describe("metrics", () => {
  it("cost by source and day, requests and actions, time saved by Jev, and who used it", async () => {
    let usage = 10;
    const fetchImpl = (async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.includes("openrouter.ai/api/v1/key")) return json({ data: { usage: (usage += 2) } });
      if (url.includes("decisions")) return json({ answers: { minutes: { choice: "15" } } });
      if (url.includes("twilio.com")) return json({ usage_records: [{ start_date: "2026-11-03", price: "-1.25" }] });
      if (url.includes("steel.dev")) return json({ sessions: [{ createdAt: "2026-11-03T19:00:00Z", duration: 1_800_000 }] });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const { m } = setup(fetchImpl);
    await m.snapshot();
    await m.snapshot();
    expect(await m.estimate()).toBe(1);
    const r = await m.report(7);
    const today = r.days.at(-1)!;
    expect(today.date).toBe("2026-11-03");
    expect(today.modelSource).toBe("openrouter");
    expect(today.cost).toMatchObject({ models: 2, phone: 1.25, browser: 0.05, hosting: 0.52 });
    expect(today.cost.speech).toBeCloseTo(0.3);
    expect(today.desk).toEqual({ engineer: 0.5 });
    expect(today.requests).toEqual({ filed: 2, finished: 1, failed: 1 });
    expect(today.actions).toEqual({ "calendar changes": 1 });
    expect(today.minutesSaved).toBe(15);
    expect(r.people).toEqual([{ name: "Ezra", phone: "…0190", conversations: 1, requests: 2, minutesSaved: 15, costUsd: 0.5 }]);
    expect(r.recent.map((x) => [x.id, x.outcome, x.minutes])).toEqual([[2, "failed", null], [1, "done", 15]]);
  });

  it("a provider that can't be reached shows as not available, not $0; models fall back to the desk's own costs", async () => {
    const { m } = setup((async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    const today = (await m.report(3)).days.at(-1)!;
    expect(today.cost.phone).toBeNull();
    expect(today.cost.browser).toBeNull();
    expect(today.modelSource).toBe("sessions");
    expect(today.cost.models).toBeCloseTo(0.5);
  });
});

describe("metrics.db (2026-11-04)", () => {
  const line = (usd: number, at: string) => JSON.stringify({ role: "assistant", usage: { cost: { total: usd } }, timestamp: Date.parse(at) });

  it("reads only what's new in each log, waits for a half-written line, and recounts a rewritten one", async () => {
    const { m, dir } = setup((async () => new Response("", { status: 500 })) as unknown as typeof fetch);
    const log = join(dir, "sessions", `${encodeURIComponent("desk:issue:1:engineer")}.jsonl`);
    const { appendFileSync } = await import("node:fs");
    expect(await m.ingest()).toBe(2);
    expect(await m.ingest()).toBe(0);
    appendFileSync(log, `${line(0.25, "2026-11-03T19:00:00Z")}\n${line(1, "2026-11-03T19:05:00Z").slice(0, 20)}`);
    expect(await m.ingest()).toBe(1);
    appendFileSync(log, `${line(1, "2026-11-03T19:05:00Z").slice(20)}\n`);
    expect(await m.ingest()).toBe(1);
    expect(m.db.costsByIssue()[1]).toBeCloseTo(1.75);
    writeFileSync(log, `${line(0.1, "2026-11-03T18:10:00Z")}\n`);
    await m.ingest();
    expect(m.db.costsByIssue()[1]).toBeCloseTo(0.1);
  });

  it("prices each reply from its tokens at OpenRouter's price, counts the PM, and re-reads costs kept the old way", async () => {
    const prices = { data: [{ id: "openai/gpt-6.1-terra", pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.0000001" } }] };
    const fetchImpl = (async (url: string) => (url.endsWith("/api/v1/models") ? new Response(JSON.stringify(prices)) : new Response("", { status: 500 }))) as typeof fetch;
    const { m, dir } = setup(fetchImpl);
    // Pi's own figure for this reply borrowed another model's prices: 0.05, twice the real cost.
    const reply = { role: "assistant", model: "openai/gpt-6.1-terra", usage: { input: 1000, output: 2000, cacheRead: 10_000, cacheWrite: 10_000, cost: { total: 0.05 } }, timestamp: Date.parse("2026-11-03T19:00:00Z") };
    writeFileSync(join(dir, "sessions", `${encodeURIComponent("desk:pm")}.jsonl`), `${JSON.stringify(reply)}\n`);
    expect(await m.ingest()).toBe(3);
    // 1000 × $1/M + 2000 × $5/M + 10k cached × $0.10/M + 10k written at the input price.
    expect(m.db.costsByRole("2026-11-03")["2026-11-03"]!.pm).toBeCloseTo(0.001 + 0.01 + 0.001 + 0.01);
    // Unpriced models keep the cost their session recorded.
    expect(m.db.costsByRole("2026-11-03")["2026-11-03"]!.engineer).toBeCloseTo(0.5);
    m.db.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(join(dir, "metrics", "metrics.db"));
    raw.exec("UPDATE meta SET value = '1' WHERE key = 'costs_version'");
    raw.close();
    const again = new Metrics({ dataDir: dir, issues: () => [], ledger: () => [], nameOf: () => undefined, timezone: "America/Los_Angeles", openrouterKeys: {}, fetchImpl, now: () => NOW });
    expect(again.db.costsByIssue()).toEqual({});
    expect(await again.ingest()).toBe(3);
  });

  it("brings in the first version's files once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-old-"));
    mkdirSync(join(dir, "metrics"));
    writeFileSync(join(dir, "metrics", "openrouter.jsonl"), `${JSON.stringify({ at: "2026-11-03T20:00:00Z", usage: { main: 10 } })}\n${JSON.stringify({ at: "2026-11-03T21:00:00Z", usage: { main: 12.5 } })}\n`);
    writeFileSync(join(dir, "metrics", "saved.json"), JSON.stringify({ 7: 30 }));
    const m = new Metrics({ dataDir: dir, issues: () => [], ledger: () => [], nameOf: () => undefined, timezone: "America/Los_Angeles", openrouterKeys: {}, now: () => NOW });
    expect(m.db.readings()).toHaveLength(2);
    expect(m.db.saved()).toEqual({ 7: 30 });
    expect((await m.report(2)).days.at(-1)!.cost.models).toBeCloseTo(2.5);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "metrics", "openrouter.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "metrics", "openrouter.jsonl.imported"))).toBe(true);
  });
});
