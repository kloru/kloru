/**
 * Which connected accounts a caller may act through. Each account belongs to a person (Composio
 * links remember whose): the owner uses his own; a family member uses hers, plus the owner's for an
 * app his words gave her (email for Gmail, calendar for Calendar). Policy still weighs each action.
 */
import type { AppAccount } from "@kloru/apps";
import type { Capability } from "@kloru/core";

/** What a member needs to use the owner's account of an app; apps not listed follow policy alone. */
const NEEDS: Record<string, Capability[]> = {
  gmail: ["email.read", "email.send"],
  googlecalendar: ["calendar.freebusy", "calendar.read", "calendar.write"],
  outlook: ["email.read", "email.send", "calendar.freebusy", "calendar.read", "calendar.write"],
};

export interface AccountScope {
  /** Accounts this caller may act through. */
  accounts: AppAccount[];
  /** Addresses whose mail this caller may read (the store and the fast path filter by these). */
  mail: string[];
  /** Calendar addresses whose events this caller may see in full. */
  calendar: string[];
  /** Calendar addresses this caller may see only as busy times. */
  busy: string[];
  /** Apps where some connected account isn't theirs to use: every action there must name its account. */
  restricted: string[];
}

export function accountScope(o: {
  accounts: () => AppAccount[];
  isOwner: (phone: string) => boolean;
  /** A family member, by phone: their contact id, and whether policy lets them have a capability. */
  personOf: (phone: string) => { id: string; may: (c: Capability) => boolean } | undefined;
  /** An owner's own contact id (a co-owner's); undefined for the primary owner, whose accounts carry no person. */
  selfOf?: (phone: string) => string | undefined;
  /** Whether a contact id is a co-owner's: owners share their accounts with each other, never a member's. */
  ownerPerson?: (contactId: string) => boolean;
}): (phone: string) => AccountScope {
  return (phone) => {
    const owner = o.isOwner(phone);
    // Owners share their accounts with each other (co-owners), their own listed first: "my mail" is theirs.
    // A member's own accounts stay theirs, owners included.
    const self = owner ? o.selfOf?.(phone) : undefined;
    const mine = (a: AppAccount) => (self ? a.person === self : !a.person);
    const owners = (a: AppAccount) => !a.person || !!o.ownerPerson?.(a.person) || a.person === self;
    const connected = o.accounts().filter((a) => a.status === "connected");
    const all = owner ? [...connected.filter(mine), ...connected.filter((a) => !mine(a))] : connected;
    const member = owner ? undefined : o.personOf(phone);
    const usable = (a: AppAccount) => {
      if (owner) return owners(a);
      if (!member) return false;
      if (a.person) return a.person === member.id;
      return (NEEDS[a.toolkit] ?? []).length === 0 || NEEDS[a.toolkit]!.some((c) => member.may(c));
    };
    const accounts = all.filter(usable);
    const reads = (a: AppAccount) => a.toolkit === "gmail" && !!a.email && (owner ? owners(a) : !!a.person || !!member?.may("email.read"));
    const cals = all.filter((a) => a.toolkit === "googlecalendar" && !!a.email);
    const sees = (a: AppAccount) => (owner ? owners(a) : !!member && (a.person ? a.person === member.id : member.may("calendar.read")));
    const busyOnly = (a: AppAccount) => !owner && !!member && !a.person && !sees(a) && (member.may("calendar.freebusy") || member.may("calendar.write"));
    const emails = (l: AppAccount[]) => [...new Set(l.map((a) => a.email!.toLowerCase()))];
    return {
      accounts,
      mail: [...new Set(accounts.filter(reads).map((a) => a.email!.toLowerCase()))],
      calendar: emails(cals.filter(sees)),
      busy: emails(cals.filter(busyOnly)),
      // Where some account isn't theirs, or (for an owner) there's more than one: every action names its account.
      restricted: [...new Set([...all.filter((a) => !usable(a)).map((a) => a.toolkit), ...(owner ? accounts.map((a) => a.toolkit).filter((t, i, l) => l.indexOf(t) !== i) : [])])],
    };
  };
}

const APP_NAMES: Record<string, string> = { gmail: "Gmail", googlecalendar: "Calendar", outlook: "Outlook", one_drive: "OneDrive" };
const appName = (t: string) => APP_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

/** For a caller's workers: their accounts per app, when there's a choice or some aren't theirs (empty otherwise). */
export function accountsLine(s: AccountScope): string {
  const byApp = new Map<string, AppAccount[]>();
  for (const a of s.accounts) byApp.set(a.toolkit, [...(byApp.get(a.toolkit) ?? []), a]);
  if (![...byApp].some(([t, l]) => l.length > 1 || s.restricted.includes(t))) return "";
  const lines = [...byApp].map(([t, l]) => `${appName(t)}: ${l.map((a) => (a.email ? `${a.email} (account ${a.id})` : `account ${a.id}`)).join(", ")}`);
  return `This caller's accounts. ${lines.join(". ")}. Pass account: <id> with each app action, the account the request belongs to; when it doesn't say, the first. Use no other account.`;
}
