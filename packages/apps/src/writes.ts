/**
 * Read or write, for the desk's roles. Engineers may only read; ops may write, and a write
 * that reaches another person (an email, a calendar invite, a payment) needs the caller's
 * yes first. This is stricter than capabilitiesForSlug, which tags Gmail's trash and label
 * actions as `email.read` because it only guards sending.
 *
 * Composio's bulk execute runs any tools in one call, so its `tools[].tool_slug` entries are
 * classified one by one. Anything that can't be read is treated as a write.
 */
const BULK_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";

const READ_VERBS: ReadonlySet<string> = new Set(["GET", "LIST", "RETRIEVE", "SEARCH", "FETCH", "FIND", "READ", "DESCRIBE", "COUNT", "LOOKUP", "QUERY", "FREEBUSY", "SCHEMAS", "VIEW"]);
const WRITE_VERBS: ReadonlySet<string> = new Set([
  "CREATE", "UPDATE", "DELETE", "PATCH", "ADD", "REMOVE", "MOVE", "SEND", "REPLY", "FORWARD", "DRAFT", "MODIFY", "INSERT", "QUICK",
  "SET", "TRASH", "UNTRASH", "ARCHIVE", "MARK", "LABEL", "CANCEL", "BATCH", "IMPORT", "CLEAR", "MANAGE", "EXECUTE", "RUN", "BASH",
  "PAY", "CHARGE", "REFUND", "TRANSFER", "BUY", "PURCHASE", "CHECKOUT", "PLACE", "SUBMIT", "BOOK", "SCHEDULE", "RESCHEDULE", "INVITE",
  "REPLACE", "UPSERT", "APPEND", "SHARE", "UPLOAD", "RENAME", "ACCEPT", "DECLINE", "RSVP", "POST", "PUBLISH", "WRITE", "SENDS", "EDIT",
  "COPY", "MERGE", "ASSIGN", "COMMENT", "REACT", "STAR", "PIN", "SNOOZE", "RESTORE", "EMPTY", "PURGE", "REVOKE", "GRANT", "ENABLE", "DISABLE",
]);
const SEND_VERBS: ReadonlySet<string> = new Set(["SEND", "SENDS", "REPLY", "FORWARD", "INVITE"]);

export interface InnerCall {
  slug: string;
  args: Record<string, unknown>;
  /** The connected account it runs as, when named (multi-account sessions). */
  account?: string;
}

const actionTokens = (slug: string): string[] => slug.trim().toUpperCase().split("_").filter(Boolean).slice(1);

/** A read names a read verb and no write verb: GMAIL_FETCH_EMAILS yes, GMAIL_LIST_AND_DELETE no. */
export function isReadSlug(slug: string): boolean {
  const action = actionTokens(slug);
  return action.some((t) => READ_VERBS.has(t)) && !action.some((t) => WRITE_VERBS.has(t));
}

/** The app calls a tool call makes: the bulk execute's entries, or the one slug of an app_<slug> tool. */
export function innerCalls(toolName: string, args: unknown): InnerCall[] | undefined {
  if (!toolName.startsWith("app_")) return [];
  const slug = toolName.slice(4).toUpperCase();
  const a = (args ?? {}) as Record<string, unknown>;
  if (slug !== BULK_EXECUTE) return [{ slug, args: a, ...(typeof a.account === "string" ? { account: a.account } : {}) }];
  if (!Array.isArray(a.tools)) return undefined;
  const out: InnerCall[] = [];
  for (const t of a.tools) {
    const entry = t as Record<string, unknown>;
    if (typeof entry?.tool_slug !== "string") return undefined;
    out.push({ slug: entry.tool_slug.toUpperCase(), args: (entry.arguments ?? {}) as Record<string, unknown>, ...(typeof entry.account === "string" ? { account: entry.account } : {}) });
  }
  return out;
}

/** True when the call changes anything, or when what it would do can't be read. Non-app tools are judged by the role's tool list instead. */
export function isWriteCall(toolName: string, args: unknown): boolean {
  const calls = innerCalls(toolName, args);
  if (calls === undefined) return true;
  return calls.some((c) => !isReadSlug(c.slug));
}

const hasGuests = (args: Record<string, unknown>): boolean => {
  const attendees = args.attendees ?? args.attendee_emails;
  return Array.isArray(attendees) ? attendees.length > 0 : typeof attendees === "string" && attendees.trim() !== "";
};

/** The call explicitly tells Google not to email the guests. */
const updatesOff = (args: Record<string, unknown>): boolean => {
  const v = args.send_updates ?? args.sendUpdates;
  return v === false || v === "none";
};

function notifies(c: InnerCall): boolean {
  const s = c.slug;
  const action = actionTokens(s);
  if (isReadSlug(s)) return false;
  if (s.startsWith("GMAIL_")) return action.some((t) => SEND_VERBS.has(t));
  if (s.startsWith("GOOGLECONTACTS_")) return false;
  if (s.startsWith("GOOGLECALENDAR_")) {
    // A new event only reaches anyone through its guests. Changing or deleting one emails
    // whatever guests it already has, which the call can't show, unless updates are off.
    if (action[0] === "CREATE" || action[0] === "QUICK") return hasGuests(c.args);
    return hasGuests(c.args) || !updatesOff(c.args);
  }
  // Every other toolkit: a write is assumed to reach someone (a post, a message, a payment).
  return true;
}

/** Irreversible: someone else is told (an email, an invite, a message) or money moves. Unreadable bulk calls count. */
export function callNotifiesSomeone(toolName: string, args: unknown): boolean {
  const calls = innerCalls(toolName, args);
  if (calls === undefined) return true;
  return calls.some(notifies);
}
