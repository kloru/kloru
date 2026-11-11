/**
 * The reviews an issue owes before its result is delivered. Each is a small state machine:
 *
 *   open → passed                     the reviewer found nothing that matters
 *   open → changes → open             the maker was sent back and ran again (rounds + 1)
 *   open → waived, changes → waived   no verdict, the round cap, or the maker changed nothing
 *   passed/waived → open              a later version is checked again
 *
 * Pure: the desk decides who reviews and when; this says what state that leaves.
 */
import { err, ok, type Result } from "./result.js";
import type { Issue, Review, ReviewHow, ReviewKind, ReviewState } from "./types.js";

/** How many times each kind sends its maker back before the notes go on with the work. */
export const REVIEW_ROUNDS: Record<ReviewKind, number> = { spec: 1, plan: 1, result: 3 };

const MOVES: Record<ReviewState, readonly ReviewState[]> = {
  open: ["passed", "changes", "waived"],
  changes: ["open", "waived"],
  passed: ["open"],
  waived: ["open"],
};

export function canReview(from: ReviewState, to: ReviewState): boolean {
  return MOVES[from].includes(to);
}

function move(r: Review, to: ReviewState, at: string): Result<Review> {
  if (!canReview(r.state, to)) return err(`a ${r.kind} review can't go from ${r.state} to ${to}`);
  r.state = to;
  r.at = at;
  return ok(r);
}

/** The issue's review of this kind: one per kind, checked again for each new version. */
export function reviewOf(issue: Issue, kind: ReviewKind): Review | undefined {
  return issue.reviews?.find((r) => r.kind === kind);
}

/** Start this kind's review, or check again after the maker ran. */
export function openReview(issue: Issue, o: { kind: ReviewKind; how: ReviewHow; askedBy: Review["askedBy"]; version?: number }, at: string): Result<Review> {
  const had = reviewOf(issue, o.kind);
  if (!had) {
    const r: Review = { kind: o.kind, how: o.how, askedBy: o.askedBy, state: "open", rounds: 0, ...(o.version !== undefined ? { version: o.version } : {}), at };
    (issue.reviews ??= []).push(r);
    return ok(r);
  }
  if (had.state !== "open") {
    const moved = move(had, "open", at);
    if (!moved.ok) return moved;
  }
  had.how = o.how;
  had.at = at;
  if (o.version !== undefined) had.version = o.version;
  delete had.verdict;
  return ok(had);
}

export function passReview(r: Review, notes: string, at: string): Result<Review> {
  const moved = move(r, "passed", at);
  if (!moved.ok) return moved;
  if (notes) r.notes = notes;
  else delete r.notes;
  return moved;
}

/** Back to the maker with the reviewer's list; at the cap it's waived and the list goes on with the work. */
export function sendBackReview(r: Review, notes: string, at: string): Result<Review> {
  const capped = r.rounds >= REVIEW_ROUNDS[r.kind];
  const moved = move(r, capped ? "waived" : "changes", at);
  if (!moved.ok) return moved;
  if (!capped) r.rounds += 1;
  r.notes = notes;
  return moved;
}

export function waiveReview(r: Review, why: string, at: string): Result<Review> {
  const moved = move(r, "waived", at);
  if (moved.ok) r.notes = why;
  return moved;
}

/** Nothing is open or awaiting changes: the result can be delivered. */
export function settled(issue: Issue): boolean {
  return !issue.reviews?.some((r) => r.state === "open" || r.state === "changes");
}

/** An issue saved before reviews: its QA state becomes a tried review, once. */
export function fromLegacyQa(issue: Issue): Issue {
  const qa = issue.qa;
  if (!qa) return issue;
  delete issue.qa;
  if (issue.reviews) return issue;
  const working = issue.status === "in_progress";
  const good = qa.verdict ? qa.verdict.usable || !qa.verdict.bugs : undefined;
  const state: ReviewState = good ? "passed" : working ? (good === false ? "changes" : "open") : "waived";
  issue.reviews = [{ kind: "result", how: "tried", askedBy: "gate", state, rounds: qa.rounds, ...(qa.version !== undefined ? { version: qa.version } : {}), ...(qa.verdict?.bugs ? { notes: qa.verdict.bugs } : {}), at: issue.updatedAt }];
  return issue;
}
