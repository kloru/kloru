import { describe, expect, it } from "vitest";
import { AuditLog, localDate } from "../src/audit.js";
import type { AuditEntry } from "../src/types.js";
import { tempState } from "./helpers.js";

function raw(state: ReturnType<typeof tempState>, e: AuditEntry): void {
  state.appendLine("audit.jsonl", JSON.stringify(e));
}

describe("localDate", () => {
  it("formats the calendar date in a zone and falls back to UTC on a bad zone", () => {
    const d = new Date("2026-10-03T02:30:00Z");
    expect(localDate(d, "UTC")).toBe("2026-10-03");
    expect(localDate(d, "America/New_York")).toBe("2026-10-02");
    expect(localDate(d, "Asia/Tokyo")).toBe("2026-10-03");
    expect(localDate(d, "Not/AZone")).toBe("2026-10-03");
  });
});

describe("AuditLog", () => {
  it("appends with a timestamp and reads back in order", () => {
    const state = tempState();
    const log = new AuditLog(state);
    log.append({ kind: "inbound", principal: "owner", detail: { text: "hi" } });
    log.append({ kind: "tool_call", principal: "owner", conversationKey: "chat:1", detail: { tool: "web_search" } });
    const all = log.read();
    expect(all).toHaveLength(2);
    expect(all[0]!.kind).toBe("inbound");
    expect(Date.parse(all[0]!.at)).not.toBeNaN();
    expect(all[1]).toMatchObject({ kind: "tool_call", conversationKey: "chat:1", detail: { tool: "web_search" } });
  });

  it("filters by kind and since, and limit keeps the newest", () => {
    const state = tempState();
    const log = new AuditLog(state);
    raw(state, { at: "2026-10-01T10:00:00Z", kind: "inbound", detail: {} });
    raw(state, { at: "2026-10-02T10:00:00Z", kind: "spend", detail: { amountUsd: 10 } });
    raw(state, { at: "2026-10-03T10:00:00Z", kind: "tool_call", detail: {} });
    raw(state, { at: "2026-10-03T11:00:00Z", kind: "spend", detail: { amountUsd: 20 } });
    expect(log.read({ kinds: ["spend"] }).map((e) => e.detail.amountUsd)).toEqual([10, 20]);
    expect(log.read({ since: "2026-10-03T00:00:00Z" })).toHaveLength(2);
    expect(log.read({ limit: 1 })[0]!.at).toBe("2026-10-03T11:00:00Z");
    expect(log.read({ kinds: ["inbound", "tool_call"], limit: 5 })).toHaveLength(2);
  });

  it("skips a torn line instead of failing", () => {
    const state = tempState();
    const log = new AuditLog(state);
    raw(state, { at: "2026-10-01T10:00:00Z", kind: "inbound", detail: {} });
    state.appendLine("audit.jsonl", '{"at":"2026-10-01T10:01:00Z","kind":"inb');
    log.append({ kind: "outbound", detail: {} });
    expect(log.read().map((e) => e.kind)).toEqual(["inbound", "outbound"]);
  });

  it("sums today's spend in the owner's zone", () => {
    const state = tempState();
    const log = new AuditLog(state);
    // 2026-10-03 03:00Z is still 2026-10-02 in New York.
    raw(state, { at: "2026-10-03T03:00:00Z", kind: "spend", detail: { amountUsd: 100 } });
    raw(state, { at: "2026-10-03T13:00:00Z", kind: "spend", detail: { amountUsd: 12.5 } });
    raw(state, { at: "2026-10-03T20:00:00Z", kind: "spend", detail: { amountUsd: 7.25 } });
    raw(state, { at: "2026-10-03T21:00:00Z", kind: "spend", detail: { amountUsd: "oops" } });
    raw(state, { at: "2026-10-03T21:30:00Z", kind: "tool_call", detail: { amountUsd: 999 } });
    raw(state, { at: "2026-10-04T05:00:00Z", kind: "spend", detail: { amountUsd: 50 } }); // Oct 4 01:00 in NY
    const now = new Date("2026-10-03T22:00:00Z");
    expect(log.spentTodayUsd("America/New_York", now)).toBe(19.75);
    expect(log.spentTodayUsd("UTC", now)).toBe(119.75);
    expect(log.spentTodayUsd("America/New_York", new Date("2026-10-04T06:00:00Z"))).toBe(50);
    expect(new AuditLog(tempState()).spentTodayUsd("UTC", now)).toBe(0);
  });
});
