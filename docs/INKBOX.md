# Inkbox: the agent's phone line

Inkbox is the identity and communication layer Kloru uses. It gives an agent a handle, an email address, an iMessage presence, an optional phone number, and an endpoint other agents can call. Kloru does not run any of that itself. It asks Inkbox for an identity and listens for webhooks.

Analogy: Inkbox is the phone company. Kloru is the person who answers the phone. The CLI signs the contract, and the server picks up when it rings.

Kloru is unrelated to Kloru, a separate project published by Merit Systems.

## Contents

1. [What Inkbox is](#what-inkbox-is)
2. [One identity, five addresses](#one-identity-five-addresses)
3. [Two kinds of API key](#two-kinds-of-api-key)
4. [The shared router and `connect @handle`](#the-shared-router-and-connect-handle)
5. [Dedicated lines](#dedicated-lines)
6. [Phone calls](#phone-calls)
7. [Webhooks and signing keys](#webhooks-and-signing-keys)
8. [Contact rules and whitelist mode](#contact-rules-and-whitelist-mode)
9. [A2A invitations and how our tiers sit on top](#a2a-invitations-and-how-our-tiers-sit-on-top)
10. [Plan limits](#plan-limits)
11. [Agent self-signup, for people without an org](#agent-self-signup-for-people-without-an-org)
12. [Environment variables](#environment-variables)
13. [What the code does with all this](#what-the-code-does-with-all-this)

## What Inkbox is

Inkbox (inkbox.ai) is a hosted service. Its API lives at `https://inkbox.ai/api/v1` and takes an `X-API-Key` header. It has SDKs for TypeScript (`@inkbox/sdk`), Python and Rust. Kloru sends messages through `@inkbox/sdk` and makes its other calls with plain `fetch`, so request shapes stay close to the API.

Inkbox solves one hard problem for a personal agent: iMessage. Apple does not let a server own a phone number. Inkbox runs real iMessage lines and exposes them over an API. Without it, iMessage support needs a signed-in Mac that stays on.

The research notes behind this page are in [research/TECH-REFERENCE.md](research/TECH-REFERENCE.md), section 2.

## One identity, five addresses

One Inkbox identity is one agent. When `instinct init` runs with an admin key, it creates one identity for your agent. The identity bundles:

| Part | Example | Created when |
|---|---|---|
| Handle | `maria-kloru` | always. Globally unique, lowercase |
| Mailbox | `maria-kloru@inkboxmail.com` | always |
| iMessage | the shared router line, or a dedicated line | when `imessage_enabled: true`. `init` turns it on |
| Phone number | a local US number for SMS and calls | only with `instinct init --phone-number`. Subject to inventory and plan |
| A2A endpoint | `https://inkbox.ai/a2a/maria-kloru` | automatic. Other agents call this |
| Tunnel host | `https://maria-kloru.inkboxwire.com` | always. Used by `instinct dev --tunnel` |

The handle is the thing people and other agents type. It appears in `connect @maria-kloru`, in A2A URLs, and in contact rules. Pick it once. If it is taken, Inkbox returns a 409 and `init` tries `maria-kloru-2`, up to `-5`.

Initialization creates a new identity by default, even when another identity in the org
already has the requested handle. To intentionally import an existing identity, use
`instinct init --handle <handle> --use-existing`. An identity already recorded in this
data directory's secrets can be resumed without that flag. Gateway signup always creates
a new identity for its user.

The agent is one identity. You, the owner, are not an Inkbox identity. You are a phone number and an email address in `config.json`. The agent recognises you by those.

## Two kinds of API key

| Key | Scope | Who holds it | Can do |
|---|---|---|---|
| Admin key | the whole org | you, in your shell, as `INKBOX_ADMIN_API_KEY` | create identities, mint identity keys, create signing keys, subscribe webhooks, write contact rules, create invitations |
| Identity-scoped key | one identity | the agent process, as `INKBOX_API_KEY` | send and receive on that identity only. Gets 403 on contact rules, domains and billing |

The split matters. The admin key can read every identity in your org. The agent runs with the narrow key, so a bug or a prompt injection in the agent cannot reach anything but its own line. `instinct init` mints the identity key for you and stores it in `<dataDir>/secrets/inkbox.json`. The admin key is never written to disk by Kloru.

Inkbox shows a new key once. If you lose the identity key, mint another with the admin key and update the agent's environment.

## The shared router and `connect @handle`

On the shared service, every agent in Inkbox sits behind one router phone number. A human links their iPhone to one agent by texting that number once.

```
instinct connect
```

prints:

```
Connect your iMessage
  1. Text connect @maria-kloru to +1 415 555 0199
  2. A new thread from your Kloru appears. Say hi.
```

The number is fetched at runtime from `GET /imessage/triage-number`, never hardcoded. The same call returns the exact connect command, an `sms:` link that opens Messages with the text filled in, and a QR code. `instinct connect` writes the QR to `<dataDir>/connect-qr.png`. The gateway's connect page shows the same three things.

What happens on Inkbox's side:

1. You send `connect @maria-kloru` to the router.
2. Inkbox creates an iMessage conversation between your phone and the identity.
3. Every later message you send arrives as an `imessage.received` webhook with a stable `conversation_id`.
4. The agent replies by that `conversation_id`.

Rules of the shared line:

| Rule | Why it matters |
|---|---|
| The human must text first | the agent cannot start a conversation with a stranger. Sending before that returns `imessage_awaiting_inbound` |
| One to one only | no group chats on the shared line |
| The router explains its own commands | text it `help` to list or replace your connections |
| Delivery falls back to SMS | if the recipient has no iMessage, the message goes as SMS and the result says `was_downgraded: true` |

This is why Kloru's `send_message` tool with no `to` replies in the current conversation, and why the agent texts you proactively (schedules, A2A results) only after you have connected once.

## Dedicated lines

A dedicated line is an iMessage-enabled phone number that belongs to one identity. It removes the shared-line limits.

| | Shared router | Dedicated line |
|---|---|---|
| Who texts first | the human | either side |
| Group chats | no | yes, 2 to 8 recipients |
| New recipients | unlimited, but each must connect | 10 new recipients per hour, 40 per 24 hours |
| Replies from known recipients | free | free, do not consume slots |
| Included in plan | Free and up | Startup plan includes one |

How you get one: `POST /imessage/numbers` with an `Idempotency-Key` header, or `claim_imessage_number: true` when creating the identity. `PATCH /identities/{handle}` with `imessage_number_id` attaches or swaps a line; `null` returns to the shared service.

Kloru's provisioner does not claim a dedicated line. `init` creates a shared-line identity.
`InkboxChannel` can address an existing shared-service connection with either its
`conversationId` or its recipient's phone number in `to`. Sending by `to` does **not**
itself require a dedicated line. Initiating contact with an unconnected recipient requires
a suitable dedicated line and remains subject to the service's sending limits. Groups
also require a suitable line; group replies use their existing conversation ID.

## Phone calls

Inkbox Voice AI makes phone calls for the agent. The agent hands Inkbox a number and a task brief
("book a table for 4 at 7pm under Maria; if 7 is full take 7:30; confirm the time back"); Inkbox
dials, speaks, listens, hangs up, and posts a `call.ended` webhook with the transcript, a verdict
(completed, no answer, declined, failed) and the action items it noted. The agent never hears
the audio and never writes the summary: the owner's text is built from the transcript.

What the pieces do:

| Piece | Where | What |
|---|---|---|
| `phone_call` tool | `packages/inkbox/src/tools.ts` | `toNumber` (E.164), `reason` (the brief), optional `voicemailMessage`. Places the call in `hosted_agent` mode with `on_voicemail=leave_message` and returns the call id and status, nothing else |
| `phone.call` capability | `packages/core/src/policy.ts` | `ask` for the owner and for staff, `no` for everyone else. Every call waits for the owner's own plain yes to the exact number and brief, even when the owner asked for it: the owner's thread can carry text the owner did not write (a pasted page, a forwarded email), and a call is outward-facing and billed, so an injected instruction must never dial. `approval_settle` refuses call approvals, as it does payments. Prompt rule 8 tells the agent to call the tool once and wait, and never to call the owner's contacts unasked |
| Voice AI authority | `placeCall` in `packages/inkbox/src/channel.ts` | pinned to `contact_scoped` on every call. Inkbox lets an organization save a `yolo` authority for its Voice AI; the explicit per-call value downscopes the call so that setting never widens what the voice agent may do with the owner's number and brief |
| `call.ended` subscription | `DEFAULT_WEBHOOK_EVENTS`, subscribed at `init`, by the gateway at signup, and added to older subscriptions when a self-hosted server boots (`ensureWebhookSubscription`) or the gateway boots (`backfillWebhookEvents`, one `ensureWebhookEvents` per ready user) | the only call event the agent listens to |
| The report | `packages/inkbox/src/calls.ts` | one text to the owner: the outcome in a sentence, the last turns of the transcript, then the action items. Delivered through the runtime's owner route, so a dashboard-only owner gets it too. When the webhook's inline transcript is `null` the verbatim transcript is fetched with the identity key first |
| Voice | `INKBOX_VOICE` or `config.json` `agent.voice` | at boot the server sets the identity's Voice AI config: the voice and a short instruction ("You are <owner>'s assistant calling on their behalf; be brief, polite, confirm names and times, never share the owner's card details or personal data"). No voice configured: the org default voice, config untouched |

Where the call comes from (`origination`), in order:

1. `INKBOX_CALL_ORIGINATION`, when set: `dedicated_number` (the identity's own local number; it must have one),
   `shared_imessage_number` (the organization's shared iMessage pool) or `dedicated_imessage_number`
   (the identity's dedicated iMessage line).
2. Otherwise the identity's dedicated iMessage line when it has one, else the shared iMessage pool.
   The caller id the owner's contacts already know is the one that calls them.

Plan caveats, from the Inkbox pricing page at the time of writing: the Developer plan has one local number
and 30 call minutes a month; the Startup plan 9 numbers. Calls are US numbers. Whether the shared
iMessage line can originate calls on your organization's plan is not stated on the pricing page:
confirm it with Inkbox (or place one test call to your own phone) before relying on it, and watch the
`rate_limit.minutes_remaining` field Inkbox returns with every placed call. A call refused by the plan
surfaces as the tool's error, which the agent reports plainly. The tool result also carries the
`minutes_remaining` figure when Inkbox returns one, so the agent can tell the owner when the plan is nearly out.

Calls are recorded and transcribed by Inkbox. Laws on recording a call and on telling the other party vary by
jurisdiction (some require every party's consent); you are responsible for the calls your agent places, so
check the rules where you and the people it calls are.

## Webhooks and signing keys

Inkbox tells the agent about new messages by posting HTTP webhooks. There is no polling.

### Subscriptions

A subscription is per identity and names a URL plus a list of event types. Kloru subscribes these nine:

```
imessage.received, imessage.reaction_received, text.received, message.received,
a2a.task.created, a2a.task.message, a2a.task.canceled, a2a.sent_task.updated, call.ended
```

| Event | Channel | What the agent sees |
|---|---|---|
| `imessage.received` | iMessage | text and attachments from one conversation |
| `imessage.reaction_received` | iMessage | a tapback on one of its messages |
| `text.received` | SMS | a text to the dedicated phone number |
| `message.received` | email | subject and body of an inbound mail |
| `a2a.task.created`, `a2a.task.message` | A2A | another agent is asking something |
| `a2a.task.canceled` | A2A | the caller gave up |
| `a2a.sent_task.updated` | A2A | a reply to a task our agent sent |
| `call.ended` | phone | a call the agent placed is over: outcome, transcript, action items. Reported to the owner, never shown to the model |

Delivery lifecycle events (`*.sent`, `*.delivered`, `*.failed`) are not subscribed, and the parser ignores them if they arrive.

Who subscribes, and to what URL:

| Shape | Subscribed by | URL |
|---|---|---|
| Self-host | `instinct dev --tunnel`, or the server with `INSTINCT_TUNNEL=1`, when `INKBOX_ADMIN_API_KEY` is set | `https://<handle>.inkboxwire.com/webhooks/inkbox` |
| Gateway (many users) | the gateway at signup | `<GATEWAY_PUBLIC_URL>/webhooks/inkbox/<userId>` |
| By hand | you, in the console or with the API | whatever public URL reaches the server |

Subscription setup checks existing subscriptions for the identity and URL. It reuses them
when their combined event lists cover all required events; otherwise it adds missing
events to an existing subscription without dropping its other events. An identity may
hold up to 60 active subscriptions.

Deliveries are at least once. The gateway and agent persist webhook receipts before
acknowledging them, deduplicate by event ID, and retry queued work after temporary
failures or a restart. Gateway forwarding can be replayed with the same event ID because
the receiving agent deduplicates it. An admitted model turn interrupted with an uncertain
outcome is recorded as `uncertain` rather than executed again automatically. The agent's `/status` includes
receipt counts. Keep the receipt files with the rest of the persistent data directory;
each store is owned by one process.

### Conversation and content hydration

The synchronous parser normalizes events; the server then completes missing information
before running the agent:

- **SMS and iMessage reactions:** retrieve conversation membership. If membership cannot
  be resolved, retry the event instead of assuming it is a private conversation. SMS is
  keyed and replied to by conversation ID, including groups.
- **Group messages:** preserve the wire conversation separately from each participant's
  internal session. Permissions are limited to the group's audience, and group activity
  does not select a private owner-notification destination.
- **Email:** fetch the complete body when the webhook contains only a prefix or no body,
  and retrieve attachment URLs. Email tools carry the inbound sender and reply headers.
- **Attachments:** save inbound email/iMessage/MMS files under `workspace/inbound` with
  generated filenames. At most 10 files are included per event, with a default 10 MiB
  download limit per file. A failed download produces an explicit note and retains the
  full URL. Signed URLs are never shortened for display.

These lookups use the identity-scoped key. Downloading an attachment does not forward
that key to the file URL. Embedders using the adapter directly should run
`InkboxInboundHydrator.hydrate()` after parsing and before runtime admission.

### Signing keys

Every identity should have a signing key. Until it does, Inkbox sends its webhooks unsigned, and the Kloru server answers 503 to any webhook it cannot verify.

The key is created with `POST /identities/{handle}/signing-key` and shown once.
Initialization and subscription setup first check whether the identity already has one.
They reuse a known key from `INKBOX_SIGNING_KEY` or the identity's saved secrets; if an
existing key is unknown, setup stops with instructions instead of replacing it. A newly
created key is saved before later provisioning requests. The CLI uses
`secrets/inkbox.json`; server webhook setup also records `secrets/webhook.json`.

How a webhook is checked:

1. Read the headers `X-Inkbox-Request-ID`, `X-Inkbox-Timestamp` (unix seconds) and `X-Inkbox-Signature` (`sha256=<hex>`).
2. Reject a timestamp more than 300 seconds from now.
3. Compute HMAC-SHA256 over the string `{request_id}.{timestamp}.{raw body}` with the signing key. The `whsec_` prefix is stripped first.
4. Compare in constant time. A mismatch is 401. A valid event is acknowledged only after
   its receipt is persisted, then handled in the background.

The gateway and the server use the same `verifyInkboxSignature` function from `@kloru/inkbox`. Nothing reads a webhook body before the signature passes.

To intentionally rotate during initialization, run `instinct init --rotate-signing-key`.
If importing an identity not recorded locally, include `--use-existing`. Coordinate the
new key with every receiver subscribed to that identity; receivers using the old key
will stop accepting its webhooks. The adapter also exposes explicit `{ rotate: true }`
on `ensureSigningKey` for integrations managing their own setup.

## Contact rules and whitelist mode

Inkbox decides who may reach an identity at all. Kloru decides what a person may ask once their message arrives. This section is the first of those two gates.

### Contact rules

A contact rule is `allow` or `block`, a match, and a direction.

| Channel | Route | Match type | Example |
|---|---|---|---|
| iMessage and phone | `/imessage/identities/{handle}/contact-rules` | `exact_number` | allow `+14155550100`, direction `both` |
| A2A | `/identities/{handle}/a2a/contact-rules` | `handle` | allow `sam-kloru`, direction `both` |

Writing a rule needs the admin key. Kloru writes A2A rules in one place: `instinct invite <name> --handle <peer-handle>` calls `addContactRule(ourHandle, peerHandle, "both")`, so the peer's first task is admitted. A duplicate rule returns 409 and is treated as done.

Kloru does not write iMessage contact rules. The agent's own policy handles who may ask for what, and the shared router already requires each human to connect on purpose.

### Whitelist mode

Every identity has a filter mode per channel: `imessage_filter_mode`, `mail_inbound_filter_mode`, `phone_outbound_filter_mode`, and so on. Each is `whitelist` or `blacklist`.

| Mode | Meaning | Default |
|---|---|---|
| `blacklist` | everyone may contact the identity unless a `block` rule names them | yes |
| `whitelist` | nobody may contact the identity unless an `allow` rule names them | no |

Kloru leaves the modes at their defaults. A stranger's message does arrive, but the policy engine places an unknown sender in the `stranger` tier: one short introduction, leave a message, rate limited. If you prefer that strangers never reach the agent at all, switch the identity's iMessage or mail filter to `whitelist` in the Inkbox console and add `allow` rules for the people you want. The agent needs no change. Fewer messages arrive, and the tiers still apply to the ones that do.

The two gates compared:

| | Inkbox contact rules | Kloru tiers |
|---|---|---|
| Decides | whether a message or task is delivered | what the sender may ask for |
| Lives in | Inkbox, per identity | `policy.json` and `contacts.json` in your data directory |
| Edited with | the admin key, the console, `instinct invite --handle` | `instinct trust`, `instinct invite`, or plain language to the agent |
| Granularity | allow or block | seven tiers plus scoped grants |

## A2A invitations and how our tiers sit on top

A2A is how one Kloru talks to another. Every identity speaks A2A 1.0 JSON-RPC at `https://inkbox.ai/a2a/{handle}`. Inkbox stores the task, posts `a2a.task.created` to the worker, and relays each reply back to the caller as `a2a.sent_task.updated`.

Kloru persists each outgoing task's originating conversation, so a peer's answer
returns to the person who asked. A peer's request for clarification can be continued with
`ask_instinct` using that task's `taskId`; reusing only `contextId` groups a topic but starts
a separate task. Worker-side `reply_instinct` takes its task from the current conversation,
not a model-supplied task ID. Separate tasks are isolated, and cancellation/terminal state
prevents further tools or delayed approvals from resuming a finished task.
Nested delegation from an inbound A2A task is not supported: workers use
`reply_instinct` with `ask_caller` when they need more information.

Two identities in different orgs may talk only when both sides allow it. There are two ways to get there:

| Way | How | Opens |
|---|---|---|
| Matching contact rules | each org's admin adds an `allow` rule for the other handle | one direction per rule |
| An invitation | one side creates `POST /a2a/invitations { peer_agent_handles, recipient_email?, expires_in_seconds }`; the other side's agent accepts the link or token | both directions at once |

An invitation returns an id, a link, an `a2ai_` token and a handoff prompt the other person can paste into their own agent. The default expiry is seven days.

`instinct invite` does both the Inkbox part and the Kloru part in one command:

```bash
instinct invite "Sam Lee" --tier partner --email sam@example.com --handle sam-kloru
```

| Step | Where | Effect |
|---|---|---|
| 1. Create or update the contact | `contacts.json` | Sam Lee exists, with email and agent handle `sam-kloru` |
| 2. Set the tier | `policy.json` | Sam is `partner` |
| 3. Add the A2A contact rule | Inkbox, admin key | `@sam-kloru` may call `@maria-kloru` and vice versa |
| 4. Create the invitation | Inkbox, admin key | a link for Sam to forward to their agent |

When `@sam-kloru` later calls, the server resolves the caller handle to the contact whose `agentHandle` matches and takes that contact's tier. Sam's agent gets what a partner gets: calendar details, bookings after you say yes. A handle that matches no contact is a `stranger`, whatever Inkbox let through. Inkbox opened the door. The tier decides what happens in the room.

The full tier table is in [PERMISSIONS.md](PERMISSIONS.md). The message format two agents exchange is in [PROTOCOL.md](PROTOCOL.md). The worked example of a dinner booked between two agents is in the [network README](../packages/network/README.md#worked-example-dinner-between-two-agents).

## Plan limits

Inkbox plans cap identities, iMessage volume and unique recipients. From the Inkbox pricing page at the time of writing:

| Plan | Price | Identities | iMessage | Phone | Mail |
|---|---|---|---|---|---|
| Free | $0 | 3 | shared router, 2,000 per month, 3 unique recipients | none | 1 GiB |
| Developer | $30 per month | 10 | 10,000 per month, 10 recipients | 1 number, 300 SMS and 30 call minutes | 2 GiB |
| Startup | $200 per month | 100 | 100,000 per month, 100 recipients, 1 iMessage-enabled number | 9 numbers | 3 GiB |
| Enterprise | custom | | | | |

The messages API also mentions a ceiling of 100 iMessages per rolling 24 hours. Treat the exact shared-router number as something to confirm with Inkbox.

How the limits show up in Kloru:

| Limit | What you see |
|---|---|
| Identity cap reached | `instinct init` or a gateway signup fails with HTTP 402. The CLI prints `Inkbox plan limit` and the billing URL. The gateway records the error on the user |
| Phone inventory exhausted | HTTP 429 on `--phone-number`. The provisioner retries without a number and the identity still works on iMessage |
| Rate limits on sends | 429 with `Retry-After`. The channel retries up to two more times when the wait is 5 seconds or less. A 429 with no `Retry-After` is a quota and is reported to the model with the wait time |
| Unique recipients | a hard cap on how many humans one org's agents can text. For a gateway deployment this bounds how many users you can serve on one plan |

The adapter's own REST helper retries reads and explicitly replay-safe A2A `SendMessage`
requests with stable message IDs. It does not automatically retry provisioning mutations
or worker-reply POSTs. SDK-backed message sends use the SDK's idempotency/retry handling.

A single self-hosted agent for one person fits the Free plan: one identity, one recipient (you), a few hundred messages a month.

## Agent self-signup, for people without an org

Inkbox has a path for an agent to register itself with no admin key and no org. The human only confirms an email.

```
POST https://inkbox.ai/api/v1/agent-signup/
{ "human_email": "maria@example.com", "note_to_human": "This is Maria's Kloru asking for a line.",
  "display_name": "Maria's Kloru", "agent_handle": "maria-kloru" }
```

The response carries `api_key`, `email_address`, `agent_handle` and `claim_status`. The human gets a six-digit code by email and the agent posts it to `POST /api/v1/agent-signup/verify`. After that the identity is live and the key works like any identity-scoped key.

Kloru does not automate this path yet. `instinct init` expects `INKBOX_ADMIN_API_KEY`. To use self-signup today:

1. Call the two routes above with curl and keep the `api_key`.
2. Run `instinct init --name <you> --phone +1... --handle <the handle Inkbox returned> --skip-inkbox`.
3. Export `INKBOX_API_KEY` and `INKBOX_AGENT_HANDLE` (and `INKBOX_IDENTITY_ID` if you have it) before `instinct dev --tunnel`.
4. Subscribe the webhook to the printed tunnel URL with the identity key. The first subscription on a keyless identity returns the `signing_key`. Put it in `INKBOX_SIGNING_KEY`.

What you lose without an org: contact rules and invitations need an admin key, so `instinct invite --handle` cannot open the A2A gate from your side. Another person's org can still invite your agent, and accepting that invitation opens both directions.

## Environment variables

Each of these is read by the server, the CLI or the gateway. Nothing else in the repo reads `process.env`.

| Variable | Set by | Read by | Meaning |
|---|---|---|---|
| `INKBOX_ADMIN_API_KEY` | you | `instinct init`, `connect`, `invite`, `dev --tunnel`, the server, the gateway | org-wide key. Provisions identities, mints keys, creates signing keys, subscribes webhooks, writes contact rules, creates invitations |
| `INKBOX_API_KEY` | `init` writes it to `secrets/inkbox.json`; `dev` and `deploy` load it | the server, `dev --tunnel` | the identity-scoped key the agent sends with |
| `INKBOX_AGENT_HANDLE` | same | the server, `dev --tunnel` | the agent's handle. Needed with `INKBOX_API_KEY` for the outbox to become Inkbox |
| `INKBOX_IDENTITY_ID` | same | the server | the identity's UUID. Saves one lookup when subscribing webhooks |
| `INKBOX_SIGNING_KEY` | same, or by hand | the server, the gateway | webhook verification. Also read from `secrets/webhook.json` |
| `INKBOX_BASE_URL` | you | CLI, server, gateway | Inkbox API origin used consistently for provisioning, identity, messaging, hydration and A2A. Default `https://inkbox.ai` |
| `INSTINCT_TUNNEL` | `dev --tunnel`, or you in `deploy/.env` | the server | `1` opens the tunnel to a webhook-only listener |
| `INKBOX_VOICE` | you | the server | a Voice AI voice id (`instinct` has no picker yet; see the console's voice list). Set at boot with the assistant instructions. Unset: the org default voice |
| `INKBOX_CALL_ORIGINATION` | you | the server | force where `phone_call` dials from: `dedicated_number`, `shared_imessage_number` or `dedicated_imessage_number`. Unset: the identity's iMessage line |

Without `INKBOX_API_KEY` and `INKBOX_AGENT_HANDLE` the agent still boots. Replies go to a console outbox and are printed. That is how local development without a phone works.

## What the code does with all this

The `@kloru/inkbox` package wraps the pieces above. The [package README](../packages/inkbox/README.md) has the API.

| Part | Inkbox feature it uses | Called from |
|---|---|---|
| `InkboxProvisioner` | identities, API keys, signing keys, subscriptions, router info, A2A settings, contact rules, invitations | `instinct init`, `connect`, `invite`; the gateway at signup; the server when it subscribes its own webhook |
| `verifyInkboxSignature` and `parseInkboxEvent` | signed webhooks, the event catalog | the server's `POST /webhooks/inkbox`; the gateway's `POST /webhooks/inkbox/:userId` |
| `DurableInbox` | persistent local admission and retries for received events | gateway and agent webhook listeners |
| `InkboxInboundHydrator` | conversation membership, full mail bodies, attachment retrieval | the server before runtime admission |
| `InkboxChannel` | iMessage, SMS and email sends, typing, tapbacks, read receipts | the runtime's outbox |
| `InkboxA2A` | A2A send and reply | the network tools `ask_instinct` and `reply_instinct` |
| `phone_call`, `parseCallEnded`, `handleCallEnded` | Voice AI outbound calls, transcripts, the `call.ended` event, hosted-agent config | the messaging tools; the server's webhook routes; boot (voice) |

Where things end up on disk, so you know what to back up:

| File | Holds |
|---|---|
| `<dataDir>/secrets/inkbox.json` | handle, identity id, identity key, signing key, email, phone, tunnel host. Mode 0600 |
| `<dataDir>/secrets/webhook.json` | subscription id, URL, signing key. Mode 0600 |
| `<dataDir>/contacts.json` | each contact's `agentHandle`, which is how an A2A caller maps to a tier |
| `<dataDir>/inkbox-inbox.json` | the agent's queued, completed and uncertain webhook receipts |
| `<gatewayDataDir>/webhook-inbox.json` | queued gateway relay receipts |
| `<dataDir>/a2a-delegations.json`, `a2a-tasks.json` | original reply routes and A2A task lifecycle state |
| `<dataDir>/workspace/inbound/` | downloaded email/iMessage/MMS attachments |

Related reading: [SETUP.md](../SETUP.md) for running your own Kloru; [ARCHITECTURE.md](ARCHITECTURE.md) for the full message flow; the [gateway README](../packages/gateway/README.md) for the many-user shape.
