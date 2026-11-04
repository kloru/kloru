/**
 * Whether texting works for someone yet. On Inkbox's shared iMessage line a person has to text
 * Kloru first (`connect @<handle>`); until they do, Kloru can't text them. The desk knows: a text
 * conversation from their phone, or a text Kloru sent them.
 */
export interface TextingStatus {
  /** The number people text, E.164. */
  number?: string;
  /** The family's handle on the shared line; the opt-in text is `connect @<handle>`. */
  handle?: string;
  /** When they last texted Kloru (ISO). */
  texted?: string;
  /** When Kloru last texted them (ISO). */
  sent?: string;
}

export interface TextingRepo {
  callsFor(phone: string): Array<{ channel: string; startedAt: string }>;
  notifications(phone: string): Array<{ channel: string; at: string }>;
}

export function textingStatus(o: { number?: string; handle?: string; repo?: TextingRepo }, phone: string): TextingStatus {
  const texted = o.repo?.callsFor(phone).find((c) => c.channel === "imessage")?.startedAt;
  const sent = o.repo?.notifications(phone).filter((n) => n.channel === "imessage").at(-1)?.at;
  return { ...(o.number ? { number: o.number } : {}), ...(o.handle ? { handle: o.handle } : {}), ...(texted ? { texted } : {}), ...(sent ? { sent } : {}) };
}
