import type { Contact, ContactStore, Tier } from "@kloru/core";

/** Inkbox handles arrive as `@maria-instinct`, `maria-instinct` or mixed case. Compare in one form. */
export function normalizeAgentHandle(handle: string): string {
  return handle.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Gate 2 of A2A admission (docs/PROTOCOL.md): map the calling agent's handle to a contact and
 * take that contact's tier. Unknown callers are strangers, whatever Inkbox let through.
 */
export function resolveA2aPrincipal(callerHandle: string, contacts: ContactStore): { contact?: Contact; tier: Tier } {
  const handle = normalizeAgentHandle(callerHandle);
  if (!handle) return { tier: "stranger" };
  const contact = contacts.findByHandle(handle) ?? contacts.all().find((c) => c.agentHandle && normalizeAgentHandle(c.agentHandle) === handle);
  if (!contact) return { tier: "stranger" };
  return { contact, tier: contact.tier };
}
