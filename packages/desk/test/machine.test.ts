import { describe, expect, it } from "vitest";
import { canTransition, transition } from "../src/machine.js";
import { andThen, err, map, ok } from "../src/result.js";
import type { Issue } from "../src/types.js";

const issue = (status: Issue["status"]): Issue => ({ id: 1, kind: "work", status, request: "x", filedBy: { phone: "+1", call: "c" }, baseTurn: 0, baseHash: "0", resources: [], thread: [], prs: [], links: {}, createdAt: "", updatedAt: "" });

describe("issue state machine", () => {
  it("allows the lifecycle in the design and nothing else", () => {
    expect(canTransition("open", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "in_review")).toBe(true);
    expect(canTransition("in_review", "merged")).toBe(true);
    expect(canTransition("in_review", "in_progress")).toBe(true);
    expect(canTransition("executing", "needs_confirmation")).toBe(true);
    expect(canTransition("needs_confirmation", "executing")).toBe(true);
    expect(canTransition("done", "reverted")).toBe(true);
    expect(canTransition("done", "in_progress")).toBe(false);
    expect(canTransition("wont_do", "executing")).toBe(false);
    expect(canTransition("open", "done")).toBe(false);
    expect(canTransition("open", "failed")).toBe(true);
    expect(canTransition("needs_info", "in_review")).toBe(true);
    // #3: a finished result that is really a question goes to the caller; their answer reopens a resolved issue.
    expect(canTransition("in_review", "needs_info")).toBe(true);
    expect(canTransition("resolved", "open")).toBe(true);
    expect(canTransition("merged", "open")).toBe(true);
    expect(canTransition("wont_do", "open")).toBe(false);
  });

  it("transition is a Result: the new issue, or why not", () => {
    const moved = transition(issue("open"), "in_progress");
    expect(moved.ok && moved.value.status).toBe("in_progress");
    expect(transition(issue("done"), "in_progress")).toEqual({ ok: false, error: "issue 1 can't go from done to in_progress" });
    expect(transition(issue("merged"), "merged").ok).toBe(true);
  });
});

describe("Result", () => {
  it("map and andThen short-circuit on the first error", () => {
    expect(map(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });
    expect(map(err("no"), (n: number) => n * 3)).toEqual({ ok: false, error: "no" });
    expect(andThen(ok(2), (n) => (n > 1 ? ok(n) : err("small")))).toEqual({ ok: true, value: 2 });
    expect(andThen(ok(0), (n) => (n > 1 ? ok(n) : err("small")))).toEqual({ ok: false, error: "small" });
  });
});
