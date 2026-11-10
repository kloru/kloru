# Outbox Agent Implementation Plan

**Goal:** Every message Kloru sends a person goes through that person's outbox: a fast pass on
each item, an organizer agent for what waits, and timed items for reminders (#42).

**Spec:** `docs/superpowers/specs/2026-11-10-outbox-agent-design.md`

**Architecture:** `PersonOutbox` (desk) owns a per-person append-only file and a small state
machine per item. Writers call one `submit`. The fast pass is a Jev decision (server); the
organizer is an agent run per person (desk). The desk records one ledger entry per finished item.

## Files

| File | What it holds |
|---|---|
| `packages/desk/src/outbox-machine.ts` | item states and the moves between them |
| `packages/desk/src/outbox-store.ts` | `outbox/<person>.jsonl`, fsynced; `readOutbox` for the website |
| `packages/desk/src/outbox.ts` | `PersonOutbox`: submit, fast pass, timers, organizer wakes, recovery, list, cancel |
| `packages/desk/src/outbox-organizer.ts` | the organizer's prompt, view and tools |
| `packages/server/src/outbox-decider.ts` | the fast pass on Jev |
| `packages/desk/src/desk.ts` | writers submit here; one ledger entry per item; `remind`, list, cancel |
| `packages/desk/src/worker-tools.ts`, `pm.ts` | `remind`, `outbox_list`, `outbox_cancel`; `tell_caller` removed |
| `packages/server/src/text-desk.ts`, `text-talker.ts` | thread replies submit to the outbox; talker tools |
| `packages/server/src/boot.ts` | wires the fast pass, the organizer and the timer |
| `packages/web/src/desk-pages.ts`, `server.ts`, `html.ts` | the Messages page (`/outbox`) |

## Tasks, in the order they were built

1. State machine and store, with tests for every move and for a file read back after a restart.
2. `PersonOutbox`: submit, fast pass, send, the safe path when the pass fails, recovery of an item
   caught in `sending`.
3. Timed items: schedule, fire at the time, cancel, survive a restart.
4. Organizer: view, tools, wake timing (90 s after the last queued item, 5 min at most, 20 s after
   the person speaks, its own wake).
5. Desk: every writer submits; `why` set by plumbing; ledger entry per item; old paths removed.
6. Fast pass on Jev with a labeled live set.
7. Text threads and the talker's tools.
8. Messages page.

## Tests

- `packages/desk/test/outbox.test.ts`: the outbox alone.
- `packages/desk/test/coms.test.ts`: every writer through the desk, reminders, list and cancel.
- `packages/server/test/outbox-decider.test.ts` and `.live.test.ts`: the fast pass, and its labeled cases.
- `packages/server/test/text-desk.test.ts`, `text-talker.test.ts`: threads and talker tools.
- `packages/web/test/outbox-page.test.ts`: the Messages page.

## Where the build differs from the spec

- Both rollout steps ship together.
- When the fast pass fails, a reply or a reminder at its time is sent; anything else waits for the organizer.
- The Messages page is read-only; stopping an item is done by telling Kloru.
- A send that fails in a text thread stays in the outbox and is tried again.
