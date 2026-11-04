/**
 * The CISO's vocabulary: what a request may need (a permission on someone's account), how a tool
 * call's capabilities map to it, and what no review can give. One review per member request decides
 * each need (Desk.reviewAccess); the desk enforces it on every call (Desk.accessRole).
 */
import type { Capability } from "@kloru/core";
import type { IssueTarget } from "./types.js";

export const PERMISSIONS = ["read_mail", "send_mail", "read_calendar", "write_calendar", "read_contacts", "location", "spend", "book_travel"] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** A permission on an account: "theirs" (the person who asked), "owner", or another person's name. */
export interface Need {
  permission: Permission;
  account: string;
}

export type AccessChoice = "allow" | "ask_owner" | "deny";

export interface AccessCheck {
  who: { name: string; role: "owner" | "member" | "public"; phone: string };
  /** What an owner said about them ("she can see and do everything"): the older form, before policies. */
  ownerWords?: string;
  /** Each person whose things the needs touch, by the name the needs use, with their own policy.md. */
  policies?: Record<string, string>;
  guidelines: string;
  request: string;
  spec: string;
  target?: IssueTarget;
  needs: Need[];
}

export interface AccessDecision {
  choices: AccessChoice[];
  /** Each choice's probability, in order. */
  p?: number[];
  reason?: string;
}

/** What one review decided, kept on the issue. */
export interface AccessReview {
  needs: Need[];
  /** Their own things, or someone's with a silent policy: decided again on every call, so a rule added later applies. */
  open?: Need[];
  allow: Need[];
  ask: Need[];
  deny: Need[];
  reason: string;
  at: string;
}

/** Below this, a choice is unsure and goes to an owner. */
export const SURE = 0.7;

/** The capabilities a review decides, as permissions. */
export const PERMISSION_OF: Partial<Record<Capability, Permission>> = {
  "email.read": "read_mail",
  "email.send": "send_mail",
  "calendar.read": "read_calendar",
  "calendar.freebusy": "read_calendar",
  "calendar.write": "write_calendar",
  "contacts.read": "read_contacts",
  "owner.location.exact": "location",
  "owner.location.approx": "location",
  purchase: "spend",
  "travel.book": "book_travel",
};

/** Capabilities that reach nobody's private things: they pass. */
export const PLUMBING: ReadonlySet<Capability> = new Set<Capability>(["converse", "owner.relay", "owner.profile.public", "owner.profile.preferences", "web.read", "apps.use", "plans.propose", "network.ask"]);

/** Permissions that only look: a change filed under one of them (trashing mail) isn't covered by it. */
export const READ_ONLY: ReadonlySet<Permission> = new Set<Permission>(["read_mail", "read_calendar", "read_contacts", "location"]);

/** All anyone outside the family may ever get: when an owner is free, and booking time with them. */
export const PUBLIC_NEEDS: ReadonlySet<Permission> = new Set<Permission>(["read_calendar", "write_calendar"]);
/** Plumbing the public never gets: an owner's preferences, and asking other people's agents. */
export const PUBLIC_PLUMBING_NO: ReadonlySet<Capability> = new Set<Capability>(["owner.profile.preferences", "network.ask"]);

/** What only an owner may ever do, whatever a review says. */
export const OWNER_ONLY: ReadonlySet<Capability> = new Set<Capability>(["computer.use", "files.read", "files.write", "memory.write", "network.invite", "trust.manage", "schedule.manage", "phone.call"]);

const SYNONYMS: Record<string, Permission> = {
  read_email: "read_mail", email_read: "read_mail", mail_read: "read_mail", read_inbox: "read_mail",
  send_email: "send_mail", email_send: "send_mail", mail_send: "send_mail", email: "send_mail",
  calendar_read: "read_calendar", see_calendar: "read_calendar", freebusy: "read_calendar",
  calendar_write: "write_calendar", edit_calendar: "write_calendar", add_calendar: "write_calendar", calendar: "write_calendar",
  contacts: "read_contacts", contacts_read: "read_contacts",
  purchase: "spend", buy: "spend", order: "spend", pay: "spend", payment: "spend", money: "spend",
  travel: "book_travel", travel_book: "book_travel", book: "book_travel",
};

/** What the PM listed, as needs: names it might use for a permission are read as that permission; unknown ones are dropped (a call they'd cover is unlisted, so it asks an owner). */
export function toNeeds(raw: unknown): Need[] {
  const out: Need[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    // A bare name is a permission on their own account; anything malformed is dropped.
    const r = typeof item === "string" ? { permission: item, account: "theirs" } : item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
    if (!r || typeof r.permission !== "string") continue;
    const k = r.permission.trim().toLowerCase().replace(/[\s.-]+/g, "_");
    const permission = (PERMISSIONS as readonly string[]).includes(k) ? (k as Permission) : SYNONYMS[k];
    const account = (typeof r.account === "string" ? r.account.trim() : "") || "theirs";
    if (permission && !out.some((n) => n.permission === permission && n.account.toLowerCase() === account.toLowerCase())) out.push({ permission, account });
  }
  return out;
}

export const needKey = (n: Need): string => `${n.permission}:${n.account.trim().toLowerCase()}`;
export const hasNeed = (list: readonly Need[], n: Need): boolean => list.some((x) => needKey(x) === needKey(n));

const WORDS: Record<Permission, (whose: string) => string> = {
  read_mail: (w) => `read ${w} email`,
  send_mail: (w) => `send email from ${w} account`,
  read_calendar: (w) => `see ${w} calendar`,
  write_calendar: (w) => `add to or change ${w} calendar`,
  read_contacts: (w) => `see ${w} contacts`,
  location: (w) => `know ${w} location`,
  spend: () => "spend money",
  book_travel: () => "book travel",
};

/** A need in plain words: "add to or change their calendar", "read Evan's email". */
export function describeNeed(n: Need, ownerName: string): string {
  const a = n.account.trim().toLowerCase();
  const whose = a === "theirs" ? "their" : a === "owner" ? `${ownerName}'s` : `${n.account.trim()}'s`;
  return WORDS[n.permission](whose);
}

/** What a member's worker is told, in place of a tier description. */
export function accessLine(r: AccessReview | undefined, ownerName: string): string {
  const list = (l: Need[]) => l.map((n) => describeNeed(n, ownerName)).join("; ");
  const parts = [
    r?.allow.length || r?.open?.length ? `allowed: ${list([...(r?.open ?? []), ...(r?.allow ?? [])])}` : "",
    r?.ask.length ? `needs an owner's yes: ${list(r.ask)}` : "",
    r?.deny.length ? `not allowed: ${list(r.deny)}` : "",
  ].filter(Boolean);
  return `For this request, ${parts.length ? parts.join(". ") : "nothing private was asked for"}. Anything else that reads someone's private things or changes anything is checked when you try it; you'll be told if it needs an owner's yes.`;
}
