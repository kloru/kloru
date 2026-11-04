import { describe, expect, it } from "vitest";
import { loadConsoleEnv } from "../src/main.js";

const FULL = { KLORU_SESSION_SECRET: "x".repeat(32), KLORU_ADMIN_PHONES: "(415) 555-0190, +1 415 555 0100", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_VERIFY_SERVICE_SID: "VA1" };

describe("loadConsoleEnv", () => {
  it("names every missing required key", () => {
    expect(() => loadConsoleEnv({})).toThrow(/KLORU_SESSION_SECRET.*KLORU_ADMIN_PHONES.*TWILIO_ACCOUNT_SID.*TWILIO_AUTH_TOKEN.*TWILIO_VERIFY_SERVICE_SID/);
  });

  it("refuses admin numbers without an area code", () => {
    expect(() => loadConsoleEnv({ ...FULL, KLORU_ADMIN_PHONES: "5550190" })).toThrow(/area code/);
  });

  it("refuses a short session secret", () => {
    expect(() => loadConsoleEnv({ ...FULL, KLORU_SESSION_SECRET: "short" })).toThrow(/at least 32/);
  });

  it("applies defaults", () => {
    const e = loadConsoleEnv(FULL);
    expect(e).toMatchObject({ port: 8790, bind: "127.0.0.1", publicUrl: "http://localhost:8790", dataDir: ".kloru", adminPhones: ["+14155550190", "+14155550100"] });
    expect(e.verify).toEqual({ accountSid: "AC1", authToken: "tok", serviceSid: "VA1" });
    expect(e.devAgent).toBeUndefined();
  });

  it("uses the dev agent URL and a public URL without a trailing slash", () => {
    const e = loadConsoleEnv({ ...FULL, KLORU_PUBLIC_URL: "https://app.kloru.com/", KLORU_DEV_AGENT_URL: "http://127.0.0.1:8080", KLORU_PORT: "9000", KLORU_BIND: "0.0.0.0" });
    expect(e.publicUrl).toBe("https://app.kloru.com");
    expect(e.devAgent).toEqual({ kind: "direct", url: "http://127.0.0.1:8080", tokenEnv: "INSTINCT_CHAT_TOKEN", secretEnv: "OWNER_API_SECRET" });
    expect(e).toMatchObject({ port: 9000, bind: "0.0.0.0" });
    expect(e.databaseUrl).toBeUndefined();
    expect(loadConsoleEnv({ ...FULL, DATABASE_URL: " postgres://x " }).databaseUrl).toBe("postgres://x");
  });
});
