import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resendClient, verifySvix } from "../src/resend.js";

const KEY = Buffer.from("a test signing key of thirty two!").toString("base64");
const SECRET = `whsec_${KEY}`;
const NOW = new Date("2026-10-30T18:00:00Z");

function sign(body: string, id = "msg_1", ts = Math.floor(NOW.getTime() / 1000), secret = KEY) {
  const sig = createHmac("sha256", Buffer.from(secret, "base64")).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": String(ts), "svix-signature": `v1,${sig}` };
}

describe("Resend webhook signatures (Svix)", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "e1" } });

  it("a correctly signed delivery passes", () => {
    expect(verifySvix(body, sign(body), SECRET, NOW)).toBe(true);
  });

  it("a tampered body, another secret, or an old timestamp fails", () => {
    expect(verifySvix(body + " ", sign(body), SECRET, NOW)).toBe(false);
    expect(verifySvix(body, sign(body, "msg_1", undefined, Buffer.from("another key entirely, 32 bytes!!").toString("base64")), SECRET, NOW)).toBe(false);
    expect(verifySvix(body, sign(body, "msg_1", Math.floor(NOW.getTime() / 1000) - 600), SECRET, NOW)).toBe(false);
    expect(verifySvix(body, {}, SECRET, NOW)).toBe(false);
  });

  it("any of several signatures may match (secret rotation)", () => {
    const good = sign(body);
    expect(verifySvix(body, { ...good, "svix-signature": `v1,AAAA ${good["svix-signature"]}` }, SECRET, NOW)).toBe(true);
  });
});

describe("Resend API", () => {
  function fake(respond: (url: string, init: RequestInit) => unknown) {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(respond(url, init)), { status: 200 });
    }) as unknown as typeof fetch;
    return { seen, client: resendClient({ apiKey: "k", fetchImpl }) };
  }

  it("sends attachments as base64 files", async () => {
    const { seen, client } = fake(() => ({ id: "e1" }));
    await client.send({ from: "Kloru <k@mail.kloru.com>", to: "evan@work.example.com", subject: "Plan", text: "Here it is.", attachments: [{ filename: "plan.png", content: "aGk=" }] });
    expect(JSON.parse(String(seen[0]!.init.body)).attachments).toEqual([{ filename: "plan.png", content: "aGk=" }]);
  });

  it("reads a received email with its DMARC result and threading ids", async () => {
    const { seen, client } = fake(() => ({
      id: "e1", from: "Evan Marshall <evan@work.example.com>", to: ["marshalls@mail.kloru.com"], subject: "Dentist?", text: "When is Maya's dentist?", html: "<p>…</p>",
      message_id: "<abc@work.example.com>", headers: { references: "<x@work.example.com> <y@work.example.com>" }, authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    }));
    const m = await client.received("e1");
    expect(seen[0]!.url).toBe("https://api.resend.com/emails/receiving/e1");
    expect(m).toMatchObject({ id: "e1", from: "evan@work.example.com", subject: "Dentist?", text: "When is Maya's dentist?", messageId: "<abc@work.example.com>", references: ["<x@work.example.com>", "<y@work.example.com>"], dmarc: "pass" });
  });

  it("lists a received email's attachments, and gets each one's download link", async () => {
    const { seen, client } = fake((url) =>
      url.includes("/attachments/")
        ? { object: "attachment", id: "a1", filename: "Quote.pdf", content_type: "application/pdf", download_url: "https://inbound-cdn.resend.com/a1", expires_at: "2026-11-02T00:00:00Z" }
        : { id: "e1", from: "evan@work.example.com", to: [], subject: "Quote", text: "see attached", message_id: "<m>", headers: {}, authentication: { dmarc: "pass" }, attachments: [{ id: "a1", filename: "Quote.pdf", content_type: "application/pdf", size: 1200 }] },
    );
    const m = await client.received("e1");
    expect(m.attachments).toEqual([{ id: "a1", name: "Quote.pdf", mime: "application/pdf" }]);
    expect(await client.attachmentUrl("e1", "a1")).toBe("https://inbound-cdn.resend.com/a1");
    expect(seen.at(-1)!.url).toBe("https://api.resend.com/emails/receiving/e1/attachments/a1");
  });

  it("a sender name that hides someone else's address never becomes that address", async () => {
    for (const from of ['"Evan <evan@work.example.com>" <x@evil.com>', "Evan evan@work.example.com <x@evil.com>", "evan@work.example.com <x@evil.com>", "<evan@work.example.com>, <x@evil.com>", "a <x@evil.com> <evan@work.example.com>"]) {
      const { client } = fake(() => ({ id: "e", from, to: [], subject: "", text: "hi", message_id: "<m>", headers: {}, authentication: { dmarc: "pass" } }));
      expect((await client.received("e")).from, from).not.toBe("evan@work.example.com");
    }
    for (const [from, want] of [["Evan Marshall <evan@work.example.com>", "evan@work.example.com"], ['"Marshall, Evan" <Evan@Work.Example.com>', "evan@work.example.com"], ["evan@work.example.com", "evan@work.example.com"]] as const) {
      const { client } = fake(() => ({ id: "e", from, to: [], subject: "", text: "hi", message_id: "<m>", headers: {}, authentication: {} }));
      expect((await client.received("e")).from).toBe(want);
    }
  });

  it("falls back to the HTML's words when there's no text part", async () => {
    const { client } = fake(() => ({ id: "e2", from: "a@b.com", to: [], subject: "", text: null, html: "<p>Hi <b>there</b></p>", message_id: "<m>", headers: {}, authentication: {} }));
    expect((await client.received("e2")).text).toBe("Hi there");
  });

  it("sends a reply in the thread", async () => {
    const { seen, client } = fake(() => ({ id: "s1" }));
    const r = await client.send({ from: "Kloru <marshalls@mail.kloru.com>", to: "evan@work.example.com", subject: "Re: Dentist?", text: "Thursday at 3.", inReplyTo: "<abc@work.example.com>", references: ["<x@work.example.com>", "<abc@work.example.com>"] });
    expect(r).toEqual({ ok: true, id: "s1" });
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(seen[0]!.url).toBe("https://api.resend.com/emails");
    expect(body).toMatchObject({ from: "Kloru <marshalls@mail.kloru.com>", to: ["evan@work.example.com"], subject: "Re: Dentist?", text: "Thursday at 3.", headers: { "In-Reply-To": "<abc@work.example.com>", References: "<x@work.example.com> <abc@work.example.com>" } });
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });
});
