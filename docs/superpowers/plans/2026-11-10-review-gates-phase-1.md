# Review Gates, Phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each ticket carries the reviews it owes; app QA becomes the first of them; a Jev decision says whether a changed app needs trying; an engineer's message waits until that check is settled.

**Architecture:** `reviews.ts` (desk) is a pure unit: review types, a small state machine, round caps. The desk's QA code keeps its flow but stores its state in `Issue.reviews` instead of `Issue.qa`. A new optional `decideResult` on the desk is asked once an engineer finishes with a changed app and no result review yet; without it, or when it fails, the app is tried as today. `messageCaller` keeps a worker's message on the issue while the check is unsettled and releases it when the result goes to the PM.

**Tech Stack:** TypeScript, vitest, pnpm workspaces (`@kloru/desk`, `@kloru/server`), Jev (`typesafe/jev-1.14`) through `https://openrouter.ai/api/alpha/decisions`.

**Spec:** `docs/superpowers/specs/2026-11-10-review-gates-design.md` (phase 1 only).

## Global Constraints

- With no `decideResult` configured, every test in `packages/desk/test/app-qa.test.ts` passes with only its `qa:` assertions renamed to `reviews:`.
- A gate timeout, error, `unsure`, or low confidence means the app is tried. Nothing a gate does may stall a ticket.
- Jev only: model `typesafe/jev-1.14`, `provider: { zdr: true }`, 3 s timeout. Never `typesafe/jev-router`, never an Anthropic model.
- The gate's criteria are guidelines in the decider's `criteria` strings. No keyword rules in code.
- Expected failures return `Result` (`packages/desk/src/result.ts`); they are not thrown.
- No real person's name or family detail in tests or cases. Use the names already in the tests (Ezra, Cleo, Sam) and invented requests.
- Work on branch `review-gates`. Do not push: a push to `main` deploys.
- Commit messages follow the repo's style (`feat(scope): a sentence saying what is now true`) and end with `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Review Focus

1. The gate hangs or throws: the app is still tried, and the ticket moves. (Task 3)
2. The person cancels while the gate is deciding: no QA run starts and no result goes to the PM. (Task 3)
3. The person texts more while the gate is deciding: the engineer gets it; it is not lost. (Task 3)
4. A ticket stored before the deploy, with the old `qa` field: it keeps its round count and state. (Task 1)
5. QA still finds bugs after three rounds, or the engineer changes nothing after a send-back: the engineer's kept "here's your link" is not sent as if all were well; the PM sees it on the thread. (Task 4)

## Files

| File | Change |
|---|---|
| `packages/desk/src/types.ts` | `Review` types, `HeldMessage`, `Issue.reviews`, `Issue.heldMessages`; `Issue.qa` kept only as the legacy shape |
| `packages/desk/src/reviews.ts` (new) | review state machine, caps, `settled`, `fromLegacyQa` |
| `packages/desk/src/repo.ts` | converts a legacy `qa` when issues load |
| `packages/desk/src/desk.ts` | QA on the review plan; `decideResult` gate; message hold and release |
| `packages/desk/src/index.ts` | exports |
| `packages/desk/test/reviews.test.ts` (new) | the pure unit |
| `packages/desk/test/app-qa.test.ts` | renamed assertions; gate and hold tests |
| `packages/server/src/result-gate.ts` (new) | the Jev decider |
| `packages/server/test/result-gate.test.ts`, `result-gate.live.test.ts` (new) | shape tests; labeled cases |
| `packages/server/src/boot.ts` | wiring, `KLORU_RESULT_GATE` |
| `SETUP.md`, `docs/KEYS.md`, `docs/ARCHITECTURE.md` | the new switch and one paragraph |

Commands used throughout (run from the repo root):

- One desk test file: `pnpm --filter @kloru/desk exec vitest run test/<file>`
- One server test file: `pnpm --filter @kloru/desk run build && pnpm --filter @kloru/server exec vitest run test/<file>` (the server imports the desk's build)
- Types: `pnpm --filter @kloru/desk run typecheck`

---

### Task 1: The review plan (pure unit)

**Files:**
- Modify: `packages/desk/src/types.ts` (after the `IssueTarget`/before `Issue`, and inside `Issue` at the `qa?` line, ~76)
- Create: `packages/desk/src/reviews.ts`
- Modify: `packages/desk/src/repo.ts:124-128`, `packages/desk/src/index.ts`
- Test: `packages/desk/test/reviews.test.ts`

**Interfaces:**
- Produces (from `reviews.ts`): `REVIEW_ROUNDS`, `canReview(from, to)`, `reviewOf(issue, kind)`, `openReview(issue, o, at): Result<Review>`, `passReview(r, notes, at): Result<Review>`, `sendBackReview(r, notes, at): Result<Review>`, `waiveReview(r, why, at): Result<Review>`, `settled(issue): boolean`, `fromLegacyQa(issue): Issue`.
- Produces (from `types.ts`): `Review`, `ReviewKind`, `ReviewHow`, `ReviewState`, `HeldMessage`.

- [ ] **Step 1: Add the types**

In `packages/desk/src/types.ts`, add above `export interface Issue`:

```ts
export type ReviewKind = "spec" | "plan" | "result";
/** How it's checked: a peer reads it; QA tries it; its sources are opened again; the change is read back. */
export type ReviewHow = "reader" | "tried" | "reopened" | "read_back";
export type ReviewState = "open" | "passed" | "changes" | "waived";

/** One review an issue owes before its result is delivered (reviews.ts holds the moves). */
export interface Review {
  kind: ReviewKind;
  how: ReviewHow;
  askedBy: "gate" | "pm" | "engineer";
  state: ReviewState;
  /** Times the maker was sent back. */
  rounds: number;
  /** The reviewer's list, or why it was waived. */
  notes?: string;
  /** For "tried": the app version last tried. */
  version?: number;
  /** What the reviewer said, until the desk acts on it. */
  verdict?: { approve: boolean; notes: string };
  at: string;
}

/** A worker's message to the caller, kept until the result check is settled. */
export interface HeldMessage {
  text: string;
  channel?: "imessage" | "email";
  subject?: string;
  media?: string[];
  at: string;
}
```

Replace the `qa?` field and its comment in `Issue` with:

```ts
  /** The reviews this issue owes; its result is delivered once none is open or awaiting changes. */
  reviews?: Review[];
  /** Messages a worker wrote to the caller before the result check settled. */
  heldMessages?: HeldMessage[];
  /** Before reviews: QA's state. Read once when the issue loads (fromLegacyQa), never written. */
  qa?: { rounds: number; version?: number; verdict?: { usable: boolean; bugs: string } };
```

- [ ] **Step 2: Write the failing test**

Create `packages/desk/test/reviews.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it and see it fail**

Run: `pnpm --filter @kloru/desk exec vitest run test/reviews.test.ts`
Expected: FAIL, cannot find `../src/reviews.js`.

- [ ] **Step 4: Write `packages/desk/src/reviews.ts`**

```ts
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
```

- [ ] **Step 5: Run the test and see it pass**

Run: `pnpm --filter @kloru/desk exec vitest run test/reviews.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Convert on load and export**

In `packages/desk/src/repo.ts`, add `import { fromLegacyQa } from "./reviews.js";` beside the other local imports, and in the constructor's issue loop change

```ts
      if (issue) this.issueMap.set(issue.id, issue);
```

to

```ts
      if (issue) this.issueMap.set(issue.id, fromLegacyQa(issue));
```

In `packages/desk/src/index.ts`, after the `machine.js` line add:

```ts
export { REVIEW_ROUNDS, canReview, openReview, passReview, reviewOf, sendBackReview, settled, waiveReview } from "./reviews.js";
```

(`Review`, `ReviewKind`, `ReviewHow`, `ReviewState`, `HeldMessage` are already exported by `export * from "./types.js"`.)

- [ ] **Step 7: Commit**

`desk.ts` still reads `issue.qa`, which still type-checks. Run `pnpm --filter @kloru/desk run typecheck` (expected: clean), then:

```bash
git add packages/desk/src/types.ts packages/desk/src/reviews.ts packages/desk/src/repo.ts packages/desk/src/index.ts packages/desk/test/reviews.test.ts
git commit -m "feat(reviews): an issue carries the reviews it owes, each a small state machine

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: App QA runs on the review plan

**Files:**
- Modify: `packages/desk/src/desk.ts` (imports ~20-31; `workerDone` ~1528-1532; `openPr` ~1552-1557; `QA_ROUNDS` through `qaDone` ~1559-1633)
- Test: `packages/desk/test/app-qa.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `private startQa(issue: Issue, app: Artifact, result: string): void` (no longer returns a boolean; the caller finds the app with `appForQa` first). `Desk.QA_ROUNDS` stays and equals `REVIEW_ROUNDS.result`. `qaVerdict(issueId, usable, bugs)` keeps its signature.

- [ ] **Step 1: Change the tests to the new shape**

In `packages/desk/test/app-qa.test.ts`:

Replace
```ts
    expect(s.now(issue)).toMatchObject({ status: "in_review", qa: { rounds: 0, version: 1, verdict: { usable: true } } });
```
with
```ts
    expect(s.now(issue)).toMatchObject({ status: "in_review", reviews: [{ kind: "result", how: "tried", askedBy: "gate", state: "passed", rounds: 0, version: 1 }] });
    expect(s.now(issue).qa).toBeUndefined();
```

Replace
```ts
    expect(s.now(issue)).toMatchObject({ status: "in_progress", qa: { rounds: 1 } });
```
with
```ts
    expect(s.now(issue)).toMatchObject({ status: "in_progress", reviews: [{ state: "changes", rounds: 1, notes: "Removed Milk, reloaded: Milk is back." }] });
```

In "after three rounds the PM hears what QA still finds", after the last `expect(s.host.runs...)` add:
```ts
    expect(s.now(issue).reviews).toMatchObject([{ state: "waived", rounds: 3, notes: "Add does nothing." }]);
```

In "an engineer sent back who changes nothing isn't tried again", after the last `expect` add:
```ts
    expect(s.now(issue).reviews).toMatchObject([{ state: "waived", rounds: 1, notes: "the engineer made no new version" }]);
```

In "QA that fails or gives no verdict doesn't hold the result up", after the first `thread.at(-1)` assertion add:
```ts
    expect(s.now(one).reviews).toMatchObject([{ state: "waived", notes: "couldn't try it: browser didn't start" }]);
```
and after `expect(s.now(two).prs.at(-1)!.body).toBe("Made the chart.");` add:
```ts
    expect(s.now(two).reviews).toMatchObject([{ state: "waived", notes: "no verdict" }]);
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @kloru/desk exec vitest run test/app-qa.test.ts`
Expected: FAIL on the `reviews` assertions (the issue still has `qa`).

- [ ] **Step 3: Move the desk's QA onto reviews**

In `packages/desk/src/desk.ts`:

Add the import beside `./repo.js`:
```ts
import { REVIEW_ROUNDS, openReview, passReview, reviewOf, sendBackReview, waiveReview } from "./reviews.js";
```

In `workerDone`, replace
```ts
    if (issue.kind === "work") {
      if (this.startQa(issue, text, since)) return;
      this.openPr(issue, text);
      return;
    }
```
with
```ts
    if (issue.kind === "work") {
      const app = this.appForQa(issue, since);
      if (app) return this.startQa(issue, app, text);
      this.openPr(issue, text);
      return;
    }
```

Replace `openPr` with:
```ts
  /** The engineer's result goes to the PM for review. A review still waiting on a version that never came is waived. */
  private openPr(issue: Issue, body: string): void {
    const at = new Date().toISOString();
    for (const r of issue.reviews ?? []) if (r.state === "open" || r.state === "changes") waiveReview(r, "the engineer made no new version", at);
    issue.prs.push({ at, body, baseTurn: this.repo.lastTurn(issue.filedBy.call), status: "open" });
    this.move(issue, "in_review");
    this.trigger({ kind: "pr", issue: issue.id });
  }
```

Replace everything from the `QA_ROUNDS` comment through the end of `qaDone` with:
```ts
  /** How many times QA sends one issue's app back before the PM hears what's still wrong. */
  static readonly QA_ROUNDS = REVIEW_ROUNDS.result;

  /**
   * The app this issue's engineer made or changed in the run that began at `since`, when QA hasn't
   * tried this version yet. A follow-up's engineer works in the earlier issue's conversation, so the app is on that issue.
   */
  private appForQa(issue: Issue, since?: Date): Artifact | undefined {
    if (!this.qa || issue.status !== "in_progress") return undefined;
    const id = issue.artifact ?? (issue.links.continues !== undefined ? this.repo.issue(issue.links.continues)?.artifact : undefined);
    const app = id ? this.repo.artifact(id) : undefined;
    const tried = reviewOf(issue, "result");
    if (!app || app.kind !== "app" || tried?.version === (app.version ?? 1)) return undefined;
    const changed = since !== undefined && Date.parse(app.updatedAt ?? app.createdAt) >= since.getTime();
    return changed || tried ? app : undefined;
  }

  /** An engineer finished an app: QA uses it before the PM reviews the result. */
  private startQa(issue: Issue, app: Artifact, result: string): void {
    const opened = openReview(issue, { kind: "result", how: "tried", askedBy: "gate", version: app.version ?? 1 }, new Date().toISOString());
    if (!opened.ok) throw new Error(opened.error);
    const rounds = opened.value.rounds;
    this.repo.saveIssue(issue);
    if (!this.qaRunning.has(issue.id)) this.qaRunning.set(issue.id, []);
    this.runWorker(
      issue,
      [
        `Issue #${issue.id}: the engineer says this app is ready. App id ${app.id}: ${app.title} (version ${app.version ?? 1}).`,
        `Request: ${issue.request}`,
        issue.target ? `Goal: ${issue.target.goal}\nDone when: ${issue.target.doneWhen}` : `Spec: ${issue.spec ?? issue.request}`,
        `The engineer's result:\n${result}`,
        rounds ? `You sent it back ${rounds === 1 ? "once" : `${rounds} times`} already; check those fixes first.` : "",
      ].filter(Boolean).join("\n\n"),
      true,
    );
  }

  /** QA's verdict on the app, from its app_verdict call. */
  qaVerdict(issueId: number, usable: boolean, bugs: string): Result<true> {
    const issue = this.repo.issue(issueId);
    const review = issue ? reviewOf(issue, "result") : undefined;
    if (!issue || review?.state !== "open" || !this.qaRunning.has(issueId)) return err("no app is waiting on QA for this issue");
    review.verdict = { approve: usable, notes: bugs.trim() };
    this.repo.saveIssue(issue);
    return ok(true);
  }

  /** QA finished (or broke): real bugs go back to the engineer, a few times at most; otherwise the PM reviews the engineer's result. */
  private qaDone(issueId: number, text: string, error?: string): void {
    const issue = this.mustIssue(issueId);
    const held = this.qaRunning.get(issueId) ?? [];
    this.qaRunning.delete(issueId);
    this.inflight.delete(issueId);
    if (isClosed(issue.status) || issue.status !== "in_progress") return;
    const result = issue.thread.filter((e) => e.by === "engineer").at(-1)?.text ?? "";
    const review = reviewOf(issue, "result");
    const verdict = review?.state === "open" ? review.verdict : undefined;
    const news = held.length ? `\nMeanwhile: ${held.join("\n")}` : "";
    const at = new Date().toISOString();
    if (error !== undefined || !review || !verdict) {
      if (review?.state === "open") waiveReview(review, error !== undefined ? `couldn't try it: ${error}` : "no verdict", at);
      this.note(issue, "system", error !== undefined ? `QA couldn't try the app: ${error}` : `QA gave no verdict: ${clip(text, 400)}`);
      if (held.length) return this.runWorker(issue, news.trim());
      return this.openPr(issue, result);
    }
    if (verdict.approve || !verdict.notes) {
      passReview(review, verdict.notes, at);
      this.note(issue, "qa", `Tried the app: usable.${verdict.notes ? ` Minor: ${verdict.notes}` : ""}`);
      if (held.length) return this.runWorker(issue, news.trim());
      return this.openPr(issue, result);
    }
    const back = sendBackReview(review, verdict.notes, at);
    if (!back.ok) throw new Error(back.error);
    if (review.state === "waived") {
      this.note(issue, "qa", `Still wrong after ${review.rounds} rounds: ${verdict.notes}`);
      return this.openPr(issue, `${result}\n\nQA still finds, after ${review.rounds} rounds of fixes: ${verdict.notes}`);
    }
    this.note(issue, "qa", `Sent back (${review.rounds}/${Desk.QA_ROUNDS}): ${verdict.notes}`);
    this.runWorker(issue, `QA used the app on a phone and found problems that stop people using it:\n${verdict.notes}\nSee each one happen yourself first (app_test), fix it, then check the same steps again.${news}`);
  }
```

Then confirm nothing else reads the old field: `grep -n "\.qa\b" packages/desk/src/desk.ts` must show only `this.qa` (the on/off flag).

- [ ] **Step 4: Run the desk's tests**

Run: `pnpm --filter @kloru/desk exec vitest run`
Expected: PASS, every file (the review state now sits in `reviews`; the flow is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/desk/src/desk.ts packages/desk/test/app-qa.test.ts
git commit -m "refactor(qa): app QA is a tried review on the issue's review plan

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: The result gate in the desk

**Files:**
- Modify: `packages/desk/src/desk.ts` (types near `MessageDecision` ~114; `DeskOptions` ~192; fields ~470; constructor ~534; `runWorker` ~1470; `workerDone`; new `gateResult`, `appChange`), `packages/desk/src/index.ts`
- Test: `packages/desk/test/app-qa.test.ts`

**Interfaces:**
- Consumes: `startQa(issue, app, result)`, `appForQa`, `reviewOf` (Tasks 1–2).
- Produces:
  ```ts
  export interface ResultCheck { request: string; goal?: string; doneWhen?: string; deliverable?: string; result: string; changed: string; ledger: string[] }
  export interface ResultDecision { check: "none" | "tried"; p?: number }
  // DeskOptions
  decideResult?: (c: ResultCheck) => Promise<ResultDecision>;
  ```
  and `private readonly since = new Map<number, Date>()` (the desk-clock time each issue's current run began; Task 4 reads it).

The gate is asked when an engineer finishes with a changed app and the issue has no result review yet. Once a version has been tried, every later version is tried without asking (that is today's rule, and a fix after a bug report should be checked).

- [ ] **Step 1: Let the test setup take a gate**

In `packages/desk/test/app-qa.test.ts`, change the import and `setup`:

```ts
import { Desk, type Planner, type ResultCheck, type ResultDecision, type Trigger, type WorkerHost } from "../src/desk.js";
```
```ts
function setup(o: { qa?: boolean; store?: boolean; gate?: (c: ResultCheck) => Promise<ResultDecision>; notify?: boolean } = {}) {
```
and inside `new Desk({ ... })`, after the `appStore` line:
```ts
    ...(o.gate ? { decideResult: o.gate } : {}),
    ...(o.notify ? { notify: async () => true } : {}),
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/desk/test/app-qa.test.ts`:

```ts
describe("the result gate says whether a changed app needs trying", () => {
  it("none: the result goes straight to the PM, and the decision is on the thread", async () => {
    const seen: ResultCheck[] = [];
    const s = setup({ gate: async (c) => (seen.push(c), { check: "none", p: 0.9 }) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    expect(s.now(issue).status).toBe("in_review");
    expect(s.host.runs.filter((r) => r.role.name === "qa")).toHaveLength(0);
    expect(s.now(issue).reviews).toBeUndefined();
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Result check: none (0.90)" });
    expect(s.now(issue).prs.at(-1)!.body).toBe("Made the list.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ request: "Make us a shared grocery list", goal: "Make us a shared grocery list", doneWhen: "it works on a phone", deliverable: "app", result: "Made the list.", changed: 'app "Groceries": new, 7 lines', ledger: [] });
  });

  it("tried: QA uses the app, as without a gate", async () => {
    const s = setup({ gate: async () => ({ check: "tried", p: 0.95 }) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    expect(s.last().role.name).toBe("qa");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Result check: try the app (0.95)" });
    expect(s.now(issue).reviews).toMatchObject([{ kind: "result", how: "tried", askedBy: "gate", state: "open" }]);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    expect(s.now(issue).status).toBe("in_review");
  });

  it("a gate that fails means the app is tried", async () => {
    const s = setup({ gate: async () => { throw new Error("decision model 503"); } });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    expect(s.last().role.name).toBe("qa");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: "Result check: try the app" });
  });

  it("is asked once: after a version has been tried, each new one is", async () => {
    let asked = 0;
    const s = setup({ gate: async () => (asked++, { check: "tried" }) });
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    await s.as(issue)("app_update", { id, replace: { old: "items.length", new: "items.length + 0" } });
    await s.finish("Fixed.");
    expect(s.last().role.name).toBe("qa");
    expect(asked).toBe(1);
  });

  it("a small change to an app nobody has tried on this issue is asked about, with how much changed", async () => {
    const seen: ResultCheck[] = [];
    const s = setup({ gate: async (c) => (seen.push(c), { check: "none", p: 0.8 }) });
    const first = s.assigned("Make us a shared grocery list");
    const id = await made(s, first);
    await s.finish("Made the list.");
    const follow = s.assigned("Call the list Shopping", "app", first);
    await s.as(first)("app_update", { id, replace: { old: "<title>Groceries</title>", new: "<title>Shopping</title>" } });
    await s.finish("Renamed.");
    expect(s.now(follow).status).toBe("in_review");
    expect(seen.at(-1)!.changed).toBe('app "Groceries": version 1 → 2, 2 of 7 lines changed');
  });

  it("what the caller says while the gate decides reaches the engineer", async () => {
    let release!: (d: ResultDecision) => void;
    const s = setup({ gate: () => new Promise((r) => (release = r)) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    s.desk.comment(issue, s.now(issue).filedBy.call, "Also add a quantity field");
    expect(s.host.steered).toEqual([]);
    release({ check: "none", p: 0.9 });
    await tick();
    expect(s.now(issue).status).toBe("in_progress");
    expect(s.last().role.name).toBe("engineer");
    expect(s.last().prompt).toContain("Also add a quantity field");
  });

  it("an issue closed while the gate decides starts nothing", async () => {
    let release!: (d: ResultDecision) => void;
    const s = setup({ gate: () => new Promise((r) => (release = r)) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    const runs = s.host.runs.length;
    expect(s.desk.close(issue, "wont_do").ok).toBe(true);
    release({ check: "tried" });
    await tick();
    expect(s.host.runs).toHaveLength(runs);
    expect(s.now(issue).status).toBe("wont_do");
    expect(s.now(issue).prs).toHaveLength(0);
  });

  it("the sweeper doesn't call an issue stuck while the gate decides", async () => {
    let release!: (d: ResultDecision) => void;
    const s = setup({ gate: () => new Promise((r) => (release = r)) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    await s.finish("Made the list.");
    s.desk.sweep();
    expect(s.now(issue).status).toBe("in_progress");
    release({ check: "none" });
    await tick();
    expect(s.now(issue).status).toBe("in_review");
    expect(s.now(issue).thread.at(-1)).toMatchObject({ text: "Result check: none" });
  });
});
```

(`LIST` in this file has 7 lines when split on `\n`, counting the empty one after the last newline. The title change removes one line and adds one, so 2 changed.)

- [ ] **Step 3: Run and see them fail**

Run: `pnpm --filter @kloru/desk exec vitest run test/app-qa.test.ts -t "result gate"`
Expected: FAIL to compile or run: `ResultCheck` is not exported, `decideResult` is unknown.

- [ ] **Step 4: Add the types, option and field**

In `packages/desk/src/desk.ts`, after the `MessageDecision` interface:

```ts
/** What the result gate weighs when an engineer finishes work that changed an app. */
export interface ResultCheck {
  request: string;
  goal?: string;
  doneWhen?: string;
  deliverable?: string;
  /** The engineer's own report. */
  result: string;
  /** What changed, in a line: 'app "Groceries": new, 120 lines' or 'app "Groceries": version 4 → 5, 3 of 120 lines changed'. */
  changed: string;
  /** Real-world changes this issue made, from the ledger. */
  ledger: string[];
}

/** Whether the result needs an independent check before the PM reviews it, and which. */
export interface ResultDecision {
  check: "none" | "tried";
  p?: number;
}
```

In `DeskOptions`, after `qaModel`:
```ts
  /** The result gate: whether a changed app needs trying before the PM reviews the result. Without it, or when it fails, every changed app is tried. */
  decideResult?: (c: ResultCheck) => Promise<ResultDecision>;
```

Among the private fields, after `qaRunning`:
```ts
  private readonly decideResult: ((c: ResultCheck) => Promise<ResultDecision>) | undefined;
  /** When each issue's current run began, by the desk's clock: what "changed in this run" is measured from. */
  private readonly since = new Map<number, Date>();
```

In the constructor, after `this.qaModel = ...`:
```ts
    this.decideResult = o.decideResult;
```

In `runWorker`, directly after `const since = this.now();` add:
```ts
    this.since.set(issue.id, since);
```

In `packages/desk/src/index.ts`, add `type ResultCheck, type ResultDecision,` to the `./desk.js` export list (next to `type MessageDecision`).

- [ ] **Step 5: Ask the gate**

In `workerDone`, replace the block from Task 2 with:

```ts
    if (issue.kind === "work") {
      const app = this.appForQa(issue, since);
      if (!app) return this.openPr(issue, text);
      // Once a version has been tried, each new one is. Before that, the gate says whether this change needs trying.
      if (!this.decideResult || reviewOf(issue, "result")) return this.startQa(issue, app, text);
      void this.gateResult(issue.id, app, text, since);
      return;
    }
```

Add after `openPr`:

```ts
  /**
   * The result gate: does this change to an app need trying before the PM reviews it? While it
   * decides, the issue is held like one QA has. Unsure, slow or broken means it's tried, as without a gate.
   */
  private async gateResult(issueId: number, app: Artifact, result: string, since?: Date): Promise<void> {
    const issue = this.mustIssue(issueId);
    const waiting: string[] = [];
    const run = this.runs.get(issueId);
    this.qaRunning.set(issueId, waiting);
    // The sweeper treats in_progress with no worker as stuck: the decision is this issue's worker for now.
    this.started.set(issueId, Date.now());
    let d: ResultDecision;
    try {
      d = await this.decideResult!({
        request: issue.request,
        ...(issue.target ? { goal: issue.target.goal, doneWhen: issue.target.doneWhen, deliverable: issue.target.deliverable } : {}),
        result: clip(result, 2000),
        changed: this.appChange(app, since),
        ledger: this.repo.ledger(issueId).filter((e) => e.ok).map((e) => `${e.slug.toLowerCase().replace(/_/g, " ")} → ${clip(e.result, 200)}`),
      });
    } catch (error) {
      this.log(`desk: #${issueId} result gate failed, trying the app: ${error instanceof Error ? error.message : String(error)}`);
      d = { check: "tried" };
    }
    try {
      if (this.qaRunning.get(issueId) !== waiting || this.runs.get(issueId) !== run) return; // something else took the issue over
      this.started.delete(issueId);
      const now = this.mustIssue(issueId);
      if (now.status !== "in_progress") {
        this.qaRunning.delete(issueId);
        return;
      }
      this.log(`desk: #${issueId} result gate → ${d.check}${d.p !== undefined ? ` ${d.p.toFixed(2)}` : ""}`);
      this.note(now, "system", `Result check: ${d.check === "tried" ? "try the app" : "none"}${d.p !== undefined ? ` (${d.p.toFixed(2)})` : ""}`);
      if (d.check === "tried") return this.startQa(now, app, result);
      this.qaRunning.delete(issueId);
      if (waiting.length) return this.runWorker(now, `Meanwhile: ${waiting.join("\n")}`);
      this.openPr(now, result);
    } catch (error) {
      this.log(`desk: result gate on #${issueId} ignored: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** What an engineer's run changed in an app, in a line the result gate can weigh. */
  private appChange(app: Artifact, since?: Date): string {
    const lines = (html?: string) => (html ?? "").split("\n");
    const now = lines(app.html);
    const before = since ? this.repo.artifactVersions(app.id).filter((v) => Date.parse(v.at) < since.getTime()).at(-1) : undefined;
    if (!before) return `app "${app.title}": new, ${now.length} lines`;
    const old = lines(before.html);
    const changed = now.filter((l) => !old.includes(l)).length + old.filter((l) => !now.includes(l)).length;
    return `app "${before.title}": version ${before.version} → ${app.version ?? 1}, ${changed} of ${now.length} lines changed`;
  }
```

Notes for the implementer:
- `startQa` (Task 2) keeps an existing `qaRunning` entry, so what arrived during the decision carries into QA.
- `close()` on an issue in `in_progress` moves it to a closed status; the `now.status !== "in_progress"` check covers it.
- If `mustIssue` is not what the surrounding code uses for "this issue must exist", use what it uses; do not add a new helper.

- [ ] **Step 6: Run the tests**

Run: `pnpm --filter @kloru/desk exec vitest run test/app-qa.test.ts`
Expected: PASS, including every earlier test (they pass no gate). If the "2 of 7 lines changed" count differs because two versions were written in the same millisecond as the run began, make the follow-up test wait one tick before `assigned(...)`; do not loosen the assertion.

- [ ] **Step 7: Run the whole desk suite, then commit**

Run: `pnpm --filter @kloru/desk exec vitest run && pnpm --filter @kloru/desk run typecheck`
Expected: PASS, clean.

```bash
git add packages/desk/src/desk.ts packages/desk/src/index.ts packages/desk/test/app-qa.test.ts
git commit -m "feat(reviews): a result gate says whether a changed app needs trying; unsure or broken means it is tried

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: A worker's message waits for the result check

**Files:**
- Modify: `packages/desk/src/desk.ts` (`messageCaller` ~1754-1793; `openPr`; `workerFailed` ~1651)
- Test: `packages/desk/test/app-qa.test.ts`

**Interfaces:**
- Consumes: `Issue.heldMessages`, `HeldMessage` (Task 1); `this.since` (Task 3); `appForQa`, `reviewOf`.
- Produces: `messageCaller` keeps its signature and returns `ok("Kept: …")` when it holds. New privates: `awaitsCheck(issue): boolean`, `liveThread(issue, channel, hasMedia): CallRecord | undefined`, `passOn(issue, body, channel, subject, items): Promise<string>`, `releaseHeld(issue): void`, `dropHeld(issue, why): void`.

Rule: while a `work` issue is `in_progress`, QA is on, and either its result review is open or awaiting changes, or its app changed in this run and that version has not been tried, a worker's message is kept on the issue. It is released when the result goes to the PM with the check passed or not needed. It is not sent when the check ended with known bugs or the work failed; the thread says so, and the PM decides what the person hears.

- [ ] **Step 1: Write the failing tests**

Append to `packages/desk/test/app-qa.test.ts`:

```ts
describe("a worker's message about an app waits until the app has been checked", () => {
  const LINK = "Your list is ready: https://example.com/a/x";
  const inbox = (s: ReturnType<typeof setup>, issue: number) => s.desk.repo.inbox(s.now(issue).filedBy.call, 0).map((m) => m.text);
  const said = async (s: ReturnType<typeof setup>, issue: number, text: string) => {
    const r = await s.desk.messageCaller(issue, text);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("goes at once before there is an app; is kept once the app exists; goes when QA passes it", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    expect(await said(s, issue, "Starting on it.")).toBe("Passed on in their conversation.");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept: it goes to them once the app has been checked/);
    expect(inbox(s, issue)).toContain("Starting on it.");
    expect(inbox(s, issue)).not.toContain(LINK);
    expect(s.now(issue).heldMessages).toMatchObject([{ text: LINK }]);
    expect(s.now(issue).thread.at(-1)).toMatchObject({ by: "system", text: `Kept until the app has been checked: ${LINK}` });
    await s.finish("Made the list.");
    expect(inbox(s, issue)).not.toContain(LINK);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
    expect(s.now(issue).heldMessages).toBeUndefined();
    expect(s.now(issue).status).toBe("in_review");
  });

  it("goes as soon as the engineer finishes when the gate says no check is needed", async () => {
    const s = setup({ notify: true, gate: async () => ({ check: "none", p: 0.9 }) });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    await s.finish("Made the list.");
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
  });

  it("is kept through a send-back and goes when the fixed version passes", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    const id = await made(s, issue);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    expect(await said(s, issue, LINK)).toMatch(/^Kept/); // the engineer, fixing, before it has changed anything
    await s.as(issue)("app_update", { id, replace: { old: "items.length", new: "items.length + 0" } });
    await s.finish("Fixed.");
    expect(inbox(s, issue)).not.toContain(LINK);
    await s.as(issue, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
  });

  it("is not sent when QA still finds bugs: the PM sees it on the thread", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    await s.finish("Made the list.");
    await s.as(issue, "qa")("app_verdict", { usable: false, bugs: "Add does nothing." });
    await s.finish("One bug.");
    await s.finish("Add works for me; nothing to change."); // no new version: the review is waived with its bug
    await tick();
    expect(s.now(issue).status).toBe("in_review");
    expect(inbox(s, issue)).not.toContain(LINK);
    expect(s.now(issue).heldMessages).toBeUndefined();
    expect(s.now(issue).thread.map((e) => e.text)).toContain(`Not sent (the check found problems): ${LINK}`);
  });

  it("is not sent when the work fails", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    s.last().fail("model error");
    await tick();
    expect(s.now(issue).status).toBe("failed");
    expect(inbox(s, issue)).not.toContain(LINK);
    expect(s.now(issue).thread.map((e) => e.text)).toContain(`Not sent (the work failed): ${LINK}`);
  });

  it("QA that couldn't run doesn't keep the message back", async () => {
    const s = setup({ notify: true });
    const issue = s.assigned("Make us a shared grocery list");
    await made(s, issue);
    expect(await said(s, issue, LINK)).toMatch(/^Kept/);
    await s.finish("Made the list.");
    s.last().fail("browser didn't start");
    await tick();
    await tick();
    expect(inbox(s, issue)).toContain(LINK);
  });

  it("nothing is kept with QA off, for work that isn't an app, or for an app this run didn't change", async () => {
    const off = setup({ notify: true, qa: false });
    const a = off.assigned("Make us a shared grocery list");
    await made(off, a);
    expect(await said(off, a, LINK)).toBe("Passed on in their conversation.");

    const s = setup({ notify: true });
    const answer = s.assigned("When is the dentist?", "answer");
    expect(await said(s, answer, "Monday at 9.")).toBe("Passed on in their conversation.");
    await s.finish("Monday at 9.");

    const first = s.assigned("Make us a shared grocery list");
    await made(s, first);
    await s.finish("Made the list.");
    await s.as(first, "qa")("app_verdict", { usable: true });
    await s.finish("Works.");
    const ask = s.assigned("What does the grocery list app do?", "answer", first);
    expect(await said(s, ask, "It keeps a shared list.")).toBe("Passed on in their conversation.");
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `pnpm --filter @kloru/desk exec vitest run test/app-qa.test.ts -t "waits until the app has been checked"`
Expected: FAIL: the kept cases return "Passed on in their conversation."

- [ ] **Step 3: Hold, pass on, release**

In `packages/desk/src/desk.ts`, add `type HeldMessage` to the `./types.js` import, and replace `messageCaller` with:

```ts
  /**
   * "Text me the link", "email me when you're done": a worker's message to the person who asked.
   * It goes into their outbox, which sends it now, keeps it for a better time, or drops it.
   * About an app nobody has checked yet, it waits on the issue until the check is settled.
   */
  async messageCaller(issueId: number, text: string, channel?: NoticeChannel, subject?: string, media: string[] = []): Promise<Result<string>> {
    const issue = this.repo.issue(issueId);
    if (!issue) return err(`no issue ${issueId}`);
    if (!this.notify) return err("Kloru can't text or email from here yet. Tell them plainly; offer to say it on the call.");
    const body = text.trim();
    if (!body) return err("nothing to send");
    const items = this.attachable(issue, media);
    if (!items.ok) return items;
    if (!this.liveThread(issue, channel, items.value.length > 0)) {
      // The draft, weighed against how they like messages: a clear miss goes back to its writer once.
      const once = `${issue.id}:worker`;
      if (this.checkDraft && !this.redrafted.has(once)) {
        const why = await this.draftMiss(issue.filedBy.phone, issue.filedBy.call, issue.request, body, channel, "result");
        if (why) {
          this.redrafted.add(once);
          this.log(`desk: #${issue.id} worker draft → redraft: ${why}`);
          return err(`Not sent yet: redraft it. ${why} Then send the new version the same way.`);
        }
      }
      this.redrafted.delete(once);
    }
    if (this.awaitsCheck(issue)) {
      const kept: HeldMessage = { text: body, ...(channel ? { channel } : {}), ...(subject?.trim() ? { subject: subject.trim() } : {}), ...(media.length ? { media: [...new Set(media)] } : {}), at: new Date().toISOString() };
      (issue.heldMessages ??= []).push(kept);
      this.note(issue, "system", `Kept until the app has been checked: ${clip(body, 300)}`);
      return ok("Kept: it goes to them once the app has been checked. Don't send it another way; carry on.");
    }
    return ok(await this.passOn(issue, body, channel, subject, items.value));
  }

  /** The app this issue changed hasn't been checked yet: its messages wait, so a link never arrives before the app works. */
  private awaitsCheck(issue: Issue): boolean {
    if (!this.qa || issue.kind !== "work" || issue.status !== "in_progress") return false;
    const review = reviewOf(issue, "result");
    if (review && (review.state === "open" || review.state === "changes")) return true;
    return this.appForQa(issue, this.since.get(issue.id)) !== undefined;
  }

  /** Their live text or email thread, when this message can go into it as it is. */
  private liveThread(issue: Issue, channel: NoticeChannel | undefined, hasMedia: boolean): CallRecord | undefined {
    const call = this.repo.call(issue.filedBy.call);
    return call && !call.endedAt && (call.channel === "imessage" || call.channel === "email") && !hasMedia && (!channel || channel === (call.channel === "email" ? "email" : "imessage")) ? call : undefined;
  }

  /** Hand a worker's message on: into their live thread, or to their outbox. Says what became of it. */
  private async passOn(issue: Issue, body: string, channel: NoticeChannel | undefined, subject: string | undefined, items: Array<{ item: MediaItem; path: string }>): Promise<string> {
    // In a live text or email thread, one writer: the thread's own model passes it on, in the shape they like.
    const live = this.liveThread(issue, channel, items.length > 0);
    if (live) {
      this.deliver(live.id, { kind: "info", text: body, issue: issue.id });
      return "Passed on in their conversation.";
    }
    const item = await this.outbox.submit({
      phone: issue.filedBy.phone,
      text: body,
      why: this.whyOf(issue),
      from: { agent: "worker", issue: issue.id, call: issue.filedBy.call },
      drafted: true,
      subject: subject?.trim() || `Kloru: ${clip(issue.request, 70)}`,
      ...(channel ? { channel } : {}),
      ...(items.length ? { media: items.map((x) => x.item.id) } : {}),
    });
    if (item.state === "sent") return `Sent${item.sentOn && item.sentOn !== "default" ? ` by ${item.sentOn}` : ""}.`;
    if (item.state === "dropped") return "Not sent: they already have this or don't need it. Don't send it another way.";
    return "It's in their outbox and will reach them at a good time for them. Don't send it another way; carry on.";
  }

  /** The check is settled and found nothing that matters: what the worker wrote meanwhile goes now. */
  private releaseHeld(issue: Issue): void {
    const held = issue.heldMessages;
    if (!held?.length) return;
    delete issue.heldMessages;
    this.repo.saveIssue(issue);
    void (async () => {
      for (const m of held) {
        try {
          const items = this.attachable(issue, m.media ?? []);
          const said = await this.passOn(issue, m.text, m.channel, m.subject, items.ok ? items.value : []);
          this.log(`desk: #${issue.id} kept message released: ${said}`);
        } catch (error) {
          this.log(`desk: #${issue.id} kept message not sent: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
  }

  /** What the worker wrote won't go as written: the thread keeps it, and the PM decides what they hear. */
  private dropHeld(issue: Issue, why: string): void {
    const held = issue.heldMessages;
    if (!held?.length) return;
    delete issue.heldMessages;
    for (const m of held) this.note(issue, "system", `Not sent (${why}): ${clip(m.text, 300)}`);
  }
```

If `CallRecord` is not already imported in `desk.ts`, it is (see the `./types.js` import); `MediaItem` comes from `./media.js`, also already imported.

In `openPr`, after the waive loop and before `issue.prs.push`, add:

```ts
    // A check that ended with known problems: the worker's "it's ready" doesn't go as written.
    const result = reviewOf(issue, "result");
    if (result?.state === "waived" && result.verdict?.approve === false) this.dropHeld(issue, "the check found problems");
    else this.releaseHeld(issue);
```

`openReview` deletes `verdict` when a version is checked again, so `verdict.approve === false` on a waived review means the last look found bugs (the cap, or an engineer who changed nothing). A review waived because QA couldn't run has no verdict, and the message goes.

In `workerFailed`, directly before `this.note(issue, "system", \`Worker failed: ${error}\`);` add:

```ts
    this.dropHeld(issue, "the work failed");
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @kloru/desk exec vitest run`
Expected: PASS, all files. `coms.test.ts` and `outbox` tests exercise `messageCaller`'s outbox path; they must pass unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/desk/src/desk.ts packages/desk/test/app-qa.test.ts
git commit -m "fix(apps): an engineer's message about an app waits until the app has been checked

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: The gate on Jev, wired in

**Files:**
- Create: `packages/server/src/result-gate.ts`
- Test: `packages/server/test/result-gate.test.ts`, `packages/server/test/result-gate.live.test.ts`
- Modify: `packages/server/src/boot.ts` (import ~9; desk options ~945), `SETUP.md:168`, `docs/KEYS.md:45`, `docs/ARCHITECTURE.md`

**Interfaces:**
- Consumes: `ResultCheck`, `ResultDecision` from `@kloru/desk` (Task 3).
- Produces: `resultGate(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (c: ResultCheck) => Promise<ResultDecision>`.

- [ ] **Step 1: Write the failing unit test**

Create `packages/server/test/result-gate.test.ts`:

```ts
import type { ResultCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { resultGate } from "../src/result-gate.js";

const check: ResultCheck = {
  request: "Call the list Shopping",
  goal: "Rename the grocery app to Shopping",
  doneWhen: "the title reads Shopping",
  deliverable: "app",
  result: "Renamed.",
  changed: 'app "Groceries": version 4 → 5, 2 of 120 lines changed',
  ledger: [],
};

function fake(answers: unknown, seen: Array<{ url: string; body: Record<string, any> }> = [], status = 200): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers }), { status });
  }) as unknown as typeof fetch;
}
const answer = (choice: string, p: number) => ({ check: { type: "choice", choice, probabilities: { [choice]: p } } });

describe("the result gate on Jev", () => {
  it("asks Jev one choice, with the spec, the result and what changed", async () => {
    const seen: Array<{ url: string; body: Record<string, any> }> = [];
    await resultGate({ apiKey: "k", fetchImpl: fake(answer("none", 0.9), seen) })(check);
    expect(seen[0]!.url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(seen[0]!.body).toMatchObject({ model: "typesafe/jev-1.14", provider: { zdr: true } });
    expect(Object.keys(seen[0]!.body.questions.check.criteria)).toEqual(["none", "tried", "unsure"]);
    expect(seen[0]!.body.state).toEqual({
      what_they_asked: "Call the list Shopping",
      spec: { goal: "Rename the grocery app to Shopping", done_when: "the title reads Shopping", deliverable: "app" },
      engineers_result: "Renamed.",
      what_changed: 'app "Groceries": version 4 → 5, 2 of 120 lines changed',
      changes_made_elsewhere: [],
    });
  });

  it("none only when Jev is sure; anything else means the app is tried", async () => {
    const gate = (a: unknown) => resultGate({ apiKey: "k", fetchImpl: fake(a) })(check);
    expect(await gate(answer("none", 0.9))).toEqual({ check: "none", p: 0.9 });
    expect(await gate(answer("none", 0.6))).toEqual({ check: "none", p: 0.6 });
    expect(await gate(answer("none", 0.59))).toEqual({ check: "tried", p: 0.59 });
    expect(await gate(answer("unsure", 0.7))).toEqual({ check: "tried", p: 0.7 });
    expect(await gate(answer("tried", 0.95))).toEqual({ check: "tried", p: 0.95 });
    expect(await gate({ check: { type: "choice", choice: "none" } })).toEqual({ check: "tried" });
  });

  it("throws on an error or an answer it can't read, so the desk falls back to trying", async () => {
    await expect(resultGate({ apiKey: "k", fetchImpl: fake({}, [], 503) })(check)).rejects.toThrow("decision model 503");
    await expect(resultGate({ apiKey: "k", fetchImpl: fake({ check: { type: "choice", choice: "ship_it" } }) })(check)).rejects.toThrow(/no check in/);
    await expect(resultGate({ apiKey: "k", fetchImpl: fake({}) })(check)).rejects.toThrow(/no check in/);
  });
});
```

- [ ] **Step 2: Run and see it fail**

Run: `pnpm --filter @kloru/desk run build && pnpm --filter @kloru/server exec vitest run test/result-gate.test.ts`
Expected: FAIL, cannot find `../src/result-gate.js`.

- [ ] **Step 3: Write `packages/server/src/result-gate.ts`**

```ts
/**
 * The result gate (decision-models skill): when an engineer finishes work that changed an app, Jev
 * says whether someone should use the app before the PM reviews the result. Its criteria are
 * guidelines it weighs, not rules in code. The desk tries the app when this is unsure, slow or broken.
 */
import type { ResultCheck, ResultDecision } from "@kloru/desk";

const URL = "https://openrouter.ai/api/alpha/decisions";
// Measured 2026-11-10 on 16 invented cases, three runs each: ~0.18 s a decision; every miss was an extra check.
const MODEL = "typesafe/jev-1.14";
/** How sure "none" has to be before an app goes on untried. */
const SURE = 0.6;

const CHECKS = {
  none: "No check: a small change to an app that already works (wording, a label, a color), which they will see at once if it is wrong.",
  tried: "Someone uses the app in a browser first: it is new, or what it does or how it keeps its data changed in a way that could break it.",
  unsure: "Can't tell from this.",
};

export function resultGate(o: { apiKey: string; fetchImpl?: typeof fetch; model?: string; timeoutMs?: number }): (c: ResultCheck) => Promise<ResultDecision> {
  return async (c) => {
    const state = {
      what_they_asked: c.request,
      spec: { goal: c.goal ?? "(none)", done_when: c.doneWhen ?? "(none)", deliverable: c.deliverable ?? "(none)" },
      engineers_result: c.result,
      what_changed: c.changed,
      changes_made_elsewhere: c.ledger,
    };
    const questions = {
      check: {
        type: "choice",
        instructions: "Kloru is a family's assistant. An engineer finished this work on an app. Before the coordinator reviews it and the person hears, does the app need an independent check?",
        criteria: CHECKS,
      },
    };
    const res = await (o.fetchImpl ?? fetch)(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${o.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      body: JSON.stringify({ model: o.model ?? MODEL, provider: { zdr: true }, state, questions }),
    });
    if (!res.ok) throw new Error(`decision model ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }> };
    const a = data.answers?.check;
    if (a?.type !== "choice" || !a.choice || !(a.choice in CHECKS)) throw new Error(`no check in ${JSON.stringify(data).slice(0, 200)}`);
    const p = a.probabilities?.[a.choice];
    return { check: a.choice === "none" && p !== undefined && p >= SURE ? "none" : "tried", ...(p !== undefined ? { p } : {}) };
  };
}
```

- [ ] **Step 4: Run the unit test and see it pass**

Run: `pnpm --filter @kloru/server exec vitest run test/result-gate.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the labeled cases**

Create `packages/server/test/result-gate.live.test.ts`:

```ts
/**
 * The result gate on invented finished work, each with the check its family would want. Runs only with
 * OPENROUTER_API_KEY:  OPENROUTER_API_KEY=… npx vitest run test/result-gate.live.test.ts
 */
import type { ResultCheck } from "@kloru/desk";
import { describe, expect, it } from "vitest";
import { resultGate } from "../src/result-gate.js";

const key = process.env.OPENROUTER_API_KEY;
const c = (request: string, doneWhen: string, result: string, changed: string, ledger: string[] = []): ResultCheck => ({ request, goal: request, doneWhen, deliverable: "app", result, changed, ledger });

// [name, what the gate sees, checks the family would accept]
const CASES: Array<[string, ResultCheck, Array<"none" | "tried">]> = [
  ["a new app", c("Make us a shared grocery list", "we can add, tick and remove items on a phone", "Built the list with add, tick and remove.", 'app "Groceries": new, 140 lines'), ["tried"]],
  ["a new app with several parts", c("An app where the kids log chores, earn points, and we approve them", "kids log chores; parents approve; points total per child", "Built logging, approvals and a points view.", 'app "Chores": new, 620 lines'), ["tried"]],
  ["a title change", c("Call the list Shopping", "the title reads Shopping", "Renamed it.", 'app "Groceries": version 4 → 5, 2 of 140 lines changed'), ["none"]],
  ["a color change", c("Make the chores app header green", "the header is green", "Changed the header color.", 'app "Chores": version 7 → 8, 1 of 620 lines changed'), ["none"]],
  ["a label's wording", c("Change 'Submit' to 'Add' on the list", "the button says Add", "Changed the button label.", 'app "Groceries": version 5 → 6, 2 of 140 lines changed'), ["none"]],
  ["a typo fixed", c("There's a typo: 'Grocries'", "the heading is spelled Groceries", "Fixed the spelling.", 'app "Groceries": version 6 → 7, 2 of 140 lines changed'), ["none"]],
  ["a new field with sorting", c("Add a due date to each chore and sort by it", "chores have a due date and sort by it", "Added due dates and sorting.", 'app "Chores": version 8 → 9, 48 of 660 lines changed'), ["tried"]],
  ["how data is kept changes", c("Make lists per store and remember each item's aisle, keeping what's there", "lists are per store; items show their aisle; old items are still there", "Reworked the lists and moved the 140 existing items over.", 'app "Groceries": version 9 → 10, 310 of 420 lines changed'), ["tried"]],
  ["a bug fix in saving", c("Removed items come back when I reload", "a removed item stays removed after a reload", "Fixed: remove now saves.", 'app "Groceries": version 7 → 8, 6 of 140 lines changed'), ["tried"]],
  ["a new button that does something", c("Add a 'clear ticked' button", "one tap removes every ticked item", "Added the button.", 'app "Groceries": version 8 → 9, 14 of 150 lines changed'), ["tried"]],
  ["sign-in added", c("Only our family should be able to edit the list", "visitors can look; only the family can change it", "Visitors are now read-only.", 'app "Groceries": version 10 → 11, 9 of 420 lines changed'), ["tried"]],
  ["bigger text", c("The text is too small on my phone", "the list is easy to read on a phone", "Raised the font size.", 'app "Groceries": version 11 → 12, 3 of 420 lines changed'), ["none", "tried"]],
  ["a small change the engineer calls risky", c("Rename the 'items' list to 'things' everywhere", "it says things, and nothing is lost", "Renamed the label and the stored collection; old entries may need moving.", 'app "Groceries": version 12 → 13, 11 of 420 lines changed'), ["tried"]],
  ["an emoji in the heading", c("Put a cart emoji next to the title", "the title has a cart emoji", "Added it.", 'app "Groceries": version 13 → 14, 2 of 420 lines changed'), ["none"]],
];

describe.skipIf(!key)("the result gate, on Jev", () => {
  const gate = resultGate({ apiKey: key ?? "", timeoutMs: 10_000 });
  it.each(CASES)("%s", async (_name, check, accepted) => {
    const d = await gate(check);
    expect(accepted, `chose ${d.check} at ${d.p}`).toContain(d.check);
  });
});
```

- [ ] **Step 6: Run the labeled cases**

Run: `set -a && source .instinct.env && set +a && pnpm --filter @kloru/server exec vitest run test/result-gate.live.test.ts`
Expected: PASS on all 14.

If a case misses:
- A miss that tries something the label called `none` costs one QA run. Reword the `none` or `tried` criterion in `CHECKS` (a guideline, one sentence) and run all 14 again. At most two rewording rounds.
- A miss that chooses `none` where the label says `tried` is the dangerous direction. Reword first; if it still misses, raise `SURE` (and the `0.6`/`0.59` lines in the unit test with it).
- Do not edit a case's label to make it pass, and do not add keyword checks in code. If two rounds don't get every `tried` case right, stop and report which cases miss and at what probability.

- [ ] **Step 7: Wire it in**

In `packages/server/src/boot.ts`, add beside the `comsDecider` import:
```ts
import { resultGate } from "./result-gate.js";
```
and in the desk options, directly after `qa: qaOn,`:
```ts
      // The result gate (Jev): a small change to an app goes on without a QA run; unsure or broken means it's tried.
      ...(fastKey && qaOn && env.KLORU_RESULT_GATE?.trim().toLowerCase() !== "off" ? { decideResult: resultGate({ apiKey: fastKey }) } : {}),
```
Confirm `fastKey` is declared above this object (it is, near line 810, and is used further down for `decideMessage`). In the `desk: ready` log line, change `QA tries apps` to:
```ts
QA tries apps${fastKey && env.KLORU_RESULT_GATE?.trim().toLowerCase() !== "off" ? " the result gate picks" : ""}
```

- [ ] **Step 8: Document the switch**

- `SETUP.md:168`: extend the parenthesis to `(`KLORU_QA = "off"` skips that; `KLORU_QA_MODEL` gives QA its own model; `KLORU_RESULT_GATE = "off"` has QA try every changed app instead of letting the result gate skip small changes)`.
- `docs/KEYS.md:45`: add `` `KLORU_RESULT_GATE`, `` after `` `KLORU_QA_MODEL`, ``.
- `docs/ARCHITECTURE.md`: the doc has a numbered list (point 3 is "Access is reviewed once."). Add a point at the end of that list, numbered to follow the last one:

  > **Reviews scale with the task.** An issue carries the reviews it owes (`reviews.ts`): each is open, passed, awaiting changes or waived. App QA is a `tried` review. When an engineer finishes with a changed app, the result gate (`result-gate.ts`, Jev) says whether it needs trying; unsure, slow or broken means it is tried. A worker's message about the app waits on the issue until that check is settled.

- [ ] **Step 9: Everything, then commit**

Run: `pnpm run build && pnpm run test`
Expected: PASS across packages.

```bash
git add packages/server/src/result-gate.ts packages/server/test/result-gate.test.ts packages/server/test/result-gate.live.test.ts packages/server/src/boot.ts SETUP.md docs/KEYS.md docs/ARCHITECTURE.md
git commit -m "feat(reviews): the result gate runs on Jev; a small change to an app goes on without a QA run

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## After the last task

- `pnpm run check` (build, tests, smoke) passes.
- `git log --oneline main..review-gates` shows the spec, this plan and five commits.
- Do not merge or push. Report: the labeled-case result from Task 5 Step 6 (count and any rewording), and anything in the desk that behaved differently from this plan's description.
- After deploy (Evan's call): in production logs, `desk: #<n> result gate → none|tried <p>` appears once per app ticket; a "Result check" line is on the issue thread.
