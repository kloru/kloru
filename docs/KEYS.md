# Keys

Every key your Kloru uses, in one place. [SETUP.md](../SETUP.md) walks through getting them, in
order. They go in `kloru.env` (git-ignored; start from `kloru.env.example`), and
`deploy/selfhost/setup.py` stages them as Fly secrets without printing them. Nothing in this
repository contains a key.

## Required

| Key | What it's for | Where to get it |
|---|---|---|
| `OPENROUTER_API_KEY` | every model: the agent, the PM, engineers, voice, the Jev decisions | [openrouter.ai](https://openrouter.ai) → Keys (add credit first) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Kloru's phone number and calls | [Twilio console](https://console.twilio.com) home (upgrade from the trial) |
| `TWILIO_VERIFY_SERVICE_SID` | the sign-in codes for your website | Twilio → Verify → Services → Create (starts with `VA`) |
| `DEEPGRAM_API_KEY` | hearing you on calls | [deepgram.com](https://deepgram.com) → API Keys |
| `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` | speaking on calls, and in which voice | [cartesia.ai](https://cartesia.ai) → API Keys; a voice from [play.cartesia.ai](https://play.cartesia.ai) |
| `INKBOX_API_KEY` | texting by iMessage (setup creates the identity) | [inkbox.ai](https://inkbox.ai) → Console → API keys (an admin key) |
| `COMPOSIO_API_KEY` | Gmail, Google Calendar and other apps | [composio.dev](https://composio.dev) → Settings → API Keys |

## Optional

| Key | What it's for | Where to get it |
|---|---|---|
| `RESEND_API_KEY`, `KLORU_MAIL_FROM` | email from Kloru | [resend.com](https://resend.com) (verify your domain there) |
| `STEEL_API_KEY` | a cloud browser for booking and buying; without it, Chromium runs on the machine | [steel.dev](https://steel.dev) → API keys ($10 of paid balance enables the residential proxy) |
| `STRIPE_PUBLISHABLE_KEY`, `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET` | one-time cards from Stripe Link | Stripe's agent-spend program (apply; see [PAYMENTS.md](PAYMENTS.md)) |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | traces of calls and tasks | [langfuse.com](https://langfuse.com) → Settings → API keys |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | nightly encrypted backups | Cloudflare → R2 → Manage API tokens |

## Generated for you

Setup makes these once and keeps them in `.selfhost/<app>.env`. Keep a copy somewhere safe.

| Key | What it's for |
|---|---|
| `KLORU_SESSION_SECRET` | website sign-in sessions |
| `INSTINCT_CHAT_TOKEN`, `OWNER_API_SECRET` | the website and voice service talking to the agent |
| `BACKUP_KEY` | encrypts backups (lose it and backups can't be read) |
| `KLORU_VAULT_KEY` | encrypts the vault's cards and logins (lose it and they can't be read) |

## Settings, not secrets

Models, URLs and the texting number live in `.selfhost/<app>/fly.toml` (from
`deploy/selfhost/fly.template.toml`): `INSTINCT_MODEL`, `KLORU_PM_MODEL`, `KLORU_ENGINEER_MODEL`,
`VOICE_MODEL`, `KLORU_PUBLIC_URL`, `KLORU_TEXT_NUMBER`, `COMPOSIO_TOOLKITS`. Change one and deploy again.
