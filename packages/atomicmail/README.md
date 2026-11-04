# @kloru/atomicmail

An inbox of the agent's own for Kloru, through the Atomic Mail hosted MCP server. The
agent can read, search, send and reply from an address that belongs to it. Each tool is tagged
with the capability the policy engine checks.

## What Atomic Mail is

Atomic Mail is an email service built for agents. An inbox there belongs to the agent, not to a
person, and it speaks JMAP. The hosted server exposes the inbox as MCP tools, so the agent talks
to it the same way it talks to its desktop: through `@earendil-works/pi-mcp`.

This is a different thing from the other two mail paths:

- The owner's Gmail goes through `packages/apps`. That is the owner's mailbox.
- The agent's Inkbox identity has its own mailbox for the channel the owner texts on.
- This package is a second inbox for what the agent does on its own: signing up for a service,
  receiving a verification code, or mail the owner wants kept out of their own inbox.

## How it fits

```
owner texts "sign me up for that newsletter with your own address"
  -> model fills the form on its desktop with the address from its prompt
  -> the confirmation mail arrives; the model calls atomicmail_search_messages
  -> core resolves principal (owner); policy guard: needs email.read, owner has it, allow
  -> AtomicMailBackend -> MCP callTool("search_messages") -> Atomic Mail
  -> result text, wrapped as untrusted, back to the model -> reply on iMessage
```

Nothing is written to disk. The key lives in the environment.

## Usage

```ts
import { AtomicMailBackend, atomicMailGuidance } from "@kloru/atomicmail";

const mailbox = new AtomicMailBackend({ apiKey: process.env.ATOMIC_MAIL_API_KEY! });
registry.registerMany(await mailbox.tools());
promptSections.push(atomicMailGuidance(await mailbox.address()));
// on shutdown
await mailbox.close();
```

The server does this for you when `ATOMIC_MAIL_API_KEY` is set. See [docs/ATOMICMAIL.md](../../docs/ATOMICMAIL.md).

## Tools

| Tool | Hosted tool | Capability |
|---|---|---|
| `atomicmail_read_inbox` | `read_inbox` | `email.read` |
| `atomicmail_read_message` | `read_message` | `email.read` |
| `atomicmail_search_messages` | `search_messages` | `email.read` |
| `atomicmail_send_email` | `send_email` | `email.send` |
| `atomicmail_reply_to_message` | `reply_to_message` | `email.send` |

By default `email.read` is for the owner only. `email.send` is for the owner, and a partner is
asked first. The table is in `src/capabilities.ts`. A tool that is not in it is not registered,
so a tool the server adds later stays off until someone tags it.

## What is left out

- `jmap_request` and `run_preset` can read, send and delete in one call. A per-tool capability
  cannot describe that. This is the same reason `packages/apps` warns about
  `COMPOSIO_MULTI_EXECUTE_TOOL`.
- `search` and `fetch` repeat `search_messages` and `read_message` for other clients.
- `list_agents` and `help` are for the person setting up the connection. The backend calls
  `list_agents` once to learn the address for the prompt.

## Safety

- **Mail is untrusted.** Whatever a read returns is wrapped with `wrapUntrusted`, so text in a
  message cannot pass as an instruction. A message that tries to close the wrapper tag is
  stripped of it.
- **The model never picks an inbox.** `agent_id` is removed from every schema and from every
  call. The key is bound to one inbox, and a prompt injection cannot aim a send at another.
- **The audit log has no bodies.** A send is logged as the recipient and the subject.
- **The key stays out of logs and errors.** A 401 or 403 becomes a plain sentence for the
  person running the agent.

## Testing

```bash
pnpm --filter @kloru/atomicmail test
```

The tests run a fake MCP server over an in-memory transport, and one test checks the Bearer
header through a stub `fetch`. Nothing touches the network.
