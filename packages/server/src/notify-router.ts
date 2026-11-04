/**
 * Where a desk notice goes: iMessage through Inkbox or email through Resend from Kloru's own
 * address. The message check picks the channel (coms); this only sends on it, falls back to the other
 * one when it fails, says which one it used, and says which channels a person has.
 */
import type { Notice, NoticeChannel, NoticeMedia } from "@kloru/desk";

export interface NotifyRouter {
  /** The channel it went on, or false. */
  notify(n: Notice): Promise<NoticeChannel | false>;
  channelsFor(phone: string): NoticeChannel[];
}

export function notifyRouter(o: {
  imessage?: (to: string, text: string, media?: NoticeMedia[]) => Promise<boolean>;
  email?: (to: string, subject: string, text: string, media?: NoticeMedia[]) => Promise<boolean>;
  /** How to reach a person, by phone: their number for iMessage, their address for email. */
  people: (phone: string) => { phone?: string; email?: string } | undefined;
  log: (m: string) => void;
}): NotifyRouter {
  const channelsFor = (phone: string): NoticeChannel[] => {
    const who = o.people(phone);
    if (!who) return [];
    return [...(o.imessage && who.phone ? (["imessage"] as const) : []), ...(o.email && who.email ? (["email"] as const) : [])];
  };
  const sendOn = async (channel: NoticeChannel, n: Notice): Promise<boolean> => {
    const who = o.people(n.phone)!;
    try {
      return channel === "imessage" ? await o.imessage!(who.phone!, n.text, n.media) : await o.email!(who.email!, n.subject, n.text, n.media);
    } catch (error) {
      o.log(`notify: ${channel} to ${n.phone} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  return {
    channelsFor,
    async notify(n) {
      const have = channelsFor(n.phone);
      if (!have.length) {
        o.log(`notify: no way to reach ${n.phone}`);
        return false;
      }
      const order = n.channel && have.includes(n.channel) ? [n.channel, ...have.filter((c) => c !== n.channel)] : have;
      for (const channel of order) {
        if (await sendOn(channel, n)) {
          o.log(`notify: ${n.callId} to ${n.phone} by ${channel}`);
          return channel;
        }
      }
      return false;
    },
  };
}
