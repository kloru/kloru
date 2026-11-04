import type { Capability } from "@kloru/core";

/**
 * The hosted Atomic Mail tools this package registers, and the capability each call needs.
 * The policy engine checks the capability against the caller's tier, so this table decides
 * what a partner or a friend can do through the agent's inbox. Reading is owner only.
 * Sending is owner only too, and asks first for a partner.
 *
 * A tool that is not listed is not registered, so a tool the server adds later stays off
 * until someone tags it here. Four hosted tools are left out on purpose:
 * - `jmap_request` and `run_preset` can read, send and delete in one call. A per-tool
 *   capability cannot describe that, the same reason `packages/apps` warns about
 *   COMPOSIO_MULTI_EXECUTE_TOOL.
 * - `search` and `fetch` repeat `search_messages` and `read_message` for other clients.
 * - `list_agents` and `help` are for the person setting up the connection, not the model.
 */
export const TOOL_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = {
  read_inbox: ["email.read"],
  read_message: ["email.read"],
  search_messages: ["email.read"],
  send_email: ["email.send"],
  reply_to_message: ["email.send"],
};

/** Tools whose result is text written by other people. Their output is wrapped as untrusted. */
export const READ_TOOLS: ReadonlySet<string> = new Set(["read_inbox", "read_message", "search_messages"]);

export function isSupportedTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITIES, name);
}

/** Capabilities a call to this tool needs. Throws for a tool that is not registered. */
export function capabilitiesFor(name: string): Capability[] {
  if (!isSupportedTool(name)) throw new Error(`Atomic Mail tool "${name}" has no capability tag`);
  return [...(TOOL_CAPABILITIES[name] as readonly Capability[])];
}
