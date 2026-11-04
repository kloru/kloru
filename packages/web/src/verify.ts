/**
 * Texted sign-in codes through Twilio Verify. Twilio generates, sends, expires and checks
 * the code, so the console never stores one. Verify sends from Twilio's own registered
 * senders, so it works before the console's own number finishes A2P registration.
 */
export class VerifyError extends Error {}

export interface PhoneVerifier {
  /** Text a code to an E.164 number. Throws VerifyError when Twilio refuses. */
  start(phone: string): Promise<void>;
  /** True only when Twilio approves this code for this number. */
  check(phone: string, code: string): Promise<boolean>;
}

export interface TwilioVerifyOptions {
  accountSid: string;
  authToken: string;
  serviceSid: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class TwilioVerify implements PhoneVerifier {
  constructor(private readonly o: TwilioVerifyOptions) {}

  private async post(path: string, form: Record<string, string>): Promise<Response> {
    const f = this.o.fetchImpl ?? fetch;
    const base = (this.o.baseUrl ?? "https://verify.twilio.com").replace(/\/+$/, "");
    try {
      return await f(`${base}/v2/Services/${encodeURIComponent(this.o.serviceSid)}/${path}`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new VerifyError(`could not reach Twilio: ${(err as Error).message}`);
    }
  }

  async start(phone: string): Promise<void> {
    const res = await this.post("Verifications", { To: phone, Channel: "sms" });
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new VerifyError(body.message ?? `Twilio answered HTTP ${res.status}`);
  }

  async check(phone: string, code: string): Promise<boolean> {
    // 404 means no pending verification (expired, used, or too many attempts): not approved.
    const res = await this.post("VerificationCheck", { To: phone, Code: code });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return body.status === "approved";
  }
}
