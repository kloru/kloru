# An inbox through Atomic Mail

Kloru can give the agent a second, optional inbox at Atomic Mail. This page
explains what Atomic Mail is, how to get a key, and what the agent may do with it.

Code: [`packages/atomicmail`](../packages/atomicmail/README.md). Server wiring: [`packages/server`](../packages/server/README.md).

Inkbox stays the default mailbox. This page is about an extra inbox, not a replacement.

## What Atomic Mail is

Atomic Mail is an email service with a hosted MCP server at
`https://mcp.atomicmail.ai/mcp`. The agent connects to it over MCP, the same
protocol it uses for its desktop. Each allowed tool becomes a Pi tool with a name
like `atomicmail_read_inbox`.

Analogy: the inbox is a letterbox that belongs to the agent. The owner's own mail
stays where it is.

## Getting an API key

1. Create an Atomic Mail account and an inbox at <https://dashboard.atomicmail.ai>.
2. Make sure the inbox is active. The hosted server refuses keys from inboxes that are not.
3. Copy the inbox API key. Give it to the agent as `ATOMIC_MAIL_API_KEY`.

The key is a deployer secret. The owner never sees it. Setting the key turns the
tools on. Without the key, nothing changes.

`ATOMIC_MAIL_MCP_URL` is optional. Set it only to point at a different server.

## What the agent can do

| Tool | Does | Capability | Owner | Partner |
|---|---|---|---|---|
| `atomicmail_read_inbox` | List recent messages | `email.read` | yes | no |
| `atomicmail_read_message` | Read one message | `email.read` | yes | no |
| `atomicmail_search_messages` | Search the inbox | `email.read` | yes | no |
| `atomicmail_send_email` | Send a message | `email.send` | yes | asks first |
| `atomicmail_reply_to_message` | Reply in a thread | `email.send` | yes | asks first |

Text read from the inbox is wrapped as untrusted. The agent treats it as data, never as
orders.

Only these five tools are wired. The hosted server has more, such as raw JMAP requests.
They are left out on purpose, because no capability is tagged for them. The boot log
lists every tool it leaves out.

## If the server is down or the key is wrong

The agent still boots. The server logs `atomicmail unavailable` with a plain reason.
The key is never written to a log.
