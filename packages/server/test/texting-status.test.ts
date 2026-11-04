import { describe, expect, it } from "vitest";
import { textingStatus } from "../src/texting-status.js";

const EVAN = "+14155550190";
const call = (phone: string, channel: string, startedAt: string) => ({ id: `${startedAt}-${channel}`, callSid: "x", phone, channel, startedAt, deliveredSeq: 0 });
const sent = (phone: string, channel: string, at: string) => ({ at, phone, channel, subject: "", text: "", call: "", issues: [], hash: "" });

function repo(calls: ReturnType<typeof call>[], notes: ReturnType<typeof sent>[]) {
  return {
    callsFor: (p: string) => calls.filter((c) => c.phone === p).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    notifications: (p: string) => notes.filter((n) => n.phone === p),
  };
}

describe("texting status: has this person texted with Kloru?", () => {
  const base = { number: "+16504849720", handle: "kloru-marshalls" };

  it("the newest text they sent and the newest text Kloru sent them", () => {
    const r = repo(
      [call(EVAN, "phone", "2026-10-31T10:00:00Z"), call(EVAN, "imessage", "2026-10-30T09:00:00Z"), call(EVAN, "imessage", "2026-10-31T09:00:00Z")],
      [sent(EVAN, "imessage", "2026-10-30T12:00:00Z"), sent(EVAN, "email", "2026-10-31T12:00:00Z")],
    );
    expect(textingStatus({ ...base, repo: r }, EVAN)).toEqual({ ...base, texted: "2026-10-31T09:00:00Z", sent: "2026-10-30T12:00:00Z" });
  });

  it("phone calls and emails don't count as texting", () => {
    const r = repo([call(EVAN, "phone", "2026-10-31T10:00:00Z"), call(EVAN, "email", "2026-10-31T11:00:00Z")], [sent(EVAN, "email", "2026-10-31T12:00:00Z")]);
    expect(textingStatus({ ...base, repo: r }, EVAN)).toEqual(base);
  });

  it("without a desk or a texting number, says only what it knows", () => {
    expect(textingStatus({}, EVAN)).toEqual({});
  });
});
