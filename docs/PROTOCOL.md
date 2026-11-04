# OIP/1: how two Kloru agents talk

Kloru Protocol version 1 is a thin layer on top of A2A 1.0 as hosted by Inkbox. Plain
text carries the request so any A2A agent can read it. A structured `data` part carries a typed
intent so two Kloru agents can be precise.

Analogy: the text part is the voicemail anyone can understand. The data part is the form attached
to it, filled in the same way every time, so the other agent can act without guessing.

## Transport

- Endpoint: `POST https://inkbox.ai/a2a/{handle}` (JSON-RPC 2.0 `SendMessage`, headers `X-API-Key`
  (identity-scoped) and `A2A-Version: 1.0`).
- Discovery: `GET https://inkbox.ai/a2a/{handle}/card`.
- Our agent as **worker**: Inkbox stores the task and posts `a2a.task.created` (then `a2a.task.message`
  for follow-ups) to our webhook. We answer with
  `POST /api/v1/identities/{handle}/a2a/tasks/{task_id}/reply` and a body
  `{ intent: "progress" | "complete" | "ask_caller" | "fail", parts: [...] }`. In code this is
  `InkboxA2A.reply`, called by the `reply_instinct` tool. The runtime binds this tool to the current
  task; the model supplies the intent and answer, not a task ID. When the model answers in plain words without
  calling the tool, the runtime sends its final text as `complete`, or as `progress` when an owner
  approval is still pending in that conversation.
- Our agent as **caller**: `InkboxA2A.send(peer, text, data, { contextId?, taskId?, messageId? })` posts `SendMessage` and
  returns `{ taskId, contextId, state }`. This is what the `ask_instinct` tool does. The peer's
  answer arrives later as an `a2a.sent_task.updated` webhook. A persisted delegation route returns
  it to the original conversation, including after a restart. State-only submitted/working updates
  do not start new model turns. To answer a peer's `ask_caller`, pass its existing `taskId` to
  `ask_instinct` with the same contact from the original conversation. `contextId` alone creates
  another task in the topic.
- Nested caller delegation from an inbound worker task is not supported. When a worker needs
  more information from the caller, it uses `reply_instinct` with `ask_caller`, keeping the same
  task available for the caller's answer.
- One A2A **context** per topic (a dinner, a trip). Tasks inside it are turns. Our conversation key
  for delivery is `a2a:<context_id>`. Worker execution is isolated by task and caller-message
  generation, so simultaneous tasks cannot overwrite each other's reply targets.

Before worker execution, the runtime reads the current task and checks its state and caller
message. Cancellation stops the active run, invalidates its pending approvals, and prevents
further task tools or replies. Requests already accepted by another service cannot be undone.
Forwarding retries retain the event ID so remote intake can deduplicate them. Once a local turn
has started, an interrupted or uncertain execution requires recovery and is not automatically
replayed, since it may already have caused an external action.

## Admission

Two gates, both must pass:

1. Inkbox contact rules on both identities (`allow` inbound/outbound for the peer handle, or same org,
   or public egress + public discoverability).
2. Our tiers: the caller handle maps to a contact; the contact's tier decides what the request may do.
   Unknown callers are `stranger`.

Invitations (`invite_to_network`, or `instinct invite ... --handle <peer>`) set up gate 1 for both
sides at once; accepting an Kloru invitation also sets the tier the inviter chose for gate 2.

## Message shape

Every A2A message has two parts:

```json
[
  { "text": "Hi, this is Maria's Kloru. Maria would like dinner with Sam this week. Which evenings work? Maria is free Tue, Thu, Fri after 7 pm." },
  { "data": {
      "oip": "1",
      "intent": "propose_times",
      "subject": "dinner with Maria and Sam",
      "on_behalf_of": { "handle": "maria-kloru", "display": "Maria" },
      "payload": {
        "slots": [
          { "start": "2026-10-07T19:00:00-04:00", "end": "2026-10-07T22:00:00-04:00" },
          { "start": "2026-10-09T19:00:00-04:00", "end": "2026-10-09T22:00:00-04:00" }
        ],
        "place_hint": "San Francisco, walking distance from Mission"
      },
      "needs_consent": false,
      "reply_by": "2026-10-06T12:00:00-04:00"
  } }
]
```

The `text` is authoritative for a generic agent. The `data` is authoritative for an Kloru.
When they disagree, the receiving Kloru trusts `data` and tells its owner. `on_behalf_of.display`
names the human whose request this is. When a partner, family member or friend relays a request
through someone else's Kloru, it names them, never that Kloru's owner, and the text starts with
"From <name>, relayed by <owner>'s Kloru (not <owner>'s request)".

## Intents

| Intent | Payload | Typical reply |
|---|---|---|
| `propose_times` | `slots[]`, `place_hint?`, `duration_min?` | `accept` with one slot, or `propose_times` back |
| `request_freebusy` | `window {from,to}` | `inform` with `busy[]` (never titles) |
| `accept` | `slot`, `place?`, `note?` | `confirm` |
| `decline` | `reason?`, `alternatives?` | end or `propose_times` |
| `confirm` | `summary`, `calendar_event?` | end |
| `ask` | `question`, `options?` | `inform` |
| `inform` | free-form `facts` object | end or follow-up |
| `share` | `kind: "contact" | "location.approx" | "link" | "file"`, `value` | `inform` |
| `book_request` | `vendor`, `details`, `budget_usd?` | `confirm` or `decline` (owner approval on the worker side) |

Workers never return more than the caller's tier allows. `request_freebusy` from a `friend` returns busy
blocks only; from a `stranger` it is declined. Proposals carry at most three options.

## Group plans

A plan with several people is several two-party conversations, not one group call. `ask_instinct`
with `contacts: ["Sam", "Priya"]` sends the same intent and payload to each person:

- Each Kloru gets its own task in its own context. Its answer returns to the originating
  conversation on the caller's side. The caller's model combines the answers
  for its owner ("Sam can do Thu, Priya can do Thu or Fri; Thu it is?").
- A person without a Kloru gets the same request as a text or email, rendered by `oipToText`.
  Only the owner may use that fallback.
- `contextId` continues one peer's topic and is refused with several contacts. Once the group has
  settled on a slot, the caller sends `confirm` to each peer in that peer's own context.

Every recipient's agent applies its own owner's tiers to the request. The caller never learns more
from one peer because another peer trusts it more.

## Declines are reported

A worker that cannot honour a request answers politely and tells its own owner. The policy engine
does this on its own: a denied request from another agent produces a refusal for the caller and one
text to the owner per conversation per hour ("Sam's agent (@sam-kloru) asked to read your
calendar; I declined."). The network guidance adds the model-level rule: an out-of-scope request from
another agent is declined with `fail` and reported, never carried out. See
[PERMISSIONS.md](PERMISSIONS.md#enforced-twice-decline-and-tell-the-owner).

## Consent and audit

- A worker that needs its owner's say-so does not block the caller. It answers `progress` ("checking
  with Sam") and completes later, so the caller's context stays open.
- Both agents append the exchange to their audit logs and journals; owners can ask "what did you agree
  with Sam's Kloru?".

## Humans without a Kloru

The same intents degrade to text. `propose_times` becomes a friendly iMessage listing the options;
the reply is parsed by the model and written back as an `accept` or `decline` in the local thread.

