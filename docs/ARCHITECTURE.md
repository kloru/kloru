# Architecture

One Kloru is one family's: one Fly machine, one disk, the family's own accounts. Everything below
runs on that machine.

```
           call                 text / email               web
             │                       │                       │
   Twilio ── voice/ ──┐   Inkbox / Resend ──┐      your domain ── packages/web
   (Deepgram, the     │                     │      (sign-in, Get started, connections,
    voice model,      │                     │       vault, policy, admin, metrics)
    Cartesia)         ▼                     ▼                       │
              ┌──────────────── packages/server (the agent) ────────┴───────┐
              │  talkers: the voice model on a call, the texting model in a  │
              │  thread. They file requests and pass on results.             │
              │                                                              │
              │  the desk (packages/desk)                                    │
              │    PM ── assigns, reviews, merges ──► engineers / ops        │
              │    one access review per request (a Jev decision)            │
              │    the ledger: every message, change and purchase            │
              │                                                              │
              │  tools: apps (Composio) · the browser (Playwright on Steel   │
              │  or local Chromium) · the vault · the store (mail and        │
              │  calendar, synced) · household memory · scripts · media      │
              └──────────────────────────────────────────────────────────────┘
```

## A request, end to end

1. **Someone asks.** By phone, the voice model listens and files a request. By text, the texting
   model reacts 👀 (or answers if something needs clarifying) and files it.
2. **The PM triages.** It writes the goal and what "done" means, lists what the work needs
   (whose mail, whose calendar, spending), and assigns an engineer (find out, do) or ops (one
   exact change).
3. **Access is reviewed once.** For a family member, one Jev decision weighs the request against
   each owner's `policy.md` and the floor in code. Anything private asks its owner.
4. **The worker does it** with the tools above, and comments on the request as it goes. An
   owner's own request is the approval for what it needs; every approval, and who gave it, goes
   on the request and in the ledger.
5. **The result goes into the person's outbox.** Every message Kloru sends someone (a reply, a
   result, a report, a question, a reminder) is one item in that person's outbox, whoever wrote it.
   In a text thread the texting model writes it, shaped first (a reaction, one line, or the whole
   answer, from their `messages.md`) and redrafted once if it clearly misses.
   - **Fast pass:** one Jev decision per item: send it now, drop it (they already have it), or
     leave it for the organizer.
   - **Organizer:** one agent per person that sees everything waiting for them, what they got
     today and their guidelines, and decides what they get, when, and in what shape: as written,
     several as one message, scheduled, or dropped.
   - **Timed items:** a reminder is an item with a time; it is sent then with no PM or worker
     run, and survives restarts.

   Each item ends as one ledger entry. What waits is on the website under Messages, and anyone
   can ask Kloru what's waiting for them or to stop one. Sends from a connected account (Gmail,
   Outlook) pass the message check instead.
6. **It learns.** How they answer a result (asking for the link, for more, for less) becomes a
   dated line in their `messages.md`. After each conversation, the memory worker files people,
   places and plans into household memory.

## Where things live

| | |
|---|---|
| `/data/instinct/repo` | the desk's records: calls and threads, requests, the ledger (a hash chain), pages, media |
| `/data/instinct/repo/outbox` | one file per person: every message for them and where it stands |
| `/data/instinct/repo/memory` | household memory: a git repo of markdown, `household/` plus one folder per person (`policy.md`, `messages.md`, `private/`) |
| `/data/instinct/store` | mail and calendar synced from Composio, with full-text search |
| `/data/instinct/secrets/vault.json` | the vault: AES-256-GCM, keyed by `KLORU_VAULT_KEY` |
| `/data/instinct/browser` | each person's browser profile (or their Steel profile id) |
| `/data/kloru/apps.db` | what people entered into apps Kloru made (the website's; the agent only reads script errors from it) |
| `/data/instinct/metrics` | hourly OpenRouter usage and time-saved estimates |

## Packages

| Package | |
|---|---|
| `server` | the agent process: boot, the text and email desk, tools, the browser, metrics, the owner API |
| `desk` | requests, the PM and worker roles, the ledger, household memory, the vault |
| `web` | the website (Caddy routes your domain to it) |
| `core` | the agent loop, policy and trust tiers, scheduler, approvals, audit |
| `inkbox` | iMessage and email transport, webhooks |
| `apps` | Composio: Gmail, Calendar and other connected apps |
| `store` | the synced mail and calendar store |
| `network` | contacts, tiers and agent-to-agent tools ([PROTOCOL.md](PROTOCOL.md)) |
| `payments` | Stripe Link one-time cards ([PAYMENTS.md](PAYMENTS.md)) |
| `cli` | the `instinct` command for local development |
| `voice/` | phone calls (Python, Pipecat) |

Decisions with a fixed set of answers (access, message shape, draft fit, send/hold/drop, time
saved) go to Jev, a small structured decision model, never to a general model. Words people read
or hear are written by the talkers and workers. Prompts stay short and say the goal; each
person's own guidelines and preferences set the details.
