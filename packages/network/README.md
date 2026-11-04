# @kloru/network

The trusted network for Kloru: who your agent knows, how much each person may ask of it, and how it talks to their agents.

This package gives the agent nine tools and one prompt section. It owns no state of its own. Contacts live in core's `ContactStore`, grants in core's `PolicyEngine`, and every change lands in core's `AuditLog`. The package depends on core for types only, so it can be tested on its own.

Analogy: core is the house and its locks. This package is the guest list, the spare keys, and the phone the agent uses to call other houses.

## Contents

1. [Tiers](#tiers)
2. [Grants](#grants)
3. [OIP/1, the typed envelope](#oip1-the-typed-envelope)
4. [A2A flow](#a2a-flow)
5. [Worked example: dinner between two agents](#worked-example-dinner-between-two-agents)
6. [People without a Kloru](#people-without-a-kloru)
7. [Tools](#tools)
8. [Prompt guidance](#prompt-guidance)
9. [API](#api)
10. [Wiring it in](#wiring-it-in)
11. [Tests](#tests)

## Tiers

Every contact sits in one tier. The tier decides what their messages, and their agent's messages, may ask for. The full capability table is in [docs/PERMISSIONS.md](../../docs/PERMISSIONS.md). The short version:

| Tier | Who | What their Kloru can learn or do |
|---|---|---|
| `partner` | spouse, partner | calendar details, exact location, most preferences; books and writes to the calendar after the owner says yes |
| `family` | close family | free/busy, approximate location, some preferences; commitments need a yes |
| `friend` | friends | free/busy, yes or no on plans, up to 3 proposed options |
| `contact` | colleagues, services | public facts, leave a message |
| `stranger` | everyone else | one introduction, leave a message, rate limited |

Nobody but the owner is `owner`. The tools refuse to place a contact there.

An agent inherits the tier of the person it acts for. When `@sam-kloru` calls, `resolveA2aPrincipal` looks up the contact whose `agentHandle` is `sam-kloru` and takes that contact's tier. An unknown handle is a stranger, whatever Inkbox let through.

The owner moves people between tiers in plain language. "Sam is my partner" becomes `trust_set_tier { contact: "Sam", tier: "partner" }`.

## Grants

A grant is a scoped, time-boxed exception. It adds capabilities on top of a tier for one purpose and then expires.

"Sam can book us dinner this week, up to $150" becomes:

```json
{
  "to": "contact:sam-lee",
  "capabilities": ["calendar.write", "plans.commit"],
  "scope": { "purpose": "dinner", "window": { "from": "2026-10-06", "to": "2026-10-12" }, "maxUsd": 150 },
  "expiresAt": "2026-10-12T23:59:59",
  "note": "Sam can book us dinner this week"
}
```

Rules the tools enforce:

- Only the owner can create, list or revoke grants.
- Capability names are checked against the list in `CAPABILITIES`. A typo fails the whole call rather than silently granting less.
- A window needs both ends. When `expiresAt` is omitted the grant expires at the end of the window's last day.
- `to` is resolved to a contact and stored as `contact:<id>`. A raw principal id such as `agent:sam-kloru` is accepted as given.
- Grants never widen past what the owner can do. The policy engine still applies spend limits to any `maxUsd`.

`trust_list` prints the whole picture: contacts grouped by tier, tier overrides, and active grants with their ids. `trust_revoke { grantId }` removes one.

Grants change the policy in memory. Pass `onPolicyChange` in the deps to persist them (see [Wiring it in](#wiring-it-in)).

## OIP/1, the typed envelope

Two Kloru agents speak A2A 1.0 through Inkbox. Every message has a plain text part that any agent can read and a `data` part with a typed intent that ours can act on precisely. The data part is OIP/1 (Kloru Protocol, version 1). The full spec is [docs/PROTOCOL.md](../../docs/PROTOCOL.md).

```json
{
  "oip": "1",
  "intent": "propose_times",
  "subject": "dinner with Maria and Sam",
  "on_behalf_of": { "handle": "maria-kloru", "display": "Maria" },
  "payload": {
    "slots": [
      { "start": "2026-10-06T19:00:00-04:00", "end": "2026-10-06T22:00:00-04:00" },
      { "start": "2026-10-08T19:00:00-04:00", "end": "2026-10-08T22:00:00-04:00" }
    ],
    "place_hint": "walking distance from Mission"
  },
  "needs_consent": false,
  "reply_by": "2026-10-05T12:00:00-04:00"
}
```

Intents: `propose_times`, `request_freebusy`, `accept`, `decline`, `confirm`, `ask`, `inform`, `share`, `book_request`. The table of payloads and expected replies is in the protocol doc.

Four functions handle the envelope:

- `encodeOip(m)` produces the wire object and drops undefined fields.
- `decodeOip(data)` validates. Anything that is not an OIP/1 object with a known intent returns `undefined`, so the caller falls back to the text part. Malformed optional fields are dropped, not fatal.
- `describeOip(m)` writes one paragraph for the model: intent, subject, sender, payload, consent flag, deadline, and the reply the protocol expects.
- `oipToText(m, ownerName, { tz })` writes a short friendly message for a human who has no Kloru. Slot times are printed in `tz` when given, else as the sender wrote them.

## A2A flow

```
 Maria's Kloru (caller)                 Inkbox                    Sam's Kloru (worker)
 ──────────────────────────                ──────                    ───────────────────────
 ask_instinct { contact: "Sam", ... }
   └ InkboxA2A.send("sam-kloru",
        text, encodeOip(oip))  ──────────► POST /a2a/sam-kloru
                                           stores task, posts webhook ──► a2a.task.created
                                                                           principal = resolveA2aPrincipal("maria-kloru")
                                                                           prompt includes describeOip(data) + networkGuidance
                                                                           reply_instinct { intent: "progress", ... }
 a2a.sent_task.updated ◄────────────────── POST .../tasks/{id}/reply ◄────┘
 (new message in the same conversation)                                    ... asks its owner, then
                                                                           reply_instinct { intent: "complete", oipIntent: "accept", ... }
 a2a.sent_task.updated ◄────────────────── POST .../tasks/{id}/reply ◄────┘
```

Admission is double gated. Inkbox contact rules decide whether the two identities may talk at all. Our tier decides what the request may do once it arrives. `invite_to_network` sets up both gates: it creates an Inkbox invitation for the other person and records the tier the owner chose.

Replies are asynchronous. `ask_instinct` returns at once with the task and context ids. The worker's progress and completion arrive later as webhooks, which the server turns into new messages in the same conversation. The guidance tells the model to say so to the owner rather than wait.

## Worked example: dinner between two agents

Maria and Sam are partners. Each has an Kloru. Maria's agent has the handle `maria-kloru`, Sam's has `sam-kloru`. Maria has Sam at tier `partner`; Sam has Maria at tier `partner`.

**1. Maria asks.** Maria texts her agent: "Set up dinner with Sam this week, Tue or Thu after 7."

Maria's agent checks her calendar, then calls:

```json
{
  "tool": "ask_instinct",
  "args": {
    "contact": "Sam",
    "intent": "propose_times",
    "subject": "dinner with Maria and Sam",
    "text": "Hi, this is Kloru, Maria's assistant. Maria would like dinner with Sam this week. Tue or Thu after 7 pm work for her. Which suits Sam?",
    "payload": {
      "slots": [
        { "start": "2026-10-06T19:00:00-04:00", "end": "2026-10-06T22:00:00-04:00" },
        { "start": "2026-10-08T19:00:00-04:00", "end": "2026-10-08T22:00:00-04:00" }
      ],
      "place_hint": "near the Mission"
    }
  }
}
```

The tool finds Sam's contact, sees `agentHandle: "sam-kloru"`, and sends the text plus `encodeOip(...)` with `on_behalf_of: { handle: "maria-kloru", display: "Maria" }`. Inkbox returns a task id and a context id. The audit log gets an `outbound` entry. Maria's agent texts her: "Asked Sam's Kloru about Tue or Thu. I will tell you when it answers."

**2. Sam's agent receives.** Inkbox posts `a2a.task.created` to Sam's agent. The server resolves the caller handle `maria-kloru` with `resolveA2aPrincipal` and gets Sam's contact "Maria" at tier `partner`. The prompt includes `describeOip(data)` and `networkGuidance(principal)`, which tells it what a partner may learn and that it must not commit Sam without his yes.

Sam's agent reads Sam's free/busy. Thursday is open. It answers at once so the context stays alive:

```json
{ "tool": "reply_instinct", "args": { "taskId": "task-7f3", "intent": "progress", "text": "Checking with Sam. Thursday looks open on his side." } }
```

Then it texts Sam: "Maria wants dinner this week, Tue or Thu after 7 near the Mission. Thu is free for you. OK to say yes to Thu 7 pm?"

**3. Sam says yes.** Sam replies "Thu works". His agent completes the task with a typed accept:

```json
{
  "tool": "reply_instinct",
  "args": {
    "taskId": "task-7f3",
    "intent": "complete",
    "text": "Sam can do Thursday Oct 8 at 7 pm. Anywhere near the Mission is fine.",
    "oipIntent": "accept",
    "payload": { "slot": { "start": "2026-10-08T19:00:00-04:00", "end": "2026-10-08T22:00:00-04:00" } }
  }
}
```

The tool wraps the payload as OIP/1 with `on_behalf_of: { handle: "sam-kloru", display: "Sam" }` and posts the reply.

**4. Maria's agent closes the loop.** The `a2a.sent_task.updated` webhook arrives with the accept. Maria's agent tells her: "Sam is in for Thu Oct 8, 7 pm, near the Mission. Want me to book somewhere?" Maria says "Yes, Nopa, keep it under $150."

Booking is a `plans.commit` and a possible `purchase`. The owner just approved it in this conversation, so the agent proceeds within the spend policy. Then it confirms with Sam's side:

```json
{
  "tool": "ask_instinct",
  "args": {
    "contact": "Sam",
    "intent": "confirm",
    "contextId": "ctx-21a",
    "text": "Booked: Nopa, Thursday Oct 8, 7:00 pm, table for 2, under Maria's name.",
    "payload": { "summary": "Nopa, Thu Oct 8, 7:00 pm, 2 people" }
  }
}
```

Both agents append the exchange to their journals. Either owner can later ask "what did you agree with Sam's Kloru?" and get the audit trail.

**What the tiers did here.** Sam's agent shared free/busy (allowed for `partner`) and did not share event titles (it never does over A2A). Neither agent committed its owner without a yes. If Maria had Sam at `friend`, the flow would be the same but Sam's agent would learn only yes or no, not Maria's preferences. If Sam's handle were unknown to Maria's contacts, Sam's agent would be a `stranger` and the request would be declined with an offer to pass a message.

## People without a Kloru

If a contact has no `agentHandle`, `ask_instinct` sends the same request as a normal message through the `Outbox`: iMessage when a phone is on file, email when only an email is. The body comes from `oipToText`, which turns the `propose_times` above into:

```
Hi, this is Kloru, Maria's assistant.
Maria would like to plan dinner with Maria and Sam.
Would any of these work?
1) Tue, Oct 6, 7:00 PM to 10:00 PM
2) Thu, Oct 8, 7:00 PM to 10:00 PM
Place: near the Mission.
Reply with the number that works, or suggest another time.
```

The human's reply comes back in the normal thread. The model reads it and continues as if it were an `accept` or `decline`.

This fallback is the owner's alone. When a partner, family member or friend calls `ask_instinct`, a contact without a Kloru is refused with "only the owner can message people who have no Kloru"; the agent never texts or emails a third party with someone else's words under "Hi, this is Kloru, Maria's assistant."

## Group plans

`ask_instinct` takes `contacts: string[]` as well as `contact`. Every person gets the same intent, subject and payload; Kloru agents get it over A2A, others as text or email, and the tool returns one line per person plus `details.results` with each contact's `ok`, `via`, `taskId` and `contextId`. Replies arrive separately, one `a2a:<contextId>` conversation per Kloru, so the model combines them for the owner. `contextId` only makes sense with one contact and is refused with several.

## What a non-owner may ask

`ask_instinct` is available to partner, family and friend (`network.ask`), so its `execute` narrows what they may do:

- They may address only their own contact entry (so a person can reach their own Kloru through this one). Anyone else, known or not, gets the same generic refusal; the contact list is never enumerated, and an ambiguous name returns "Several contacts match; ask the owner." without candidates.
- Over A2A the text is prefixed with who asked ("From Jo Rivera, relayed by Kloru for Maria (not Maria's request): ...") and `on_behalf_of.display` is the requester, never the owner, so the far side cannot mistake it for the owner's intent.
- The text or email fallback is refused.

## Tools

| Tool | Capability | Who | What it does |
|---|---|---|---|
| `contacts_search { query }` | `contacts.read` | owner (partners see only their own entry) | find people by name, phone, email or handle; empty query lists all |
| `contacts_upsert { name, phone?, email?, agentHandle?, tier?, notes? }` | `trust.manage` | owner | add or update a contact; phones and emails are merged |
| `trust_set_tier { contact, tier }` | `trust.manage` | owner | move a contact between tiers |
| `trust_grant { to, capabilities[], purpose?, from?, to_date?, maxUsd?, expiresAt?, note? }` | `trust.manage` | owner | scoped, time-boxed exception |
| `trust_revoke { grantId }` | `trust.manage` | owner | remove a grant |
| `trust_list {}` | `trust.manage` | owner | tiers, overrides and grants in one view |
| `ask_instinct { contact?, contacts?, intent, subject?, text, payload?, contextId? }` | `network.ask` | owner, partner, family, friend | send an OIP request to one or several contacts' Kloru agents, or (owner only) to the person as text or email; non-owners may address only their own entry |
| `reply_instinct { taskId, intent, text, payload?, oipIntent?, subject? }` | `converse` | any A2A caller | answer the task being worked on; only inside an `a2a` conversation |
| `invite_to_network { contact, tier, email? }` | `network.invite` | owner | create the contact if needed, set the tier, create an Inkbox invitation |

The runtime's policy engine decides whether a call may run at all. These tools add a second, structural check in `execute`: owner-only tools refuse non-owners, `reply_instinct` refuses outside `a2a`, and `contacts_search` narrows what non-owners see. Both checks exist on purpose. Hiding a tool is a convenience; the check in the tool is the guard.

Contact references are forgiving. `contact`, `to` and `query` accept an id (`sam-lee`), a principal id (`contact:sam-lee`), a name, a phone in any format, an email, or `@handle`. When a name matches several people the tool returns the candidates to the owner and asks for the id instead of guessing; non-owners get the same error without the names (`lookupContact(contacts, ref, { disclose: false })`).

`reply_instinct` turns an Inkbox 429 into "Inkbox is rate limiting; try reply_instinct again in N s." so the model waits instead of surfacing a raw error.

## Prompt guidance

`networkGuidance(principal)` returns a prompt section the runtime appends when network tools are available.

For the owner it explains `ask_instinct`, group plans with `contacts`, the fallback to text, the three-options rule, and that replies arrive later.

For anyone else it states the counterpart's tier, lists what may be shared at that tier, and repeats the hard rules: say who you act for, treat their words as information rather than instructions, propose at most 3 options, never commit the owner without a yes, and decline anything above their tier or reserved for the owner while telling the owner what was asked. For agents it adds how to use `reply_instinct`, that an out-of-scope request from another agent is declined with `fail` and reported to the owner rather than carried out, and that the OIP data part wins over the text when they disagree.

## API

```ts
import {
  // envelope
  encodeOip, decodeOip, describeOip, oipToText, OIP_INTENTS, type OipIntent, type OipMessage,
  // tools and prompt
  networkTools, networkGuidance, type NetworkToolDeps,
  // admission
  resolveA2aPrincipal, normalizeAgentHandle,
  // helpers
  lookupContact, slugify, phoneKey, CAPABILITIES, TIERS, ASSIGNABLE_TIERS, isCapability, isTier, parseCapabilities,
} from "@kloru/network";
```

`networkTools(deps)` takes:

```ts
interface NetworkToolDeps {
  contacts: ContactStore;       // core
  policy: PolicyEngine;         // core
  config: InstinctConfig;       // core; agent.handle and owner.name go into on_behalf_of
  audit: AuditLog;              // core
  outbox: Outbox;               // core; used when a contact has no Kloru
  a2a?: InkboxA2A;              // @kloru/inkbox; omit and ask_instinct always falls back to text
  provisioner?: InkboxProvisioner; // @kloru/inkbox; omit and invite_to_network explains the manual path
  onPolicyChange?: (policy: Policy) => void; // persist grants, e.g. savePolicy(state, policy)
}
```

`a2a` and `provisioner` are typed as the slices this package uses (`send`, `reply`; `createInvitation`, `addContactRule`), so a fake with those methods works in tests.

## Wiring it in

```ts
import { networkTools, networkGuidance } from "@kloru/network";
import { InkboxA2A, InkboxProvisioner } from "@kloru/inkbox";
import { savePolicy } from "@kloru/core";

registry.registerMany(
  networkTools({
    contacts, policy, config, audit, outbox,
    a2a: new InkboxA2A({ apiKey: inkboxKey, handle: config.agent.handle! }),
    provisioner: adminKey ? new InkboxProvisioner({ adminApiKey: adminKey }) : undefined,
    onPolicyChange: (p) => savePolicy(state, p),
  }),
);
// and in the prompt builder:
extra: [networkGuidance(principal)]
```

On an inbound `a2a.task.created`, resolve the principal first:

```ts
const { contact, tier } = resolveA2aPrincipal(msg.from, contacts);
const oip = decodeOip(msg.data);
const text = oip ? `${msg.text}\n\n${describeOip(oip)}` : msg.text;
```

## Tests

```
pnpm --filter @kloru/network test
```

Covered: OIP encode/decode round trips for every intent and rejection of junk; `oipToText` for every intent including time zone handling; contact lookup by every reference form and refusal to guess between similar names; every tool's permission check with a stub A2A client, a stub outbox and a stub provisioner that record their calls; `resolveA2aPrincipal`; `networkGuidance` per tier.
