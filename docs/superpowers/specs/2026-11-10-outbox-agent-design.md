# One outbox per person

Design for the outbox agent and for [issue #42](https://github.com/kloru/kloru/issues/42) (send a
message later), 2026-11-10.

## Problem

Every message Kloru sends passes a check, and every check answers a question about one message:
does this draft fit their style, should this one go now. Nothing looks at the whole stream and
asks whether the person is glad to be getting it.

On the first full day of an email automation, one person was sent 83 messages. 45 were reports
from the automation that nobody was waiting for; several arrived late at night to say that no
alert had been sent because it was late; eight arrived in nine minutes about one batch of calendar
invites. Each was a reasonable answer to "should this one go?".

The causes, in the code as it stands:

- Three writers send on their own: the talker (`sendInConversation`), a worker (`messageCaller`)
  and the PM (`tellCaller`). A fourth path, `askOwner`, sends with no check at all.
- A finished automation issue counts as "something they asked for and haven't heard"
  (`askedAndDone`), so the PM is woken to report each one (`sendNotice`).
- Every tie-break leans toward sending: an unsure drop from the PM is sent, a failed check is
  sent, a message held once is sent.
- "Hold" has no time attached. A held message waits for the person's next conversation, or goes
  back to the PM to send "with the rest". For an automation run, that conversation may never come
  (#42).
- A reminder is a one-time automation that starts a PM and a worker to send a line that was known
  when it was saved (#42).

## Goal

Each person has one outbox. Every message for them enters it, and one agent that sees everything
queued and everything already sent decides what they receive.

Success:

- A day like the one above produces a handful of messages, not 83.
- Nothing unprompted arrives outside the hours a person has asked for, unless they chose that time.
- Nothing they were waiting for is lost or left unsent.
- #42's acceptance list holds (see Testing).

## Approach

A new Outbox unit in `packages/desk` owns the queue, its state machine and the timer. The talker,
workers and the PM call one `submit` and no longer send. The send logic leaves `desk.ts`.

Considered and set aside:

- **Extend the existing paths** (`sendChecked`, `sendInConversation`) with a queue and a timer.
  Less code moves, but the separate paths and their "when in doubt, send" overrides stay, and they
  are much of the problem.
- **A separate process** with its own store. A second thing to deploy and keep alive on a
  one-machine install, for no gain yet.

## How a message flows

```
talker ─┐
worker ─┼─ submit ─► fast pass ─► send now ──────────────► channel ─► ledger
PM ─────┤              │  └─────► drop ───────────────────────────────► ledger
ask ────┘              └────────► queue ─► organizer ─► send / merge / page / schedule / drop
reminder ─ submit (with a time) ─► scheduled ─► timer ─► fast pass ─► …
```

### One door: `submit`

Every outgoing message to a person on Kloru's own channels becomes an outbox item. That covers
talker replies, worker results, PM messages, questions that need a yes (including `askOwner`) and
reminders. A send from a person's connected account (their Gmail) is not an outbox item; it keeps
the message check it has today.

An item records:

- `to`: the person (phone), and the channel the writer suggests (text, email), subject, media.
- `text`: the draft as written. It is never edited in place.
- `from`: talker, worker, pm or organizer, with the issue and conversation it came from.
- `why`: one of
  - `reply`: an answer in a live conversation, with what they wrote;
  - `result`: the outcome of something a person asked for;
  - `report`: output of an automation or of Kloru's own runs, which nobody asked for by hand;
  - `question`: something that needs their answer or yes before work continues;
  - `reminder`: words to send at a time they chose.
- `sendAt`: set for a reminder, or by the organizer.

`why` comes from plumbing, not a model: a reply is a talker send answering a turn; a report is any
item whose issue has `event` or `purpose` set or was started by a schedule; a question is an
`askForYes`, `askCaller` or `askOwner`; a reminder is saved with its time; the rest are results.

### Fast pass

A structured decision model (the one behind today's message check, `coms-decider.ts`) looks at
each item as it arrives. It sees the item and its `why`, the request and last turns it follows,
the person's guidelines, message preferences and outbox notes, their local time, whether they are
in a conversation with Kloru now, what is queued and scheduled for them, and what was sent and
dropped in the last day.

It chooses one of three:

- **send**: it goes out now.
- **drop**: it is recorded in the ledger with the reason and never sent.
- **organizer**: it stays in the person's queue.

The draft check (`checkDraft`, style) still runs on anything about to be sent.

### Organizer

One full agent per person. It wakes:

- a short pause after an item is queued (90 seconds, restarted by each new item, at most 5
  minutes), so a burst arrives as one batch;
- at a wake-up time it set itself;
- when the person replies or starts a conversation.

Each run it reads the whole queue, the day's ledger (sent, dropped, merged), how the person
reacted (replies, silence, "stop"), their guidelines, message preferences and outbox notes. For
each queued item it does one of:

- **send** it as written;
- **merge** it with others into one message it writes;
- **page**: add it to a living page and send, or fold into another message, one short line with
  the link;
- **schedule** it for a time;
- **drop** it.

It chooses the channel. It may leave items queued and set its next wake-up. It may add a dated
line to the person's outbox notes. Rarely, when a pattern is costly and unclear, it may send the
person one question ("I sent 12 email updates today. Want one summary a day instead?") and save
the answer as a guideline.

Two things hold whatever it decides:

- **Exact details survive.** Original drafts stay in the item records, and the ledger entry for a
  merged message lists the items it covers.
- **A question is never folded into a digest.** It may be delayed or sent beside other things, but
  it stays its own clearly stated question.

Anything the organizer writes passes the draft check, and is sent as an item `from: organizer`
that skips the fast pass (the organizer already decided).

### Timed items (#42)

An item with `sendAt` waits in `scheduled`. The timer fires it with no PM or worker run. At that
moment the fast pass runs with the current time and ledger, so a stale or already-delivered
message can be dropped or handed to the organizer.

A `reminder` is a time the person chose, and the fast pass is told so. A reminder asked for at
6:30 AM is sent at 6:30; quiet hours for alerts don't hold it.

Ops, or the talker for a plain reminder, saves a reminder with a new tool (`remind`: the words and
the time). It no longer saves an `at` automation for words that are already known. An automation
is still right when something has to be looked up or done at that time.

### Ledger

Every item ends in exactly one ledger entry: sent, dropped (with the reason), merged (naming the
message that covered it) or cancelled. A sent message that covers several items lists them. The
ledger stays the only record of what went out, and nothing leaves any other way.

### What goes away

- The PM's wake-up after a conversation to report what "never reached them" (`sendNotice`, the
  `unheard` trigger) and its `tell_caller` tool. A finished issue's result is submitted to the
  outbox instead.
- `askedAndDone` treating an automation's issue as something a person asked for. The item's `why`
  says which it is.
- The overrides that turn an unsure decision into a send: an unsure drop from the PM, a held
  message sent the second time, a worker's hold left as a comment for the PM.
- `askOwner` sending outside the check.

## Item states

A state machine in the style of `machine.ts`; every change goes through one `transition`, and an
illegal one is an error.

| State | Meaning | May go to |
|---|---|---|
| `new` | Submitted; no fast pass yet | `sending`, `dropped`, `queued` |
| `queued` | Waiting for the organizer | `sending`, `scheduled`, `merged`, `dropped`, `cancelled` |
| `scheduled` | Has a `sendAt` | `sending`, `queued`, `dropped`, `cancelled` |
| `sending` | Handed to the channel | `sent`, `queued` |
| `sent` | Delivered to the channel | final |
| `dropped` | Decided against, with a reason | final |
| `merged` | Covered by another message | final |
| `cancelled` | The person or the asker withdrew it | final |

A reminder enters at `scheduled`. An organizer-written message enters at `sending`.

## Storage and restarts

- Items live in the desk repo, one file per person (`outbox/<person>.jsonl`), written with the same
  fsync discipline as issues. Final items older than 30 days are compacted away; the ledger keeps
  the record.
- The organizer's next wake-up per person is stored beside the items.
- The timer is driven by the existing scheduler's 30-second poll, which asks the outbox what is
  due: scheduled items and organizer wake-ups. Nothing is held only in memory.
- **Never twice.** An item is moved to `sending` and saved before the channel is called. On boot,
  an item found in `sending` goes to `queued` marked "may already have been delivered", for the
  organizer to weigh; it is never resent blindly.
- On boot: `new` items get their fast pass, overdue `scheduled` items fire (through the fast pass,
  which decides whether they still matter), and a non-empty queue wakes the organizer.

## Failures

- **The fast pass fails or times out.** A `reply` is sent, because silence in a conversation is
  worse than a message too many. Everything else is queued.
- **The organizer fails or hangs.** Its run time is bounded. Items stay queued and it is retried.
  After two failed runs, queued `result` and `question` items are sent as written, oldest first.
  This is the only fallback that sends, and it never applies to a `report`.
- **The channel send fails.** The item returns to `queued` with the error noted.
- **Two runs at once.** The organizer runs one at a time per person; a wake-up during a run is
  remembered and runs after it.
- **A question blocks work.** A `question` whose issue is waiting on it is visible to the fast
  pass and the organizer as blocking, with how long it has waited.

## Listing and cancelling

- The talker gets two tools: list what is queued or scheduled for the caller, and cancel one
  ("never mind the reminder"). A person cancels their own items; an owner can cancel any.
- The website shows each person's outbox to them and to owners: queued, scheduled, and the day's
  sent and dropped with reasons.

## Models and guidelines

Behavior comes from what the models read, not from rules in code (guidelines-not-rules). Code is
the queue, the state machine, the timer and the ledger. There are no counts, caps or quiet-hour
windows in code.

- **Fast pass:** the structured decision model, with a three-choice schema (decision-models). Its
  prompt asks one thing: does this need to reach them now, is it not worth sending at all, or
  should it wait with the rest?
- **Organizer:** a full agent with a short role prompt stating one goal: the person is glad to
  have each message they get, and misses nothing they needed. Its tools: read the queue and the
  day, send, merge, add to a page, schedule, drop, set its next wake-up, add an outbox note, ask
  the person.
- **Outbox notes:** `<person>/outbox.md` in memory, beside `guidelines.md` and `messages.md`. Dated
  lines, newest kept, readable and editable by the person like any memory file. Read by the fast
  pass and the organizer.
- A person's hours, how much is too much and what counts as noise are in their guidelines and
  notes. Where today's guidelines scope quiet hours to one kind of alert, the organizer's notes
  are where the broader pattern is learned, and its question to the person is how it gets
  confirmed.
- Both prompts are written with the prompt-editing skill and benched before and after each change.

## Testing

Unit tests (fakes for the models and the channel):

- The state machine: every legal transition, and that illegal ones throw.
- Saved before sending; an item found in `sending` on boot is queued, not resent.
- Boot recovery: `new`, overdue `scheduled`, non-empty queue.
- The pause before the organizer runs, and one run at a time per person.
- Fast pass failure: a reply is sent, anything else is queued.
- Organizer failure twice: results and questions go out as written, reports don't.
- Cancel and list, and who may cancel what.
- Every item ends in exactly one ledger entry; a merged message lists what it covers.
- `why` is set correctly for a reply, a result, an automation report, a question and a reminder.

Benches, replayed from real days and rewritten with the made-up family (no-real-people):

- The 83-message day: the person receives a handful, including everything they asked for.
- Eight calendar invites in nine minutes: one message.
- An automation report at 11 PM saying no alert was sent: not sent at night; at most a line in the
  morning.
- A result someone is waiting for, arriving while they are mid-conversation: delivered promptly.
- A question that blocks work, arriving beside six reports: sent as its own question.

#42's acceptance list, as tests and live cases:

- A message held at 11 PM Pacific for quiet hours is sent shortly after 7 AM Pacific, once,
  through the fast pass, and recorded in the ledger.
- "Remind me at 9 tomorrow to call the dentist" sends at 9:00 (±1 min) with no PM or worker run.
- A reminder the person asked for at 6:30 AM is sent at 6:30 (a live case for the fast pass).
- Timed items survive restarts and deploys, and can be listed and cancelled.
- An item whose time passed while Kloru was down is sent on boot if still relevant, never twice.

## Rollout

Two steps, each deployable on its own.

1. **The outbox and the timer.** `submit`, items and their states, storage, the fast pass with its
   three choices, timed items, the `remind` tool, list and cancel, boot recovery. Until the
   organizer exists, a queued item gets one more structured decision ("send it now, or at what
   time?") and is scheduled for that time. This closes #42.
2. **The organizer.** The agent, its tools, the outbox notes, the question to the person, the
   website view, and the removal of the PM's after-conversation wake-up and `tell_caller`. The
   interim decision from step 1 is removed.

## Out of scope

- Sends from a person's connected accounts to other people (email on their behalf). They keep
  today's message check.
- Voice. What Kloru says on a call is not an outbox item; a message sent during or after a call is.
- Changing how guidelines and message preferences are learned from conversations.
