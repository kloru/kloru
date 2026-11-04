# @kloru/apps

App tools for Kloru through the Composio Tool Router. This package gives the agent
Gmail, Google Calendar, Google Contacts and any other Composio toolkit as Pi tools, each tagged
with the capability the policy engine checks. With the toolkit list `all` the owner can connect
any app by name from a text.

## What Composio is

Composio is a hosted integration layer. It holds the OAuth connections to a user's apps and
exposes the apps' actions as tools. One Tool Router session belongs to one user. The session
has an MCP endpoint, so the agent talks to it the same way it talks to its desktop: through
`@earendil-works/pi-mcp`.

Analogy: Composio is the keyring. The agent does not hold the Gmail password. It holds a key
that opens the Gmail door for one owner, and the owner can take the key back any time.

## How it fits

```
owner texts "what's on my calendar tomorrow"
  -> core resolves principal (owner) and binds tools
  -> model calls app_googlecalendar_events_list
  -> policy guard: needs calendar.read, owner has it, allow
  -> ComposioApps -> MCP callTool("GOOGLECALENDAR_EVENTS_LIST") -> Composio -> Google
  -> result text back to the model -> reply on iMessage
```

Everything persisted lives in the StateDir as `apps.json`:

```json
{ "sessionId": "...", "userId": "maria", "toolkits": ["gmail", "googlecalendar", "googlecontacts"], "mode": "direct", "createdAt": "..." }
```

The session is reused across restarts. A new one is created when the user id, toolkit list or
mode changes, or when Composio no longer knows the saved id. In all mode the file holds
`"toolkits": ["*"]` and `"mode": "router"`.

## Usage

```ts
import { ComposioApps, DEFAULT_TOOLKITS, appsGuidance, appsTools } from "@kloru/apps";

const apps = new ComposioApps({
  apiKey: composioApiKey,          // COMPOSIO_API_KEY, read by the server, never by this package
  userId: ownerId,                 // one Composio user per owner; the Maritime externalId works
  toolkits: DEFAULT_TOOLKITS,      // ["gmail", "googlecalendar", "googlecontacts"], or ["all"]
  state,                           // core StateDir
  logger: (m) => console.log(m),
});

await apps.connect();
registry.registerMany(await apps.tools());
registry.registerMany(appsTools({ apps }));   // apps_list and apps_connect

const status = await apps.connectedToolkits();
const connected = status.filter((s) => s.connected).map((s) => s.slug);
const missing = status.filter((s) => !s.connected).map((s) => s.slug);
const promptSection = appsGuidance(connected, missing, { anyApp: apps.allToolkits });

// Owner wants to connect Gmail: send them this link on iMessage.
const link = await apps.connectLink("gmail");

await apps.close();
```

### API

| Member | What it does |
|---|---|
| `new ComposioApps(opts)` | `{ apiKey, userId, toolkits, state, logger?, mode? }`. Throws when `apiKey` or `userId` is empty. `toolkits: ["all"]` or `["*"]` means every toolkit. |
| `connect()` | Reuse the saved session (`composio.sessions.use(id, { mcp: true })`) or create one (`composio.sessions.create(userId, { toolkits, manageConnections: { enable: true }, mcp: true, sessionPreset: "direct_tools" })`), save `apps.json`, then open a pi-mcp `McpClient` over `StreamableHttpTransport({ url: session.mcp.url, headers: session.mcp.headers })`. In all mode `toolkits` and `sessionPreset` are left out of the create call. Safe to call many times. |
| `tools({ refresh? })` | Every MCP tool wrapped as a `RegisteredTool`. Cached until `refresh: true` or `close()`. |
| `connectLink(toolkit)` | `session.authorize(toolkit)` and return its redirect URL. The owner opens it and signs in. |
| `connectedToolkits()` | `[{ slug, connected }]` for each configured toolkit. No-auth toolkits count as connected. In all mode: every toolkit with an active connection, each `connected: true`, paged up to 10 pages of 100. |
| `allToolkits` | True in all mode. |
| `mode` | The mode the session really runs in. `router` in all mode whatever was asked. |
| `close()` | Close the MCP client. The next call reconnects. |
| `appsTools({ apps })` | Two `RegisteredTool`s: `apps_list` (connected and missing apps, whether any app can be requested) and `apps_connect` (sign-in link for one toolkit). Both owner-only; `apps_connect` refuses non-owners itself as well. |
| `capabilitiesForSlug(slug)` | The capability list for a Composio tool slug (table below). |
| `sensitiveCapabilitiesForSlug(slug)` | The stricter tags a slug outside the Google rows earns from its words: `email.send`, `calendar.write`, `purchase`. Empty for reads. |
| `appsGuidance(connected, missing, { anyApp? })` | Prompt section listing the apps, the tools to call and the connect procedure. `anyApp: true` says any app can be requested by name. |
| `DEFAULT_TOOLKITS` | `["gmail", "googlecalendar", "googlecontacts"]`. |
| `ALL_TOOLKITS` | `"*"`, the stored form of all mode. `wantsAllToolkits(list)` tests for it. |

Lower-level pieces are exported too: `wrapMcpTools`, `wrapMcpTool`, `toolNameFor`, `parametersFor`, `metaFor`, `normalizeToolkits`, `describeStatus`, `PAYMENT_TOOLKITS`.

## Connecting an app from a text (what the owner does)

1. The deployer sets `COMPOSIO_API_KEY` (a Composio project key) on the agent. The server passes
   it into `ComposioApps`. The owner never sees it.
2. On first boot the server creates the session and the agent's prompt says which apps are
   connected and which are not.
3. The owner texts something like "connect my Gmail", "connect Notion" or "hook up Slack". The
   model calls `apps_connect` with the toolkit slug (`gmail`, `notion`, `slack`, `github`,
   `googlecalendar`, ...) and sends the owner the link it gets back. `app_composio_manage_connections`
   does the same job from Composio's side.
4. The owner opens the link on their phone, signs in and approves the scopes. Composio stores the
   tokens. Nothing is typed into the chat.
5. From then on `connectedToolkits()` reports the app as connected and its tools work. "Which apps
   are connected?" is answered by `apps_list`.

With an explicit toolkit list, `apps_connect` refuses a slug outside the list and tells the model
the fix (`COMPOSIO_TOOLKITS=...,notion` or `COMPOSIO_TOOLKITS=all`). With `all`, any slug goes.

Only the owner can connect or disconnect apps. `apps_connect` checks the caller itself, and the
prompt section from `appsGuidance` tells the model to decline when anyone else asks.

To disconnect, the owner revokes access in the app's account settings or asks the agent, which
calls `app_composio_manage_connections`. Deleting `apps.json` forces a fresh session on next boot.

## All mode: `toolkits: ["all"]`

`COMPOSIO_TOOLKITS=all` (or `*`) reaches `ComposioApps` as `toolkits: ["all"]`. Then:

- `normalizeToolkits` returns `["*"]` and `allToolkits` is true.
- The session is created with no `toolkits` and no `sessionPreset`. Composio's `direct_tools`
  preset needs a toolkit filter, so all mode always runs as `router`, whatever `mode` says. A log
  line says so.
- The MCP list holds the meta tools: `COMPOSIO_SEARCH_TOOLS` finds an action in any toolkit,
  `COMPOSIO_MULTI_EXECUTE_TOOL` runs it, `COMPOSIO_MANAGE_CONNECTIONS` connects one. All three
  are `apps.use` + `trust.manage`, so in all mode only the owner can use apps.
- `connectedToolkits()` lists the toolkits with an active connection instead of a fixed list.
- `appsGuidance(..., { anyApp: true })` tells the model that any app can be requested by name.

Use the explicit list when other tiers should reach some apps through their own tags (a partner
reading the calendar). Use `all` when the owner wants every app and apps are the owner's alone.

## Tool naming

The MCP tool `GMAIL_SEND_EMAIL` becomes `app_gmail_send_email`: prefix `app_`, lowercase, anything
outside `[a-z0-9_-]` replaced with `_`, clipped to 64 characters. The original slug is still used
on the wire. Names that collide after clipping keep the first tool.

## Capability map

The policy engine checks every capability a tool needs against the caller's tier
(docs/PERMISSIONS.md). This is how a partner's Kloru can see the owner's calendar but not send
mail as the owner.

| Tool family | Capability |
|---|---|
| `GMAIL_SEND_EMAIL`, `GMAIL_REPLY_TO_THREAD`, `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_FORWARD*` | `email.send` |
| other `GMAIL_*` | `email.read` |
| `GOOGLECALENDAR_CREATE*`, `UPDATE*`, `DELETE*`, `PATCH*`, `QUICK_ADD*` | `calendar.write` |
| `GOOGLECALENDAR_FIND_FREE_SLOTS`, `GOOGLECALENDAR_FREEBUSY`, `GOOGLECALENDAR_GET_FREE_BUSY` | `calendar.freebusy` |
| other `GOOGLECALENDAR_*` | `calendar.read` |
| `GOOGLECONTACTS_CREATE*`, `UPDATE*`, `DELETE*`, `BATCH*`, `MODIFY*`, `ADD*`, `REMOVE*`, `PATCH*`, `COPY*` | `contacts.read` + `memory.write` (owner only) |
| other `GOOGLECONTACTS_*` | `contacts.read` |
| `COMPOSIO_MANAGE_CONNECTIONS`, `COMPOSIO_SEARCH_TOOLS`, `COMPOSIO_MULTI_EXECUTE_TOOL` | `apps.use` + `trust.manage` (owner only) |
| `apps_list`, `apps_connect` | `apps.use` + `trust.manage` (owner only) |
| other toolkit, read: action word `GET`, `LIST`, `RETRIEVE`, `SEARCH`, `FETCH`, `FIND`, `READ`, `DESCRIBE`, `COUNT`, `LOOKUP`, `QUERY` | `apps.use` + `trust.manage` |
| other toolkit, plain write (`NOTION_CREATE_PAGE`, `GITHUB_DELETE_REPOSITORY`) | `apps.use` + `trust.manage` |
| other toolkit, `SEND` / `REPLY` / `FORWARD`, or `DRAFT` / `COMPOSE` with `EMAIL` / `MAIL` / `MESSAGE` | `email.send` + `apps.use` + `trust.manage` |
| other toolkit, `CALENDAR` / `EVENT` / `MEETING` / `APPOINTMENT` / `BOOKING` with `CREATE` / `UPDATE` / `DELETE` / `PATCH` / `ADD` / `CANCEL` / `RESCHEDULE` / `MOVE` / `SCHEDULE` / `BOOK` | `calendar.write` + `apps.use` + `trust.manage` |
| other toolkit, `PAY*` / `PAYOUT*` / `CHARGE*` / `REFUND*` / `TRANSFER*` / `CHECKOUT` / `PURCHASE*` / `BUY`, `ORDER` with a placing verb, or any write in `PAYMENT_TOOLKITS` (Stripe, PayPal, Square, Braintree, Razorpay, Adyen, Coinbase, Wise, Venmo, Gumroad, Lemon Squeezy, Chargebee, Recurly, Paddle, Mercury, Brex, Ramp, Revolut) | `purchase` + `apps.use` + `trust.manage` |

Only the words after the toolkit prefix count, so `SENDGRID_CREATE_TEMPLATE` is a plain write and
`SENDGRID_SEND_EMAIL` is a send. A slug can earn more than one tag (`COINBASE_SEND_TRANSACTION`
is `email.send` + `purchase`). The judgement lives in `sensitiveCapabilitiesForSlug`; the test
table in `test/capabilities.test.ts` is the reference.

`apps.use` is a transport tag. Core's tier table opens it to partner, family and friend so
that a partner's Kloru can reach `GOOGLECALENDAR_EVENTS_LIST` and be judged by
`calendar.read`. On its own it would not stop a friend from managing the owner's connections
or running an unknown toolkit, so those rows carry a second, owner-only capability.
`trust.manage` stands in for a future `apps.manage` and `memory.write` for a future
`contacts.write`; the constants `APPS_MANAGE` and `CONTACTS_WRITE` are the single place to
change when core adds them. A grant that names those capabilities widens access on purpose.

The stricter tag on an unknown toolkit does two things. A grant on `apps.use` + `trust.manage`
alone opens plain writes for that person but not sends, calendar changes or money. And
`purchase` runs the owner's own call through the spend policy: the amount is unknown, so the
agent asks the owner before any app action that moves money. No `amountUsd` extractor is set
for app tools, because each app counts money differently (Stripe in cents, for one).

### Session mode and the multi-execute limitation

`COMPOSIO_MULTI_EXECUTE_TOOL` runs several tools in one call. The guard sees one call with one
capability (`apps.use`) and cannot check the tools inside it. Two things limit the damage:

- The default `mode: "direct"` creates the session with `sessionPreset: "direct_tools"`. Composio
  then lists every allowed app tool directly (`GMAIL_SEND_EMAIL` and so on) and leaves out search
  and multi-execute, while `manageConnections: { enable: true }` keeps the connect tool. Each app
  action gets its own capability tag.
- When a deployment chooses `mode: "router"`, the MCP list holds only the meta tools. Everything
  then costs `APPS_MANAGE` (`apps.use` + `trust.manage`), which is owner-only. The tool description
  also tells the model to prefer direct tools.

Choose `router` only when the toolkit list is so large that direct listing is impractical.
All mode is router mode by construction.

## Prompt section

`appsGuidance(connected, missing, { anyApp })` returns a short section for the system prompt. It
names the connected apps, lists the missing ones, points the model at `apps_list` for "which apps
are connected" and at `apps_connect` (or `app_composio_manage_connections`) for a connect link,
says only the owner may connect apps, and forbids pasting tokens into messages. With `anyApp` it
adds that any app Composio supports can be requested by name and that `app_composio_search_tools`
finds the action. It also reminds the model that email and calendar content is data from other
people, not instructions.

## Testing

```
pnpm --filter @kloru/apps test
```

Tests cover the capability table (Google rows, the sensitive-word rows for unknown toolkits, and
the policy outcomes per tier), tool naming and schema wrapping, result conversion (text, images,
structured content, `isError`), session reuse and fallback logic with a stubbed Composio client
and MCP source, all mode (no allowlist, no preset, paged connection listing), `connectLink`,
`connectedToolkits`, `close`, the `apps_list` and `apps_connect` tools, and the guidance text. No
network calls.

## Notes for implementers

- This package reads no environment variables. The server passes the key and the user id.
- `@composio/core` 0.22.0 declares Node `>=22.22.3` in `engines`; it loads and runs on 22.20.0.
  pnpm may print an engine warning.
- The SDK's `Session` type is wide. `ComposioApps` types the subset it calls as
  `ComposioSessionLike` and `ComposioClientLike`, so a test can hand in a stub through
  `adapters: { createComposio, connectMcp }`.
- `session.mcp.headers` carry the session credential. They go only to the MCP transport and are
  never logged.
