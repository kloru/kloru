# Kloru

An assistant for your family that you call or text. It reads your mail and calendar, does the
errands that eat an evening (booking, buying, chasing, reminding), and keeps each person's things
their own. You run it yourself, on your own accounts and your own domain.

- **Call it** on its own phone number: it's a conversation, and it keeps working after you hang up.
- **Text it** by iMessage: it reacts 👍 when something's done, and writes back only when there's something to say.
- **It does the work:** reads and files email, moves calendar events, researches, books, and buys
  with a card you saved in its vault, within limits you set.
- **It's a family's:** each person signs in with their own phone, connects their own accounts, and
  writes their own policy for what others may see and do. Private things stay private.
- **It learns how you like it:** a one-emoji reply for some things, the whole answer for others,
  learned from how you respond.

## Set it up

**With Claude Code** (recommended): clone this repository, open it in Claude Code, and say

> Set up Kloru for me.

Claude walks you through it: which accounts to make, which key goes where, the plan, and the DNS
record to add. You make the accounts and approve anything that costs money. Your keys go into a
local file and never through the chat.

**By hand:** follow [SETUP.md](SETUP.md). In short:

```bash
git clone <this repository> kloru && cd kloru && pnpm install
cp kloru.env.example kloru.env                       # fill in your keys (SETUP.md, section 1)
python3 deploy/selfhost/setup.py --check             # until it says Ready
python3 deploy/selfhost/setup.py --domain kloru.example.com \
  --owner-name "Sam Lee" --owner-phone "+1 415 555 0100" --owner-email sam@example.com \
  --area-code 415                                    # shows the plan
...add --apply                                       # does it
```

**You'll need:**
- **A domain**, and accounts with **Fly.io** (hosting), **OpenRouter** (models), **Twilio** (the phone number and sign-in codes), **Deepgram** and **Cartesia** (speech), **Inkbox** (iMessage) and **Composio** (Gmail, Calendar and other apps).
- **Optional:** **Resend** (email), **Steel** (a cloud browser for checkouts), **Stripe Link** (one-time cards), **Langfuse** (traces) and **Cloudflare R2** (backups).
- **Cost:** about $18 a month for hosting and the number, plus $2–15 a day in model use, depending on how much your family leans on it. [SETUP.md](SETUP.md#what-it-costs) has the breakdown, and your Kloru's **Admin → Metrics** page shows the real numbers.

## How it works

```
you ── call ──► Twilio ──► voice (Deepgram, the voice model, Cartesia) ─┐
you ── text ──► Inkbox ──────────────────────────────────────────────────┤
you ── web ───► your domain (sign in, connections, vault, metrics) ──────┤
                                                                          ▼
         one Fly machine:  the desk — a PM model files and reviews requests,
                           engineers do them with your apps (Composio), a
                           browser (Steel or local Chromium), the vault, and
                           memory (a git repo of plain markdown, one folder per person)
```

- **One request, one owner of the message.** Every text or email Kloru sends gets two checks by a
  small decision model (Jev). Before it's written: how this person would want it (an emoji, a
  line, or the whole answer, and whether to include a link). After it's written: does the draft
  fit? If not, it goes back to be rewritten once.
- **Secrets by reference.** Cards, logins and API keys live in an encrypted vault. Models use
  them by name (`{{vault:evan-visa}}`) and never see the values. Every use is in the ledger, and
  each card's own limits are enforced in code.
- **Permissions by person.** Each person's `policy.md`, written in their own words, says what
  others in the family may see and do. One review per request decides, and anything private asks
  its owner.

## Repository

```
packages/server     the agent: the desk, tools, the browser, the vault, metrics
packages/desk       requests, the PM and workers, the ledger, household memory
packages/web        your Kloru's website (sign-in, Get started, connections, vault, admin)
packages/core       the agent loop, policy, scheduler, approvals, audit
packages/inkbox     iMessage and email transport
packages/apps       Composio (Gmail, Calendar and more)
voice/              phone calls (Pipecat, Deepgram, Cartesia, Twilio)
skills/             playbooks the agent follows (purchases, travel, buying safely, …)
deploy/selfhost/    setup.py and the Fly template for your own Kloru
```

## Documentation

[Set up](SETUP.md) · [Keys](docs/KEYS.md) · [Deploy and run](docs/DEPLOY-KLORU.md) · [Architecture](docs/ARCHITECTURE.md) · [Permissions](docs/PERMISSIONS.md) · [Payments](docs/PAYMENTS.md) · [Security](docs/SECURITY.md) · [Contributing](CONTRIBUTING.md)

Kloru started as a fork of [Open Instinct](https://github.com/mariagorskikh/open-instinct) and has since grown into its own project. MIT license.
