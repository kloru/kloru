/**
 * Resend: Kloru's own email at mail.kloru.com. Inbound mail arrives as a signed webhook
 * (Svix) carrying only ids; the body, headers and DMARC result come from the received-email API.
 * Replies keep the thread with In-Reply-To and References.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.resend.com";
/** How old a webhook delivery may be, so a captured one can't be replayed later. */
const TOLERANCE_S = 5 * 60;

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string): string | undefined => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/** Svix's scheme: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}` with the whsec_ key; any listed v1 signature may match. */
export function verifySvix(raw: string, headers: Headers, secret: string, now = new Date()): boolean {
  const id = header(headers, "svix-id");
  const ts = header(headers, "svix-timestamp");
  const sigs = header(headers, "svix-signature");
  if (!id || !ts || !sigs || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const want = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(" ").some((s) => {
    const [version, value] = s.split(",");
    if (version !== "v1" || !value) return false;
    const got = Buffer.from(value, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export interface ReceivedEmail {
  id: string;
  /** The bare address, lowercased. */
  from: string;
  to: string[];
  subject: string;
  text: string;
  messageId: string;
  references: string[];
  /** Resend's DMARC verdict for the From domain ("pass" when the sender is who they say). */
  dmarc: string;
  /** Files that came with it; each one's download link comes from attachmentUrl. */
  attachments?: Array<{ id: string; name: string; mime: string }>;
}

export interface SendEmail {
  from: string;
  to: string | string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  /** Files, their bytes in base64. */
  attachments?: Array<{ filename: string; content: string }>;
}

export interface ResendClient {
  received(id: string): Promise<ReceivedEmail>;
  /** A received attachment's short-lived download link. */
  attachmentUrl(emailId: string, attachmentId: string): Promise<string>;
  send(m: SendEmail): Promise<{ ok: boolean; id?: string; error?: string }>;
}

/**
 * The one mailbox an email is from, as DMARC checked it: a bare address, or `Name <address>`. A
 * display name holding an address or a second mailbox ("Ezra <ezra@work.example.com>" <x@evil.example>) is
 * refused (empty), so a name can never stand in for the address that was authenticated.
 */
export function senderAddress(raw: string): string {
  const s = raw.trim();
  if (/^[^\s<>@",]+@[^\s<>@",]+$/.test(s)) return s.toLowerCase();
  const m = /^(.*)<([^<>\s@]+@[^<>\s@]+)>$/.exec(s);
  if (!m) return "";
  const display = m[1]!;
  if (/[<>@]/.test(display) || display.replace(/"[^"]*"/g, "").includes(",")) return "";
  return m[2]!.toLowerCase();
}

const address = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();
const plain = (html: string) => html.replace(/<(br|\/p|\/div)[^>]*>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

export function resendClient(o: { apiKey: string; fetchImpl?: typeof fetch }): ResendClient {
  const f = o.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${o.apiKey}` };
  return {
    async received(id) {
      const res = await f(`${API}/emails/receiving/${encodeURIComponent(id)}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`resend: received email ${id}: ${res.status}`);
      const d = (await res.json()) as Record<string, any>;
      const refs = String(d.headers?.references ?? "").split(/\s+/).filter(Boolean);
      return {
        id: String(d.id ?? id),
        from: senderAddress(String(d.from ?? "")),
        to: Array.isArray(d.to) ? d.to.map((t: unknown) => address(String(t))) : [],
        subject: String(d.subject ?? ""),
        text: typeof d.text === "string" && d.text.trim() ? d.text.trim() : plain(String(d.html ?? "")),
        messageId: String(d.message_id ?? ""),
        references: refs,
        dmarc: String(d.authentication?.dmarc ?? "none"),
        ...(Array.isArray(d.attachments) && d.attachments.length
          ? { attachments: d.attachments.filter((a: any) => a?.id).map((a: any) => ({ id: String(a.id), name: String(a.filename ?? "attachment"), mime: String(a.content_type ?? "application/octet-stream") })) }
          : {}),
      };
    },
    async attachmentUrl(emailId, attachmentId) {
      const res = await f(`${API}/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`, { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`resend: attachment ${attachmentId}: ${res.status}`);
      const url = String(((await res.json()) as { download_url?: string }).download_url ?? "");
      if (!url) throw new Error(`resend: attachment ${attachmentId} has no download link`);
      return url;
    },
    async send(m) {
      const res = await f(`${API}/emails`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: m.from,
          to: Array.isArray(m.to) ? m.to : [m.to],
          subject: m.subject,
          text: m.text,
          ...(m.inReplyTo ? { headers: { "In-Reply-To": m.inReplyTo, References: (m.references?.length ? m.references : [m.inReplyTo]).join(" ") } } : {}),
          ...(m.attachments?.length ? { attachments: m.attachments } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const d = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      return res.ok ? { ok: true, ...(d.id ? { id: d.id } : {}) } : { ok: false, error: `${res.status} ${d.message ?? ""}`.trim() };
    },
  };
}
