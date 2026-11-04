import { describe, expect, it } from "vitest";
import { AuditLog } from "../src/audit.js";
import { NOTICE_WINDOW_MS, OwnerNotifier } from "../src/notifier.js";
import { tempState } from "./helpers.js";

describe("OwnerNotifier", () => {
  const notice = { conversationKey: "a2a:ctx1", principal: "agent:sam-instinct", action: "see your calendar", outcome: "declined" as const };

  it("texts the owner once per conversation per hour and audits it", async () => {
    let now = new Date("2026-10-03T12:00:00Z");
    const state = tempState();
    const audit = new AuditLog(state);
    const sent: string[] = [];
    const n = new OwnerNotifier({ state, audit, now: () => now, send: async (text) => void sent.push(text) });

    expect(await n.notify(notice, "Sam's Kloru")).toBe(true);
    expect(sent).toEqual(["Sam's Kloru asked to see your calendar; I declined."]);
    expect(await n.notify({ ...notice, action: "read your email" }, "Sam's Kloru")).toBe(false);
    expect(sent).toHaveLength(1);
    // A different conversation is not throttled by the first.
    expect(await n.notify({ ...notice, conversationKey: "imessage:alex" }, "Alex")).toBe(true);
    expect(sent).toHaveLength(2);

    now = new Date(now.getTime() + NOTICE_WINDOW_MS + 1);
    expect(await n.notify(notice, "Sam's Kloru")).toBe(true);
    expect(sent).toHaveLength(3);
    const entries = audit.read({ kinds: ["policy"] });
    expect(entries).toHaveLength(3);
    expect(entries[0]!.detail).toMatchObject({ ownerNotified: true, action: "see your calendar", outcome: "declined" });
  });

  it("survives a failing send and records the error", async () => {
    const state = tempState();
    const audit = new AuditLog(state);
    const n = new OwnerNotifier({ state, audit, send: async () => { throw new Error("no phone"); } });
    expect(await n.notify(notice, "Sam")).toBe(false);
    expect(audit.read({ kinds: ["error"] })[0]!.detail.message).toMatch(/no phone/);
    // The attempt still counts against the window, so a flapping outbox does not spam.
    expect(await n.notify(notice, "Sam")).toBe(false);
  });

  it("words an ask differently from a refusal", () => {
    expect(OwnerNotifier.text({ ...notice, outcome: "asked" }, "Sam")).toBe("Sam asked to see your calendar; I am asking you first.");
  });
});
