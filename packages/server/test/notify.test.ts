import { describe, expect, it } from "vitest";
import { gmailNotifier } from "../src/notify.js";

const notice = { phone: "+14155550190", callId: "c1", subject: "Kloru: Find a dentist", text: "From your last call:\n\n- Maplewood Kids Dental\n\nKloru" };

function fakeApps(profile: unknown = { emailAddress: "ezra@example.com" }, sendOk = true) {
  const calls: Array<{ slug: string; args: Record<string, unknown>; account?: string }> = [];
  return {
    calls,
    apps: {
      async execute(slug: string, args: Record<string, unknown>, o: { account?: string } = {}) {
        calls.push({ slug, args, ...(o.account ? { account: o.account } : {}) });
        if (slug === "GMAIL_GET_PROFILE") return { ok: true, data: profile };
        return sendOk ? { ok: true, data: {} } : { ok: false, error: "Gmail not connected" };
      },
    },
  };
}

describe("after-call summaries by email", () => {
  it("a family member's summary goes to her, sent from her own Gmail when she has one", async () => {
    const f = fakeApps();
    const people = (p: string) => (p === "+14155550191" ? { email: "cleo@gmail.example", account: "cleo@gmail.example" } : p === "+14155550100" ? { email: "linda@example.com" } : undefined);
    const send = gmailNotifier({ apps: f.apps, ownerPhones: ["+14155550190"], ownerEmail: "ezra@work.example.com", people, log: () => {} });
    expect(await send({ ...notice, phone: "+14155550191" })).toBe(true);
    expect(f.calls.at(-1)).toEqual({ slug: "GMAIL_SEND_EMAIL", args: { recipient_email: "cleo@gmail.example", subject: notice.subject, body: notice.text }, account: "cleo@gmail.example" });
    await send({ ...notice, phone: "+14155550100" });
    expect(f.calls.at(-1)).toMatchObject({ args: { recipient_email: "linda@example.com" } });
    expect(f.calls.at(-1)!.account).toBeUndefined(); // from the owner's Gmail
    expect(await send({ ...notice, phone: "+19995550000" })).toBe(false); // nobody we know: nothing sent
  });

  it("sends from the owner's Gmail to the owner's own address, asking Gmail for it once", async () => {
    const f = fakeApps();
    const send = gmailNotifier({ apps: f.apps, ownerPhones: ["+1 (415) 555-0190"], log: () => {} });
    expect(await send(notice)).toBe(true);
    expect(await send(notice)).toBe(true);
    expect(f.calls.filter((c) => c.slug === "GMAIL_GET_PROFILE")).toHaveLength(1);
    expect(f.calls.at(-1)).toEqual({ slug: "GMAIL_SEND_EMAIL", args: { recipient_email: "ezra@example.com", subject: notice.subject, body: notice.text } });
  });

  it("uses the configured address when there is one", async () => {
    const f = fakeApps();
    const send = gmailNotifier({ apps: f.apps, ownerPhones: ["+14155550190"], ownerEmail: "ezra@work.example.com", log: () => {} });
    await send(notice);
    expect(f.calls.map((c) => c.slug)).toEqual(["GMAIL_SEND_EMAIL"]);
    expect(f.calls[0]!.args.recipient_email).toBe("ezra@work.example.com");
  });

  it("never emails anyone but the owner, and reports a failed send", async () => {
    const f = fakeApps(undefined, false);
    const send = gmailNotifier({ apps: f.apps, ownerPhones: ["+14155550190"], ownerEmail: "ezra@work.example.com", log: () => {} });
    expect(await send({ ...notice, phone: "+14155550123" })).toBe(false);
    expect(f.calls).toEqual([]);
    expect(await send(notice)).toBe(false);
  });

  it("without a known address it doesn't guess", async () => {
    const f = fakeApps({});
    const send = gmailNotifier({ apps: f.apps, ownerPhones: ["+14155550190"], log: () => {} });
    expect(await send(notice)).toBe(false);
    expect(f.calls.some((c) => c.slug === "GMAIL_SEND_EMAIL")).toBe(false);
  });
});
