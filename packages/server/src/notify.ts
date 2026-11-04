/**
 * After-call summaries by email: from the owner's own Gmail, to the owner's own address. Texts
 * take over once the number's A2P registration is approved. Only the owner is ever emailed.
 */
import type { Notice } from "@kloru/desk";

interface Apps {
  execute(slug: string, args: Record<string, unknown>, o?: { account?: string }): Promise<{ ok: boolean; data?: unknown; error?: string }>;
}

const digits = (p: string) => p.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

/**
 * `people`: a family member's address, and the Gmail account (by address) to send from when she has
 * her own connected; without one it goes from the owner's Gmail.
 */
export function gmailNotifier(o: { apps: Apps; ownerPhones: string[]; ownerEmail?: string; people?: (phone: string) => { email?: string; account?: string } | undefined; log: (m: string) => void }): (n: Notice) => Promise<boolean> {
  const owners = new Set(o.ownerPhones.map(digits));
  let address = o.ownerEmail?.trim() || undefined;
  return async (n) => {
    if (!owners.has(digits(n.phone))) {
      const who = o.people?.(n.phone);
      if (!who?.email) {
        o.log(`notify: no summary for ${n.phone}: no email address for them`);
        return false;
      }
      const sent = await o.apps.execute("GMAIL_SEND_EMAIL", { recipient_email: who.email, subject: n.subject, body: n.text }, who.account ? { account: who.account } : {});
      o.log(sent.ok ? `notify: emailed the summary of ${n.callId} to ${who.email}` : `notify: email failed: ${sent.error}`);
      return sent.ok;
    }
    if (!address) {
      const profile = await o.apps.execute("GMAIL_GET_PROFILE", {});
      const data = profile.data as { emailAddress?: string; response_data?: { emailAddress?: string } } | undefined;
      address = data?.emailAddress ?? data?.response_data?.emailAddress;
      if (!address) {
        o.log(`notify: can't find the owner's email address${profile.error ? ` (${profile.error})` : ""}`);
        return false;
      }
    }
    const sent = await o.apps.execute("GMAIL_SEND_EMAIL", { recipient_email: address, subject: n.subject, body: n.text });
    o.log(sent.ok ? `notify: emailed the summary of ${n.callId}` : `notify: email failed: ${sent.error}`);
    return sent.ok;
  };
}
