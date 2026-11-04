import { describe, expect, it } from "vitest";
import { MAX_CLAIM_TOKENS, MIN_CLAIM_CODE_LENGTH, matchClaimCode, normalizeClaimCode, ownerClaimStatus } from "../src/owner-claim.js";
import { testConfig } from "./helpers.js";

const CODE = normalizeClaimCode("K7P2-QX9M-4HTB-W8ZD");

describe("owner claim code", () => {
  it("normalizes case, spaces and punctuation", () => {
    expect(normalizeClaimCode(" k7p2 qx9m-4htb_w8zd ")).toBe("K7P2QX9M4HTBW8ZD");
  });

  it("is disabled without the flag, with a phone, without a code, with a short code, a bad or past expiry", () => {
    const now = new Date("2026-10-15T00:00:00Z");
    expect(ownerClaimStatus(testConfig({ phones: [], claimCode: CODE }), now).enabled).toBe(false);
    expect(ownerClaimStatus(testConfig({ claimOnFirstContact: true, claimCode: CODE }), now).enabled).toBe(false);
    expect(ownerClaimStatus(testConfig({ phones: [], claimOnFirstContact: true }), now)).toMatchObject({ enabled: false, reason: expect.stringContaining("INSTINCT_OWNER_CLAIM_CODE") });
    expect(ownerClaimStatus(testConfig({ phones: [], claimOnFirstContact: true, claimCode: "x".repeat(MIN_CLAIM_CODE_LENGTH - 1) }), now).enabled).toBe(false);
    expect(ownerClaimStatus(testConfig({ phones: [], claimOnFirstContact: true, claimCode: "--  --" }), now).enabled).toBe(false);
    expect(ownerClaimStatus(testConfig({ phones: [], claimOnFirstContact: true, claimCode: CODE, claimExpiresAt: "soon" }), now).enabled).toBe(false);
    expect(ownerClaimStatus(testConfig({ phones: [], claimOnFirstContact: true, claimCode: CODE, claimExpiresAt: "2026-10-15T00:00:00Z" }), now).enabled).toBe(false);
    expect(ownerClaimStatus(testConfig({ phones: [], claimOnFirstContact: true, claimCode: CODE, claimExpiresAt: "2026-10-15T00:00:01Z" }), now)).toEqual({ enabled: true, code: CODE });
  });

  it("matches the code as a word or as the whole message and strips it", () => {
    expect(matchClaimCode("K7P2-QX9M-4HTB-W8ZD", CODE)).toEqual({ matched: true, rest: "" });
    expect(matchClaimCode("k7p2 qx9m 4htb w8zd", CODE)).toEqual({ matched: true, rest: "" });
    expect(matchClaimCode("connect k7p2qx9m4htbw8zd!", CODE)).toEqual({ matched: true, rest: "connect" });
    expect(matchClaimCode("hi\nmy code: K7P2-QX9M-4HTB-W8ZD thanks", CODE)).toEqual({ matched: true, rest: "hi\nmy code: thanks" });
  });

  it("does not match near misses, substrings, codes split among other words, or words past the limit", () => {
    expect(matchClaimCode("K7P2-QX9M-4HTB-W8ZE", CODE).matched).toBe(false);
    expect(matchClaimCode("K7P2-QX9M-4HTB", CODE).matched).toBe(false);
    expect(matchClaimCode("XK7P2QX9M4HTBW8ZD", CODE).matched).toBe(false);
    expect(matchClaimCode("aaaaK7P2QX9M4HTBW8ZDbbbb", CODE).matched).toBe(false);
    expect(matchClaimCode("my code is K7P2 QX9M 4HTB W8ZD", CODE).matched).toBe(false);
    const filler = Array.from({ length: MAX_CLAIM_TOKENS }, (_, i) => `w${i}`).join(" ");
    expect(matchClaimCode(`${filler} ${CODE}`, CODE).matched).toBe(false);
    expect(matchClaimCode("anything", "").matched).toBe(false);
  });
});
