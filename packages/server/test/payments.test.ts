import { describe, expect, it } from "vitest";
import { LINK_CALLBACK_PATH, PAYMENTS_PACKAGE, loadPaymentsModule, paymentsEnv } from "../src/payments.js";

const full = { LINK_CLIENT_ID: "lc_1", LINK_CLIENT_SECRET: "ls_1", STRIPE_PUBLISHABLE_KEY: "pk_test_1" };

describe("paymentsEnv", () => {
  it("is off unless all three variables are present and non-blank", () => {
    expect(paymentsEnv({})).toBeUndefined();
    expect(paymentsEnv({ ...full, LINK_CLIENT_SECRET: "" })).toBeUndefined();
    expect(paymentsEnv({ ...full, STRIPE_PUBLISHABLE_KEY: "   " })).toBeUndefined();
    expect(paymentsEnv({ LINK_CLIENT_ID: "a", LINK_CLIENT_SECRET: "b" })).toBeUndefined();
  });

  it("builds the redirect URI from the explicit value, the public URL, or loopback on PORT", () => {
    expect(paymentsEnv(full)).toEqual({ clientId: "lc_1", clientSecret: "ls_1", publishableKey: "pk_test_1", redirectUri: `http://127.0.0.1:8080${LINK_CALLBACK_PATH}`, test: true });
    expect(paymentsEnv({ ...full, PORT: "18789" })?.redirectUri).toBe(`http://127.0.0.1:18789${LINK_CALLBACK_PATH}`);
    expect(paymentsEnv({ ...full, INSTINCT_PUBLIC_URL: "https://maria.example.com/" })?.redirectUri).toBe(`https://maria.example.com${LINK_CALLBACK_PATH}`);
    expect(paymentsEnv({ ...full, INSTINCT_PUBLIC_URL: "https://x", LINK_REDIRECT_URI: "https://gw.example.com/oauth/link/callback" })?.redirectUri).toBe(
      "https://gw.example.com/oauth/link/callback",
    );
  });
});

describe("test mode", () => {
  it("is on with a test publishable key, or with LINK_TEST=on; a live key alone is live", () => {
    expect(paymentsEnv(full)?.test).toBe(true);
    expect(paymentsEnv({ ...full, STRIPE_PUBLISHABLE_KEY: "pk_live_1" })?.test).toBe(false);
    expect(paymentsEnv({ ...full, STRIPE_PUBLISHABLE_KEY: "pk_live_1", LINK_TEST: "on" })?.test).toBe(true);
  });
});

describe("loadPaymentsModule", () => {
  it("returns undefined when the package is missing or malformed, never throws", async () => {
    expect(await loadPaymentsModule(async () => { throw new Error("Cannot find module"); })).toBeUndefined();
    expect(await loadPaymentsModule(async () => ({}))).toBeUndefined();
    expect(await loadPaymentsModule(async () => ({ LinkWallet: class {} }))).toBeUndefined();
  });

  it("returns the module when it has the contract", async () => {
    const asked: string[] = [];
    const mod = { LinkWallet: class {}, paymentsTools: () => [] };
    const loaded = await loadPaymentsModule(async (spec) => {
      asked.push(spec);
      return mod;
    });
    expect(loaded).toBe(mod);
    expect(asked).toEqual([PAYMENTS_PACKAGE]);
  });
});
