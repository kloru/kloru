/** The reviews an issue owes: every move, the round caps, and an old issue's QA read into a review. */
import { describe, expect, it } from "vitest";
import { REVIEW_ROUNDS, canReview, fromLegacyQa, openReview, passReview, reviewOf, sendBackReview, settled, waiveReview } from "../src/reviews.js";
import type { Issue, ReviewState } from "../src/types.js";

const AT = "2026-11-10T10:00:00.000Z";
const LATER = "2026-11-10T10:05:00.000Z";
const issue = (extra: Partial<Issue> = {}): Issue => ({ id: 1, kind: "work", status: "in_progress", request: "Make us a list", filedBy: { phone: "+14155550191", call: "c1" }, baseTurn: 0, baseHash: "", resources: [], thread: [], prs: [], links: {}, createdAt: AT, updatedAt: AT, ...extra });
const tried = (i: Issue, version = 1) => openReview(i, { kind: "result", how: "tried", askedBy: "gate", version }, AT);
const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("the review plan", () => {
  it("allows exactly the moves in the design", () => {
    const states: ReviewState[] = ["open", "passed", "changes", "waived"];
    const allowed = states.flatMap((from) => states.filter((to) => canReview(from, to)).map((to) => `${from}>${to}`));
    expect(allowed.sort()).toEqual(["changes>open", "changes>waived", "open>changes", "open>passed", "open>waived", "passed>open", "waived>open"]);
  });

  it("an issue with no reviews is settled; an open one or one awaiting changes is not", () => {
    const i = issue();
    expect(settled(i)).toBe(true);
    const r = must(tried(i));
    expect(r).toMatchObject({ kind: "result", how: "tried", askedBy: "gate", state: "open", rounds: 0, version: 1, at: AT });
    expect(settled(i)).toBe(false);
    must(sendBackReview(r, "Add does nothing.", LATER));
    expect(r).toMatchObject({ state: "changes", rounds: 1, notes: "Add does nothing.", at: LATER });
    expect(settled(i)).toBe(false);
    must(waiveReview(r, "not checked again", LATER));
    expect(settled(i)).toBe(true);
  });

  it("passes with the reviewer's notes, and a passed review can't pass again", () => {
    const i = issue();
    const r = must(tried(i));
    must(passReview(r, "", LATER));
    expect(r).toMatchObject({ state: "passed", at: LATER });
    expect(r.notes).toBeUndefined();
    expect(passReview(r, "", LATER)).toEqual({ ok: false, error: "a result review can't go from passed to passed" });
    expect(sendBackReview(r, "x", LATER).ok).toBe(false);
  });

  it("one review per kind: opening again checks the next version and keeps the rounds", () => {
    const i = issue();
    const r = must(tried(i, 1));
    r.verdict = { approve: false, notes: "Add does nothing." };
    must(sendBackReview(r, "Add does nothing.", LATER));
    const again = must(tried(i, 2));
    expect(again).toBe(r);
    expect(i.reviews).toHaveLength(1);
    expect(again).toMatchObject({ state: "open", rounds: 1, version: 2 });
    expect(again.verdict).toBeUndefined();
    expect(reviewOf(i, "result")).toBe(r);
    expect(reviewOf(i, "spec")).toBeUndefined();
    // Opening one that's already open (a worker was lost mid-check) is the same review, not an error.
    expect(must(tried(i, 3))).toMatchObject({ state: "open", version: 3, rounds: 1 });
  });

  it("at the cap a send-back is a waiver that carries the notes", () => {
    const i = issue();
    const r = must(tried(i));
    for (let round = 1; round <= REVIEW_ROUNDS.result; round++) {
      must(sendBackReview(r, "Add does nothing.", LATER));
      expect(r).toMatchObject({ state: "changes", rounds: round });
      must(tried(i, round + 1));
    }
    must(sendBackReview(r, "Add does nothing.", LATER));
    expect(r).toMatchObject({ state: "waived", rounds: REVIEW_ROUNDS.result, notes: "Add does nothing." });
    expect(REVIEW_ROUNDS).toEqual({ spec: 1, plan: 1, result: 3 });
  });

  it("reads an old issue's qa into a tried review once, keeping its rounds", () => {
    const fixing = fromLegacyQa(issue({ qa: { rounds: 2, version: 3, verdict: { usable: false, bugs: "Add does nothing." } } }));
    expect(fixing.qa).toBeUndefined();
    expect(fixing.reviews).toEqual([{ kind: "result", how: "tried", askedBy: "gate", state: "changes", rounds: 2, version: 3, notes: "Add does nothing.", at: AT }]);
    expect(fromLegacyQa(issue({ qa: { rounds: 0, version: 1 } })).reviews).toMatchObject([{ state: "open", rounds: 0, version: 1 }]);
    expect(fromLegacyQa(issue({ status: "in_review", qa: { rounds: 0, version: 1, verdict: { usable: true, bugs: "" } } })).reviews).toMatchObject([{ state: "passed" }]);
    expect(fromLegacyQa(issue({ status: "merged", qa: { rounds: 3, version: 4, verdict: { usable: false, bugs: "Add does nothing." } } })).reviews).toMatchObject([{ state: "waived", rounds: 3 }]);
    expect(fromLegacyQa(issue({ status: "merged", qa: { rounds: 0, version: 1 } })).reviews).toMatchObject([{ state: "waived" }]);
    // Already converted, or never had QA: left alone.
    const plain = issue();
    expect(fromLegacyQa(plain)).toBe(plain);
    expect(plain.reviews).toBeUndefined();
    const both = issue({ reviews: [], qa: { rounds: 1 } });
    expect(fromLegacyQa(both).reviews).toEqual([]);
  });
});
