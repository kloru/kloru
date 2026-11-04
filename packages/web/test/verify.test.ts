import { describe, expect, it } from "vitest";
import { TwilioVerify, VerifyError } from "../src/verify.js";

function fake(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const opts = { accountSid: "AC1", authToken: "tok", serviceSid: "VA1" };

describe("TwilioVerify", () => {
  it("starts an SMS verification with basic auth", async () => {
    const g = fake([{ status: 201, body: { status: "pending" } }]);
    await new TwilioVerify({ ...opts, fetchImpl: g.f }).start("+14155550190");
    expect(g.calls[0]!.url).toBe("https://verify.twilio.com/v2/Services/VA1/Verifications");
    expect((g.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    expect(String(g.calls[0]!.init.body)).toBe("To=%2B14155550190&Channel=sms");
  });

  it("check is true only when Twilio says approved", async () => {
    const ok = fake([{ status: 200, body: { status: "approved" } }]);
    expect(await new TwilioVerify({ ...opts, fetchImpl: ok.f }).check("+14155550190", "123456")).toBe(true);
    expect(String(ok.calls[0]!.init.body)).toBe("To=%2B14155550190&Code=123456");
    expect(ok.calls[0]!.url).toBe("https://verify.twilio.com/v2/Services/VA1/VerificationCheck");
    const wrong = fake([{ status: 200, body: { status: "pending" } }]);
    expect(await new TwilioVerify({ ...opts, fetchImpl: wrong.f }).check("+14155550190", "000000")).toBe(false);
    const expired = fake([{ status: 404, body: { code: 20404 } }]);
    expect(await new TwilioVerify({ ...opts, fetchImpl: expired.f }).check("+14155550190", "123456")).toBe(false);
  });

  it("start failures raise VerifyError with Twilio's message", async () => {
    const g = fake([{ status: 429, body: { message: "Max send attempts reached" } }]);
    await expect(new TwilioVerify({ ...opts, fetchImpl: g.f }).start("+14155550190")).rejects.toMatchObject({ message: "Max send attempts reached" });
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    await expect(new TwilioVerify({ ...opts, fetchImpl: down }).start("+1")).rejects.toBeInstanceOf(VerifyError);
  });
});
