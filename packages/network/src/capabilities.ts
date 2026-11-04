import type { Capability, Tier } from "@kloru/core";

/** Local mirror of core's TIER_ORDER, highest first. */
export const TIERS: readonly Tier[] = ["owner", "staff", "partner", "family", "friend", "contact", "stranger"];

/**
 * Local mirror of the Capability union. Kept here because a TypeScript union has no runtime
 * value to validate owner input against. If core ever exports a const array, prefer that one.
 */
export const CAPABILITIES: readonly Capability[] = [
  "converse",
  "owner.relay",
  "owner.profile.public",
  "owner.profile.preferences",
  "owner.location.exact",
  "owner.location.approx",
  "calendar.freebusy",
  "calendar.read",
  "calendar.write",
  "email.read",
  "email.send",
  "contacts.read",
  "plans.propose",
  "plans.commit",
  "purchase",
  "travel.book",
  "computer.use",
  "files.read",
  "files.write",
  "memory.write",
  "network.ask",
  "network.invite",
  "trust.manage",
  "schedule.manage",
  "web.read",
  "apps.use",
];

export function isCapability(v: unknown): v is Capability {
  return typeof v === "string" && (CAPABILITIES as readonly string[]).includes(v);
}

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
}

/** Tiers the owner may place a contact in. Nobody else is `owner`. */
export const ASSIGNABLE_TIERS: readonly Tier[] = TIERS.filter((t) => t !== "owner");

/** Split a list of names into valid capabilities and rejects, preserving order and dropping duplicates. */
export function parseCapabilities(names: readonly unknown[]): { valid: Capability[]; invalid: string[] } {
  const valid: Capability[] = [];
  const invalid: string[] = [];
  for (const n of names) {
    if (isCapability(n)) {
      if (!valid.includes(n)) valid.push(n);
    } else {
      invalid.push(String(n));
    }
  }
  return { valid, invalid };
}
