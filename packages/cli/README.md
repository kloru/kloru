# @kloru/cli

The `instinct` command. It sets up your agent, runs it on your machine, deploys it to
Maritime, connects your iMessage, and edits who in your life may ask it for what.

Everything the CLI writes lives in one data directory (`$INSTINCT_DATA_DIR`, default
`./.instinct`). The agent server reads the same files, so a change made here applies on
the agent's next message.

## Install

```bash
# inside the monorepo
pnpm install && pnpm -r build
pnpm --filter @kloru/cli exec instinct --help

# or link it on your PATH
cd packages/cli && pnpm link --global
instinct --help
```

Node 22.19 or newer is required.

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `INSTINCT_DATA_DIR` | all | state directory (default `./.instinct`); `--data-dir` overrides it |
| `INKBOX_ADMIN_API_KEY` | `init`, `invite`, `connect`, `dev --tunnel` | org-wide Inkbox key; provisions identities and webhooks |
| `INKBOX_BASE_URL` | same | Inkbox API base, only for self-hosted Inkbox |
| `MARITIME_API_KEY` | `deploy`, `chat --agent` | `mk_...` key with the `provision` and `deploy` scopes |
| `MARITIME_API_URL`, `MARITIME_APP_URL` | `deploy`, `chat` | control plane and dashboard base URLs (defaults: api.maritime.sh, maritime.sh) |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` + `OPENAI_BASE_URL` | `dev`, `deploy` | model access, copied into the Maritime agent on deploy |
| `INSTINCT_MARITIME_MODEL` | `deploy --maritime-llm` | model id behind Maritime's metered proxy (default `gpt-5.4`) |
| `COMPOSIO_API_KEY`, `COMPOSIO_TOOLKITS` | `init`, `dev`, `deploy` | Gmail, Calendar and other apps through Composio. `init` turns `apps.enabled` on when either is set; `dev` warns when the key is set but apps are off |
| `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `LINK_REDIRECT_URI`, `STRIPE_PUBLISHABLE_KEY` | `deploy`, `payments` | Stripe Link Agent Wallet. `deploy` copies them into the agent when `LINK_CLIENT_ID` is set; `payments connect` uses them to build the authorize URL when no server offers one |
| `BRAVE_SEARCH_API_KEY` | `dev`, `deploy` | optional web search key |
| `VISUAL`, `EDITOR` | `persona edit` | the editor to open `PERSONA.md` in; without one the path is printed |
| `NO_COLOR` | all | disables ANSI colors |
| `INSTINCT_DEBUG` | all | prints stack traces on unexpected errors |

`instinct init` stores the identity-scoped Inkbox credentials in
`<dataDir>/secrets/inkbox.json` (mode 0600). `dev` and `deploy` read that file, so you
do not need to export `INKBOX_API_KEY` yourself.

## Commands

Every command accepts `--data-dir <dir>` and `--help`.

### `instinct init`

Writes `config.json`. With `INKBOX_ADMIN_API_KEY` set, also provisions the agent's Inkbox
identity with iMessage enabled, mints an identity-scoped API key and a webhook signing
key, saves them to `secrets/inkbox.json`, prints the matching `export` lines, and prints
the connect instructions.

```
instinct init --name <you> [--phone +1...] [--email you@x.com] [--handle <handle>]
              [--model provider/model-id] [--timezone Area/City] [--city "..."]
              [--agent-name "..."] [--phone-number] [--skip-inkbox]
              [--use-existing] [--rotate-signing-key]
              [--apps | --no-apps] [--toolkits gmail,googlecalendar]
```

| Flag | Meaning |
|---|---|
| `--name` | your name (required) |
| `--phone`, `--email` | how the agent recognises you as the owner; repeat `init` to add more |
| `--handle` | the agent's Inkbox handle, for example `maria-kloru`; required to provision. `owner` is reserved |
| `--model` | `provider/model-id`, default `anthropic/claude-fable-5-1` |
| `--timezone`, `--city` | owner profile fields used in prompts and schedules |
| `--agent-name` | display name of the agent (default from core: "Kloru") |
| `--phone-number` | also buy an SMS line for the identity (off by default; iMessage works without it) |
| `--skip-inkbox` | write config only, even when an admin key is present |
| `--use-existing` | explicitly import an existing identity instead of creating a fresh one |
| `--rotate-signing-key` | explicitly replace the identity's webhook signing key; update any other receivers too |
| `--apps`, `--no-apps` | turn Composio apps (`apps.enabled`) on or off. Apps also turn on by themselves when `COMPOSIO_API_KEY` or `COMPOSIO_TOOLKITS` is in the environment |
| `--toolkits` | comma-separated Composio toolkit slugs (default `gmail,googlecalendar,googlecontacts`); setting them turns apps on |

Running `init` again updates the existing config instead of replacing it. If the handle is
already taken, Inkbox assigns a suffixed one and `init` saves that handle in the config.

`config.json` wins over the environment after the first boot, so exporting `COMPOSIO_API_KEY`
later does nothing on its own. Run `init` again (with `--apps` or the key in env) to flip
`apps.enabled`; `dev` prints a warning naming that fix when it sees the key with apps off.

### `instinct connect`

Prints the Inkbox router number, the `connect @handle` text, a tap-to-text link, and
writes the QR code to `<dataDir>/connect-qr.png`. Text that command from your iPhone and
a new iMessage thread from your agent appears.

### `instinct dev`

Runs the agent server in this process. No Docker, no Maritime. Loads `secrets/inkbox.json`
into env, sets `PORT` and `INSTINCT_DATA_DIR`, then imports `boot` and `createHttpServer`
from `@kloru/server`.

```
instinct dev [--port 8080] [--host 127.0.0.1] [--tunnel] [--quiet]
```

The management listener binds to loopback by default. The public tunnel forwards to a
separate webhook-only listener, so it does not expose chat, status or schedules.

`--tunnel` sets `INSTINCT_TUNNEL=1`, opens an Inkbox tunnel to this listener and, with
`INKBOX_ADMIN_API_KEY`, subscribes the webhook to `<publicUrl>/webhooks/inkbox`. Without an
admin key it prints the URL for you to subscribe by hand. Ctrl-C closes the tunnel, the
server and the agent cleanly. `--data-dir` may come before or after `dev`; the binary stays
up either way.

If `COMPOSIO_API_KEY` is set but `config.json` has `apps.enabled: false`, `dev` warns and
names the fix (`instinct init --name <you> --apps`) instead of booting without app tools.

### `instinct chat`

Sends one message and prints the reply.

```
instinct chat "<message>" [--url http://127.0.0.1:8080] [--agent <maritimeAgentId>] [--conversation <id>]
```

Without `--agent` it posts to the local server's `/chat`. With `--agent` it goes through
`POST https://api.maritime.sh/api/agents/<id>/chat` with `MARITIME_API_KEY`, which wakes a
sleeping agent. `--conversation` keeps several messages in one thread. When
`INSTINCT_CHAT_TOKEN` is set, local calls send it as `Authorization: Bearer <token>`.

### `instinct status`

```
instinct status [--url http://127.0.0.1:8080]
```

Fetches `GET /` (falls back to `/health`), sending `INSTINCT_CHAT_TOKEN` when set, and prints a flattened key/value table: agent
name, owner, model, computer kind, connected apps, conversation counts, uptime.

### `instinct deploy`

Creates one Maritime agent for you from a built image. The request body is the same one
the gateway uses for multi-user signups, so both shapes produce the same kind of agent:
`framework: "custom"`, `exposedPort: 18789`, `healthCheckPath: "/health"`, `desktop: true`,
`externalId: "kloru:<handle>"`. Maritime injects `PORT=18789` for custom images; the
body sends the same number as `exposedPort` and as an explicit `PORT` env var so the port the
server binds and the port Maritime forwards to are always the same. Local runs
(`deploy/kloru/Dockerfile`, `docker compose`) keep `PORT=8080`.

```
instinct deploy --image ghcr.io/<you>/kloru-agent:<tag> [--name instinct-<handle>]
                [--idle 900] [--no-desktop] [--maritime-llm] [--model <id>] [--dry-run]
```

| Flag | Meaning |
|---|---|
| `--image` | the agent image (required); build it from `deploy/kloru/Dockerfile` |
| `--name` | Maritime agent name, default `instinct-<handle>` |
| `--idle` | seconds of silence before the microVM sleeps, default 900 |
| `--no-desktop` | skip the Linux desktop (no computer use, cheaper) |
| `--maritime-llm` | no model key of your own: sets `useMaritimeLlm: true` so Maritime injects `OPENAI_API_KEY` and `OPENAI_BASE_URL` for its metered proxy, and sets `INSTINCT_MODEL=openai-compatible/<model>` so the agent uses them. Your own `OPENAI_*` are not copied in this mode |
| `--model` | with `--maritime-llm`, the proxy model id (default `gpt-5.4`, or `INSTINCT_MARITIME_MODEL`); otherwise overrides `config.model.primary` for this agent |
| `--dry-run` | print the body with secrets redacted, create nothing |

Env vars copied into the agent: `PORT`, `INSTINCT_*` owner and model settings, `INKBOX_*` from
`secrets/inkbox.json`, `ANTHROPIC_API_KEY` or `OPENAI_*`, `COMPOSIO_*`, `BRAVE_SEARCH_API_KEY`,
and, when `LINK_CLIENT_ID` is set, `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `LINK_REDIRECT_URI`
and `STRIPE_PUBLISHABLE_KEY` for Stripe Link payments. Secrets are flagged `isSecret: true` so
Maritime encrypts them. The new agent id is saved to `<dataDir>/maritime.json` and the command
prints the dashboard URL plus the two ways to receive webhooks: run the gateway, or self-host
with `instinct dev --tunnel`. Creating an agent debits your Maritime wallet; a 402 is shown
with the server's own explanation.

### `instinct invite`

Adds a person to the trusted network and, with `INKBOX_ADMIN_API_KEY`, creates an Inkbox
A2A invitation their agent can accept.

```
instinct invite <name> --tier <partner|family|friend|contact|stranger>
                [--email x@y] [--phone +1...] [--handle <peer-handle>] [--note "..."]
```

`--handle` records the peer agent's Inkbox handle on the contact and opens our side of the
A2A contact rule, so the peer's first task is admitted. The printed link or handoff prompt
is what you forward to the other person.

### `instinct trust`

```
instinct trust list
instinct trust set <contact> <tier>
instinct trust grant <contact> <cap,cap> [--until YYYY-MM-DD] [--max-usd N] [--purpose "..."] [--note "..."]
instinct trust revoke <grantId>
```

`<contact>` is a contact id (`sam-lee`) or a name. `set` creates the contact when it does
not exist. `grant` writes a scoped, time-boxed exception to `policy.json`; `--until` with a
date means end of that day (UTC). Capabilities are the strings from
`docs/PERMISSIONS.md`, for example `calendar.write,plans.commit`. Nobody can be set to
`owner`.

### `instinct payments`

```
instinct payments connect [--url http://127.0.0.1:8080]
instinct payments status  [--url http://127.0.0.1:8080]
```

`connect` prints the Stripe Link authorize URL that links your Link wallet to the agent.
It asks the running server for `GET /oauth/link/start` first (the server holds the PKCE
verifier and finishes the token exchange when Link redirects back). When the server has no
such route, the URL is built from `LINK_CLIENT_ID` and `LINK_REDIRECT_URI`
(`https://login.link.com/auth`, scope `payment_methods.agentic`) with a warning that the
exchange still needs a server. Behind the gateway, the redirect lands on
`<gateway>/oauth/link/callback/<userId>` and the gateway relays the code to your agent.

`status` prints what the server reports on `GET /payments/status` (or the `payments` field
of `GET /`) and whether `LINK_CLIENT_ID`, `LINK_CLIENT_SECRET`, `LINK_REDIRECT_URI` and
`STRIPE_PUBLISHABLE_KEY` are set locally. Values are never printed, only `set` or `missing`.

### `instinct persona`

```
instinct persona show
instinct persona edit
instinct persona set "<text>"
instinct persona reset
instinct persona path
```

`PERSONA.md` in the data directory is the identity section of the agent's system prompt:
its voice, texting style and what it never does. The first boot writes the built-in default
(or `INSTINCT_PERSONA` from the environment); after that the file is yours. `show` prints
what is in effect, the default included when no file exists yet. `edit` opens the file in
`$VISUAL` or `$EDITOR` and writes the default first when there is nothing to edit; with no
editor set it prints the path. `set` replaces the file with the text given. `reset` puts
the default back. The server reads the file on every message, so a change applies to the
next reply. The agent's name is `agent.name` in `config.json`: `instinct init --name <you>
--agent-name "Pip"`. [docs/CUSTOMIZE.md](../../docs/CUSTOMIZE.md) covers the other layers
(`AGENTS.md`, skills, memory, policy).

### `instinct prompt`

```
instinct prompt [--channel imessage|sms|email|a2a|chat|scheduled|system] [--layers] [--json] [--no-skills]
```

Prints the system prompt your own conversation would get right now, built from the data
directory with you as the owner: `config.json`, `PERSONA.md`, `AGENTS.md`, the memory
digest, your capabilities from `policy.json`, pending approvals and the skills index. No
server or model key is needed. `--layers` prints one row per section (id, length, the file
that decides it) instead of the text; `--json` prints the sections as data. The skills
index comes from `$INSTINCT_SKILLS_DIR` or `<repo>/skills`; `--no-skills` leaves it out.
A running agent adds the tool groups it wired (messaging, computer, apps) and the network
guidance for whoever it is talking to; the text of every file is the same.

### `instinct schedules`

```
instinct schedules list
instinct schedules add "<cron>" "<prompt>" [--tz Area/City] [--name "..."]
instinct schedules add --at <iso-timestamp> "<prompt>"
instinct schedules remove <id>
```

Cron has five fields (`minute hour day month weekday`) with `*`, lists, ranges and steps,
evaluated in `--tz` (default: your system timezone). The server serves these on
`GET /schedules` so Maritime wakes the agent on time; the result is delivered to you over
iMessage.

## Example session

```bash
export INKBOX_ADMIN_API_KEY=ik_admin_...
export ANTHROPIC_API_KEY=sk-ant-...

# 1. Create the agent's config and its iMessage identity.
$ instinct init --name "Maria" --phone +14155550100 --email maria@example.com \
    --handle maria-kloru --timezone America/New_York
Wrote /Users/maria/.instinct/config.json
  owner  Maria  +14155550100  maria@example.com
  agent  Kloru  @maria-kloru
  model  anthropic/claude-fable-5-1

Provisioning Inkbox identity @maria-kloru ...
Identity ready: @maria-kloru  maria-kloru@inkboxmail.com  iMessage on
Secrets written to /Users/maria/.instinct/secrets/inkbox.json (mode 0600).

Connect your iMessage
  1. Text connect @maria-kloru to +1 415 555 0100
  2. A new thread from your Kloru appears. Say hi.

# 2. Run it on your laptop with webhooks tunneled in.
$ instinct dev --tunnel
Kloru is running on http://127.0.0.1:8080  (data: /Users/maria/.instinct)
  tunnel: https://maria-kloru.inkboxwire.com
  webhook: subscription whs_8f2 (new)

# 3. Talk to it from another terminal, or from your phone.
$ instinct chat "Book me a table for two at Nopa on Thursday at 7"
On it. I will send the result when it is done.

# 4. Give your partner more access than a friend.
$ instinct invite "Sam Lee" --tier partner --email sam@example.com --handle sam-kloru
Added Sam Lee (sam-lee) as partner, agent @sam-kloru
Allowed A2A with @sam-kloru on @maria-kloru.

Invitation for Sam Lee (partner)
  link    https://inkbox.ai/i/inv_3k9...

$ instinct trust grant sam-lee calendar.write,plans.commit --until 2026-10-12 --max-usd 150 \
    --note "Sam can book us dinner this week"
Granted calendar.write, plans.commit to Sam Lee (grant_x1) until 2026-10-12T23:59:59.000Z, max $150

# 5. A morning briefing on weekdays.
$ instinct schedules add "0 8 * * 1-5" "Morning briefing: calendar, weather, top emails" --tz America/New_York
Scheduled sch_7a  0 8 * * 1-5  (America/New_York)  next 2026-10-05T12:00:00.000Z

# 6. Move it to its own computer on Maritime.
$ export MARITIME_API_KEY=mk_...
$ instinct deploy --image ghcr.io/you/kloru-agent:latest
Creating Maritime agent instinct-maria-kloru from ghcr.io/you/kloru-agent:latest ...
Agent created: agt_01J...  (deploying)
  dashboard  https://maritime.sh/dashboard/agents/agt_01J...
  chat       instinct chat "hello" --agent agt_01J...

$ instinct chat "what did you do today" --agent agt_01J...
```

## Programmatic use

```ts
import { runCli } from "@kloru/cli";

const code = await runCli(["trust", "list"], { INSTINCT_DATA_DIR: "/tmp/agent" }, {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
```

`runCli(argv, env, io)` returns the exit code (0 ok, 1 error, 2 usage). `io` can also
carry `fetchImpl`, `createProvisioner`, `importServer`, `connectTunnel` and
`installSignalHandlers` so tests never touch the network or the signal table.

## Files the CLI writes

```
<dataDir>/config.json            owner, agent, model (init)
<dataDir>/contacts.json          people and tiers (invite, trust set)
<dataDir>/policy.json            grants and spend policy (trust grant/revoke)
<dataDir>/schedules.json         proactive jobs (schedules)
<dataDir>/PERSONA.md             the agent's voice (persona set/edit/reset)
<dataDir>/secrets/inkbox.json    identity key, signing key, handle (init; 0600)
<dataDir>/maritime.json          the deployed agent id (deploy)
<dataDir>/connect-qr.png         QR for the connect text (connect)
```

## Development

```bash
pnpm --filter @kloru/cli test        # vitest; resolves sibling packages from source
pnpm --filter @kloru/cli typecheck   # needs sibling dist (pnpm -r build first)
pnpm --filter @kloru/cli dev         # tsx src/bin.ts dev
```
