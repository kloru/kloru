/**
 * The issue lifecycle as a state machine. Every status change in the desk goes through
 * `transition`, so an issue can never jump somewhere the design doesn't allow (a finished
 * write back to in-progress, a cancelled issue back to work).
 *
 *   work: open → in_progress → in_review → merged      (in_review → in_progress: sent back;
 *         in_review → needs_info: the result was a question for the caller)
 *   ops:  open → executing ⇄ needs_confirmation → done → reverted
 *   any open state → needs_info, resolved, duplicate, wont_do, superseded, not_planned, failed
 *   (open → failed: the PM couldn't be reached and the desk gave up)
 *   resolved/merged → open: the caller answered or followed up, so the same issue continues
 *   in_progress/executing → open: the worker was lost; back to the PM, which decides
 */
import { err, ok, type Result } from "./result.js";
import type { Issue, IssueStatus } from "./types.js";

const CLOSE: IssueStatus[] = ["resolved", "duplicate", "wont_do", "superseded", "not_planned"];

const TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ["in_progress", "executing", "needs_info", "failed", ...CLOSE],
  // A worker still running when the PM asked the caller can land its PR or fail.
  needs_info: ["open", "in_progress", "in_review", "executing", "failed", ...CLOSE],
  // → open: its worker was lost (the sweeper found it); the PM decides what happens next.
  in_progress: ["in_review", "needs_info", "needs_confirmation", "failed", "open", ...CLOSE],
  in_review: ["merged", "in_progress", "needs_info", "failed", ...CLOSE],
  executing: ["needs_confirmation", "done", "failed", "wont_do", "superseded", "open"],
  // Any worker may ask for a yes (its guidelines decide); the yes sends it back to work.
  needs_confirmation: ["executing", "in_progress", "failed", "wont_do", "superseded"],
  failed: ["in_progress", "executing", "wont_do", "not_planned"],
  done: ["reverted"],
  merged: ["open"],
  reverted: [],
  resolved: ["open"],
  duplicate: [],
  wont_do: [],
  superseded: [],
  not_planned: [],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** The issue in its new status, or why it can't move. Staying put is always allowed. */
export function transition(issue: Issue, to: IssueStatus): Result<Issue> {
  if (!canTransition(issue.status, to)) return err(`issue ${issue.id} can't go from ${issue.status} to ${to}`);
  issue.status = to;
  return ok(issue);
}
