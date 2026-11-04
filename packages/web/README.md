# @kloru/web: the Kloru console

A website where you and the people you invite:

- **Connections**: connect Google Calendar, Gmail and other apps (through Composio) as the
  account the agent should act as, and disconnect them.
- **Permissions**: decide what your agent may do for you per capability: *Allowed*,
  *Ask me first* or *Never* (purchases also offer *Within spend limits*).
- **Approvals**: approve or deny what the agent is waiting on. Money and phone calls ask
  you to confirm.
- **Contacts**: who can reach your agent, their tier, and per-person extras ("Sam may book
  on my calendar until Friday, up to $50").


## How it reaches your agent

The console never stores policy. Each action is a signed `owner.api` envelope posted to the
agent's own `/chat` (`OWNER_API_SECRET` on both sides, HMAC-SHA256, five-minute window). The
agent applies it to the same `policy.json`, approvals and contacts its chat tools use.

## Sign-in

Phone number only. You enter your number, Kloru texts a 6-digit code through **Twilio
Verify**, you type it in. Codes go only to admin numbers (`KLORU_ADMIN_PHONES`) and numbers
invited on the Admin page, so the form can't be used to run up text charges; there are also
limits of 3 codes per number per 10 minutes, 10 per network address per hour, and 5 tries
per code. Twilio Verify sends from Twilio's own registered senders, so it works before the
console's own number finishes A2P registration. About $0.05 per successful verification.

## Run it locally

1. Give the agent an owner API secret and restart it:
   `echo "OWNER_API_SECRET=$(openssl rand -hex 32)" >> .instinct.env`
2. Create a Twilio Verify service once (`TWILIO_VERIFY_SERVICE_SID`, starts with `VA`):
   `curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" -d FriendlyName=Kloru https://verify.twilio.com/v2/Services`
3. Put the console settings in `.kloru.env`:

   ```
   KLORU_SESSION_SECRET=<openssl rand -hex 32>
   KLORU_ADMIN_PHONES=+14155550190
   KLORU_PUBLIC_URL=http://localhost:8790
   KLORU_DATA_DIR=.kloru
   KLORU_DEV_AGENT_URL=http://127.0.0.1:8080
   TWILIO_VERIFY_SERVICE_SID=VA...
   ```
   (`TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` come from `voice/.env`.)
4. `pnpm --filter @kloru/web build`
5. `set -a; . ./voice/.env; . ./.kloru.env; . ./.instinct.env; set +a; node packages/web/dist/main.js`
6. Open http://localhost:8790 and sign in with an admin number. Admins who have no agent yet
   get the `KLORU_DEV_AGENT_URL` agent.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `KLORU_SESSION_SECRET` | yes | ≥ 32 characters; signs session cookies. Rotating it signs everyone out. |
| `KLORU_ADMIN_PHONES` | yes | Comma-separated admin numbers, with area code; always allowed in |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | yes | Twilio account that owns the Verify service |
| `TWILIO_VERIFY_SERVICE_SID` | yes | The Verify service that texts sign-in codes |
| `KLORU_PUBLIC_URL` | no | Default `http://localhost:<port>`; used for Composio return URLs |
| `KLORU_PORT`, `KLORU_BIND` | no | Default `8790`, `127.0.0.1` |
| `KLORU_TRUST_PROXY` | no | `1` to rate-limit by `Fly-Client-IP` or `X-Forwarded-For` (only behind your own proxy) |
| `KLORU_DATA_DIR` | no | Default `.kloru`; holds `console.json` (users, invites; mode 0600) |
| `KLORU_DEV_AGENT_URL` | no | Local agent for admins; its `INSTINCT_CHAT_TOKEN` and `OWNER_API_SECRET` are read from the environment |

## Tests

`pnpm --filter @kloru/web test`. Phone sign-in and its limits, sessions, CSRF, invites, every page and form, and escaping
of agent-provided text are covered against a fake agent and a fake Twilio Verify.
