# Reviews that scale with the task

Design for direct answers, review gates and `ask_review`, 2026-11-10. The reasoning and diagrams
are on the [design page](https://claude.ai/artifact/Kqo5SA54YuG6rZAFng89iG).

## Problem

Kloru gives every request close to the same workflow.

- A question the talker could answer itself is filed as a ticket. The text talker's prompt says
  "To look something up or do something, file_issue it" (`text-talker.ts:12`), and the talker has
  no read tools. The store fast path runs only after a ticket exists and only for the primary
  owner, so its answer arrives as a second message after a 3 s burst wait and a second talker turn.
- Every engineer ticket gets one PM review of the result. App work also gets QA (7cc5673e). Nothing
  else is tried before delivery.
- Both loops check the result against the spec. Nothing checks the spec against what the person
  meant. The PM is told to "put your best reading in the spec" (`pm.ts:35`), and `done_when` is
  written from that same reading, so a wrong reading passes both loops.
- An engineer can text an app's link (`messageCaller`) before QA has tried the app.

A text change and a week-long trip plan should not get the same process. How hard the spec is and
how hard the work is vary separately, so one size per ticket is not enough.

## Goal

Each handoff decides for itself whether the work needs another pair of eyes, using what is known at
that moment. A simple request passes straight through. A vague one stops at the spec. A large build
stops before the work and after it.

Success:

- "Why do cats meow?" is answered in one message with no ticket.
- A small change to an existing app is delivered without a QA run.
- A request that can be read two ways is caught before an engineer starts, not after delivery.
- With every gate switched off or failing, Kloru behaves exactly as it does today.
- Each gate passes a labeled set of 10–30 cases before it is switched on in production.

## Approach

Three new things, all in the existing desk:

1. **A review plan on each ticket.** The reviews it owes, each with a small state machine.
2. **Gates.** One Jev decision at each handoff that may add a review to the plan.
3. **`ask_review`.** A tool any agent can call to add a review itself.

App QA becomes one kind of review under this plan. No new standing role is added: a reviewer is a
second PM, a second engineer, or QA, started in a fresh conversation.

Considered and set aside:

- **One size per ticket** (small, medium, large) chosen once. It cannot tell a hard spec with easy
  work from a clear spec with hard work, and it is decided before anyone has looked at the work.
- **The author decides.** The PM sizes its own spec, the engineer its own result. No extra
  decision, but an author that misread the request also thinks no review is needed.
- **Review everything.** Slow and costly for the many small requests.

## The path of a request

```
message ─► talk desk ─┬─ answers or looks up ──────────────────────────────► reply (no ticket)
          (gate 0)    └─ file_issue ─► PM spec ─► gate 1 ─► gate 2 ─► work ─► gate 3 ─► PM review ─► reply
                                                    │          │                 │
                                                    ▼          ▼                 ▼
                                              second reading  plan first    tried / re-opened /
                                                                             read back
```

| Gate | Asks | Decided by | Sees | Can add | Timeout or error |
|---|---|---|---|---|---|
| 0 | Answer here? | Talk desk | The message and the brief | Nothing: it answers, looks up or files | Files a ticket |
| 1 | Is the spec settled? | Jev | The person's words and the PM's template | A spec review | Goes on |
| 2 | Is the work simple? | Jev | The settled spec, deliverable, needs | A plan review | Goes on |
| 3 | How should the result be checked? | Jev | Spec, result, ledger, what changed | A result check | Today's rule: an app that changed is tried |

Gate 0 is the talker's own choice, guided by its prompt. Gates 1–3 are decision-model calls built
like `coms-decider.ts`: a `choice` question whose criteria are guidelines, a small typed state, a
3 s timeout.

For gates 1–3:

- **Low confidence adds the review.** A split probability is the sign that the case is unclear.
  At gate 3, where there are several checks, low confidence gives today's rule.
- **A timeout or error falls back to today's behavior,** so a Jev outage neither stalls tickets nor
  multiplies cost.
- **Every decision is noted on the ticket** with its choice and probability.
- **Each gate runs once per ticket.** A second `assign` after a spec review is not gated again.

## The review plan

A new unit, `packages/desk/src/reviews.ts`: types and pure functions that return `Result`. The desk
calls it; it knows nothing about workers or models.

```ts
type ReviewKind = "spec" | "plan" | "result";
type ReviewHow = "reader" | "tried" | "reopened" | "read_back";
type ReviewState = "open" | "passed" | "changes" | "waived";

interface Review {
  kind: ReviewKind;
  how: ReviewHow;
  askedBy: "gate" | "pm" | "engineer";
  state: ReviewState;
  rounds: number;        // times the maker was sent back
  notes?: string;        // the reviewer's list, or why it was waived
  version?: number;      // for "tried": the app version last tried
  at: string;
}
```

```
open ─► passed
open ─► changes ─► open        (the maker ran again; rounds + 1)
open ─► waived                 (the reviewer failed or gave no verdict)
changes ─► waived              (round cap reached; the notes travel with the result)
```

`Issue.reviews?: Review[]` replaces `Issue.qa`. A plan is settled when no review is `open` or
`changes`. The issue's own statuses do not change: reviews run while it is `open` (spec) or
`in_progress` (plan, result), as QA does now.

How each kind is done:

| How | Reviewer | Evidence the maker did not produce |
|---|---|---|
| `reader` | A peer in the same role, fresh conversation | It reads the person's words before the maker's work |
| `tried` | QA, as built | A browser and the app's scratch data |
| `reopened` | A checker with read tools | The sources the answer cites |
| `read_back` | The desk, in code | The account itself, after the change |

Round caps: spec 1, plan 1, result 3 (today's `QA_ROUNDS`). At the cap the review is waived and its
notes go on with the work, as QA's do now.

## The reviews

### Spec review (gate 1)

`assign` for a `work` issue calls the spec gate before the access review. On `review`:

1. A reader runs on the PM model with a short prompt. It gets the request and the part of the call
   around it, writes the goal it would aim for, and only then sees the PM's template.
2. It returns `same`, or the difference the person would notice.
3. `same`: the review passes and `assign` carries on.
4. Different: `assign` returns an error to the PM with the reader's note: assign again with the spec
   it now believes, or `ask_caller`. This is the pattern `messageCaller` uses for a redraft.

The reader never asks the person. The PM decides whether the difference is worth a question, which
keeps its guideline about not asking what can be assumed.

### Plan review (gate 2)

After the spec is settled, the work gate chooses `do` or `plan_first`. On `plan_first` the plan
gains an open plan review and the engineer's first prompt says to call `ask_review` with its plan
before it changes anything.

If the engineer finishes without asking, the review is waived with "never asked" and noted.
Nothing blocks. Whether engineers follow the line is a bench question, not a code guard.

### Result check (gate 3)

`workerDone` for a `work` issue calls the result gate where it calls `startQa` today. Choices:

- `none`: straight to the PM's review.
- `tried`: QA uses the app. Offered only when an app changed in this run and a browser exists.
- `reopened`: a checker re-opens the sources the result cites. Offered when the deliverable is an
  answer or a page.
- `read_back`: the desk reads the changed item back. Offered when the ledger has writes.

The checker is told to check each line of `done_when`, so a ticket with five conditions gets five
checks without a structured list. `tried` is today's QA with its trigger moved behind the gate.
The PM's review of the result stays on every engineer ticket: it is also the step that writes what
the person hears.

### `ask_review`

A tool for the PM and for engineers: `ask_review(issue, kind, text)`.

- It appends a review to the plan, runs a reviewer, waits, and returns the verdict as the tool's
  result. The author decides what to do with it.
- Reader for `spec` and `plan`. For `result`, the same choices as gate 3.
- A reviewer run does not have the tool.
- Two per kind per ticket. After that it answers: decide, or tell the PM.
- A reviewer that errors or takes more than 2 minutes: "No review available; carry on."

## Worker messages wait for the result check

While a `work` issue is `in_progress` and has an app that changed in this run, a worker's message
to the caller is kept until the result gate has run and any review it added is settled. This covers
both routes in `messageCaller`: the live conversation (`deliver`) and the outbox (`submit`).

This is delivery order, so it is plumbing. If the gate chooses `none`, the message goes as soon as
the engineer finishes. Messages on tickets with no changed app are not held.

## Direct answers (gate 0)

- **From what it knows.** One line in the text and voice talker prompts: answer what you know and
  what the brief shows; file what needs doing, live information, or someone else's things. Changed
  with the prompt-editing skill and proved on the talker benches.
- **After a lookup.** A `look_up` tool for the text talker. It runs the store fast path's plan and
  answer steps (`fast-path.ts`) with no ticket, for the primary owner only, and appends a line to
  the ledger so the next brief shows what was asked and answered. A decline returns "file it".
- The store fast path after `file_issue` stays for changes.

## Phases

Each phase ships on its own and leaves Kloru working.

1. **Review plan and result gate.** `reviews.ts`, `Issue.reviews`, `result-gate.ts`, app QA moved
   under the plan, the message hold. With no gate configured, behavior is today's.
2. **`ask_review` and the work gate.** The reader reviewer, plan review, `work-gate.ts`.
3. **Spec gate and second reading.** `spec-gate.ts`, the reader for specs.
4. **Direct answers.** The talker guideline, then `look_up`.
5. **More result checks.** `reopened`, `read_back`, a test run for automations, pages under `tried`.

The first implementation plan covers phase 1.

## Measuring

- **Ticket to reply.** Computed from the `pm` and `<role> #<issue>` spans the desk already sends to
  Langfuse. There is no such number today.
- **Reopens.** `merged → open` and `resolved → open` counted per deliverable. This is the signal
  that a spec or a check missed.
- **Gate decisions.** Choice, probability, and whether the review it added found anything. A gate
  whose reviews never find anything is choosing `review` too often.

## Testing

- `reviews.test.ts`: every transition, the caps, `settled`.
- Desk tests with fake gates, in the style of `app-qa.test.ts`: each gate choice leads to the right
  review; a throwing gate gives today's path; a held message is released on settle.
- `app-qa.test.ts` keeps passing with no gate configured.
- One labeled set per gate, 10–30 cases, as a live test beside the decider. Past tickets suggest
  the cases (a ticket sent back twice, three QA rounds, a reopen), rewritten so that no real person
  or family detail is in the repo.
- Talker benches for the gate 0 guideline.

## Not in this design

- A structured list of criteria on `done_when`.
- Skipping the PM's result review for small engineer tickets.
- Lookups for family members other than the primary owner.
- Saving corrections as bench cases automatically. Reopens are counted; cases are written by hand.

## Open points

- Whether Jev can judge "is the spec settled". It is the hardest of the three questions and gets
  its labeled set before phase 3 is built.
- Issues stored with the old `qa` field. Phase 1 reads it once into a `tried` review when the issue
  is loaded, so a ticket in flight during the deploy keeps its round count.
