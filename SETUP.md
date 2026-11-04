# Set up your own Kloru

Kloru runs on **your** accounts, on **your** domain. You end up with an assistant your family can
call or text, at `https://kloru.<your-domain>`. Plan on about an hour, mostly signing up for
services. This guide is written so you can do it yourself, or open this repository in Claude Code
and say **"set up Kloru for me"**. Claude follows the same steps, and the [For agents](#for-agents)
section tells it how.

## What you'll have

- A phone number you call to talk to Kloru, and an iMessage line you text.
- A website at your domain where you and your family sign in, connect Gmail and Google Calendar,
  save cards and logins in an encrypted vault, and see what Kloru did and what it cost.
- One always-on machine on Fly.io that runs all of it. Your data stays on that machine's disk,
  with optional encrypted nightly backups to your own Cloudflare R2 bucket.

## What it costs

| | Roughly |
|---|---|
| Fly.io machine (2 shared CPUs, 2 GB) and a 10 GB disk | $17 / month |
| Phone number (Twilio) | $1.15 / month, plus about a cent a minute for calls |
| Models (OpenRouter) | $2–15 / day, depending on how much your family uses it |
| Speech (Deepgram, Cartesia) | a few cents per call |
| iMessage (Inkbox) | Inkbox's plan for one identity |
| A domain | $10–15 / year, if you don't already have one |

Composio, Langfuse and Steel have free tiers that cover a family. Kloru's own **Admin → Metrics**
page shows the real numbers once it's running.

## Before you start

You need a computer with **git**, **Node 22.19+** with **pnpm 10**, **Python 3.12** with **uv**,
and the **Fly CLI**. On a Mac:

```bash
brew install git node pnpm uv flyctl
git clone <this repository> kloru && cd kloru
pnpm install
cp kloru.env.example kloru.env        # your keys go here; it's git-ignored
```

## 1. Sign up for the services

Each line is an account you make yourself, then a key you copy into `kloru.env`. Keep the keys
out of chats, emails and screenshots: paste them only into `kloru.env`.

**Required**

1. **Fly.io** ([fly.io](https://fly.io)): sign up, add a card, then run `fly auth login`.
2. **A domain:** use one you own, or buy one (Cloudflare Registrar is simplest). Kloru will live
   at a subdomain such as `kloru.example.com`; you'll add one DNS record at the end.
3. **OpenRouter** ([openrouter.ai](https://openrouter.ai)): add about $20 of credit, then
   **Keys → Create**. Copy the key into `OPENROUTER_API_KEY`.
4. **Twilio** ([twilio.com](https://www.twilio.com)): upgrade from the trial (needed to buy a
   number). From the console home, copy **Account SID** and **Auth Token** into
   `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. Then **Verify → Services → Create new**, name it
   "Kloru", and copy its SID (starts with `VA`) into `TWILIO_VERIFY_SERVICE_SID`. That's what texts
   you a sign-in code for the website.
5. **Deepgram** ([deepgram.com](https://deepgram.com)): **API Keys → Create**. Copy it into
   `DEEPGRAM_API_KEY`.
6. **Cartesia** ([cartesia.ai](https://cartesia.ai)): **API Keys → New**. Copy it into
   `CARTESIA_API_KEY`. Then pick the voice Kloru speaks with at
   [play.cartesia.ai](https://play.cartesia.ai) and copy its ID into `CARTESIA_VOICE_ID`.
7. **Inkbox** ([inkbox.ai](https://inkbox.ai)): choose a plan with iMessage, then **Console →
   API keys → Create** (an admin key). Copy it into `INKBOX_API_KEY`. Setup creates Kloru's
   iMessage identity for you.
8. **Composio** ([composio.dev](https://composio.dev)): **Settings → API Keys**. Copy it into
   `COMPOSIO_API_KEY`. This is how Kloru reaches Gmail, Google Calendar and other apps; each
   person signs in with Google on your Kloru's website.

**Optional:** Kloru works without these, and you can add them later.

- **Resend** ([resend.com](https://resend.com)) for email from Kloru: verify your domain there,
  then set `RESEND_API_KEY` and `KLORU_MAIL_FROM` (e.g. `Kloru <kloru@example.com>`).
- **Steel** ([steel.dev](https://steel.dev)), a cloud browser for booking and buying on websites.
  Set `STEEL_API_KEY`. Its residential proxy (which gets past checkouts that block servers) needs
  $10 of paid balance on the Launch plan.
- **Stripe Link** one-time cards for purchases, through Stripe's agent-spend program (you apply):
  `STRIPE_PUBLISHABLE_KEY`, `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`.
- **Langfuse** ([langfuse.com](https://langfuse.com)) traces of every call and task:
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`.
- **Cloudflare R2** nightly encrypted backups: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.

## 2. Check you're ready

```bash
python3 deploy/selfhost/setup.py --check
```

It checks the Fly CLI and your sign-in, that every required key is set, and that Twilio, Inkbox
and OpenRouter accept their keys. Each problem comes with what to do about it. Run it until it
says **Ready**.

## 3. See the plan, then run it

```bash
python3 deploy/selfhost/setup.py --domain kloru.example.com \
  --owner-name "Sam Lee" --owner-phone "+1 415 555 0100" --owner-email sam@example.com \
  --area-code 415
```

This prints every step and marks the ones that cost money. Nothing happens yet. Use
`--number +1...` instead of `--area-code` to use a Twilio number you already own, and `--region`
to pick a Fly region near you (`fly platform regions` lists them). When the plan looks right, add
`--apply`:

1. Create your Fly app and its 10 GB disk.
2. Create Kloru's iMessage identity on Inkbox, and look up the number people text.
3. Write your `fly.toml` (in `.selfhost/<app>/`) and stage every key as a Fly secret, never
   printed. It also generates your own secrets: session, chat, owner API, backup and vault keys.
4. Buy a local phone number and point its calls at your Kloru.
5. Add the TLS certificate and **print the DNS records you need**.
6. Build and deploy, then wait until it answers.

Generated secrets are saved in `.selfhost/<app>.env`. **Keep a copy somewhere safe**: the backup
and vault keys can't be recovered, and without them your backups and saved cards are unreadable.

## 4. Point your domain at it

Add the record setup printed, where your domain's DNS is managed. For a subdomain:

```
CNAME   kloru   →   <app>.fly.dev       (Cloudflare: DNS only, grey cloud)
```

Fly issues the certificate within a few minutes. `fly certs show kloru.example.com -a <app>`
shows when it's ready.

## 5. Sign in

Open `https://kloru.example.com` and sign in with your phone number; Twilio Verify texts you a
code. The **Get started** page walks you through the rest:

1. Connect Gmail and Google Calendar.
2. Add your family. Each person signs in the same way, with their own phone.
3. Turn on texting: from your phone, text `connect @<your-handle>` to the number it shows.
4. Ask Kloru for something, for example "what's on my calendar tomorrow?"
5. Optionally, save a card in the Vault with limits you control, and write your policy (what
   others may do with your things).

Then call your new number. Kloru answers only your number. It also checks the caller ID your
carrier vouches for, so a faked number can't get in.

## 6. Texting by SMS (optional, later)

iMessage works right away. Plain SMS from your Twilio number needs carrier registration (A2P
10DLC): in Twilio, **Messaging → Regulatory compliance**, register a brand and a campaign, and add
your number. Your Kloru already serves the privacy policy, terms and opt-in pages carriers ask for, at
`/privacy`, `/terms` and the sign-in page. Approval takes a few days.

## Day to day

- **Update to the latest Kloru:** `git pull && fly deploy -c .selfhost/<app>/fly.toml --dockerfile deploy/kloru/Dockerfile .`
- **Logs:** `fly logs -a <app>`. A shell on the machine: `fly ssh console -a <app>`.
- **Costs and activity:** your site's **Admin → Metrics**.
- **Change a key:** edit `kloru.env` and run setup again with `--apply`. It skips what exists
  and keeps your generated secrets.

## For agents

You're helping someone set up their own Kloru. Work through the numbered sections in order, and
keep these rules:

- **They make the accounts.** Never sign up, enter a card, buy anything or solve a verification
  for them. For each service in section 1, tell them exactly what to click, wait until they've
  done it, then continue.
- **Keys go into `kloru.env`, never through you.** Ask them to paste each key into the file
  themselves. Never ask them to send one in chat, and never print, echo or `cat` the file. Check
  progress with `python3 deploy/selfhost/setup.py --check`, which names missing keys without
  showing values.
- **Show the plan before any money is spent.** Run setup without `--apply`, show them the steps
  marked "costs money", and run `--apply` only after they say yes to that plan.
- **DNS is theirs.** Show them the record setup printed, and where to add it at their registrar.
  Then check with `fly certs show <domain> -a <app>` until it's issued.
- **Confirm it works:** `curl -s https://<app>.fly.dev/healthz` returns OK, and
  `fly logs -a <app> --no-tail` shows `desk: ready`. Then have them sign in at their domain.
- If a step fails, read the error, fix the cause (usually a key or an account setting), and
  re-run. Setup is safe to run again: it reuses what exists and never changes generated secrets.
