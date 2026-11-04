# @kloru/computer

The agent's computer. This package gives the Kloru runtime a set of desktop tools
(`computer`, `computer_batch`, `request_takeover`, file read and write) backed by a persistent
Linux desktop on Maritime. The model sees screenshots, clicks and types, and hands the keyboard
to the owner when a step needs a human.

Analogy: the desktop is the agent's desk in its apartment. It stays as the agent left it, with
Chromium tabs open and files on disk. The owner can walk in and use the same desk at any time.

## Two backends, one tool set

| Backend | When | Transport | Tool names |
|---|---|---|---|
| `DesktopdBackend` | The agent runs inside a Maritime microVM created with `desktop: true` | REST to `maritime-desktopd` on `http://127.0.0.1:5911` | `computer`, `computer_batch`, `request_takeover`, `takeover_status`, `computer_read_file`, `computer_write_file` |
| `MaritimeMcpBackend` | Anywhere else: self-hosted, local dev, a VM without a desktop | MCP Streamable HTTP to `https://mcp.maritime.sh/mcp/u/{externalUserId}` with `Authorization: Bearer mk_...` | Exactly what the server lists: `get_computer`, `computer`, `computer_batch`, `run_shell`, `read_file`, `write_file`, `request_takeover`, `takeover_status`, `close_computer` |

Both backends share the same `computer` action schema (the `computer_toolset_20260801` shape
Maritime uses): `screenshot`, `left_click`, `right_click`, `middle_click`, `double_click`,
`triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`,
`type`, `key`, `hold_key`, `wait`, `zoom`, `cursor_position`. Coordinates are pixels of the last
screenshot. The default frame is 1200x750 (physical 1280x800); every result reports its width and
height. Prompts written for one backend work on the other.

Every tool carries `meta: { capabilities: ["computer.use"], group: "computer" }`. The policy
engine in `@kloru/core` allows `computer.use` for the owner only, so a friend's Kloru
can never drive the desktop, whatever it asks.

## Picking a backend

```ts
import { detectComputer, computerGuidance } from "@kloru/computer";

const computer = await detectComputer({
  mode: config.computer.mode,              // "auto" | "desktopd" | "maritime" | "none"
  desktopdUrl: config.computer.desktopdUrl,
  maritimeMcpUrl: env.MARITIME_COMPUTERS_MCP_URL,
  maritimeApiKey: env.MARITIME_API_KEY,
  externalUserId: env.MARITIME_AGENT_ID ?? "owner",
  agentId: env.MARITIME_AGENT_ID,          // makes takeover hints link to this agent's page
  logger: console.error,
});
if (computer) {
  registry.registerMany(await computer.tools());
  promptSections.push(computerGuidance());
}
```

`auto` means: if `GET http://127.0.0.1:5911/health` answers `ok`, use desktopd; otherwise, if a
Maritime key is present, use the hosted MCP (the URL defaults to `https://mcp.maritime.sh`);
otherwise run without a computer. `desktopd` and `maritime` force one backend; `maritime` throws
when the URL or key is missing so a misconfigured deployment fails at boot, not mid-task.

Cold boots. Maritime launches the desktop stack in the background and starts the agent at
once, so on a fresh VM desktopd is usually not listening yet when `detectComputer` runs. Pass
`expectDesktopd: true` (the server sets it from `MARITIME_DESKTOP=1`) and the probe is retried
with backoff (1 s, 2 s, 4 s, then every 5 s) for up to `desktopdWaitMs` (default 60 s). If it
still has not answered, `auto` keeps the desktopd backend anyway: the platform said there is a
desktop, and the client turns an unreachable server into tool errors until it is up. Mode
`desktopd` always waits the full budget. Plain `auto` without the flag keeps the single fast probe,
so a laptop without a desktop boots in milliseconds. `waitForDesktopd` is exported for callers that
want the poll on its own.

`computerGuidance()` returns a short system prompt section: the screenshot, act, verify loop,
the 1200 px frame, and when to call `request_takeover`.

## How Maritime desktops work

A Maritime agent created with `desktop: true` gets a Firecracker microVM with an XFCE desktop,
Chromium and LibreOffice at 1280x800. Inside the VM, `maritime-desktopd` listens on loopback port
5911 and drives the display with xdotool; screenshots come from a resident capture process.
State under `/data` and `/home/desk` survives sleep and wake, so logins and downloads persist.
The agent process (this repo's `server` package) runs in the same VM and talks to desktopd over
HTTP, which is what `DesktopdBackend` does.

The hosted Computers product is the same desktop without the agent inside it. Maritime keeps one
computer per end user id behind an MCP server. `get_computer` creates the computer on first use
(up to 60 s) or returns the existing one; a sleeping computer wakes on its first action (a few
seconds). `MaritimeMcpBackend` sets the MCP request timeout to 180 s so the first call survives,
remembers the `computer_id` that `get_computer` returns, and fills it into later calls when the
model leaves it out. If the model calls `computer` before `get_computer`, the backend fetches the
id itself.

Hosted calls fail with `no_plan` (HTTP 402) when the Maritime account has no Computers plan.
`get_computer` succeeding proves the key works, not that the account is entitled; smoke-test with
a real action.

## Takeover

Logins, 2FA codes, QR codes, CAPTCHAs and payment confirmation are the owner's job. The agent
calls `request_takeover { reason }`:

1. desktopd flips to `human` mode and stops serving screenshots to the agent. Input actions are
   refused with `human_in_control`; `screenshot` returns `{ blocked: true }`. The agent sees
   nothing the owner does.
2. The owner opens the agent in the Maritime dashboard (`https://maritime.sh/agents/<id>`), where
   the live desktop shows a banner with the reason and Done / Failed buttons, does the step, and
   clicks one of them.
3. desktopd returns to `agent` mode. `Done` returns `{ success: true, screenshot }`; `Failed`
   returns `{ success: false, note }`. A failed takeover means the task failed; the agent must
   not request another one for the same step.

By default `request_takeover` returns at once with the message to relay to the owner, because a
tool call that blocks for ten minutes does not fit a chat product (the Maritime `/chat` budget is
30 s and the owner is on iMessage). The model sends the owner one short text, then polls
`takeover_status` or simply retries its next action. Pass `wait: true` to block instead; desktopd
caps the wait at 600 s.

On the hosted backend `request_takeover` mints a viewer link (`viewer_url`) that the owner opens
in a browser. The wrapper appends a reminder to send that link to the owner and to poll
`takeover_status`.

There is no code path that solves CAPTCHAs, in this package or in desktopd.

## Files

`computer_read_file { path }` and `computer_write_file { path, content, encoding? }` move files
between the conversation and the desktop. Paths must be absolute and under `/data` or
`/home/desk`; desktopd rejects anything else and caps files at 8 MiB. UTF-8 files come back as
text; other files as base64 (or a size note above 256 KiB). On the hosted backend the server's
own `read_file` and `write_file` tools do the same job.

## Testing

```
pnpm --filter @kloru/computer test
```

The desktopd client is tested against a scripted `fetch`; the MCP backend against an in-memory
MCP server built on `@earendil-works/pi-mcp/testing`. Nothing touches the network.

## Design notes

- REST instead of the in-VM stdio MCP server. Maritime ships `maritime-computer-mcp` (a python
  stdio server) in the desktop image. Calling desktopd's HTTP API directly removes a subprocess to
  supervise and lets `request_takeover` return without blocking.
- Hosted tool names are kept verbatim. A `computer_` prefix would make the two backends diverge
  and break prompts that Maritime's own docs teach.
- Tools are built with core's `defineTool` and `textResult`, so the shape is the one the
  ToolRegistry expects by construction. Build core first (`pnpm --filter @kloru/core build`).
