import { describe, expect, it } from "vitest";
import { notifyRouter } from "../src/notify-router.js";

const EZRA = "+14155550190";
const notice = { phone: EZRA, callId: "c1", subject: "Kloru: Dentist", text: "Maplewood has openings." };

function setup(o: { imessageOk?: boolean; emailOk?: boolean; email?: string | undefined; noImessage?: boolean } = {}) {
  const sent: string[] = [];
  const people = (p: string) => (p === EZRA ? { phone: EZRA, ...(o.email === undefined && "email" in o ? {} : { email: o.email ?? "ezra@work.example.com" }) } : undefined);
  const route = notifyRouter({
    ...(o.noImessage ? {} : { imessage: async (to: string, text: string) => (sent.push(`imessage ${to}: ${text}`), o.imessageOk ?? true) }),
    email: async (to: string, subject: string, text: string) => (sent.push(`email ${to} [${subject}]: ${text}`), o.emailOk ?? true),
    people,
    log: () => {},
  });
  return { route, sent };
}

describe("the notification router", () => {
  it("sends on the channel the check chose", async () => {
    const { route, sent } = setup();
    expect(await route.notify({ ...notice, channel: "email" })).toBe("email");
    expect(sent).toEqual(["email ezra@work.example.com [Kloru: Dentist]: Maplewood has openings."]);
  });

  it("with no choice, iMessage first", async () => {
    const { route, sent } = setup();
    await route.notify(notice);
    expect(sent).toEqual([`imessage ${EZRA}: Maplewood has openings.`]);
  });

  it("falls back to the other channel when the chosen one fails", async () => {
    const { route, sent } = setup({ imessageOk: false });
    // The channel actually used comes back, so the ledger records the fallback, not the ask.
    expect(await route.notify({ ...notice, channel: "imessage" })).toBe("email");
    expect(sent.at(-1)).toMatch(/^email/);
  });

  it("says which channels a person has", () => {
    expect(setup().route.channelsFor(EZRA)).toEqual(["imessage", "email"]);
    expect(setup({ noImessage: true }).route.channelsFor(EZRA)).toEqual(["email"]);
    expect(setup({ email: undefined }).route.channelsFor(EZRA)).toEqual(["imessage"]);
    expect(setup().route.channelsFor("+14155550123")).toEqual([]);
  });

  it("someone it can't reach: nothing sent, false", async () => {
    const { route, sent } = setup();
    expect(await route.notify({ ...notice, phone: "+14155550123" })).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("photos ride along", () => {
  const media = [{ path: "/data/media/m_0123456789abcdef.png", mime: "image/png", name: "plan.png" }];

  it("go to the iMessage sender, and to email with the same files when iMessage fails", async () => {
    const got: string[] = [];
    const route = notifyRouter({
      imessage: async (_to, _text, m) => (got.push(`imessage ${m?.map((x) => x.name).join(",")}`), false),
      email: async (_to, _subject, _text, m) => (got.push(`email ${m?.map((x) => x.name).join(",")}`), true),
      people: () => ({ phone: EZRA, email: "ezra@work.example.com" }),
      log: () => {},
    });
    expect(await route.notify({ ...notice, media })).toBe("email");
    expect(got).toEqual(["imessage plan.png", "email plan.png"]);
  });
});
