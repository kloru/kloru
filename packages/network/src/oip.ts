/**
 * OIP/1: the typed data part two Kloru agents exchange over A2A.
 * The plain text part is for any agent; this part is for ours. See docs/PROTOCOL.md.
 */

export type OipIntent =
  | "propose_times"
  | "request_freebusy"
  | "accept"
  | "decline"
  | "confirm"
  | "ask"
  | "inform"
  | "share"
  | "book_request";

export const OIP_INTENTS: readonly OipIntent[] = [
  "propose_times",
  "request_freebusy",
  "accept",
  "decline",
  "confirm",
  "ask",
  "inform",
  "share",
  "book_request",
];

export const OIP_VERSION = "1";

export interface OipMessage {
  oip: "1";
  intent: OipIntent;
  subject?: string;
  on_behalf_of?: { handle: string; display?: string };
  payload: Record<string, unknown>;
  needs_consent?: boolean;
  reply_by?: string;
}

export interface OipTextOptions {
  /** IANA time zone used to print slot times. Without it the wall clock written in the ISO string is shown. */
  tz?: string;
  locale?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isIntent(v: unknown): v is OipIntent {
  return typeof v === "string" && (OIP_INTENTS as readonly string[]).includes(v);
}

/** Produce the wire object. Undefined fields are dropped so the JSON stays small. */
export function encodeOip(m: OipMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { oip: OIP_VERSION, intent: m.intent, payload: { ...m.payload } };
  if (m.subject !== undefined) out.subject = m.subject;
  if (m.on_behalf_of !== undefined) {
    out.on_behalf_of = m.on_behalf_of.display !== undefined
      ? { handle: m.on_behalf_of.handle, display: m.on_behalf_of.display }
      : { handle: m.on_behalf_of.handle };
  }
  if (m.needs_consent !== undefined) out.needs_consent = m.needs_consent;
  if (m.reply_by !== undefined) out.reply_by = m.reply_by;
  return out;
}

/**
 * Validate a data part. Anything that is not an OIP/1 object with a known intent returns
 * undefined so the caller falls back to the text part. Optional fields with the wrong type
 * are dropped rather than failing the whole message.
 */
export function decodeOip(data: unknown): OipMessage | undefined {
  if (!isRecord(data)) return undefined;
  if (String(data.oip) !== OIP_VERSION) return undefined;
  if (!isIntent(data.intent)) return undefined;
  if (data.payload !== undefined && !isRecord(data.payload)) return undefined;

  const m: OipMessage = { oip: "1", intent: data.intent, payload: isRecord(data.payload) ? { ...data.payload } : {} };
  if (typeof data.subject === "string") m.subject = data.subject;
  if (isRecord(data.on_behalf_of) && typeof data.on_behalf_of.handle === "string") {
    m.on_behalf_of = { handle: data.on_behalf_of.handle };
    if (typeof data.on_behalf_of.display === "string") m.on_behalf_of.display = data.on_behalf_of.display;
  }
  if (typeof data.needs_consent === "boolean") m.needs_consent = data.needs_consent;
  if (typeof data.reply_by === "string") m.reply_by = data.reply_by;
  return m;
}

/** One paragraph the model reads when a typed message arrives. */
export function describeOip(m: OipMessage): string {
  const parts: string[] = [`OIP/1 message with intent "${m.intent}"`];
  if (m.subject) parts.push(`about "${m.subject}"`);
  if (m.on_behalf_of) {
    const who = m.on_behalf_of.display ? `${m.on_behalf_of.display} (@${m.on_behalf_of.handle})` : `@${m.on_behalf_of.handle}`;
    parts.push(`sent by the Kloru of ${who}`);
  }
  let text = parts.join(" ") + ".";
  text += ` Payload: ${JSON.stringify(m.payload)}.`;
  if (m.needs_consent) text += " The sender asks for the owner's explicit consent before anything is committed.";
  if (m.reply_by) text += ` A reply is expected by ${m.reply_by}.`;
  text += ` Expected reply: ${expectedReply(m.intent)}.`;
  return text;
}

function expectedReply(intent: OipIntent): string {
  switch (intent) {
    case "propose_times":
      return "accept with one slot, or propose_times back with up to 3 alternatives";
    case "request_freebusy":
      return "inform with busy blocks only (never event titles), or decline";
    case "accept":
      return "confirm with a summary";
    case "decline":
      return "end, or propose_times with alternatives";
    case "confirm":
      return "none; the plan is settled";
    case "ask":
      return "inform with an answer the owner's tier allows";
    case "inform":
      return "none, or a follow-up question";
    case "share":
      return "inform acknowledging what was received";
    case "book_request":
      return "confirm or decline after the owner approves";
  }
}

// ---------------------------------------------------------------------------
// Friendly text for people without a Kloru
// ---------------------------------------------------------------------------

const ISO_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/;

function formatWhen(iso: string, opts: OipTextOptions, withDate: boolean): string {
  const locale = opts.locale ?? "en-US";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (opts.tz) {
    const fmt = new Intl.DateTimeFormat(locale, {
      timeZone: opts.tz,
      ...(withDate ? { weekday: "short", month: "short", day: "numeric" } : {}),
      hour: "numeric",
      minute: "2-digit",
    });
    return fmt.format(date);
  }
  // Without a zone, show the wall clock the sender wrote, not the reader's local conversion.
  const m = ISO_WALL_CLOCK.exec(iso);
  if (!m) return iso;
  const [, y, mo, d, h, mi] = m;
  const utc = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? "0"), Number(mi ?? "0")));
  const fmt = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    ...(withDate ? { weekday: "short", month: "short", day: "numeric" } : {}),
    ...(h !== undefined ? { hour: "numeric", minute: "2-digit" } : {}),
  });
  return fmt.format(utc);
}

function formatSlot(slot: unknown, opts: OipTextOptions): string | undefined {
  if (!isRecord(slot) || typeof slot.start !== "string") return undefined;
  const start = formatWhen(slot.start, opts, true);
  if (typeof slot.end === "string") return `${start} to ${formatWhen(slot.end, opts, false)}`;
  return start;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function factsToLines(facts: unknown): string[] {
  if (!isRecord(facts)) return typeof facts === "string" ? [facts] : [];
  return Object.entries(facts).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
}

/**
 * Turn an OIP message into an iMessage, SMS or email a human can act on. Used when the other
 * person has no Kloru. `payload.text` is used as a fallback body when the typed fields are missing.
 */
export function oipToText(m: OipMessage, ownerName: string, opts: OipTextOptions = {}): string {
  const p = m.payload;
  const fallback = str(p.text) ?? (m.subject ? `${ownerName} is in touch about ${m.subject}.` : undefined);
  const lines: string[] = [`Hi, this is Kloru, ${ownerName}'s assistant.`];

  switch (m.intent) {
    case "propose_times": {
      const slots = Array.isArray(p.slots) ? p.slots.map((s) => formatSlot(s, opts)).filter((s): s is string => !!s) : [];
      const what = m.subject ?? "to meet";
      lines.push(`${ownerName} would like ${what.startsWith("to ") ? what : `to plan ${what}`}.`);
      if (slots.length) {
        lines.push("Would any of these work?");
        slots.forEach((s, i) => lines.push(`${i + 1}) ${s}`));
      } else if (fallback) {
        lines.push(fallback);
      }
      const place = str(p.place_hint);
      if (place) lines.push(`Place: ${place}.`);
      const dur = num(p.duration_min);
      if (dur) lines.push(`About ${dur} minutes.`);
      lines.push(slots.length ? "Reply with the number that works, or suggest another time." : "Reply with a time that works.");
      break;
    }
    case "request_freebusy": {
      const w = isRecord(p.window) ? p.window : {};
      const from = str(w.from);
      const to = str(w.to);
      lines.push(`${ownerName} is trying to plan ${m.subject ?? "something"} with you.`);
      lines.push(
        from && to
          ? `When are you free between ${formatWhen(from, opts, true)} and ${formatWhen(to, opts, true)}?`
          : "When are you free in the next few days?",
      );
      break;
    }
    case "accept": {
      const slot = formatSlot(p.slot, opts);
      const place = str(p.place);
      lines.push(`${ownerName} can do ${slot ?? "that"}${place ? ` at ${place}` : ""}.`);
      const note = str(p.note);
      if (note) lines.push(note);
      break;
    }
    case "decline": {
      const reason = str(p.reason);
      lines.push(`${ownerName} cannot make it${reason ? ` (${reason})` : ""}.`);
      const alts = Array.isArray(p.alternatives) ? p.alternatives.map((s) => formatSlot(s, opts) ?? str(s)).filter((s): s is string => !!s) : [];
      if (alts.length) {
        lines.push("Would one of these work instead?");
        alts.forEach((s, i) => lines.push(`${i + 1}) ${s}`));
      }
      break;
    }
    case "confirm": {
      lines.push(`Confirmed: ${str(p.summary) ?? fallback ?? m.subject ?? "the plan"}.`);
      break;
    }
    case "ask": {
      lines.push(str(p.question) ?? fallback ?? "Quick question for you.");
      const options = Array.isArray(p.options) ? p.options.map((o) => str(o)).filter((s): s is string => !!s) : [];
      if (options.length) lines.push(`Options: ${options.join(", ")}.`);
      break;
    }
    case "inform": {
      const facts = factsToLines(p.facts);
      if (facts.length) lines.push(...facts);
      else if (fallback) lines.push(fallback);
      break;
    }
    case "share": {
      const kind = str(p.kind) ?? "something";
      const value = typeof p.value === "string" ? p.value : JSON.stringify(p.value);
      lines.push(`${ownerName} shared ${kind.replace(".", " ")}: ${value}`);
      break;
    }
    case "book_request": {
      const vendor = str(p.vendor) ?? "a booking";
      const details = typeof p.details === "string" ? p.details : p.details !== undefined ? JSON.stringify(p.details) : undefined;
      lines.push(`${ownerName} would like to book ${vendor}${details ? `: ${details}` : "."}`);
      const budget = num(p.budget_usd);
      if (budget !== undefined) lines.push(`Budget up to $${budget}.`);
      break;
    }
  }

  if (m.reply_by) lines.push(`Please reply by ${formatWhen(m.reply_by, opts, true)}.`);
  return lines.join("\n");
}
